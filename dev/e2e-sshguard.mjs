#!/usr/bin/env node
// End-to-end test for "Protect SSH" (fail2ban + password login off) on the lab server vps-new
// (./dev/clone-setup.sh). Run a Switchboard ON THE LAB NETWORK:
//   docker build -t sb-guard-test:dev . && docker run -d --name sb-guard-test --network switchboard-dev_lab \
//     -p 127.0.0.1:8098:8080 -v "$PWD/dev/.keys:/keys:ro" -e ADMIN_USER=admin -e ADMIN_PASSWORD=admin-password-123 sb-guard-test:dev
//   SB_URL=http://localhost:8098 node dev/e2e-sshguard.mjs
// The lab's sshd logs to stderr, so the test writes "Failed password" lines into /var/log/auth.log itself
// (that is what sshd does on a real Ubuntu/Debian server). Attackers are client containers on
// 172.30.0.42 (gets blocked) and 172.30.0.41 (on the "never block" list). fail2ban is removed again at the end.
import { execSync, execFileSync } from 'node:child_process';

const BASE = process.env.SB_URL || 'http://localhost:8098';
const NET = 'switchboard-dev_lab';
const VPS = 'vps-new';
const VPS_IP = '172.30.0.22';
const OK_IP = '172.30.0.41';
const BAD_IP = '172.30.0.42';
let cookie = '';
let failures = 0;

async function api(method, url, body) {
  const go = () =>
    fetch(`${BASE}/api${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const res = await go().catch((e) => (e.message === 'fetch failed' ? go() : Promise.reject(e)));
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) cookie = c.split(';')[0];
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error(`${method} ${url} → ${res.status} ${data?.error}`);
    e.status = res.status;
    throw e;
  }
  return data;
}
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// No shell on this side: $(...) and $VAR must reach the server untouched.
const onVps = (cmd) => execFileSync('docker', ['exec', VPS, 'sh', '-c', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(cond, msg) {
  if (cond) console.log('  ✔', msg);
  else {
    failures++;
    console.log('  ✖', msg);
  }
}
async function step(name, fn) {
  console.log(`\n▶ ${name}`);
  try {
    await fn();
  } catch (e) {
    failures++;
    console.log('  ✖ ERROR', e.message);
  }
}
async function waitJob(job, ms = 600000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (j.status !== 'success') console.log(String(j.log).split('\n').slice(-12).join('\n'));
      return j;
    }
    await sleep(1500);
  }
  throw new Error(`job ${job.id} timed out`);
}
const reach = (fromIp) => {
  try {
    sh(`docker run --rm --network ${NET} --ip ${fromIp} alpine:3.22 nc -z -w 3 ${VPS_IP} 22`);
    return true;
  } catch {
    return false;
  }
};
// "Failed password" lines like sshd writes them, with the SERVER's clock (fail2ban ignores old lines)
const addFails = (ip, n) => onVps(`for i in $(seq 1 ${n}); do echo "$(date '+%b %e %H:%M:%S') vps-new sshd[40$i]: Failed password for root from ${ip} port 5000$i ssh2"; done >> /var/log/auth.log`);
const HUP = 'P=$(cat /run/sshd.pid 2>/dev/null); [ -n "$P" ] || P=$(pgrep -o -x sshd); kill -HUP $P';

let id;
const preview = async () => {
  const r = await api('POST', `/servers/${id}/ssh-guard/preview`, {});
  if (!r.ok) throw new Error(r.error);
  return r.plan;
};

await step('set up: vps-new with an auth.log, added to Switchboard', async () => {
  onVps('touch /var/log/auth.log');
  await api('POST', '/auth/login', { username: process.env.SB_USER || 'admin', password: process.env.SB_PASSWORD || 'admin-password-123' });
  id = (await api('POST', '/servers', { name: 'guard-vps', ip: VPS_IP, auth_type: 'keyfile', ssh_key_path: '/keys/id_ed25519' })).id;
  const p = await preview();
  check(p.sshd.port === 22 && p.switchboard_ip && p.can_disable_passwords, `preview: port ${p.sshd.port}, Switchboard comes from ${p.switchboard_ip}, logs in with a key`);
  check(!p.fail2ban.running, `fail2ban not running yet (${p.fail2ban.installed ? 'installed' : 'not installed'})`);
  check(p.keys.some((k) => k.n > 0), 'finds the SSH key in authorized_keys');
  check(reach(BAD_IP) && reach(OK_IP), 'before: both test IPs reach SSH');
});

await step('bad input is refused', async () => {
  let n = 0;
  for (const body of [{ passwords_off: true, fail2ban: false }, { ignore: ['not-an-ip'] }, { fail2ban: false }]) {
    await api('POST', `/servers/${id}/ssh-guard`, body).catch(() => n++);
  }
  check(n === 3, 'password login off without "I can log in with a key", a bad IP and "nothing ticked" are refused');
});

await step('fail2ban: guessing IPs get blocked, the "never block" list does not', async () => {
  const j = await waitJob((await api('POST', `/servers/${id}/ssh-guard`, { fail2ban: true, maxretry: 3, bantime: 10, ignore: [OK_IP] })).job);
  check(j.status === 'success', `job ${j.status}`);
  check(/never blocked/i.test(j.log) && j.log.includes(OK_IP), 'log lists the IPs that are never blocked');
  const jail = onVps('cat /etc/fail2ban/jail.d/switchboard-ssh.local');
  check(/maxretry = 3/.test(jail) && /bantime = 10m/.test(jail) && jail.includes(OK_IP) && jail.includes(VPS_IP), 'jail file: 3 tries, 10 min, ignore list includes the test IP and the servers');
  addFails(BAD_IP, 5);
  addFails(OK_IP, 5);
  let banned = [];
  for (let i = 0; i < 20 && !banned.includes(BAD_IP); i++) {
    await sleep(1500);
    banned = (await preview()).fail2ban.banned;
  }
  check(banned.includes(BAD_IP), `${BAD_IP} is blocked after guessing`);
  check(!banned.includes(OK_IP), `${OK_IP} is not blocked (on the list)`);
  check(!reach(BAD_IP), `${BAD_IP} can't reach SSH any more`);
  check(reach(OK_IP), `${OK_IP} still reaches SSH`);
  const s = await api('GET', `/servers/${id}`);
  check(s.ssh_guard?.fail2ban === true, 'server remembers: fail2ban on');
});

await step('unblock an IP', async () => {
  await api('POST', `/servers/${id}/ssh-guard/unban`, { ip: BAD_IP });
  check(!(await preview()).fail2ban.banned.includes(BAD_IP), `${BAD_IP} removed from the blocked list`);
  check(reach(BAD_IP), `${BAD_IP} reaches SSH again`);
});

await step('turn off password login (keys only)', async () => {
  onVps(`sed -i 's/^PasswordAuthentication no/#PasswordAuthentication no/' /etc/ssh/sshd_config; ${HUP}`);
  await sleep(1000);
  check(/passwordauthentication yes/.test(onVps('sshd -T | grep -i ^passwordauthentication')), 'lab: password login switched ON first (like a fresh VPS)');
  const j = await waitJob((await api('POST', `/servers/${id}/ssh-guard`, { fail2ban: false, passwords_off: true, confirm_keys: true })).job);
  check(j.status === 'success' && /still log in/.test(j.log), `job ${j.status}, checked a new login`);
  check(/now accepts: publickey$/m.test(j.log), 'the RUNNING SSH server only offers publickey now');
  check(/passwordauthentication no/.test(onVps('sshd -T | grep -i ^passwordauthentication')), 'sshd now refuses passwords');
  const p = await preview();
  check(p.sshd.password === false && p.guard.passwords, 'Switchboard still gets in; preview shows password login OFF');
  const s = await api('GET', `/servers/${id}`);
  check(s.ssh_guard?.passwords_off === true && s.ssh_guard?.fail2ban === true, 'server remembers both');
});

await step('remove protection', async () => {
  const j = await waitJob((await api('POST', `/servers/${id}/ssh-guard`, { remove: true })).job);
  check(j.status === 'success', `job ${j.status}`);
  check(onVps('ls /etc/ssh/sshd_config.d/00-switchboard-guard.conf /etc/fail2ban/jail.d/switchboard-ssh.local 2>/dev/null || true') === '', 'both files removed');
  check(/passwordauthentication yes/.test(onVps('sshd -T | grep -i ^passwordauthentication')), "password login back to the server's own setting");
  const s = await api('GET', `/servers/${id}`);
  check(!s.ssh_guard, 'server state cleared');
  check((await preview()).sshd.port === 22, 'Switchboard still logs in');
});

await step('clean up the lab', async () => {
  onVps(`sed -i 's/^#PasswordAuthentication no/PasswordAuthentication no/' /etc/ssh/sshd_config; ${HUP}; true`);
  onVps("(service fail2ban stop || fail2ban-client stop) >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get purge -y -q fail2ban python3-systemd >/dev/null 2>&1; rm -f /var/log/auth.log; true");
  if (id) await api('DELETE', `/servers/${id}`);
  check(/passwordauthentication no/.test(onVps('sshd -T | grep -i ^passwordauthentication')), 'lab sshd back to keys only, fail2ban removed');
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all Protect SSH checks passed');
process.exit(failures ? 1 : 0);

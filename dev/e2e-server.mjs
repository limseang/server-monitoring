#!/usr/bin/env node
// End-to-end test for server control: open ports, connect a domain, change a port, change a password, restart.
// Needs the lab (./dev/setup.sh) and vps-ci (./dev/ci-setup.sh). Only touches vps-ci, its server entry,
// the /srv/porttest stack on it, the porttest*.shop.test DNS records and the lab user "dev-srv".
//   node dev/e2e-server.mjs
// The restart is simulated on vps-ci (a container can't reboot): a stand-in "systemctl" blocks SSH for 20s.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SB_URL || 'http://localhost:8090';
const CF = 'http://localhost:8787';
const KEY = fs.readFileSync(path.join(DIR, '.keys/id_ed25519'), 'utf8');
let failures = 0;

function client() {
  let cookie = '';
  return async function api(method, url, body, { raw = false } = {}) {
    const go = () => fetch(`${BASE}/api${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await go().catch((e) => (e.message === 'fetch failed' ? go() : Promise.reject(e)));
    for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) cookie = c.split(';')[0];
    const data = await res.json().catch(() => null);
    if (raw) return { status: res.status, data };
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
    return data;
  };
}
const api = client();
const fetch2 = (u) => fetch(u).catch((e) => (e.message === 'fetch failed' ? fetch(u) : Promise.reject(e)));
const cfRecords = async () => (await (await fetch2(`${CF}/__state`)).json()).records;
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const on = (cmd) => sh(`docker exec vps-ci sh -c ${JSON.stringify(cmd)}`);
const onOk = (cmd) => {
  try {
    on(cmd);
    return true;
  } catch {
    return false;
  }
};
/** Run a multi-line script inside vps-ci (passed on stdin, so quotes and newlines stay intact). */
const onScript = (script) => execSync('docker exec -i vps-ci sh -s', { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const web = (host) => on(`curl -s -m 10 -H 'Host: ${host}' http://127.0.0.1/ || true`);
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
async function waitJob(job, expect = 'success', minutes = 10) {
  for (let i = 0; i < minutes * 60; i++) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-30).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error})` : ''}`);
      return j;
    }
    await sleep(1000);
  }
  throw new Error('job did not finish in time');
}

let server;
let zone;
let ports;

await step('Prepare vps-ci with a small compose stack', async () => {
  await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
  // Projects that use vps-ci (left by other tests) go first, then the server itself.
  for (const p of await api('GET', '/projects')) if (!p.parent_id && p.deployments?.some((d) => d.server_name === 'vps-ci')) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  for (const s of await api('GET', '/servers')) if (s.name === 'vps-ci') await api('DELETE', `/servers/${s.id}`);
  const { users } = await api('GET', '/users');
  for (const u of users) if (u.username === 'dev-srv') await api('DELETE', `/users/${u.id}`);
  await api('PUT', '/settings', { cf_token: 'test-token' });
  server = await api('POST', '/servers', { name: 'vps-ci', ip: '172.30.0.25', ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY });
  zone = (await api('GET', '/cloudflare/zones')).find((z) => z.name === 'shop.test');
  onScript(`set -e
mkdir -p /srv/porttest && cd /srv/porttest
docker compose down -v >/dev/null 2>&1 || true
cat > compose.yml <<'YML'
name: porttest
services:
  web:
    image: nginx:1.27-alpine
    ports: ["18500:80"]
  web2:
    image: nginx:1.27-alpine
    ports: ["\${WEB2_PORT}:80"]
YML
printf 'WEB2_PORT=18510\\n' > .env
rm -f compose.yml.switchboard-bak-* .env.switchboard-bak-*
docker compose up -d --quiet-pull >/dev/null 2>&1
`);
  for (const f of ['dom-porttest-shop-test', 'dom-porttest2-shop-test']) on(`rm -f /etc/switchboard/edge/conf.d/sb-${f}.conf /etc/nginx/conf.d/sb-${f}.conf`);
  check(onOk('docker ps --format {{.Names}} | grep -qx porttest-web-1') && onOk('docker ps --format {{.Names}} | grep -qx porttest-web2-1'), 'test stack runs (ports 18500, 18510)');
});

await step('Open ports list', async () => {
  const r = await api('GET', `/servers/${server.id}/ports`);
  check(r.ok, `scan ran${r.error ? `: ${r.error}` : ''}`);
  ports = r.ports;
  const ssh = ports.find((p) => p.port === 22);
  check(ssh?.kind === 'ssh' && ssh.public, 'SSH on 22 found');
  const w = ports.find((p) => p.port === 18500);
  check(w?.container === 'porttest-web-1' && w.compose?.project === 'porttest' && w.target === 80 && w.can_change, `18500 → porttest-web-1 (compose porttest/web, container port 80)`);
});

await step('Connect a domain to a port', async () => {
  const { job } = await api('POST', `/servers/${server.id}/domains`, { sub: 'porttest', zone: { zone_id: zone.id, zone_name: zone.name }, port: 18500 });
  await waitJob(job);
  const rec = (await cfRecords()).find((x) => x.name === 'porttest.shop.test');
  check(rec?.content === '172.30.0.25' && rec.proxied, 'DNS record porttest.shop.test → 172.30.0.25 (proxied)');
  check(/Welcome to nginx/.test(web('porttest.shop.test')), 'porttest.shop.test reaches the container through the web proxy');
  const r = await api('GET', `/servers/${server.id}/ports`);
  check(r.domains.some((d) => d.host === 'porttest.shop.test' && d.port === 18500), 'domain listed for the server');
  check(r.ports.find((p) => p.port === 18500)?.domains.includes('porttest.shop.test'), 'port 18500 shows its domain');
  const bad = await api('POST', `/servers/${server.id}/domains`, { sub: 'bad_name!', zone: { zone_id: zone.id, zone_name: zone.name }, port: 18500 }, { raw: true });
  check(bad.status === 400, 'invalid subdomain refused');
});

await step('Change a port written in the compose file', async () => {
  const { job } = await api('POST', `/servers/${server.id}/ports/change`, { container: 'porttest-web-1', from: 18500, to: 18600 });
  await waitJob(job);
  check(on('grep -c 18600:80 /srv/porttest/compose.yml') === '1' && onOk('ls /srv/porttest/compose.yml.switchboard-bak-*'), 'compose.yml changed, backup kept');
  check(/18600/.test(on('docker port porttest-web-1')), 'container publishes 18600');
  check(/Welcome to nginx/.test(web('porttest.shop.test')), 'domain still works (web proxy moved to the new port)');
  const r = await api('GET', `/servers/${server.id}/ports`);
  check(r.domains.find((d) => d.host === 'porttest.shop.test')?.port === 18600, 'Switchboard updated the domain to port 18600');
  const used = await api('POST', `/servers/${server.id}/ports/change`, { container: 'porttest-web-1', from: 18600, to: 22 }, { raw: true });
  check(used.status === 400, 'a port that is in use / reserved is refused');
});

await step('Change a port that comes from .env', async () => {
  const { job } = await api('POST', `/servers/${server.id}/ports/change`, { container: 'porttest-web2-1', from: 18510, to: 18610 });
  await waitJob(job);
  check(on('cat /srv/porttest/.env') === 'WEB2_PORT=18610', '.env changed (WEB2_PORT=18610)');
  check(/18610/.test(on('docker port porttest-web2-1')), 'container publishes 18610');
});

await step('Change a server user password', async () => {
  on('id labuser >/dev/null 2>&1 || useradd -m -s /bin/bash labuser');
  const users = await api('GET', `/servers/${server.id}/users`);
  check(users.some((u) => u.name === 'labuser') && users.some((u) => u.name === 'root'), 'server users listed');
  const before = on("getent shadow labuser | cut -d: -f2");
  const short = await api('POST', `/servers/${server.id}/password`, { user: 'labuser', password: 'short' }, { raw: true });
  check(short.status === 400, 'too short password refused');
  await api('POST', `/servers/${server.id}/password`, { user: 'labuser', password: 'a-long-new-password-123' });
  const after = on("getent shadow labuser | cut -d: -f2");
  check(after !== before && after.startsWith('$'), 'password hash changed');
  const nouser = await api('POST', `/servers/${server.id}/password`, { user: 'nosuchuser', password: 'a-long-new-password-123' }, { raw: true });
  check(nouser.status >= 400, 'unknown user refused');
  const ev = await api('GET', '/events?limit=10');
  check(!JSON.stringify(ev).includes('a-long-new-password-123'), 'the password is not in the activity log');
});

await step('Restart the server (simulated) and wait for it to come back', async () => {
  // Stand-in systemctl: SSH refuses new connections for 20 seconds, like a machine that is rebooting.
  on(`printf '#!/bin/sh\\niptables -I INPUT -p tcp --dport 22 -j REJECT; sleep 20; iptables -D INPUT -p tcp --dport 22 -j REJECT\\n' > /usr/local/sbin/systemctl && chmod +x /usr/local/sbin/systemctl`);
  const noConfirm = await api('POST', `/servers/${server.id}/power`, { action: 'reboot' }, { raw: true });
  check(noConfirm.status === 400, 'restart without typing the server name is refused');
  const dev = client();
  await api('POST', '/users', { username: 'dev-srv', password: 'dev-password-123', role: 'developer' });
  await dev('POST', '/auth/login', { username: 'dev-srv', password: 'dev-password-123' });
  check((await dev('POST', `/servers/${server.id}/power`, { action: 'reboot', confirm: 'vps-ci' }, { raw: true })).status === 403, 'a developer cannot restart servers');
  const { job } = await api('POST', `/servers/${server.id}/power`, { action: 'reboot', confirm: 'vps-ci' });
  const j = await waitJob(job, 'success', 5);
  check(/is down/.test(j.log) && /is back after/.test(j.log), 'job saw the server go down and come back');
  on('rm -f /usr/local/sbin/systemctl');
});

await step('Disconnect the domain', async () => {
  const r = await api('GET', `/servers/${server.id}/ports`);
  const d = r.domains.find((x) => x.host === 'porttest.shop.test');
  const { job } = await api('DELETE', `/domains/${d.id}`, { deleteDns: true });
  await waitJob(job);
  check(!(await cfRecords()).some((x) => x.name === 'porttest.shop.test'), 'DNS record deleted');
  check(!/Welcome to nginx/.test(web('porttest.shop.test')), 'web proxy site removed');
  on('cd /srv/porttest && docker compose down -v >/dev/null 2>&1; rm -rf /srv/porttest');
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);

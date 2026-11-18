/**
 * PROTECT SSH — against "someone is guessing passwords":
 *  - fail2ban: an IP that fails to log in a few times is blocked for a while (longer each time).
 *    Switchboard's own IP and the IPs of your servers are never blocked.
 *  - optional: turn OFF password login (keys only). Only when Switchboard itself logs in with a key;
 *    after the change Switchboard opens a NEW connection to make sure it still gets in, and puts the
 *    old setting back if it doesn't.
 * The state is kept in servers.ssh_guard, so the "failed SSH logins" alert gets quieter.
 */
import net from 'node:net';
import { all, update, now } from '../db.js';
import { bus } from '../bus.js';
import { logEvent } from '../events.js';
import { defineJob } from '../jobs.js';
import { getServer, parseJSON } from '../models.js';
import { connect, exec } from '../ssh.js';
import { connectTo, runRemote, asRoot, shq } from './remote.js';

const GUARD_CONF = '/etc/ssh/sshd_config.d/00-switchboard-guard.conf';
const JAIL = '/etc/fail2ban/jail.d/switchboard-ssh.local';

export const guardOf = (server) => (server?.ssh_guard && typeof server.ssh_guard === 'object' ? server.ssh_guard : parseJSON(server?.ssh_guard, null));

const isIp = (ip) => {
  const [a, bits] = String(ip || '').split('/');
  if (!net.isIP(a)) return false;
  if (bits === undefined) return true;
  const max = net.isIPv4(a) ? 32 : 128;
  return /^\d+$/.test(bits) && Number(bits) >= 8 && Number(bits) <= max;
};

export function guardOptions(b = {}) {
  const ignore = (Array.isArray(b.ignore) ? b.ignore : String(b.ignore || '').split(/[\s,]+/))
    .map((x) => String(x).trim())
    .filter(Boolean);
  for (const ip of ignore) if (!isIp(ip)) throw new Error(`"${ip}" is not an IP address (like 203.0.113.5 or 203.0.113.0/24)`);
  const num = (v, def, min, max) => Math.min(max, Math.max(min, Math.round(Number(v)) || def));
  return {
    remove: b.remove === true,
    fail2ban: b.fail2ban !== false,
    maxretry: num(b.maxretry, 5, 2, 20),
    bantime: num(b.bantime, 60, 5, 7 * 24 * 60), // minutes
    passwords_off: b.passwords_off === true,
    ignore: [...new Set(ignore)].slice(0, 50),
  };
}

/** Public IPs of every server in Switchboard: never blocked (they talk to each other). */
export function serverIps() {
  const ips = new Set();
  for (const s of all('SELECT ip, private_ip FROM servers')) {
    if (s.ip) ips.add(s.ip);
    if (s.private_ip) ips.add(s.private_ip);
  }
  return [...ips];
}

/** The IP this server sees Switchboard coming from (SSH_CLIENT of our own connection). */
async function switchboardIp(conn) {
  const r = await exec(conn, 'echo "${SSH_CLIENT%% *}"', { timeout: 15000 }).catch(() => null);
  const ip = r?.stdout.trim();
  return ip && net.isIP(ip) ? ip : null;
}

const SCAN = `
echo @@os; (. /etc/os-release 2>/dev/null; echo "\${PRETTY_NAME:-Linux}")
echo @@sshd; sshd -T 2>/dev/null | grep -iE '^(port|passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication) '
echo @@f2b; if command -v fail2ban-client >/dev/null 2>&1; then echo installed; fail2ban-client status sshd 2>/dev/null || echo not-running; fi
echo @@guard; [ -f ${GUARD_CONF} ] && echo passwords; [ -f ${JAIL} ] && echo jail; true
echo @@fails
if [ -f /var/log/auth.log ]; then tail -n 20000 /var/log/auth.log; elif command -v journalctl >/dev/null 2>&1; then journalctl -u ssh -u sshd --since -24h -o cat --no-pager 2>/dev/null | tail -n 20000; fi | grep -E 'Failed password|Invalid user|authentication failure' | grep -oE 'from [0-9a-fA-F.:]+' | sort | uniq -c | sort -rn | head -n 500
echo @@keys; for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do [ -f "$f" ] && echo "$f $(grep -cE '^(ssh-|ecdsa-|sk-)' "$f" 2>/dev/null)"; done; true
echo @@end`;

function sections(out) {
  const s = {};
  let cur = null;
  for (const line of out.split('\n')) {
    const m = line.match(/^@@(\w+)$/);
    if (m) cur = m[1];
    else if (cur) (s[cur] ||= []).push(line);
  }
  return s;
}

export function parseScan(out) {
  const s = sections(out);
  const sshd = {};
  for (const l of s.sshd || []) {
    const [k, v] = l.trim().split(/\s+/);
    if (k) sshd[k.toLowerCase()] = v;
  }
  const f2b = s.f2b || [];
  const banned = (f2b.find((l) => /Banned IP list:/.test(l)) || '').replace(/.*Banned IP list:\s*/, '').split(/\s+/).filter(Boolean);
  const totalBanned = Number((f2b.find((l) => /Total banned:/.test(l)) || '').replace(/\D+/g, '')) || 0;
  let failCount = 0;
  const top = [];
  for (const l of s.fails || []) {
    const m = l.trim().match(/^(\d+)\s+from\s+(\S+)$/);
    if (!m) continue;
    failCount += Number(m[1]);
    if (top.length < 8) top.push({ ip: m[2], n: Number(m[1]) });
  }
  return {
    os: (s.os || [])[0] || '',
    sshd: {
      port: Number(sshd.port) || 22,
      password: sshd.passwordauthentication ? sshd.passwordauthentication === 'yes' : null,
      kbd: sshd.kbdinteractiveauthentication === 'yes',
      root: sshd.permitrootlogin || null,
    },
    fail2ban: {
      installed: f2b.includes('installed'),
      running: f2b.some((l) => /Status for the jail: sshd/.test(l)),
      banned,
      currently: banned.length,
      total: totalBanned,
    },
    guard: { passwords: (s.guard || []).includes('passwords'), jail: (s.guard || []).includes('jail') },
    fails: { count: failCount, ips: (s.fails || []).filter((l) => /from/.test(l)).length, top },
    keys: (s.keys || []).filter(Boolean).map((l) => ({ file: l.split(' ')[0], n: Number(l.split(' ')[1]) || 0 })),
  };
}

export async function previewGuard(server) {
  const conn = await connectTo(null, server);
  try {
    const me = await switchboardIp(conn);
    const r = await exec(conn, asRoot(server, SCAN), { timeout: 60000 });
    if (r.code !== 0 && !r.stdout.includes('@@end')) throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || 'scan failed');
    const scan = parseScan(r.stdout);
    return {
      ...scan,
      switchboard_ip: me,
      switchboard_auth: server.auth_type,
      can_disable_passwords: server.auth_type !== 'password',
      ignore_suggest: [...new Set([me, ...serverIps()].filter(Boolean))],
      state: guardOf(server),
    };
  } finally {
    conn.end();
  }
}

function jailFile(o, port, backend) {
  return `# Managed by Switchboard (Protect SSH). Remove it with "Protect SSH → Remove protection".
[sshd]
enabled = true
port = ${port}
maxretry = ${o.maxretry}
findtime = 10m
bantime = ${o.bantime}m
bantime.increment = true
bantime.maxtime = 1w
ignoreip = 127.0.0.1/8 ::1 ${o.ignore.join(' ')}
${backend === 'systemd' ? 'backend = systemd' : 'backend = auto\nlogpath = /var/log/auth.log'}
`;
}

// systemd: reload the service. Otherwise (containers, old init): HUP the listening sshd.
const RELOAD_SSHD = `if [ -d /run/systemd/system ]; then systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || systemctl restart ssh 2>/dev/null || systemctl restart sshd; else P="$(cat /run/sshd.pid 2>/dev/null)"; [ -n "$P" ] || P="$(pgrep -o -x sshd)"; [ -n "$P" ] && kill -HUP "$P"; fi`;

/** Which login methods the RUNNING sshd offers (asks it on localhost), e.g. "publickey" or "publickey,password". */
const methodsCheck = (port) =>
  `command -v ssh >/dev/null 2>&1 && ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o LogLevel=ERROR -p ${port} sb-guard-check@127.0.0.1 true 2>&1 | grep -o 'Permission denied ([^)]*)' | head -1 | sed 's/Permission denied (//; s/)//'; true`;
const START_F2B = `if [ -d /run/systemd/system ]; then systemctl enable fail2ban >/dev/null 2>&1; systemctl restart fail2ban; else service fail2ban restart >/dev/null 2>&1 || fail2ban-client -x start >/dev/null; fi
for i in 1 2 3 4 5 6 7 8 9 10; do fail2ban-client ping >/dev/null 2>&1 && break; sleep 1; done
fail2ban-client status sshd`;

async function root(ctx, conn, server, script, opts = {}) {
  return runRemote(ctx, conn, asRoot(server, script), { timeout: 10 * 60000, ...opts });
}

function saveGuard(serverId, patch) {
  const s = getServer(serverId);
  const g = { ...(guardOf(s) || {}), ...patch, at: now() };
  update('servers', serverId, { ssh_guard: JSON.stringify(g) });
  return g;
}

defineJob('ssh-guard', async (ctx, p) => {
  const server = getServer(Number(p.server));
  if (!server) throw new Error('Server not found');
  const o = guardOptions(p);
  let conn = await connectTo(ctx, server);
  try {
    const me = await switchboardIp(conn);
    if (me) ctx.log(`Switchboard reaches ${server.name} from ${me} — that IP is never blocked`);
    const scan = parseScan((await root(ctx, conn, server, SCAN, { quiet: true, timeout: 60000 })).stdout);
    const port = scan.sshd.port;

    if (o.remove) {
      ctx.step('Remove the protection');
      if (scan.guard.passwords) {
        await root(ctx, conn, server, `rm -f ${GUARD_CONF}; sshd -t && (${RELOAD_SSHD})`);
        ctx.log('Password login: back to the server\'s own setting');
      }
      if (scan.guard.jail) {
        await root(ctx, conn, server, `rm -f ${JAIL}; fail2ban-client reload >/dev/null 2>&1 || true`);
        ctx.log('fail2ban: Switchboard\'s SSH jail removed (fail2ban itself stays installed)');
      }
      update('servers', server.id, { ssh_guard: null });
      logEvent('warn', `SSH protection removed from ${server.name}`, { serverId: server.id, jobId: ctx.id, user: ctx.user });
      return;
    }

    if (o.fail2ban) {
      ctx.step('fail2ban: block IPs that keep guessing passwords');
      const ignore = [...new Set([me, ...serverIps(), ...o.ignore].filter(Boolean))];
      const r = await root(
        ctx,
        conn,
        server,
        `set -e
if ! command -v fail2ban-client >/dev/null 2>&1; then
  echo "Installing fail2ban…"
  if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null; DEBIAN_FRONTEND=noninteractive apt-get install -y -q fail2ban >/dev/null
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q epel-release >/dev/null 2>&1 || true; dnf install -y -q fail2ban >/dev/null
  elif command -v apk >/dev/null 2>&1; then apk add -q fail2ban >/dev/null
  else echo "Can't install fail2ban on this system — install it by hand" >&2; exit 3; fi
fi
if [ -f /var/log/auth.log ]; then echo "backend=auto"
else
  if command -v apt-get >/dev/null 2>&1 && ! python3 -c 'import systemd.journal' 2>/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-systemd >/dev/null 2>&1 || true; fi
  echo "backend=systemd"
fi`,
        { timeout: 10 * 60000 },
      );
      const backend = /backend=systemd/.test(r.stdout) ? 'systemd' : 'auto';
      await root(ctx, conn, server, `mkdir -p /etc/fail2ban/jail.d && cat > ${JAIL}`, { stdin: jailFile({ ...o, ignore }, port, backend), quiet: true });
      const st = await root(ctx, conn, server, START_F2B, { quiet: true, timeout: 120000, okCodes: [0, 1, 255] });
      if (!/Status for the jail: sshd/.test(st.stdout)) throw new Error(`fail2ban did not start: ${(st.stderr || st.stdout).trim().split('\n').slice(-3).join(' ')}`);
      ctx.log(`fail2ban is on: ${o.maxretry} wrong tries in 10 minutes → blocked ${o.bantime} min (longer each time it happens again)`);
      ctx.log(`Never blocked: ${['127.0.0.1', ...ignore].join(', ')}`);
      saveGuard(server.id, { fail2ban: true, maxretry: o.maxretry, bantime: o.bantime });
    }

    if (o.passwords_off) {
      ctx.step('Turn off password login (SSH keys only)');
      if (server.auth_type === 'password') throw new Error('Switchboard itself logs in to this server with a password — switch it to an SSH key first (Edit server), or it would lock itself out');
      if (!scan.keys.some((k) => k.n > 0)) throw new Error('No SSH keys found in authorized_keys on this server — add your key first');
      await root(
        ctx,
        conn,
        server,
        `set -e
mkdir -p /etc/ssh/sshd_config.d
grep -qiE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config.d/' /etc/ssh/sshd_config || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
cat > ${GUARD_CONF}
if ! sshd -t; then rm -f ${GUARD_CONF}; echo "The new SSH setting was refused by sshd — nothing changed" >&2; exit 3; fi
${RELOAD_SSHD}
sleep 2
sshd -T | grep -iE '^passwordauthentication '`,
        { stdin: '# Managed by Switchboard (Protect SSH): log in with SSH keys only.\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n', quiet: true },
      );
      const methods = (await root(ctx, conn, server, methodsCheck(port), { quiet: true, timeout: 30000 })).stdout.trim();
      if (methods) ctx.log(`The SSH server now accepts: ${methods}`);
      if (/password|keyboard-interactive/.test(methods)) {
        throw new Error(`The setting is saved, but the running SSH server still accepts passwords (${methods}) — restart SSH on the server (sudo systemctl restart ssh) or reboot it, then open Protect SSH again`);
      }
      // The real test: can Switchboard still get in, on a brand-new connection?
      ctx.log('Checking that Switchboard can still log in (new connection)…');
      let ok = false;
      try {
        const c2 = await connect(server, { timeout: 20000 });
        c2.end();
        ok = true;
      } catch (e) {
        ctx.warn(`New login failed: ${e.message} — putting the old setting back`);
      }
      if (!ok) {
        await root(ctx, conn, server, `rm -f ${GUARD_CONF}; ${RELOAD_SSHD}`, { signal: null });
        throw new Error('Password login was NOT turned off: Switchboard could not log in afterwards (the old setting is back)');
      }
      ctx.log('Password login is OFF — only SSH keys work now. Password guessing can no longer get in.');
      saveGuard(server.id, { passwords_off: true });
    }
    bus.emit('state', { serverId: server.id });
    logEvent('success', `SSH of ${server.name} protected: ${[o.fail2ban && 'fail2ban', o.passwords_off && 'password login off'].filter(Boolean).join(', ')}`, { serverId: server.id, jobId: ctx.id, user: ctx.user });
  } finally {
    conn?.end();
  }
});

/** Unblock one IP (e.g. your own, after typing a wrong password too often). */
export async function unbanIp(server, ip) {
  if (!isIp(ip)) throw new Error('Not an IP address');
  const conn = await connectTo(null, server);
  try {
    const r = await exec(conn, asRoot(server, `fail2ban-client set sshd unbanip ${shq(ip)}`), { timeout: 30000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'unban failed');
  } finally {
    conn.end();
  }
}

import { all, get, insert, run, update, now } from '../db.js';
import { bus } from '../bus.js';
import { alert, logEvent } from '../events.js';
import { defineJob } from '../jobs.js';
import { getServer, getProject, parseJSON } from '../models.js';
import { config } from '../config.js';
import * as cf from '../cloudflare.js';
import { connect, exec } from '../ssh.js';
import { encrypt } from '../crypto.js';
import { isPrivateAddress, sleep } from '../util.js';
import { connectTo, runRemote, asRoot, shq } from './remote.js';
import { parseNginx } from './hostapps.js';
import { installHelper, helper } from './stack.js';
import { collectMetrics } from '../monitor.js';

/**
 * Server control: power (restart / force restart / turn off), passwords, open ports,
 * changing a container's published port, and connecting a domain to a port.
 */

/* ------------------------------------------------------------------ what depends on this server */
export function serverRoles(serverId) {
  const roles = [];
  for (const p of all('SELECT p.id, p.name FROM projects p JOIN deployments d ON d.id = p.active_deployment_id WHERE d.server_id = ?', serverId)) roles.push(`live server of ${p.name}`);
  for (const p of all('SELECT name FROM projects WHERE lb_server_id = ?', serverId)) roles.push(`load balancer of ${p.name}`);
  if (get('SELECT 1 AS x FROM db_servers WHERE server_id = ?', serverId)) roles.push('shared database server');
  return roles;
}

/* ------------------------------------------------------------------ power */
export const POWER = {
  reboot: { label: 'Restart', cmd: 'systemctl reboot || reboot', back: true },
  'force-reboot': { label: 'Force restart', cmd: 'sync; systemctl reboot --force --force || reboot -f', back: true },
  shutdown: { label: 'Turn off', cmd: 'systemctl poweroff || poweroff || shutdown -h now', back: false },
};

async function sshUp(server) {
  try {
    const c = await connect(server, { timeout: 8000 });
    c.end();
    return true;
  } catch {
    return false;
  }
}

defineJob('power', async (ctx, p) => {
  const server = getServer(Number(p.server));
  const act = POWER[p.action];
  if (!server || !act) throw new Error('Unknown server or action');
  const roles = serverRoles(server.id);
  if (roles.length) ctx.warn(`${server.name} is the ${roles.join(', ')} — confirmed by ${ctx.user}`);
  ctx.step(`${act.label} ${server.name}`);
  const conn = await connectTo(ctx, server);
  try {
    // Detached with a short delay, so the SSH command returns before the machine goes away.
    await runRemote(ctx, conn, asRoot(server, `nohup setsid sh -c ${shq(`sleep 2; ${act.cmd}`)} >/dev/null 2>&1 < /dev/null & echo 'Sent.'`), { timeout: 30000 });
  } finally {
    conn.end();
  }
  logEvent('warn', `${server.name}: ${act.label.toLowerCase()} requested`, { serverId: server.id, jobId: ctx.id, user: ctx.user });

  ctx.step(`Wait for ${server.name} to go down`);
  let down = false;
  for (let i = 0; i < 36 && !down; i++) {
    await sleep(5000);
    if (ctx.signal.aborted) throw new Error('Cancelled');
    down = !(await sshUp(server));
  }
  if (!down) throw new Error(`${server.name} still answers after 3 minutes — the ${act.label.toLowerCase()} did not happen (check the server's sudo rights / systemd)`);
  ctx.log(`${server.name} is down`);
  if (!act.back) {
    update('servers', server.id, { status: 'down', status_error: 'Turned off from Switchboard', checked_at: now() });
    bus.emit('state', {});
    alert('warn', `${server.name} was turned off by ${ctx.user}. Turn it on again in your VPS provider's panel (or with the power button).`, { serverId: server.id, link: `#/servers/${server.id}` });
    return;
  }
  ctx.step(`Wait for ${server.name} to come back (up to 10 minutes)`);
  const start = Date.now();
  let up = false;
  while (!up && Date.now() - start < 10 * 60000) {
    await sleep(5000);
    if (ctx.signal.aborted) throw new Error('Cancelled');
    up = await sshUp(server);
  }
  if (!up) {
    alert('error', `${server.name} did not come back within 10 minutes after the ${act.label.toLowerCase()} — check it in your provider's panel`, { serverId: server.id, link: `#/servers/${server.id}` });
    throw new Error(`${server.name} did not come back within 10 minutes`);
  }
  ctx.log(`${server.name} is back after ${Math.round((Date.now() - start) / 1000)}s`);
  await sleep(5000);
  await collectMetrics(getServer(server.id)).catch(() => {});
  const m = parseJSON(getServer(server.id).metrics);
  if (m?.containers) {
    const stopped = m.containers.filter((c) => c.state !== 'running');
    ctx.log(`Containers: ${m.containers.length - stopped.length} of ${m.containers.length} running`);
    if (stopped.length) ctx.warn(`Not running after the restart (no "restart: unless-stopped"?): ${stopped.map((c) => c.name).join(', ')}`);
  }
  logEvent('success', `${server.name} is back up after a ${act.label.toLowerCase()}`, { serverId: server.id, jobId: ctx.id, user: ctx.user });
  bus.emit('state', {});
});

/* ------------------------------------------------------------------ users / password */
export const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export async function listUsers(server) {
  const conn = await connect(server, { timeout: 15000 });
  try {
    const r = await exec(conn, `getent passwd | awk -F: '($3 == 0 || ($3 >= 1000 && $3 < 60000)) && $7 !~ /(nologin|false)$/ {print $1"\\t"$3"\\t"$6"\\t"$7}'`, { timeout: 20000 });
    return r.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, uid, home, shell] = l.split('\t');
        return { name, uid: Number(uid), home, shell };
      });
  } finally {
    conn.end();
  }
}

/** Set a server user's login password. The password goes over stdin, never on a command line or in a log. */
export async function changePassword(server, user, password) {
  const conn = await connect(server, { timeout: 15000 });
  try {
    const r = await exec(conn, asRoot(server, `id -u ${shq(user)} >/dev/null 2>&1 || { echo "No user ${user} on this server" >&2; exit 3; }; chpasswd`), {
      stdin: `${user}:${password}\n`,
      timeout: 20000,
    });
    if (r.code !== 0) throw new Error(r.stderr.replace(/\x1eSBPGID \d+\n?/, '').trim().split('\n').pop() || `chpasswd failed (exit ${r.code})`);
  } finally {
    conn.end();
  }
  // Switchboard logs in with this password? Keep its copy in sync.
  if (server.auth_type === 'password' && (server.ssh_user || 'root') === user) update('servers', server.id, { ssh_password: encrypt(password) });
}

/* ------------------------------------------------------------------ ports */
const PORTS_SCRIPT = `
echo @@ss; ss -ltnup 2>/dev/null | tail -n +2
echo @@docker; docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Image}}' 2>/dev/null
echo @@nginx; command -v nginx >/dev/null 2>&1 && nginx -T 2>/dev/null
echo @@edge; cat /etc/switchboard/edge/mode 2>/dev/null; [ -d /etc/switchboard/edge/conf.d ] && cat /etc/switchboard/edge/conf.d/*.conf 2>/dev/null
echo @@end`;

function sections(out) {
  const s = {};
  let cur = null;
  for (const line of out.split('\n')) {
    const m = line.match(/^@@(\w+)$/);
    if (m) {
      cur = m[1];
      s[cur] = [];
    } else if (cur) s[cur].push(line);
  }
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.join('\n')]));
}

/** Parse "0.0.0.0:8081->80/tcp, [::]:8081->80/tcp" into [{ host, port, target, proto }]. */
export function parseDockerPorts(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const m = part.trim().match(/^(?:(\[?[0-9a-f.:]*\]?):)?(\d+)(?:-(\d+))?->(\d+)(?:-\d+)?\/(tcp|udp)$/i);
    if (!m) continue;
    const host = (m[1] || '0.0.0.0').replace(/^\[|\]$/g, '');
    if (!out.some((x) => x.port === Number(m[2]) && x.proto === m[5])) out.push({ host, port: Number(m[2]), target: Number(m[4]), proto: m[5].toLowerCase() });
  }
  return out;
}

/** Everything that listens on the server, with the container / project / domains behind each port. */
export async function scanPorts(server) {
  const conn = await connect(server, { timeout: 15000 });
  let s;
  try {
    const r = await exec(conn, asRoot(server, PORTS_SCRIPT), { timeout: 45000 });
    s = sections(r.stdout);
  } finally {
    conn.end();
  }
  const containers = (s.docker || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, ports, project, service, dir, image] = l.split('\t');
      return { name, ports: parseDockerPorts(ports), project, service, dir, image };
    });
  const sites = [...parseNginx(s.nginx), ...parseNginx(s.edge)];
  const domainsFor = (port) =>
    [...new Set(sites.filter((x) => x.proxies.some((pp) => new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|0\\.0\\.0\\.0|\\[::1\\]):${port}(/|$)`).test(pp))).flatMap((x) => x.names))];
  const deps = all('SELECT d.*, p.name AS project_name FROM deployments d JOIN projects p ON p.id = d.project_id WHERE d.server_id = ?', server.id);
  const ports = new Map();
  for (const line of (s.ss || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    const proto = f[0];
    const local = f[4];
    const m = local.match(/^(.*):(\d+)$/);
    if (!m) continue;
    const port = Number(m[2]);
    const addr = m[1].replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const key = `${proto}:${port}`;
    const proc = (line.match(/users:\(\("([^"]+)",pid=(\d+)/) || []).slice(1);
    const row = ports.get(key) || { proto, port, addresses: [], process: proc[0] || '', pid: Number(proc[1]) || null };
    if (!row.addresses.includes(addr)) row.addresses.push(addr);
    ports.set(key, row);
  }
  const rows = [...ports.values()].map((r) => {
    const c = containers.find((x) => x.ports.some((pp) => pp.port === r.port && pp.proto === r.proto));
    const mapping = c?.ports.find((pp) => pp.port === r.port && pp.proto === r.proto);
    const dep = deps.find((d) => d.app_port === r.port || (c && (d.app_container === c.name || d.db_container === c.name)));
    const local = r.addresses.every((a) => a === '127.0.0.1' || a === '::1' || a.startsWith('127.'));
    return {
      ...r,
      public: !local,
      container: c?.name || null,
      image: c?.image || null,
      compose: c?.project ? { project: c.project, service: c.service, dir: c.dir } : null,
      target: mapping?.target || null,
      domains: domainsFor(r.port),
      project: dep ? { id: dep.project_id, name: dep.project_name } : null,
      kind: r.port === 22 || r.process === 'sshd' ? 'ssh' : [80, 443].includes(r.port) && /nginx|caddy|apache|httpd/.test(r.process) ? 'web' : c ? 'container' : 'process',
      can_change: !!(c?.project && c.dir && r.proto === 'tcp'),
    };
  });
  rows.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
  return { ports: rows, sites: sites.map((x) => ({ names: x.names, proxies: x.proxies, listen: x.listen })), edge: (s.edge || '').split('\n')[0] || null };
}

/* ------------------------------------------------------------------ change a container's published port */
export function portChangeScript({ container, from, to, project, service, dir }) {
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `set -e
C=${shq(container)}; FROM=${from}; TO=${to}; DIR=${shq(dir)}; P=${shq(project)}; SVC=${shq(service)}; TS=${ts}
if ss -ltn "sport = :$TO" | tail -n +2 | grep -q .; then echo "Port $TO is already used on this server" >&2; exit 3; fi
FILES=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$C" | tr ',' ' ')
[ -n "$FILES" ] || { echo "$C was not started with Docker Compose — change its port by hand" >&2; exit 3; }
changed=''
# 1) The port is written in a compose file ("8081:80", "0.0.0.0:8081:80" or "published: 8081").
for f in $FILES; do
  [ -f "$f" ] || continue
  n=$(grep -cE "(^|[^0-9])$FROM:[0-9]+|published:[[:space:]]*\\"?$FROM\\"?([^0-9]|$)" "$f" || true)
  [ "$n" = 0 ] && continue
  [ "$n" = 1 ] || { echo "Port $FROM appears $n times in $f — change it by hand to be safe" >&2; exit 3; }
  cp -p "$f" "$f.switchboard-bak-$TS"
  FROM=$FROM TO=$TO perl -pi -e 's/(^|[^0-9])$ENV{FROM}:([0-9]+)/$1$ENV{TO}:$2/; s/(published:[ \\t]*"?)$ENV{FROM}("?)(?![0-9])/$1$ENV{TO}$2/' "$f"
  echo ">>> $f: $FROM → $TO (backup: $f.switchboard-bak-$TS)"
  changed="$f"; break
done
# 2) Or it comes from a variable in .env (e.g. "\${APP_PORT}:80" with APP_PORT=8081).
if [ -z "$changed" ] && [ -f "$DIR/.env" ]; then
  for f in $FILES; do
    for v in $(grep -oE '\\$\\{?[A-Za-z_][A-Za-z0-9_]*' "$f" 2>/dev/null | tr -d '\${' | sort -u); do
      if grep -qE "^$v=\\"?$FROM\\"?\\s*$" "$DIR/.env"; then
        cp -p "$DIR/.env" "$DIR/.env.switchboard-bak-$TS"
        sed -i -E "s/^$v=\\"?$FROM\\"?\\s*$/$v=$TO/" "$DIR/.env"
        echo ">>> $DIR/.env: $v=$FROM → $TO (backup: .env.switchboard-bak-$TS)"
        changed="$DIR/.env"
        [ -f "/etc/switchboard/ports/$P" ] && grep -qx "$FROM" "/etc/switchboard/ports/$P" && echo "$TO" > "/etc/switchboard/ports/$P"
        break 2
      fi
    done
  done
fi
[ -n "$changed" ] || { echo "Could not find port $FROM in the compose files ($FILES) or .env — change it by hand" >&2; exit 3; }
args=''; for f in $FILES; do args="$args -f $f"; done
echo ">>> Recreate $SVC with the new port"
if ! (cd "$DIR" && docker compose -p "$P" $args up -d --no-deps "$SVC"); then
  echo ">>> Failed — putting the old file back" >&2
  mv "$changed.switchboard-bak-$TS" "$changed"
  (cd "$DIR" && docker compose -p "$P" $args up -d --no-deps "$SVC") || true
  exit 4
fi
docker port "$C" | grep -qE ":$TO$" || { echo "The container does not show port $TO after the change" >&2; exit 4; }
echo ">>> $C now publishes $TO"
# 3) Web proxy sites that pointed at the old port.
NG=$(grep -rlE "(127\\.0\\.0\\.1|localhost):$FROM([^0-9]|$)" /etc/nginx /etc/switchboard/edge/conf.d 2>/dev/null || true)
if [ -n "$NG" ]; then
  for f in $NG; do cp -p "$f" "/tmp/$(basename "$f").switchboard-bak-$TS"; FROM=$FROM TO=$TO perl -pi -e 's/(127\\.0\\.0\\.1|localhost):$ENV{FROM}(?![0-9])/$1:$ENV{TO}/g' "$f"; echo ">>> $f: proxy → :$TO"; done
  ok=1
  if [ "$(cat /etc/switchboard/edge/mode 2>/dev/null)" = container ] && docker ps --format '{{.Names}}' | grep -qx switchboard-edge; then docker exec switchboard-edge nginx -t -q && docker exec switchboard-edge nginx -s reload || ok=0; fi
  if command -v nginx >/dev/null 2>&1 && echo "$NG" | grep -q '^/etc/nginx'; then nginx -t -q && (systemctl reload nginx 2>/dev/null || nginx -s reload) || ok=0; fi
  if [ "$ok" = 0 ]; then
    for f in $NG; do cp -p "/tmp/$(basename "$f").switchboard-bak-$TS" "$f"; done
    echo "nginx rejected the change — old proxy config restored. Point it to port $TO by hand." >&2; exit 5
  fi
  echo ">>> nginx reloaded"
else
  echo ">>> No web proxy site used port $FROM"
fi`;
}

defineJob('port-change', async (ctx, p) => {
  const server = getServer(Number(p.server));
  const from = Number(p.from);
  const to = Number(p.to);
  ctx.step(`Change ${p.container} on ${server.name}: port ${from} → ${to}`);
  const conn = await connectTo(ctx, server);
  try {
    await runRemote(ctx, conn, asRoot(server, portChangeScript({ container: p.container, from, to, project: p.project, service: p.service, dir: p.dir })), { timeout: 15 * 60000 });
  } finally {
    conn.end();
  }
  // Switchboard's own records of that port.
  for (const d of all('SELECT id FROM deployments WHERE server_id = ? AND app_port = ?', server.id, from)) update('deployments', d.id, { app_port: to });
  run('UPDATE domains SET port = ? WHERE server_id = ? AND port = ?', to, server.id, from);
  const affected = all('SELECT p.name FROM projects p JOIN deployments d ON d.project_id = p.id WHERE d.server_id = ? AND p.health_port = ?', server.id, from);
  if (affected.length) ctx.warn(`Health checks of ${affected.map((x) => x.name).join(', ')} use port ${from} — update it in the project settings`);
  logEvent('info', `${server.name}: ${p.container} moved from port ${from} to ${to}`, { serverId: server.id, jobId: ctx.id, user: ctx.user });
  bus.emit('state', {});
});

/* ------------------------------------------------------------------ connect a domain to a port */
export const siteName = (host) => `dom-${host.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 120);

defineJob('domain-connect', async (ctx, p) => {
  const server = getServer(Number(p.server));
  const { host, port, zone } = p;
  if (!config.allowPrivateDns && isPrivateAddress(server.ip)) {
    throw new Error(`${server.name} has the private IP ${server.ip} — visitors can't reach it. Set its public IP first (Servers → Edit; keep the private one as SSH host) and forward ports 80/443 to it.`);
  }
  const conn = await connectTo(ctx, server);
  let recordId = null;
  let created = false;
  try {
    ctx.step(`Check port ${port} and existing sites on ${server.name}`);
    const r = await runRemote(ctx, conn, asRoot(server, `ss -ltn "sport = :${port}" | tail -n +2 | grep -q . && echo listening || echo nothing; command -v nginx >/dev/null 2>&1 && nginx -T 2>/dev/null; cat /etc/switchboard/edge/conf.d/*.conf 2>/dev/null; true`), { quiet: true });
    const [first, ...rest] = r.stdout.split('\n');
    if (first.trim() !== 'listening') ctx.warn(`Nothing listens on port ${port} yet — the site will show "502 Bad Gateway" until it does`);
    const taken = parseNginx(rest.join('\n')).find((x) => x.names.includes(host) && !x.proxies.some((pp) => pp.endsWith(`:${port}`)));
    if (taken) throw new Error(`${host} is already served by another site on ${server.name} (${[...taken.proxies, ...taken.roots].join(', ') || 'nginx'}) — remove that site first`);

    ctx.step('Web proxy');
    await installHelper(ctx, conn, server);
    await helper(ctx, conn, server, ['edge-site', siteName(host), String(port), host]);

    ctx.step(`Cloudflare DNS: ${host}`);
    const existing = (await cf.findRecords(zone.zone_id, host)).filter((x) => x.name === host);
    const a = existing.find((x) => x.type === 'A');
    if (!existing.length) {
      const rec = await cf.createRecord(zone.zone_id, { type: 'A', name: host, content: server.ip, proxied: p.proxied !== false, comment: `Switchboard: ${server.name}:${port}` });
      recordId = rec.id;
      created = true;
      ctx.log(`Created A ${host} → ${server.ip} (${p.proxied !== false ? 'proxied' : 'DNS only'})`);
    } else if (a) {
      recordId = a.id;
      if (a.content === server.ip) ctx.log(`${host} already points to ${server.ip}`);
      else if (p.takeover) {
        await cf.updateRecord(zone.zone_id, a.id, { content: server.ip });
        ctx.log(`${host} pointed from ${a.content} to ${server.ip}`);
      } else ctx.warn(`${host} already exists and points to ${a.content} — NOT changed (tick "point it here" to move it)`);
    } else throw new Error(`${host} exists as a ${existing[0].type} record — remove it in Cloudflare first`);

    ctx.step('Check');
    const t = await runRemote(ctx, conn, asRoot(server, `curl -ks -o /dev/null -m 10 -w '%{http_code}' -H ${shq(`Host: ${host}`)} https://127.0.0.1/ || true`), { quiet: true });
    ctx.log(`https://${host} on the server answers HTTP ${t.stdout.trim() || '—'}${p.proxied !== false ? ' (Cloudflare SSL mode must be "Full")' : ''}`);
  } finally {
    conn.end();
  }
  const row = { server_id: server.id, host, port, zone_id: zone.zone_id, zone_name: zone.zone_name, record_id: recordId, record_created: created ? 1 : 0, project_id: p.project || null, created_at: now() };
  const ex = get('SELECT id FROM domains WHERE host = ?', host);
  if (ex) update('domains', ex.id, row);
  else insert('domains', row);
  if (p.project && recordId) {
    const proj = getProject(Number(p.project));
    const recs = parseJSON(proj.dns_records, []);
    if (!recs.some((x) => x.id === recordId)) {
      recs.push({ zone_id: zone.zone_id, zone_name: zone.zone_name, id: recordId, name: host, type: 'A' });
      update('projects', proj.id, { dns_records: JSON.stringify(recs) });
      ctx.log(`${host} added to ${proj.name}: it moves along when you switch servers`);
    }
  }
  logEvent('success', `${host} → ${server.name} port ${port}`, { serverId: server.id, jobId: ctx.id, user: ctx.user });
  bus.emit('state', {});
});

defineJob('domain-remove', async (ctx, p) => {
  const d = get('SELECT * FROM domains WHERE id = ?', Number(p.domain));
  if (!d) throw new Error('Domain not found');
  const server = getServer(d.server_id);
  const conn = await connectTo(ctx, server);
  try {
    await installHelper(ctx, conn, server);
    await helper(ctx, conn, server, ['edge-rm', siteName(d.host)]);
  } finally {
    conn.end();
  }
  if (d.record_id && p.deleteDns && d.record_created) {
    await cf.deleteRecord(d.zone_id, d.record_id).catch((e) => ctx.warn(`Cloudflare: ${e.message}`));
    ctx.log(`DNS record ${d.host} deleted`);
  } else if (d.record_id) ctx.log(`DNS record ${d.host} kept in Cloudflare`);
  if (d.project_id) {
    const proj = getProject(d.project_id);
    if (proj) update('projects', proj.id, { dns_records: JSON.stringify(parseJSON(proj.dns_records, []).filter((x) => x.id !== d.record_id)) });
  }
  run('DELETE FROM domains WHERE id = ?', d.id);
  logEvent('info', `${d.host} disconnected from ${server.name}`, { serverId: server.id, jobId: ctx.id, user: ctx.user });
  bus.emit('state', {});
});

/* ------------------------------------------------------------------ folders (where a new app goes) */
/** Clean an absolute folder path: no "..", no doubled or trailing slashes. Returns '' when it is not one. */
export function cleanFolder(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.length > 500 || /[\0\n\r\t]/.test(p)) return '';
  const c = `/${p.split('/').filter(Boolean).join('/')}`;
  if (/(^|\/)\.\.?(\/|$)/.test(c)) return '';
  return c;
}

/**
 * The sub-folders of `dir` on a server (for the folder picker), plus a few handy places to start.
 * Read-only; runs as root so folders like /srv or /root can be listed too.
 */
export async function listFolders(server, dir) {
  const path = cleanFolder(dir || '/srv') || '/srv';
  const conn = await connect(server, { timeout: 15000 });
  try {
    const script = [
      `D=${shq(path)}`,
      'if [ -d "$D" ]; then echo "@exists"; [ -z "$(ls -A "$D" 2>/dev/null)" ] && echo "@empty"; find "$D" -mindepth 1 -maxdepth 1 -type d ! -name ".*" -printf "%f\\n" 2>/dev/null | LC_ALL=C sort | head -n 500; fi',
      `echo "@home $(getent passwd ${shq(server.ssh_user || 'root')} | cut -d: -f6)"`,
      'for p in /srv /opt /var/www /home; do [ -d "$p" ] && echo "@place $p"; done; true',
    ].join('\n');
    const r = await exec(conn, asRoot(server, script), { timeout: 20000 });
    if (r.code) throw new Error(r.stderr.replace(/\x1eSBPGID \d+\n?/, '').trim().split('\n').pop() || `Could not list ${path}`);
    const out = { path, parent: path === '/' ? null : path.replace(/\/[^/]+$/, '') || '/', exists: false, empty: false, dirs: [], places: [] };
    for (const l of r.stdout.split('\n').filter(Boolean)) {
      if (l === '@exists') out.exists = true;
      else if (l === '@empty') out.empty = true;
      else if (l.startsWith('@home ')) {
        const h = l.slice(6).trim();
        if (h && h !== '/') out.places.unshift(h);
      } else if (l.startsWith('@place ')) out.places.push(l.slice(7));
      else out.dirs.push(l);
    }
    out.places = [...new Set(out.places)];
    return out;
  } finally {
    conn.end();
  }
}

/** Make a folder (and its parents) on a server, owned by the user apps run as. */
export async function makeFolder(server, dir) {
  const user = server.ssh_user || 'root';
  const conn = await connect(server, { timeout: 15000 });
  try {
    const r = await exec(conn, asRoot(server, `set -e; mkdir -p -- ${shq(dir)}; chown ${shq(user)}: ${shq(dir)}`), { timeout: 20000 });
    if (r.code) throw new Error(r.stderr.replace(/\x1eSBPGID \d+\n?/, '').trim().split('\n').pop() || `Could not create ${dir}`);
  } finally {
    conn.end();
  }
}

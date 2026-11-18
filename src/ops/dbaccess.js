/**
 * OUTSIDE DATABASE ACCESS — let another service (e.g. a media server) use a project's database
 * through ONE name that follows the live server, e.g. DB_HOST=db.example.com.
 *
 *  - Cloudflare: an A record (DNS only, TTL 60) linked to the project, so every switch moves it.
 *  - On each server of the project: a tiny proxy container (socat) publishes the database on one
 *    port, without touching the project's docker-compose. An iptables allow-list (DOCKER-USER chain,
 *    because Docker bypasses ufw) lets only the listed IPs in.
 *  - Only the LIVE server is open. Standbys are closed, and a switch closes the old server BEFORE
 *    the database is copied, so nothing written from outside can get lost.
 */
import { update, now } from '../db.js';
import { bus } from '../bus.js';
import { logEvent, alert } from '../events.js';
import { defineJob } from '../jobs.js';
import { getProject, getServer, deploymentsOf, parseJSON } from '../models.js';
import * as cf from '../cloudflare.js';
import { connectTo, runRemote, asRoot, dockerBin, shq } from './remote.js';

export const PROXY_IMAGE = process.env.DBACCESS_IMAGE || 'alpine/socat:1.8.0.3';
const DIR = '/opt/switchboard-dbaccess';
export const DEFAULT_PORTS = { mysql: 3306, postgres: 5432 };

export const dbAccessOf = (project) => (project?.db_access && typeof project.db_access === 'object' ? project.db_access : parseJSON(project?.db_access, null));
export const dbAccessOn = (project) => !!dbAccessOf(project)?.enabled;
export const proxyName = (project) => `sb-dbaccess-${project.id}`;
const chainName = (project) => `SB-DBX-${project.id}`;
export const allowedIps = (cfg) => (cfg?.ips || []).map((x) => x.ip).filter((ip) => /^[0-9./]+$/.test(ip));
export const dbDeps = (project) => deploymentsOf(project.id).filter((d) => d.db_type && d.db_type !== 'none' && d.db_container);
const innerPort = (dep) => DEFAULT_PORTS[dep.db_type] || 3306;

/** Why this project can't use outside access, or null. */
export function dbAccessProblem(project) {
  if (project.traffic_mode === 'lb') return 'This project is load balanced — its database is on the shared database server, which has its own allow-list.';
  if (project.db_server_id) return 'This project uses a shared database server — it has its own allow-list.';
  if (!dbDeps(project).length) return 'No server of this project has a database container set (edit the servers in this project).';
  return null;
}

/** Save the state of one server (re-reads the project, so parallel changes are kept). */
function saveServerState(projectId, depId, state) {
  const p = getProject(projectId);
  const cfg = dbAccessOf(p);
  if (!cfg) return;
  cfg.servers = cfg.servers || {};
  if (state === null) delete cfg.servers[depId];
  else cfg.servers[depId] = { ...state, at: now() };
  update('projects', projectId, { db_access: JSON.stringify(cfg) });
}

/** iptables rules: only `ips` (when open) may reach `port` from outside. Container-to-container traffic is never blocked. */
function firewallScript(project, port, ips) {
  const c = chainName(project);
  return `#!/bin/sh
# Managed by Switchboard — outside database access for project "${String(project.name).replace(/[^\w .-]/g, '')}" (port ${port}).
iptables -N ${c} 2>/dev/null; iptables -F ${c}
iptables -A ${c} -i docker0 -j RETURN
iptables -A ${c} -i br-+ -j RETURN
iptables -A ${c} -s 127.0.0.0/8 -j RETURN
${ips.map((ip) => `iptables -A ${c} -s ${ip} -j RETURN`).join('\n')}
iptables -A ${c} -j DROP
iptables -C DOCKER-USER -p tcp -m conntrack --ctorigdstport ${port} --ctdir ORIGINAL -j ${c} 2>/dev/null || iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport ${port} --ctdir ORIGINAL -j ${c}
# IPv6: allowed IPs are IPv4, so the port is closed over IPv6 (a database publishing on [::] would bypass the rules above)
if command -v ip6tables >/dev/null 2>&1 && ip6tables -S INPUT >/dev/null 2>&1; then
  ip6tables -N ${c}6 2>/dev/null; ip6tables -F ${c}6
  ip6tables -A ${c}6 -i lo -j RETURN
  ip6tables -A ${c}6 -i docker0 -j RETURN
  ip6tables -A ${c}6 -i br-+ -j RETURN
  ip6tables -A ${c}6 -j DROP
  ip6tables -C INPUT -p tcp --dport ${port} -j ${c}6 2>/dev/null || ip6tables -I INPUT -p tcp --dport ${port} -j ${c}6
  if ip6tables -S DOCKER-USER >/dev/null 2>&1; then
    ip6tables -C DOCKER-USER -p tcp -m conntrack --ctorigdstport ${port} --ctdir ORIGINAL -j ${c}6 2>/dev/null || ip6tables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport ${port} --ctdir ORIGINAL -j ${c}6
  fi
fi
`;
}

/** Shell helper: delete the rules in a parent chain that jump to a target chain (except for one port). */
const SBDEL = `sbdel() {
  command -v "$1" >/dev/null 2>&1 || return 0
  "$1" -S "$2" 2>/dev/null | grep -- "-j $3\\$" | { if [ -n "$4" ]; then grep -v -- "port $4 " || true; else cat; fi; } | sed 's/^-A /-D /' | while read -r R; do eval "$1" $R; done
}`;

/** Remove the rules (also used before re-adding with another port). */
const unfirewall = (project) => {
  const c = chainName(project);
  return `${SBDEL}
sbdel iptables DOCKER-USER ${c}; sbdel ip6tables DOCKER-USER ${c}6; sbdel ip6tables INPUT ${c}6
iptables -F ${c} 2>/dev/null; iptables -X ${c} 2>/dev/null; ip6tables -F ${c}6 2>/dev/null; ip6tables -X ${c}6 2>/dev/null; rm -f ${DIR}/${project.id}.sh
# last project gone: no reboot line, no folder
if ! ls ${DIR}/*.sh >/dev/null 2>&1; then rmdir ${DIR} 2>/dev/null; if command -v crontab >/dev/null 2>&1; then crontab -l 2>/dev/null | grep -v 'switchboard-dbaccess' | crontab -; fi; fi; true`;
};

/**
 * Make outside access on one server: mode 'open' (allow-list), 'closed' (proxy kept, nobody from
 * outside) or 'remove' (proxy + rules gone). Returns the saved state.
 */
export async function setServerAccess(ctx, conn, project, dep, mode) {
  const server = getServer(dep.server_id);
  const cfg = dbAccessOf(project) || {};
  const docker = dockerBin(server);
  const name = proxyName(project);
  if (mode === 'remove') {
    await runRemote(ctx, conn, asRoot(server, `${docker} rm -f ${name} >/dev/null 2>&1; ${unfirewall(project)}`), { quiet: true, timeout: 60000 });
    saveServerState(project.id, dep.id, null);
    ctx?.log(`${dep.server_name}: outside database access removed`);
    return null;
  }
  const port = Number(cfg.port) || innerPort(dep);
  const inner = innerPort(dep);
  const db = dep.db_container;
  const sig = `${port}:${db}:${inner}:${PROXY_IMAGE}`;
  // Proxy container on the database's own Docker network, published on IPv4 only (iptables covers IPv4).
  const setup = `set -e
DB=${shq(db)}; NAME=${name}; P=${port}; IN=${inner}
${docker} inspect "$DB" >/dev/null 2>&1 || { echo "Database container $DB not found on this server" >&2; exit 3; }
NET="$(${docker} inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$DB" | grep -v '^$' | head -1)"
[ -n "$NET" ] || { echo "Database container $DB has no Docker network" >&2; exit 3; }
[ "$NET" != host ] || { echo "Database container $DB uses the host network — publish its port yourself" >&2; exit 3; }
TARGET="$DB"
[ "$NET" != bridge ] || TARGET="$(${docker} inspect -f '{{(index .NetworkSettings.Networks "bridge").IPAddress}}' "$DB")"
# Does the database container already publish its port on this server (docker -p 3306:3306)?
PUB="$(${docker} port "$DB" $IN/tcp 2>/dev/null | grep -v -e '^127\.' -e '^\[::1\]' | sed 's/.*://' | grep -E '^[0-9]+$' | sort -u | head -1 || true)"
OWN=0
if [ -n "$PUB" ]; then
  [ "$PUB" = "$P" ] || { echo "The database container $DB already publishes its port on $PUB (open to the internet) — set the port to $PUB here (Edit → Port) so Switchboard protects that one" >&2; exit 4; }
  OWN=1
fi
CUR="$(${docker} inspect -f '{{index .Config.Labels "switchboard.dbaccess"}}' "$NAME" 2>/dev/null || true)"
if [ $OWN = 1 ]; then
  ${docker} rm -f "$NAME" >/dev/null 2>&1 || true
  echo "mode: own port"
elif [ "$CUR" != ${shq(sig)} ] || [ "$(${docker} inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != true ]; then
  ${docker} rm -f "$NAME" >/dev/null 2>&1 || true
  if (ss -ltnH "sport = :$P" 2>/dev/null || netstat -ltn 2>/dev/null | awk '{print $4}' | grep -E "[:.]$P\\$") | grep -q .; then
    echo "Port $P is already used by something else on this server (docker ps / ss -ltnp shows what) — pick another port" >&2; exit 4
  fi
  ${docker} pull -q ${PROXY_IMAGE} >/dev/null 2>&1 || true
  ${docker} run -d --name "$NAME" --restart unless-stopped --network "$NET" -p "0.0.0.0:$P:$IN" \\
    --label switchboard.dbaccess=${shq(sig)} ${PROXY_IMAGE} \\
    -d TCP-LISTEN:$IN,fork,reuseaddr TCP:"$TARGET":$IN >/dev/null
  echo "proxy started"
else
  echo "proxy already running"
fi
command -v iptables >/dev/null 2>&1 || { echo "iptables is not installed — can't protect the port" >&2; exit 5; }
iptables -S DOCKER-USER >/dev/null 2>&1 || { echo "No DOCKER-USER firewall chain (is Docker running with iptables?)" >&2; exit 5; }
mkdir -p ${DIR}
# rules for an old port go first
${SBDEL}
sbdel iptables DOCKER-USER ${chainName(project)} $P; sbdel ip6tables DOCKER-USER ${chainName(project)}6 $P; sbdel ip6tables INPUT ${chainName(project)}6 $P
cat > ${DIR}/${project.id}.sh; chmod 700 ${DIR}/${project.id}.sh; sh ${DIR}/${project.id}.sh
if command -v crontab >/dev/null 2>&1; then (crontab -l 2>/dev/null | grep -v 'switchboard-dbaccess'; echo '@reboot sleep 40 && for f in ${DIR}/*.sh; do sh "$f"; done') | crontab -; fi
# check: can the database be reached through the proxy?
PADDR="$NAME"; [ $OWN = 0 ] || PADDR=127.0.0.1; [ $OWN = 1 ] || [ "$NET" != bridge ] || PADDR="$(${docker} inspect -f '{{(index .NetworkSettings.Networks "bridge").IPAddress}}' "$NAME")"
sleep 1
if ${docker} exec "$DB" sh -c 'command -v pg_isready' >/dev/null 2>&1; then
  ${docker} exec "$DB" pg_isready -h "$PADDR" -p $IN -t 5 >/dev/null && echo "check: database answers through the proxy" || echo "check: NO answer through the proxy"
else
  ${docker} exec "$DB" sh -c "A=\\$(command -v mysqladmin || command -v mariadb-admin); \\$A -h $PADDR -P $IN --connect-timeout=5 ping 2>&1" | grep -qiE 'alive|access denied' && echo "check: database answers through the proxy" || echo "check: NO answer through the proxy"
fi`;
  const ips = mode === 'open' ? allowedIps(cfg) : [];
  try {
    const r = await runRemote(ctx, conn, asRoot(server, setup), { stdin: firewallScript(project, port, ips), quiet: true, timeout: 180000 });
    const ok = /database answers through the proxy/.test(r.stdout);
    const own = /mode: own port/.test(r.stdout);
    const state = { state: mode, port, ok, via: own ? 'own-port' : 'proxy', error: ok ? null : 'The database did not answer' };
    saveServerState(project.id, dep.id, state);
    ctx?.log(
      `${dep.server_name}: port ${port} ${mode === 'open' ? `OPEN for ${ips.join(', ') || 'nobody (add IPs)'}` : 'CLOSED to outside (standby)'}${own ? ' (the database publishes this port itself — protected by the firewall)' : ''}${ok ? ' — database answers ✓' : ''}`,
    );
    if (!ok) ctx?.warn(`${dep.server_name}: the database did not answer through the proxy — is ${db} running?`);
    return state;
  } catch (e) {
    saveServerState(project.id, dep.id, { state: 'error', port, ok: false, error: e.message.replace(/^Command failed \(exit \d+\): /, '') });
    throw e;
  }
}

/** Switch hooks: never fail the switch because of this — warn instead. */
export async function closeForSwitch(ctx, conn, project, dep, why) {
  if (!dbAccessOn(project) || !conn || !dep || dep.db_type === 'none') return false;
  ctx.step(`Outside database access: close ${dep.server_name} (${why})`);
  try {
    await setServerAccess(ctx, conn, project, dep, 'closed');
    return true;
  } catch (e) {
    ctx.warn(`Could not close outside database access on ${dep.server_name}: ${e.message}`);
    return false;
  }
}
export async function openForSwitch(ctx, conn, project, dep) {
  if (!dbAccessOn(project) || !dep || dep.db_type === 'none') return;
  if (!conn) {
    ctx.warn(`Outside database access: could not reach ${dep.server_name} to open it — press Apply in the Database access tab`);
    return;
  }
  ctx.step(`Outside database access: open ${dep.server_name} for ${allowedIps(dbAccessOf(project)).join(', ') || 'nobody yet'}`);
  try {
    await setServerAccess(ctx, conn, project, dep, 'open');
  } catch (e) {
    ctx.warn(`Could not open outside database access on ${dep.server_name}: ${e.message}`);
    alert('warn', `${project.name}: outside database access could not be opened on ${dep.server_name} — ${e.message}`, { projectId: project.id, link: `#/projects/${project.id}` });
  }
}

/** Expected state per server vs. what was last applied — for the problems list and the tab. */
export function dbAccessIssues(project, deps) {
  const cfg = dbAccessOf(project);
  if (!cfg?.enabled) return [];
  const out = [];
  for (const d of deps) {
    if (!d.db_type || d.db_type === 'none' || !d.db_container) continue;
    const st = cfg.servers?.[d.id];
    const active = project.active_deployment_id === d.id;
    if (!st) out.push({ level: 'warn', dep: d, message: `outside database access is not set up on ${d.server_name} yet — press Apply` });
    else if (st.state === 'error') out.push({ level: 'warn', dep: d, message: `outside database access on ${d.server_name} failed: ${st.error}` });
    else if (active && st.state !== 'open') out.push({ level: 'error', dep: d, message: `outside database access is CLOSED on the live server ${d.server_name} — press Apply` });
    else if (!active && st.state === 'open') out.push({ level: 'warn', dep: d, message: `outside database access is still OPEN on standby ${d.server_name} — writes there would be lost; press Apply` });
  }
  return out;
}

/** Find the Cloudflare zone of a host name (longest matching zone). */
export async function zoneOf(host) {
  const zones = await cf.listZones();
  const z = zones.filter((x) => host === x.name || host.endsWith(`.${x.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
  return z ? { zone_id: z.id, zone_name: z.name } : null;
}

/** The DNS record: create it (DNS only, TTL 60) or adopt an existing grey one, and link it to the project. */
async function ensureRecord(ctx, project, cfg, active) {
  const ip = active ? getServer(active.server_id).ip : null;
  let rec = null;
  if (cfg.record_id) rec = await cf.getRecord(cfg.zone_id, cfg.record_id).catch(() => null);
  if (rec && rec.name !== cfg.host) rec = null; // host was renamed
  if (!rec) {
    const existing = (await cf.findRecords(cfg.zone_id, cfg.host)).filter((x) => x.name === cfg.host);
    const a = existing.find((x) => x.type === 'A');
    if (existing.length && !a) throw new Error(`${cfg.host} exists as a ${existing[0].type} record — remove it in Cloudflare or pick another name`);
    if (a?.proxied) throw new Error(`${cfg.host} already exists and is proxied (orange cloud) — it is probably used by a website. Pick another name, e.g. db.${cfg.zone_name}`);
    if (a) {
      rec = a;
      cfg.record_created = false;
      ctx.log(`Using the existing record ${cfg.host}`);
    } else {
      if (!ip) throw new Error('This project has no live server yet — set one first');
      rec = await cf.createRecord(cfg.zone_id, { type: 'A', name: cfg.host, content: ip, proxied: false, ttl: 60, comment: `Switchboard: database of ${project.name}` });
      cfg.record_created = true;
      ctx.log(`Created A ${cfg.host} → ${ip} (DNS only, TTL 60s)`);
    }
  }
  const patch = {};
  if (rec.proxied) patch.proxied = false;
  if (rec.ttl !== 60) patch.ttl = 60;
  if (ip && rec.content !== ip) patch.content = ip;
  if (Object.keys(patch).length) {
    await cf.updateRecord(cfg.zone_id, rec.id, patch);
    ctx.log(`${cfg.host}: ${Object.entries(patch).map(([k, v]) => `${k} → ${v}`).join(', ')}`);
  }
  cfg.record_id = rec.id;
  const fresh = getProject(project.id);
  const recs = parseJSON(fresh.dns_records, []).filter((x) => x.name !== cfg.host || x.id === rec.id);
  if (!recs.some((x) => x.id === rec.id)) {
    recs.push({ zone_id: cfg.zone_id, zone_name: cfg.zone_name, id: rec.id, name: cfg.host, type: 'A' });
    ctx.log(`${cfg.host} linked to ${project.name}: it moves along when you switch servers`);
  }
  const all = { ...dbAccessOf(fresh), ...cfg, servers: dbAccessOf(fresh)?.servers || {} };
  update('projects', project.id, { dns_records: JSON.stringify(recs), db_access: JSON.stringify(all) });
}

defineJob('db-access', async (ctx, p) => {
  let project = getProject(ctx.job.project_id);
  if (!project) throw new Error('Project not found');
  const cfg = dbAccessOf(project);
  if (!cfg) throw new Error('Outside database access is not configured');
  const deps = dbDeps(project);
  const active = deps.find((d) => d.id === project.active_deployment_id) || null;
  const link = `#/projects/${project.id}`;

  if (p.action === 'remove') {
    for (const d of deploymentsOf(project.id)) {
      if (!cfg.servers?.[d.id]) continue;
      ctx.step(`Remove from ${d.server_name}`);
      const conn = await connectTo(ctx, getServer(d.server_id), { required: false });
      if (!conn) continue;
      try {
        await setServerAccess(ctx, conn, project, d, 'remove');
      } catch (e) {
        ctx.warn(`${d.server_name}: ${e.message}`);
      } finally {
        conn.end();
      }
    }
    if (cfg.record_id) {
      ctx.step(`Cloudflare: ${cfg.host}`);
      const fresh = getProject(project.id);
      update('projects', project.id, { dns_records: JSON.stringify(parseJSON(fresh.dns_records, []).filter((x) => x.id !== cfg.record_id)) });
      if (cfg.record_created && p.deleteDns !== false) {
        await cf.deleteRecord(cfg.zone_id, cfg.record_id).then(() => ctx.log(`Record ${cfg.host} deleted`)).catch((e) => ctx.warn(`Cloudflare: ${e.message}`));
      } else ctx.log(`${cfg.host} unlinked from the project (kept in Cloudflare)`);
    }
    const left = dbAccessOf(getProject(project.id)) || {};
    update('projects', project.id, { db_access: JSON.stringify({ ...left, enabled: false, record_id: null, record_created: false, servers: {} }) });
    logEvent('warn', `${project.name}: outside database access turned off`, { projectId: project.id, jobId: ctx.id, user: ctx.user });
    bus.emit('state', { projectId: project.id });
    return;
  }

  const problem = dbAccessProblem(project);
  if (problem) throw new Error(problem);
  if (!active) ctx.warn('This project has no live server yet: every server stays closed until you switch to one.');

  ctx.step(`Cloudflare: ${cfg.host} (DNS only)`);
  await ensureRecord(ctx, project, cfg, active);
  project = getProject(project.id);

  let failed = 0;
  // standbys first (closing is safe), the live server last
  for (const d of [...deps.filter((x) => x !== active), ...(active ? [active] : [])]) {
    const mode = d === active ? 'open' : 'closed';
    ctx.step(`${d.server_name}: ${mode === 'open' ? 'open for the allowed IPs (live server)' : 'closed to outside (standby)'}`);
    const conn = await connectTo(ctx, getServer(d.server_id), { required: false });
    if (!conn) {
      saveServerState(project.id, d.id, { state: 'error', port: cfg.port, ok: false, error: 'Could not connect over SSH' });
      failed++;
      continue;
    }
    try {
      await setServerAccess(ctx, conn, project, d, mode);
    } catch (e) {
      failed++;
      ctx.warn(`${d.server_name}: ${e.message}`);
    } finally {
      conn.end();
    }
  }
  const ips = allowedIps(cfg);
  ctx.step('Use these settings in your other service');
  ctx.log(`DB_HOST=${cfg.host}`);
  ctx.log(`DB_PORT=${cfg.port}`);
  if (active?.db_name) ctx.log(`DB_DATABASE=${active.db_name}`);
  if (active?.db_user) ctx.log(`DB_USERNAME=${active.db_user}`);
  ctx.log('DB_PASSWORD=(the same password the app uses)');
  if (!ips.length) ctx.warn('No IP is allowed yet — add the IP of the server that needs the database.');
  ctx.log("Also open this port in your provider's firewall (DigitalOcean Cloud Firewall, AWS security group…) if you use one.");
  bus.emit('state', { projectId: project.id });
  if (failed) throw new Error(`${failed} server${failed === 1 ? '' : 's'} could not be set up — see the log`);
  logEvent('success', `${project.name}: outside database access at ${cfg.host}:${cfg.port} for ${ips.join(', ') || 'nobody yet'}`, { projectId: project.id, jobId: ctx.id, user: ctx.user, link });
});

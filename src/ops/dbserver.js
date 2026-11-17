/**
 * SHARED DATABASE SERVER — one database (+ Redis) that every app server of a
 * load-balanced project uses, so all live servers see the same data and sessions.
 *
 * Setup: MySQL / MariaDB / PostgreSQL + Redis in Docker on a server you choose
 * (/opt/switchboard-db), published only on its private IP when it has one, and an
 * iptables allow-list so only your app servers can connect.
 *
 * Move: dump the project's database from the live server → import on the DB server →
 * verify → rewrite each app's .env (backup kept) → restart → health check. Any failure
 * after the .env change puts the old .env back.
 */
import crypto from 'node:crypto';
import { encrypt, decrypt } from '../crypto.js';
import { all, get, insert, update, now } from '../db.js';
import { getServer, getProject, deploymentsOf, parseJSON } from '../models.js';
import { probe } from '../health.js';
import { sleep } from '../util.js';
import { connectTo, runRemote, asRoot, dockerBin, shq } from './remote.js';
import { ensureDocker } from './clone.js';
import { setMaintenance } from './app.js';
import { dumpToFile, importFromFile, countTables, backupFilePath, recordBackup, requireDb } from './database.js';

const DIR = '/opt/switchboard-db';
const ENGINES = {
  mysql: { image: 'mysql:8.4', port: 3306, data: '/var/lib/mysql', env: 'MYSQL_ROOT_PASSWORD', type: 'mysql' },
  mariadb: { image: 'mariadb:11.4', port: 3306, data: '/var/lib/mysql', env: 'MARIADB_ROOT_PASSWORD', type: 'mysql' },
  postgres: { image: 'postgres:17', port: 5432, data: '/var/lib/postgresql/data', env: 'POSTGRES_PASSWORD', type: 'postgres' },
};
export const ENGINE_NAMES = Object.keys(ENGINES);
const secret = () => crypto.randomBytes(18).toString('base64url').replace(/[-_]/g, 'x');

export const getDbServer = (id) => get('SELECT * FROM db_servers WHERE id = ?', id);

export function dbServerPublic(d) {
  if (!d) return null;
  const s = getServer(d.server_id);
  const { root_password, redis_password, ...rest } = d;
  return { ...rest, server_name: s?.name, allowed: parseJSON(d.allowed, []), projects: all('SELECT id, name FROM projects WHERE db_server_id = ?', d.id) };
}

/** The shared database as a "deployment-like" object, so the existing dump/import/backup code works on it. */
export function sharedDbDep(project) {
  const dbs = project?.db_server_id ? getDbServer(project.db_server_id) : null;
  const shared = parseJSON(project?.shared_db, null);
  if (!dbs || !shared) return null;
  const s = getServer(dbs.server_id);
  return {
    id: null,
    project_id: project.id,
    server_id: dbs.server_id,
    server_name: `${s?.name || 'DB server'} (database server)`,
    server_ip: s?.ip,
    db_type: ENGINES[dbs.engine].type,
    db_container: dbs.container,
    db_name: shared.name,
    // MySQL: root (dumps need SHOW_ROUTINE, views keep their DEFINER). PostgreSQL: the owner of the tables.
    db_user: ENGINES[dbs.engine].type === 'postgres' ? shared.user : '',
    db_password: ENGINES[dbs.engine].type === 'postgres' ? shared.password : dbs.root_password,
  };
}

/** IPs of every app server of the projects that use this DB server (+ extra ones). */
function appServerIps(dbsId, extraServerIds = []) {
  const ids = new Set(extraServerIds);
  for (const p of all('SELECT id FROM projects WHERE db_server_id = ?', dbsId)) for (const d of deploymentsOf(p.id)) ids.add(d.server_id);
  const ips = new Set();
  for (const id of ids) {
    const s = getServer(id);
    if (s?.ip) ips.add(s.ip);
    if (s?.private_ip) ips.add(s.private_ip);
  }
  return [...ips];
}

/** Only the given IPs may reach the DB and Redis ports (Docker bypasses ufw, so this uses DOCKER-USER). */
export async function writeFirewall(ctx, conn, server, dbs, ips) {
  const ports = [dbs.port, dbs.redis ? dbs.redis_port : null].filter(Boolean);
  const safe = ips.filter((ip) => /^[0-9.]+$/.test(ip));
  const script = `#!/bin/sh
# Managed by Switchboard: only these app servers may connect to the database / Redis.
iptables -N SB-DB 2>/dev/null; iptables -F SB-DB
iptables -A SB-DB -s 127.0.0.0/8 -j RETURN
${safe.map((ip) => `iptables -A SB-DB -s ${ip} -j RETURN`).join('\n')}
iptables -A SB-DB -j DROP
for port in ${ports.join(' ')}; do
  iptables -C DOCKER-USER -p tcp -m conntrack --ctorigdstport "$port" --ctdir ORIGINAL -j SB-DB 2>/dev/null || iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport "$port" --ctdir ORIGINAL -j SB-DB
done
`;
  await runRemote(
    ctx,
    conn,
    asRoot(
      server,
      `mkdir -p ${DIR} && cat > ${DIR}/firewall.sh && chmod 700 ${DIR}/firewall.sh && sh ${DIR}/firewall.sh
# again after a reboot (Docker must be up first)
if command -v crontab >/dev/null 2>&1; then (crontab -l 2>/dev/null | grep -v 'switchboard-db/firewall.sh'; echo '@reboot sleep 40 && sh ${DIR}/firewall.sh') | crontab -; fi`,
    ),
    { stdin: script, quiet: true, timeout: 60000 },
  );
  update('db_servers', dbs.id, { allowed: JSON.stringify(safe) });
  ctx?.log(`Database firewall: only ${safe.join(', ') || 'nobody'} may connect`);
}

/** Re-apply the allow-list after servers were added (scale-out). */
export async function refreshDbFirewall(ctx, dbsId, extraServerIds = []) {
  const dbs = getDbServer(dbsId);
  if (!dbs) return;
  const server = getServer(dbs.server_id);
  const conn = await connectTo(ctx, server);
  try {
    await writeFirewall(ctx, conn, server, dbs, appServerIps(dbs.id, extraServerIds));
  } finally {
    conn.end();
  }
}

/* ------------------------------------------------------------------ setup */

export async function setupDbServer(ctx, p) {
  const server = getServer(Number(p.server));
  if (!server) throw new Error('Server not found');
  const eng = ENGINES[p.engine];
  if (!eng) throw new Error('Unknown database engine');
  if (get('SELECT id FROM db_servers WHERE server_id = ?', server.id)) throw new Error(`${server.name} is already a database server`);
  const bind = server.private_ip || server.ip;
  if (!server.private_ip) ctx.warn(`${server.name} has no private IP set — the database listens on the public IP ${server.ip}, protected by the firewall allow-list`);
  let conn = await connectTo(ctx, server);
  try {
    const D = dockerBin(server).replace(/^sudo\s+/, '');
    const ver = (await runRemote(ctx, conn, asRoot(server, `${D} version --format '{{.Server.Version}}' 2>/dev/null || echo none; ${D} compose version --short 2>/dev/null || echo none`), { quiet: true })).stdout.split('\n');
    conn = await ensureDocker(ctx, conn, server, { docker: ver[0]?.trim() || 'none', compose: ver[1]?.trim() || 'none' });

    const rootPw = secret();
    const redisPw = secret();
    const redis = p.redis !== false;
    const compose = `# Managed by Switchboard — shared database${redis ? ' + Redis' : ''}.
name: switchboard-db
services:
  db:
    image: ${eng.image}
    container_name: switchboard-db
    restart: unless-stopped
    environment:
      ${eng.env}: \${DB_ROOT_PASSWORD}
    ports: ["${bind}:${eng.port}:${eng.port}"]
    volumes: ["db:${eng.data}"]
${
  redis
    ? `  redis:
    image: redis:7-alpine
    container_name: switchboard-redis
    restart: unless-stopped
    command: ["redis-server", "--requirepass", "\${REDIS_PASSWORD}", "--appendonly", "yes"]
    ports: ["${bind}:6379:6379"]
    volumes: ["redis:/data"]
`
    : ''
}volumes:
  db: {}
${redis ? '  redis: {}\n' : ''}`;
    ctx.step(`Start ${p.engine}${redis ? ' + Redis' : ''} on ${server.name} (${DIR}, listening on ${bind})`);
    await runRemote(
      ctx,
      conn,
      asRoot(server, `set -e; mkdir -p ${DIR}; umask 077; printf 'DB_ROOT_PASSWORD=%s\\nREDIS_PASSWORD=%s\\n' ${shq(rootPw)} ${shq(redisPw)} > ${DIR}/.env; cat > ${DIR}/docker-compose.yml; cd ${DIR} && ${D} compose up -d`),
      { stdin: compose, timeout: 20 * 60000 },
    );
    const id = insert('db_servers', {
      server_id: server.id,
      engine: p.engine,
      dir: DIR,
      container: 'switchboard-db',
      port: eng.port,
      bind_ip: bind,
      root_password: encrypt(rootPw),
      redis: redis ? 1 : 0,
      redis_container: redis ? 'switchboard-redis' : null,
      redis_port: redis ? 6379 : null,
      redis_password: redis ? encrypt(redisPw) : null,
      allowed: '[]',
      status: 'starting',
      created_at: now(),
    });
    ctx.step('Wait until the database accepts connections');
    // Over TCP: on first start the official images run a temporary socket-only server, then restart.
    const ping =
      eng.type === 'postgres'
        ? `${D} exec switchboard-db pg_isready -h 127.0.0.1 -U postgres -q`
        : `${D} exec -e MYSQL_PWD=${shq(rootPw)} switchboard-db sh -c 'CLI=$(command -v mariadb || command -v mysql); "$CLI" -h127.0.0.1 -uroot -N -e "SELECT 1" >/dev/null'`;
    let ready = false;
    for (let i = 0; i < 90 && !ready; i++) {
      ctx.throwIfCancelled();
      ready = (await runRemote(ctx, conn, asRoot(server, ping), { quiet: true, okCodes: [0, 1, 2, 127], timeout: 30000 })).code === 0;
      if (!ready) await sleep(2000);
    }
    if (!ready) throw new Error('The database did not start in 3 minutes — check "docker logs switchboard-db" on the server');
    await writeFirewall(ctx, conn, server, getDbServer(id), appServerIps(id, (p.allow || []).map(Number)));
    update('db_servers', id, { status: 'ready' });
    ctx.log(`${server.name} is ready as a database server`);
    return id;
  } finally {
    conn.end();
  }
}

/* ------------------------------------------------------------------ move */

/** Write KEY=value lines into an .env file (replace or append), keeping a backup. */
const ENV_EDIT = (file) => `f=${shq(file)}
[ -f "$f" ] || { echo "no .env file at $f" >&2; exit 3; }
cp -p "$f" "$f.switchboard-bak"
t=$(mktemp); cat > "$t"
awk 'NR==FNR { i=index($0,"="); if (i>1) { k=substr($0,1,i-1); v[k]=$0 } next }
     { line=$0; for (k in v) if (index(line, k "=")==1) { print v[k]; seen[k]=1; next } print line }
     END { for (k in v) if (!(k in seen)) print v[k] }' "$t" "$f" > "$t.out" && cat "$t.out" > "$f"
rm -f "$t" "$t.out"`;

const ENV_RESTORE = (file) => `f=${shq(file)}; [ -f "$f.switchboard-bak" ] && cat "$f.switchboard-bak" > "$f"`;

async function restartApp(ctx, conn, server, dep) {
  const D = dockerBin(server);
  if (dep.app_container) {
    await runRemote(
      ctx,
      conn,
      `${D} exec ${shq(dep.app_container)} sh -c '[ -f bootstrap/cache/config.php ] && php artisan config:cache >/dev/null 2>&1; true'; ` +
        `p=$(${D} inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' ${shq(dep.app_container)} 2>/dev/null); ` +
        `if [ -n "$p" ]; then ${D} ps -q --filter "label=com.docker.compose.project=$p" | while read -r c; do n=$(${D} inspect -f '{{.Name}}' "$c" | tr -d /); [ "$n" = ${shq(dep.db_container || '-')} ] || ${D} restart "$c" >/dev/null; done; else ${D} restart ${shq(dep.app_container)} >/dev/null; fi`,
      { quiet: true, timeout: 300000 },
    );
    ctx.log(`${dep.server_name}: app restarted`);
  } else {
    ctx.warn(`${dep.server_name}: no app container — restart the app yourself so it reads the new .env (e.g. pm2 reload all)`);
  }
}

export async function moveDatabase(ctx, projectId, p) {
  const project = getProject(projectId);
  if (project.db_server_id) throw new Error('This project already uses a database server');
  const dbs = getDbServer(Number(p.db_server));
  if (!dbs || dbs.status !== 'ready') throw new Error('Database server not found or not ready');
  const eng = ENGINES[dbs.engine];
  const deps = deploymentsOf(projectId);
  const source = deps.find((d) => d.id === project.active_deployment_id) || deps.find((d) => d.db_type !== 'none');
  if (!source) throw new Error('No server with a database in this project');
  requireDb(source);
  if ((source.db_type === 'postgres') !== (eng.type === 'postgres')) throw new Error(`The project uses ${source.db_type} but the database server runs ${dbs.engine}`);
  const dbServer = getServer(dbs.server_id);
  const srcServer = getServer(source.server_id);

  const srcConn = await connectTo(ctx, srcServer);
  let dbConn = null;
  let maint = false;
  const edited = []; // deployments whose .env was changed
  const conns = new Map();
  const connFor = async (d) => {
    if (!conns.has(d.server_id)) conns.set(d.server_id, await connectTo(ctx, getServer(d.server_id)));
    return conns.get(d.server_id);
  };
  try {
    dbConn = await connectTo(ctx, dbServer);
    // Database name: what Switchboard knows, else the container's own setting.
    let dbName = source.db_name;
    if (!dbName) {
      const r = await runRemote(ctx, srcConn, `${dockerBin(srcServer)} exec ${shq(source.db_container)} sh -c 'echo "\${MYSQL_DATABASE:-\${MARIADB_DATABASE:-\${POSTGRES_DB:-}}}"'`, { quiet: true });
      dbName = r.stdout.trim();
    }
    if (!/^[A-Za-z0-9_]{1,64}$/.test(dbName || '')) throw new Error(`Can't tell the database name (got "${dbName}") — set it in the project's server settings`);
    const user = `app_${project.slug.replace(/[^a-z0-9]/g, '_')}`.slice(0, 30);
    const pw = secret();
    // Import as root on MySQL (views/routines keep their DEFINER), as the owner on PostgreSQL.
    const target =
      eng.type === 'postgres'
        ? { id: null, server_id: dbServer.id, server_name: dbServer.name, db_type: eng.type, db_container: dbs.container, db_name: dbName, db_user: user, db_password: encrypt(pw) }
        : { id: null, server_id: dbServer.id, server_name: dbServer.name, db_type: eng.type, db_container: dbs.container, db_name: dbName, db_user: '', db_password: dbs.root_password };

    if (p.maintenance !== false) {
      ctx.step(`Maintenance mode ON at ${source.server_name} (no new writes while moving)`);
      maint = await setMaintenance(ctx, srcConn, project, source, true);
    }
    ctx.step(`Dump the database on ${source.server_name}`);
    const srcTables = await countTables(srcConn, srcServer, source);
    if (srcTables === 0) throw new Error(`The database on ${source.server_name} has 0 tables — refusing to move an empty database`);
    const file = backupFilePath(project, source, 'move');
    const dump = await dumpToFile(ctx, srcConn, srcServer, source, file);
    recordBackup(project, source, 'manual', file, dump.size, srcTables, `Before moving to ${dbServer.name}`);
    ctx.log(`Dump OK (${srcTables} tables), kept as a backup`);

    ctx.step(`Create database "${dbName}" and user "${user}" on ${dbServer.name}`);
    const rootPw = decrypt(dbs.root_password);
    const sql =
      eng.type === 'postgres'
        ? `psql -U postgres -v ON_ERROR_STOP=1 -q -c "DO \\$\\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${user}') THEN CREATE ROLE ${user} LOGIN PASSWORD '${pw}'; ELSE ALTER ROLE ${user} LOGIN PASSWORD '${pw}'; END IF; END \\$\\$;" && (psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'" | grep -q 1 || psql -U postgres -q -c "CREATE DATABASE ${dbName} OWNER ${user}")`
        : `CLI=$(command -v mariadb || command -v mysql); "$CLI" -uroot -e "CREATE DATABASE IF NOT EXISTS \\\`${dbName}\\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY '${pw}'; ALTER USER '${user}'@'%' IDENTIFIED BY '${pw}'; GRANT ALL PRIVILEGES ON \\\`${dbName}\\\`.* TO '${user}'@'%'; FLUSH PRIVILEGES;"`;
    await runRemote(ctx, dbConn, asRoot(dbServer, `${dockerBin(dbServer).replace(/^sudo\s+/, '')} exec -e MYSQL_PWD=${shq(rootPw)} -e PGPASSWORD=${shq(rootPw)} ${shq(dbs.container)} sh -c ${shq(sql)}`), { quiet: true, timeout: 120000 });

    ctx.step(`Import into ${dbServer.name}`);
    await importFromFile(ctx, dbConn, dbServer, target, file);
    const n = await countTables(dbConn, dbServer, target);
    if (n !== srcTables) throw new Error(`Verification failed: ${source.server_name} has ${srcTables} tables, the database server has ${n}`);
    ctx.log(`Verified: ${n} tables ✓`);

    // Let the app servers in before they switch over.
    await writeFirewall(ctx, dbConn, dbServer, dbs, appServerIps(dbs.id, deps.map((d) => d.server_id)));

    const env = [`DB_HOST=${dbs.bind_ip}`, `DB_PORT=${dbs.port}`, `DB_DATABASE=${dbName}`, `DB_USERNAME=${user}`, `DB_PASSWORD=${pw}`];
    if (eng.type === 'postgres') env.unshift('DB_CONNECTION=pgsql');
    if (dbs.redis && p.redis !== false) {
      env.push(`REDIS_HOST=${dbs.bind_ip}`, `REDIS_PORT=${dbs.redis_port}`, `REDIS_PASSWORD=${decrypt(dbs.redis_password)}`, 'SESSION_DRIVER=redis', 'CACHE_STORE=redis', 'CACHE_DRIVER=redis');
    }
    for (const d of deps) {
      if (!d.app_dir) {
        ctx.warn(`${d.server_name}: no app folder set — update its .env by hand: ${env.map((l) => l.split('=')[0]).join(', ')}`);
        continue;
      }
      ctx.step(`Point ${d.server_name} at the database server (${d.app_dir}/.env, old one kept as .env.switchboard-bak)`);
      const conn = await connFor(d);
      const server = getServer(d.server_id);
      await runRemote(ctx, conn, asRoot(server, ENV_EDIT(`${d.app_dir}/.env`)), { stdin: `${env.join('\n')}\n`, quiet: true });
      edited.push(d);
      await restartApp(ctx, conn, server, d);
    }

    ctx.step('Health check every server with the new database');
    if (maint) {
      await setMaintenance(ctx, srcConn, project, source, false, { signal: null });
      maint = false;
    }
    for (const d of deps) {
      let r;
      for (let i = 0; i < 10; i++) {
        r = await probe(project, d);
        if (r.ok) break;
        await sleep(3000);
      }
      if (!r.ok && d.id === source.id) throw new Error(`${d.server_name} is not healthy with the new database (${r.error})`);
      (r.ok ? ctx.log : ctx.warn)(`${d.server_name}: ${r.ok ? `HTTP ${r.code}` : r.error}`);
    }

    update('projects', projectId, {
      db_server_id: dbs.id,
      shared_db: JSON.stringify({ name: dbName, user, password: encrypt(pw), host: dbs.bind_ip, port: dbs.port, redis: !!(dbs.redis && p.redis !== false), moved_at: now(), from: source.server_name }),
    });
    ctx.log(`Done. All servers of ${project.name} now use the database on ${dbServer.name}. The old database containers are untouched (stop them when you're sure).`);
  } catch (e) {
    if (edited.length) {
      ctx.step('Something failed — putting the old .env files back');
      for (const d of edited) {
        try {
          const conn = await connFor(d);
          const server = getServer(d.server_id);
          await runRemote(ctx, conn, asRoot(server, ENV_RESTORE(`${d.app_dir}/.env`)), { quiet: true, signal: null });
          await restartApp(ctx, conn, server, d);
        } catch (e2) {
          ctx.warn(`${d.server_name}: could not restore .env (${e2.message}) — copy .env.switchboard-bak back by hand!`);
        }
      }
    }
    throw e;
  } finally {
    if (maint) {
      try {
        await setMaintenance(ctx, srcConn, project, source, false, { signal: null });
      } catch (e) {
        ctx.warn(`Could not turn maintenance off at ${source.server_name}: ${e.message}`);
      }
    }
    srcConn.end();
    dbConn?.end();
    for (const c of conns.values()) c.end();
  }
}

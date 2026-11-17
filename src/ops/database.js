import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { config } from '../config.js';
import { decrypt } from '../crypto.js';
import { all, insert, run, update, now } from '../db.js';
import { exec } from '../ssh.js';
import { getServer } from '../models.js';
import { byteCounter, fmtBytes, lastLines, slugify } from '../util.js';
import { queueUpload, removeBackupFiles } from './backupstore.js';
import { dockerExec, runRemote, PIPEFAIL } from './remote.js';

/*
 * All database commands run *inside the DB container* with `docker exec`, so the
 * servers need nothing installed except Docker. Credentials: if no password is
 * saved in Switchboard, the container's own env (MYSQL_ROOT_PASSWORD,
 * MYSQL_PASSWORD, POSTGRES_PASSWORD, *_FILE secrets) is used.
 */

// --- MySQL / MariaDB -------------------------------------------------------
const MYSQL_AUTH = [
  'U="${SB_U:-root}"',
  'if [ -n "$SB_P" ]; then P="$SB_P"',
  'elif [ "$U" = root ]; then P="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"',
  '  if [ -z "$P" ] && [ -n "${MYSQL_ROOT_PASSWORD_FILE:-}" ]; then P="$(cat "$MYSQL_ROOT_PASSWORD_FILE")"; fi',
  '  if [ -z "$P" ] && [ -n "${MARIADB_ROOT_PASSWORD_FILE:-}" ]; then P="$(cat "$MARIADB_ROOT_PASSWORD_FILE")"; fi',
  'else P="${MYSQL_PASSWORD:-${MARIADB_PASSWORD:-}}"',
  '  if [ -z "$P" ] && [ -n "${MYSQL_PASSWORD_FILE:-}" ]; then P="$(cat "$MYSQL_PASSWORD_FILE")"; fi',
  '  if [ -z "$P" ] && [ -n "${MARIADB_PASSWORD_FILE:-}" ]; then P="$(cat "$MARIADB_PASSWORD_FILE")"; fi',
  'fi',
  'D="${SB_DB:-${MYSQL_DATABASE:-${MARIADB_DATABASE:-}}}"',
  'if [ -z "$D" ]; then echo "Database name is not set (set it in Switchboard, or MYSQL_DATABASE in the container)" >&2; exit 2; fi',
  'case "$D" in *[!A-Za-z0-9_-]*) echo "Unsupported characters in database name: $D" >&2; exit 2;; esac',
  'set --',
  'if [ -n "$P" ]; then set -- "-p$P"; fi',
].join('\n');

const MYSQL_CLI = 'CLI="$(command -v mariadb || command -v mysql)" || { echo "mysql/mariadb client not found in the container" >&2; exit 127; }';
const MYSQL_DUMP = 'DUMP="$(command -v mariadb-dump || command -v mysqldump)" || { echo "mysqldump/mariadb-dump not found in the container" >&2; exit 127; }';

// --- PostgreSQL --------------------------------------------------------------
const PG_AUTH = [
  'U="${SB_U:-${POSTGRES_USER:-postgres}}"',
  'if [ -n "$SB_P" ]; then export PGPASSWORD="$SB_P"',
  'elif [ -n "${POSTGRES_PASSWORD:-}" ]; then export PGPASSWORD="$POSTGRES_PASSWORD"',
  'elif [ -n "${POSTGRES_PASSWORD_FILE:-}" ]; then export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"',
  'fi',
  'D="${SB_DB:-${POSTGRES_DB:-$U}}"',
  'case "$D" in *[!A-Za-z0-9_-]*) echo "Unsupported characters in database name: $D" >&2; exit 2;; esac',
].join('\n');

// Drops every user schema so the restore is an exact mirror (runs in the same transaction as the restore).
const PG_RESET_SQL =
  "DO $$ DECLARE s text; BEGIN FOR s IN SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' LOOP EXECUTE format('DROP SCHEMA %I CASCADE', s); END LOOP; END $$; CREATE SCHEMA IF NOT EXISTS public;";

const dbEnv = (dep) => ({ SB_U: dep.db_user || '', SB_P: decrypt(dep.db_password) || '', SB_DB: dep.db_name || '' });

export function requireDb(dep) {
  if (!dep.db_type || dep.db_type === 'none') throw new Error(`${dep.server_name}: no database configured for this project`);
  if (!dep.db_container) throw new Error(`${dep.server_name}: the database container name is not set (edit the server in this project)`);
}

const isPg = (dep) => dep.db_type === 'postgres';

export function dumpCommand(server, dep) {
  requireDb(dep);
  const script = isPg(dep)
    ? `${PG_AUTH}\nexec pg_dump -U "$U" -d "$D" --no-owner --no-privileges`
    : [
        MYSQL_AUTH,
        MYSQL_DUMP,
        'X=""',
        `if "$DUMP" --help 2>/dev/null | grep -q -- '--set-gtid-purged'; then X="--set-gtid-purged=OFF"; fi`,
        'exec "$DUMP" -u"$U" "$@" --single-transaction --quick --routines --triggers --events --hex-blob --no-tablespaces --default-character-set=utf8mb4 $X "$D"',
      ].join('\n');
  return `${PIPEFAIL}${dockerExec(server, dep.db_container, script, { env: dbEnv(dep) })} | gzip -c`;
}

/** MySQL: drop & recreate the database (same charset/collation) so the target becomes an exact copy. */
function mysqlRecreateCommand(server, dep) {
  const script = [
    MYSQL_AUTH,
    MYSQL_CLI,
    `CS="$("$CLI" -u"$U" "$@" -N -B -e "SELECT CONCAT(DEFAULT_CHARACTER_SET_NAME,' ',DEFAULT_COLLATION_NAME) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$D'" 2>/dev/null)"`,
    'CH="${CS%% *}"; CO="${CS#* }"',
    'case "$CH$CO" in ""|*[!A-Za-z0-9_]*) CH=utf8mb4; CO=utf8mb4_unicode_ci;; esac',
    'exec "$CLI" -u"$U" "$@" -e "DROP DATABASE IF EXISTS \\`$D\\`; CREATE DATABASE \\`$D\\` CHARACTER SET $CH COLLATE $CO;"',
  ].join('\n');
  return dockerExec(server, dep.db_container, script, { env: dbEnv(dep) });
}

export function importCommand(server, dep, { recreate = true } = {}) {
  requireDb(dep);
  if (isPg(dep)) {
    const script = `${PG_AUTH}\nexec psql -U "$U" -d "$D" -X -q -v ON_ERROR_STOP=1 --single-transaction ${recreate ? '-c "$SB_PREP" ' : ''}-f -`;
    return `${PIPEFAIL}gunzip -c | ${dockerExec(server, dep.db_container, script, { env: { ...dbEnv(dep), SB_PREP: PG_RESET_SQL }, interactive: true })}`;
  }
  const script = `${MYSQL_AUTH}\n${MYSQL_CLI}\nexec "$CLI" -u"$U" "$@" --default-character-set=utf8mb4 "$D"`;
  // Newer MariaDB dumps start with a "sandbox mode" line that older clients/MySQL reject; drop it.
  return `${PIPEFAIL}gunzip -c | sed '1{/enable the sandbox mode/d;}' | ${dockerExec(server, dep.db_container, script, { env: dbEnv(dep), interactive: true })}`;
}

function countCommand(server, dep) {
  const script = isPg(dep)
    ? `${PG_AUTH}\nexec psql -U "$U" -d "$D" -X -A -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')"`
    : `${MYSQL_AUTH}\n${MYSQL_CLI}\nexec "$CLI" -u"$U" "$@" -N -B -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$D'"`;
  return dockerExec(server, dep.db_container, script, { env: dbEnv(dep) });
}

/** Number of tables in the deployment's database (also used as "test DB connection"). */
export async function countTables(conn, server, dep, { signal } = {}) {
  requireDb(dep);
  const r = await exec(conn, countCommand(server, dep), { timeout: 60000, signal });
  if (r.code !== 0) throw new Error(`${dep.server_name}: cannot query database — ${lastLines(r.stderr || r.stdout) || `exit ${r.code}`}`);
  const n = parseInt(r.stdout.trim().split('\n').pop(), 10);
  if (!Number.isFinite(n)) throw new Error(`${dep.server_name}: unexpected output from database: ${r.stdout.slice(0, 200)}`);
  return n;
}

/** Writable that gunzips what it receives and keeps the tail, to verify a dump is complete. */
class GzipTail extends Writable {
  constructor() {
    super();
    this.gz = zlib.createGunzip();
    this.tail = Buffer.alloc(0);
    this.total = 0;
    this.gz.on('data', (c) => {
      this.total += c.length;
      this.tail = Buffer.concat([this.tail, c]).subarray(-2048);
    });
    this.done = new Promise((resolve, reject) => {
      this.gz.on('end', resolve);
      this.gz.on('error', reject);
    });
    this.done.catch(() => {});
  }
  _write(chunk, enc, cb) {
    if (this.gz.write(chunk)) cb();
    else this.gz.once('drain', cb);
  }
  _final(cb) {
    this.gz.end();
    cb();
  }
  text() {
    return this.tail.toString('utf8');
  }
}

/** Stream a gzipped dump to a local file and verify it ends with the dump-complete marker. */
export async function dumpToFile(ctx, conn, server, dep, file, { signal } = {}) {
  const tmp = `${file}.part`;
  const out = fs.createWriteStream(tmp);
  const pass = byteCounter((n) => ctx?.log(`  … ${fmtBytes(n)} received`));
  const tail = new GzipTail();
  pass.pipe(out);
  pass.pipe(tail);
  try {
    const r = await exec(conn, dumpCommand(server, dep), {
      pipeTo: pass,
      signal: signal === undefined ? ctx?.signal : signal || undefined,
      onStderr: ctx ? (d) => ctx.output(d, 'e') : undefined,
    });
    await finished(out);
    const gzError = await tail.done.then(() => null, (e) => e);
    if (r.code !== 0) throw new Error(`Database dump failed on ${dep.server_name} (exit ${r.code}): ${lastLines(r.stderr) || 'no error output'}`);
    if (gzError) throw new Error(`Dump from ${dep.server_name} is not valid gzip data: ${gzError.message}`);
    const marker = isPg(dep) ? '-- PostgreSQL database dump complete' : '-- Dump completed';
    if (!tail.text().includes(marker)) throw new Error(`Dump from ${dep.server_name} looks incomplete (end marker missing). Stopped to protect your data.`);
    fs.renameSync(tmp, file);
    return { size: pass.total, raw: tail.total };
  } catch (e) {
    pass.destroy();
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Load a .sql.gz file into a deployment's database (replacing it when `recreate`). */
export async function importFromFile(ctx, conn, server, dep, file, { signal, recreate = true } = {}) {
  requireDb(dep);
  const sig = signal === undefined ? ctx?.signal : signal || undefined;
  if (recreate && !isPg(dep)) {
    ctx?.log(`Recreating database on ${dep.server_name} (exact copy, removes tables that are not in the source)…`);
    await runRemote(ctx, conn, mysqlRecreateCommand(server, dep), { signal: sig || null, timeout: 300000 });
  }
  const size = fs.statSync(file).size;
  const input = fs.createReadStream(file).pipe(byteCounter((n) => ctx?.log(`  … imported ${Math.round((n / size) * 100)}% (${fmtBytes(n)} of ${fmtBytes(size)})`)));
  const r = await exec(conn, importCommand(server, dep, { recreate }), {
    stdin: input,
    signal: sig,
    onStderr: ctx ? (d) => ctx.output(d, 'e') : undefined,
  });
  if (r.code !== 0) throw new Error(`Import into ${dep.server_name} failed (exit ${r.code}): ${lastLines(r.stderr) || 'no error output'}`);
}

// --- backup files --------------------------------------------------------------
export function backupFilePath(project, dep, kind) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dir = path.join(config.backupDir, project.slug);
  fs.mkdirSync(dir, { recursive: true });
  const base = `${stamp}-${slugify(dep.server_name)}-${kind}`;
  let file = path.join(dir, `${base}.sql.gz`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base}-${i}.sql.gz`);
  return file;
}

export const backupAbsPath = (b) => path.join(config.backupDir, b.file);

export function recordBackup(project, dep, kind, file, size, tables, note) {
  const rel = path.relative(config.backupDir, file);
  const id = insert('backups', {
    project_id: project.id,
    deployment_id: dep.id,
    server_name: dep.server_name,
    db_type: dep.db_type,
    db_name: dep.db_name || null,
    kind,
    file: rel,
    size,
    tables: tables ?? null,
    note: note || null,
    created_at: now(),
  });
  queueUpload(id); // to S3 in the background, when S3 storage is on
  return { id, file: rel, path: file };
}

/** Keep the newest N backups of each automatic kind. Manual backups are never auto-deleted. */
export function pruneBackups(project) {
  const keep = Math.max(1, Number(project.backup_keep) || 7);
  for (const kind of ['scheduled', 'sync', 'pre-sync', 'pre-restore']) {
    const old = all('SELECT * FROM backups WHERE project_id = ? AND kind = ? ORDER BY id DESC LIMIT -1 OFFSET ?', project.id, kind, keep);
    for (const b of old) {
      removeBackupFiles(b);
      run('DELETE FROM backups WHERE id = ?', b.id);
    }
  }
}

/** Dump one deployment's database into the backup folder. */
export async function backupDeployment(ctx, conn, project, dep, kind, note) {
  const server = getServer(dep.server_id);
  let tables = null;
  try {
    tables = await countTables(conn, server, dep, { signal: ctx?.signal });
  } catch (e) {
    ctx?.warn(e.message);
  }
  const file = backupFilePath(project, dep, kind);
  const d = await dumpToFile(ctx, conn, server, dep, file);
  const b = recordBackup(project, dep, kind, file, d.size, tables, note);
  ctx?.log(`Saved backup #${b.id}: ${path.basename(file)} — ${fmtBytes(d.size)} compressed${tables != null ? `, ${tables} tables` : ''}`);
  return { ...b, size: d.size, tables };
}

/**
 * Copy the database from `source` to `target`:
 * dump source → (optional) safety backup of target → replace target → verify table count.
 * If the import fails, the target is automatically restored from the safety backup.
 */
export async function syncDatabase(ctx, { project, source, target, srcConn, dstConn, backupTarget = true, sourceLive = false }) {
  requireDb(source);
  requireDb(target);
  if (isPg(source) !== isPg(target)) throw new Error(`Database types differ (${source.db_type} on ${source.server_name}, ${target.db_type} on ${target.server_name})`);
  const srcServer = getServer(source.server_id);
  const dstServer = getServer(target.server_id);
  const startedAt = now();

  ctx.step(`Dump database on ${source.server_name}`);
  const srcTables = await countTables(srcConn, srcServer, source);
  ctx.log(`Source database has ${srcTables} tables`);
  if (srcTables === 0) throw new Error(`The source database on ${source.server_name} has 0 tables. Refusing to overwrite ${target.server_name} with an empty database — check the DB container/name settings.`);
  const srcFile = backupFilePath(project, source, 'sync');
  const dump = await dumpToFile(ctx, srcConn, srcServer, source, srcFile);
  const snap = recordBackup(project, source, 'sync', srcFile, dump.size, srcTables, `Copied to ${target.server_name}`);
  ctx.log(`Dump OK: ${fmtBytes(dump.size)} compressed (${fmtBytes(dump.raw)} SQL), kept as backup #${snap.id}`);

  let safety = null;
  if (backupTarget) {
    ctx.step(`Safety backup of the current database on ${target.server_name}`);
    try {
      safety = await backupDeployment(ctx, dstConn, project, target, 'pre-sync', `Before copy from ${source.server_name}`);
    } catch (e) {
      throw new Error(`Could not back up the target database first: ${e.message}. (You can untick "back up target first" if the target DB is empty/new.)`);
    }
  }

  ctx.step(`Replace database on ${target.server_name}`);
  try {
    await importFromFile(ctx, dstConn, dstServer, target, srcFile);
    const dstTables = await countTables(dstConn, dstServer, target);
    if (dstTables !== srcTables) throw new Error(`Verification failed: source has ${srcTables} tables but target has ${dstTables}`);
    ctx.log(`Verified: ${dstTables} tables on ${target.server_name} ✓`);
  } catch (e) {
    if (safety) {
      ctx.step(`Copy failed — restoring ${target.server_name} from safety backup #${safety.id}`);
      try {
        await importFromFile(ctx, dstConn, dstServer, target, safety.path, { signal: null });
        ctx.log(`${target.server_name} was restored to how it was before.`);
      } catch (e2) {
        ctx.warn(`Automatic restore failed too: ${e2.message}. The safety backup is kept as #${safety.id}.`);
      }
    }
    throw e;
  }
  update('deployments', target.id, {
    data_at: sourceLive ? startedAt : source.data_at || startedAt,
    data_note: `Copied from ${source.server_name}`,
  });
  pruneBackups(project);
  return { tables: srcTables, size: dump.size };
}

#!/usr/bin/env node
// Extra end-to-end checks: PostgreSQL, MariaDB, automatic rollback of a failed import, cancelling a job.
// Needs the lab + extra databases:  docker compose -f dev/docker-compose.yml --profile extra up -d
// and the servers created by dev/e2e.mjs (run that first).
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SB_URL || 'http://localhost:8090';
const SB = 'switchboard-dev-switchboard-1';
let cookie = '';
let failures = 0;

async function api(method, url, body, raw = false) {
  const go = () =>
    fetch(`${BASE}/api${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // Node reuses idle connections; one the server just closed fails with "fetch failed" before anything is sent.
  const res = await go().catch((e) => (e.message === 'fetch failed' ? go() : Promise.reject(e)));
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) cookie = c.split(';')[0];
  if (raw) return Buffer.from(await res.arrayBuffer());
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
  return data;
}
const sh = (cmd, input) => execSync(cmd, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = (c, q) => sh(`docker exec ${c} psql -U app -d shop -At -c "${q}"`);
const maria = (c, pass, q) => sh(`docker exec ${c} mariadb -uroot -p${pass} -N -B shop -e "${q}" 2>/dev/null`);
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
async function waitJob(job, expect = 'success') {
  for (let i = 0; i < 300; i++) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-30).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error.slice(0, 160)})` : ''}`);
      return j;
    }
    await sleep(700);
  }
  throw new Error('job did not finish in time');
}
async function waitFor(fn, label) {
  for (let i = 0; i < 60; i++) {
    try {
      if (fn()) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`${label} not ready`);
}

await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
const servers = await api('GET', '/servers');
const A = servers.find((s) => s.name === 'Server A');
const B = servers.find((s) => s.name === 'Server B');
if (!A || !B) throw new Error('Run dev/e2e.mjs first (it creates Server A and B)');
for (const p of await api('GET', '/projects')) if (p.name !== 'Home Electric Shop' && !p.parent_id) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });

async function makeProject(name, dbType, dbA, dbB) {
  const p = await api('POST', '/projects', { name, domain: 'shop.test', health_scheme: 'http', health_path: '/up' });
  const a = await api('POST', `/projects/${p.id}/deployments`, { server_id: A.id, db_type: dbType, db_container: dbA, db_name: 'shop', app_container: 'a-app' });
  const b = await api('POST', `/projects/${p.id}/deployments`, { server_id: B.id, db_type: dbType, db_container: dbB, db_name: 'shop', app_container: 'b-app' });
  await api('POST', `/projects/${p.id}/adopt`, { deployment: a.id });
  return { p, a, b };
}

await step('PostgreSQL: copy A → B (exact mirror incl. extra schema)', async () => {
  await waitFor(() => pg('pa-db', 'SELECT 1') === '1' && pg('pb-db', 'SELECT 1') === '1', 'postgres');
  pg('pa-db', 'DROP SCHEMA IF EXISTS reporting CASCADE; DROP TABLE IF EXISTS orders, products CASCADE');
  pg('pa-db', "CREATE TABLE products (id serial PRIMARY KEY, name text NOT NULL, price numeric(10,2)); INSERT INTO products (name, price) VALUES ('Fan', 45), ('LED ✓ ភ្លើង', 2.5)");
  pg('pa-db', 'CREATE TABLE orders (id bigserial PRIMARY KEY, product_id int REFERENCES products(id), qty int); INSERT INTO orders (product_id, qty) SELECT 1 + (g % 2), g FROM generate_series(1, 500) g');
  pg('pa-db', 'CREATE SCHEMA reporting; CREATE VIEW reporting.sales AS SELECT p.name, sum(o.qty) AS qty FROM orders o JOIN products p ON p.id = o.product_id GROUP BY p.name');
  pg('pb-db', 'DROP SCHEMA IF EXISTS junk CASCADE; CREATE SCHEMA junk; CREATE TABLE junk.old (x int); CREATE TABLE IF NOT EXISTS public.leftover (y int)');
  const { p, a, b } = await makeProject('PG Shop', 'postgres', 'pa-db', 'pb-db');
  const t = await api('POST', `/servers/${A.id}/test-db`, { db_type: 'postgres', db_container: 'pa-db', db_name: 'shop' });
  check(t.ok && t.tables === 3, `test-db: ${t.tables ?? t.error} tables`);
  const { job } = await api('POST', `/projects/${p.id}/sync`, { source: a.id, target: b.id });
  await waitJob(job);
  check(pg('pb-db', 'SELECT count(*) FROM orders') === '500', '500 orders on B');
  check(pg('pb-db', "SELECT name FROM products WHERE id = 2") === 'LED ✓ ភ្លើង', 'unicode intact');
  check(pg('pb-db', 'SELECT qty FROM reporting.sales ORDER BY name LIMIT 1') !== '', 'view in extra schema copied');
  check(pg('pb-db', "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'junk'") === '0', 'old junk schema removed');
  check(pg('pb-db', "SELECT count(*) FROM information_schema.tables WHERE table_name = 'leftover'") === '0', 'leftover table removed');
  check(pg('pb-db', "SELECT nextval('orders_id_seq')") === '501', 'sequence continues at 501');
  pg('pa-db', 'INSERT INTO orders (product_id, qty) VALUES (1, 7)');
  const again = await api('POST', `/projects/${p.id}/sync`, { source: a.id, target: b.id });
  await waitJob(again.job);
  check(pg('pb-db', 'SELECT count(*) FROM orders') === '501', 'second copy over existing data works (501 orders)');
  const bk = await api('POST', `/deployments/${a.id}/backup`, {});
  await waitJob(bk.job);
  const backup = (await api('GET', `/projects/${p.id}/backups`)).find((x) => x.kind === 'manual');
  pg('pb-db', 'DELETE FROM orders');
  const r = await api('POST', `/backups/${backup.id}/restore`, { target: b.id });
  await waitJob(r.job);
  check(pg('pb-db', 'SELECT count(*) FROM orders') === '501', 'restore brought back 501 orders');
});

let maria1;
await step('MariaDB 11: copy A → B (mariadb-dump, sandbox line)', async () => {
  await waitFor(() => maria('ma-db', 'mariapass-a', 'SELECT 1') === '1' && maria('mb-db', 'mariapass-b', 'SELECT 1') === '1', 'mariadb');
  sh('docker exec -i ma-db mariadb -uroot -pmariapass-a -e "DROP DATABASE IF EXISTS shop; CREATE DATABASE shop"');
  sh('docker exec -i ma-db mariadb -uroot -pmariapass-a --default-character-set=utf8mb4 shop', require_seed());
  maria1 = await makeProject('Maria Shop', 'mysql', 'ma-db', 'mb-db');
  const { p, a, b } = maria1;
  const { job } = await api('POST', `/projects/${p.id}/sync`, { source: a.id, target: b.id });
  await waitJob(job);
  check(maria('mb-db', 'mariapass-b', 'SELECT COUNT(*) FROM orders') === '3', '3 orders on B');
  check(maria('mb-db', 'mariapass-b', 'SELECT COUNT(*) FROM order_totals') === '3', 'view works on B');
  const dump = zlib.gunzipSync(await api('GET', `/backups/${(await api('GET', `/projects/${p.id}/backups`)).find((x) => x.kind === 'sync').id}/download`, undefined, true)).toString();
  console.log(`      first line of dump: ${dump.split('\n')[0].slice(0, 70)}`);
});

function require_seed() {
  return execSync(`cat ${path.join(DIR, 'seed.sql')}`, { encoding: 'utf8' });
}

await step('Failed import is rolled back automatically', async () => {
  const { p, b } = maria1;
  maria('mb-db', 'mariapass-b', "INSERT INTO orders (user_id, product_id, qty, note) VALUES (1, 1, 9, 'must survive')");
  const before = maria('mb-db', 'mariapass-b', 'SELECT COUNT(*) FROM orders');
  // Build a broken backup: a valid dump with a bad statement half-way.
  const good = (await api('GET', `/projects/${p.id}/backups`)).find((x) => x.kind === 'sync');
  const sqlText = zlib.gunzipSync(await api('GET', `/backups/${good.id}/download`, undefined, true)).toString();
  const cut = sqlText.indexOf('INSERT INTO `orders`');
  const broken = `${sqlText.slice(0, cut)}THIS IS NOT VALID SQL;\n${sqlText.slice(cut)}`;
  const rel = `maria-shop/broken-${Date.now()}.sql.gz`;
  sh(`docker exec -i ${SB} sh -c 'cat > /data/backups/${rel}'`, zlib.gzipSync(Buffer.from(broken)));
  const inserted = sh(
    `docker exec ${SB} node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/switchboard.db');d.exec('PRAGMA busy_timeout=5000');console.log(d.prepare(\\"INSERT INTO backups (project_id, deployment_id, server_name, db_type, db_name, kind, file, size, tables, created_at) VALUES (?, ?, 'Server A', 'mysql', 'shop', 'manual', ?, 1, 5, ?)\\").run(${p.id}, ${maria1.a.id}, '${rel}', new Date().toISOString()).lastInsertRowid)"`,
  );
  const r = await api('POST', `/backups/${inserted}/restore`, { target: b.id });
  const j = await waitJob(r.job, 'failed');
  check(/ERROR 1064|syntax/i.test(j.error || ''), `failed on the bad SQL statement: ${(j.error || '').slice(0, 90)}`);
  check(/back to how it was/.test(j.log), 'log says the target was put back');
  check(maria('mb-db', 'mariapass-b', 'SELECT COUNT(*) FROM orders') === before, `target still has its ${before} orders`);
  check(maria('mb-db', 'mariapass-b', "SELECT COUNT(*) FROM orders WHERE note = 'must survive'") === '1', 'the row written on B survived');
});

await step('Cancel a running job', async () => {
  const { job } = await api('POST', `/servers/${A.id}/command`, { command: 'echo started; sleep 47; echo SHOULD-NOT-PRINT' });
  await sleep(2500);
  await api('POST', `/jobs/${job.id}/cancel`);
  const j = await waitJob(job, 'cancelled');
  check(!/│ SHOULD-NOT-PRINT/.test(j.log), 'no output after cancel');
  await sleep(1500);
  const still = sh('docker exec switchboard-dev-srv-a-1 sh -c "ps -o args | grep -c [s]leep\\ 47 || true"');
  check(still === '0', `remote process killed (running copies: ${still})`);
});

for (const p of await api('GET', '/projects')) if (p.name !== 'Home Electric Shop' && !p.parent_id) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all extra checks passed');
process.exit(failures ? 1 : 0);

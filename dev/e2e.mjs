#!/usr/bin/env node
// End-to-end test against the local lab. Start it first with ./dev/setup.sh, then: node dev/e2e.mjs
// Uses the real API exactly like the dashboard does, and checks results in MySQL / fake Cloudflare / containers.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SB_URL || 'http://localhost:8090';
const CF = 'http://localhost:8787';
const KEY = fs.readFileSync(path.join(DIR, '.keys/id_ed25519'), 'utf8');
let cookie = '';
let failures = 0;

async function api(method, url, body) {
  const go = () =>
    fetch(`${BASE}/api${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // Node reuses idle connections; one the server just closed fails with "fetch failed" before anything is sent.
  const res = await go().catch((e) => (e.message === 'fetch failed' ? go() : Promise.reject(e)));
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) cookie = c.split(';')[0];
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
  return data;
}
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const shOk = (cmd) => {
  try {
    sh(cmd);
    return true;
  } catch {
    return false;
  }
};
const sql = (db, pass, q) => sh(`docker exec ${db} mysql -uroot -p${pass} -N -B --default-character-set=utf8mb4 shop -e "${q}" 2>/dev/null`);
const A = { db: 'a-db', pass: 'rootpass-a', app: 'a-app' };
const B = { db: 'b-db', pass: 'rootpass-b', app: 'b-app' };
const cfIps = async () => {
  const s = await (await fetch(`${CF}/__state`)).json();
  return Object.fromEntries(s.records.map((r) => [r.name, r.content]));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inMaintenance = (app) => shOk(`docker exec ${app} test -f /shared/down`);

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
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error})` : ''}`);
      return j;
    }
    await sleep(700);
  }
  throw new Error('job did not finish in time');
}

let project;
let depA;
let depB;

await step('Reset the lab', async () => {
  await fetch(`${CF}/__reset`);
  for (const app of [A.app, B.app]) sh(`docker exec ${app} rm -f /shared/down /shared/broken`);
  sh('docker exec b-app sh -c "rm -rf /var/www/html/storage/app/public/*"');
  sh(`docker exec a-db mysql -uroot -p${A.pass} -e "DROP DATABASE IF EXISTS shop; CREATE DATABASE shop" 2>/dev/null`);
  sh(`docker exec -i a-db mysql -uroot -p${A.pass} --default-character-set=utf8mb4 shop < ${path.join(DIR, 'seed.sql')} 2>/dev/null`);
  sh(`docker exec b-db mysql -uroot -p${B.pass} -e "DROP DATABASE IF EXISTS shop; CREATE DATABASE shop" 2>/dev/null`);
  check(sql(A.db, A.pass, 'SELECT COUNT(*) FROM orders') === '3', 'server A seeded with 3 orders, server B empty');
});

await step('Log in and configure Cloudflare', async () => {
  await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
  await api('PUT', '/settings', { cf_token: 'test-token', check_interval: 15, metrics_interval: 60, telegram_token: '123456:TEST', telegram_chat_id: '987654' });
  const n = await api('POST', '/settings/notify/test', {});
  check(n.ok && n.sent.includes('telegram'), 'Telegram test message sent');
  const t = await api('POST', '/settings/cloudflare/test', {});
  check(t.ok && t.zones === 2, `Cloudflare token works (${t.zones} zones)`);
});

await step('Add servers A and B over SSH', async () => {
  for (const p of await api('GET', '/projects')) if (!p.parent_id) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug }); // staging copies go with their project
  for (const s of await api('GET', '/servers')) await api('DELETE', `/servers/${s.id}`);
  const base = { ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY };
  const t = await api('POST', '/servers/test', { ...base, name: 'Server A', ip: '172.30.0.11' });
  check(t.ok && t.docker_ok, `SSH test: ${t.uname || t.error} / docker ${t.docker}`);
  const a = await api('POST', '/servers', { ...base, name: 'Server A', ip: '172.30.0.11' });
  const b = await api('POST', '/servers', { ...base, name: 'Server B', ip: '172.30.0.12' });
  check(a.id && b.id, 'servers saved');
  const disc = await api('GET', `/servers/${a.id}/discover?hint=a-db`);
  check(disc.containers.some((c) => c.name === 'a-db' && c.kind === 'db'), `discover found ${disc.containers.length} containers incl. a-db (suggested db_name=${disc.suggestion.db_name})`);
  globalThis.srv = { a, b };
});

await step('Create project with Cloudflare records', async () => {
  const zones = await api('GET', '/cloudflare/zones');
  const zone = zones.find((z) => z.name === 'shop.test');
  const recs = (await api('GET', `/cloudflare/zones/${zone.id}/records`)).filter((r) => ['shop.test', 'www.shop.test'].includes(r.name));
  project = await api('POST', '/projects', {
    name: 'Home Electric Shop',
    domain: 'shop.test',
    health_scheme: 'http',
    health_path: '/up',
    dns_records: recs.map((r) => ({ zone_id: zone.id, zone_name: zone.name, id: r.id, name: r.name, type: r.type })),
  });
  await api('PUT', `/projects/${project.id}`, { name: project.name, sync_paths: 'app:/var/www/html/storage/app/public' });
  const common = { db_type: 'mysql', db_name: 'shop' };
  const tdb = await api('POST', `/servers/${srv.a.id}/test-db`, { ...common, db_container: 'a-db' });
  check(tdb.ok && tdb.tables === 5, `test DB on A: ${tdb.tables ?? tdb.error} tables (4 tables + 1 view)`);
  depA = await api('POST', `/projects/${project.id}/deployments`, { ...common, server_id: srv.a.id, app_container: 'a-app', db_container: 'a-db', priority: 10 });
  depB = await api('POST', `/projects/${project.id}/deployments`, { ...common, server_id: srv.b.id, app_container: 'b-app', db_container: 'b-db', priority: 20 });
  await api('POST', `/projects/${project.id}/dns/refresh`);
  const p = await api('GET', `/projects/${project.id}`);
  check(p.active_deployment_id === depA.id, 'active server detected from Cloudflare = Server A');
  await api('POST', `/projects/${project.id}/check`);
  const p2 = await api('GET', `/projects/${project.id}`);
  check(p2.deployments.every((d) => d.health === 'up'), `health: ${p2.deployments.map((d) => `${d.server_name}=${d.health} ${d.health_detail?.ms}ms`).join(', ')}`);
});

await step('Copy data A → B (database + files)', async () => {
  const { job } = await api('POST', `/projects/${project.id}/sync`, { source: depA.id, target: depB.id, files: true });
  await waitJob(job);
  check(sql(B.db, B.pass, 'SELECT COUNT(*) FROM orders') === '3', 'B has the 3 orders');
  check(sql(B.db, B.pass, 'SELECT note FROM orders WHERE id=2').includes('ទិញអំពូល'), 'Khmer/unicode text survived');
  check(sql(B.db, B.pass, 'SELECT COUNT(*) FROM order_totals') === '3', 'view copied');
  check(shOk('docker exec b-app test -f /var/www/html/storage/app/public/products/fan.jpg'), 'uploaded files copied to B');
});

await step('Switch A → B with database copy (safe switch)', async () => {
  sql(A.db, A.pass, "INSERT INTO orders (user_id, product_id, qty, note) VALUES (1, 4, 2, 'written on A just before switch')");
  const { job } = await api('POST', `/projects/${project.id}/switch`, { target: depB.id, syncDb: true, syncFiles: true, maintenance: true });
  await waitJob(job);
  const ips = await cfIps();
  check(ips['shop.test'] === '172.30.0.12' && ips['www.shop.test'] === '172.30.0.12', `Cloudflare → B (${ips['shop.test']}, www ${ips['www.shop.test']})`);
  check(ips['mail.shop.test'] === '172.30.0.99', 'unrelated record untouched');
  check(sql(B.db, B.pass, "SELECT COUNT(*) FROM orders WHERE note='written on A just before switch'") === '1', 'last order from A is on B');
  check(inMaintenance(A.app), 'A kept in maintenance mode');
  check(!inMaintenance(B.app), 'B is live (not in maintenance)');
  const p = await api('GET', `/projects/${project.id}`);
  check(p.active_deployment_id === depB.id, 'dashboard shows B as live');
});

await step('Switch back B → A (copies B → A first)', async () => {
  sql(B.db, B.pass, "INSERT INTO orders (user_id, product_id, qty, note) VALUES (2, 1, 1, 'written on B while live')");
  const { job } = await api('POST', `/projects/${project.id}/switch`, { target: depA.id, syncDb: true, maintenance: true, keepOldDown: false });
  await waitJob(job);
  check((await cfIps())['shop.test'] === '172.30.0.11', 'Cloudflare → A');
  check(sql(A.db, A.pass, "SELECT COUNT(*) FROM orders WHERE note='written on B while live'") === '1', 'order written on B is now on A');
  check(!inMaintenance(A.app), 'A live again (maintenance off)');
  check(!inMaintenance(B.app), 'B back online as standby (keepOldDown=false)');
});

await step('Switch is refused safely when the target is broken', async () => {
  sh('docker exec b-app touch /shared/broken');
  const { job } = await api('POST', `/projects/${project.id}/switch`, { target: depB.id, syncDb: false, maintenance: true });
  await waitJob(job, 'failed');
  check((await cfIps())['shop.test'] === '172.30.0.11', 'DNS unchanged (still A)');
  check(!inMaintenance(A.app), 'A not left in maintenance');
  // "Mark as live" + "Point DNS" on a broken server must not send visitors there either.
  await api('POST', `/projects/${project.id}/adopt`, { deployment: depB.id });
  const fix = await api('POST', `/projects/${project.id}/dns/fix`);
  await waitJob(fix.job, 'failed');
  check((await cfIps())['shop.test'] === '172.30.0.11', '"Point DNS" to a broken server refused, DNS unchanged');
  await api('POST', `/projects/${project.id}/adopt`, { deployment: depA.id });
  sh('docker exec b-app rm -f /shared/broken');
});

await step('Backup and restore', async () => {
  const { job } = await api('POST', `/deployments/${depA.id}/backup`, { note: 'e2e' });
  await waitJob(job);
  const backups = await api('GET', `/projects/${project.id}/backups`);
  const b = backups.find((x) => x.kind === 'manual');
  check(b && b.size > 0 && b.tables === 5, `backup #${b?.id} saved (${b?.size} bytes, ${b?.tables} tables)`);
  sql(B.db, B.pass, 'DELETE FROM orders; CREATE TABLE junk (id INT)');
  const r = await api('POST', `/backups/${b.id}/restore`, { target: depB.id });
  await waitJob(r.job);
  check(sql(B.db, B.pass, 'SELECT COUNT(*) FROM orders') === '5', 'orders restored on B');
  check(sql(B.db, B.pass, "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='shop' AND TABLE_NAME='junk'") === '0', 'extra table removed (exact copy)');
  let refused = false;
  try {
    await api('POST', `/backups/${b.id}/restore`, { target: depA.id });
  } catch {
    refused = true;
  }
  check(refused, 'restore into the LIVE server refused without typed confirmation');
});

await step('A broken source dump never touches the target', async () => {
  await api('PUT', `/deployments/${depA.id}`, { app_container: 'a-app', db_type: 'mysql', db_container: 'a-db', db_name: 'does_not_exist', priority: 10 });
  const before = sql(B.db, B.pass, 'SELECT COUNT(*) FROM orders');
  const { job } = await api('POST', `/projects/${project.id}/sync`, { source: depA.id, target: depB.id });
  await waitJob(job, 'failed');
  check(sql(B.db, B.pass, 'SELECT COUNT(*) FROM orders') === before, 'target data unchanged');
  await api('PUT', `/deployments/${depA.id}`, { app_container: 'a-app', db_type: 'mysql', db_container: 'a-db', db_name: 'shop', priority: 10 });
});

await step('Auto-failover when the live server dies', async () => {
  await api('PUT', `/projects/${project.id}`, { name: project.name, auto_failover: true, failover_threshold: 2, failover_cooldown: 0 });
  sh('docker exec a-app touch /shared/broken');
  await api('POST', `/projects/${project.id}/check`);
  await api('POST', `/projects/${project.id}/check`);
  let job = null;
  for (let i = 0; i < 20 && !job; i++) {
    job = (await api('GET', `/jobs?project=${project.id}&limit=5`)).find((j) => j.user === 'auto-failover');
    if (!job) await sleep(500);
  }
  check(!!job, 'auto-failover job started');
  if (job) await waitJob(job);
  check((await cfIps())['shop.test'] === '172.30.0.12', 'Cloudflare → B automatically');
  const p = await api('GET', `/projects/${project.id}`);
  check(p.active_deployment_id === depB.id, 'B is live');
  const a = p.deployments.find((d) => d.id === depA.id);
  check(/has data/.test(a.data_note || ''), `A is flagged as having data B may not have: "${a.data_note}"`);
  await sleep(500);
  const msgs = (await (await fetch(`${CF}/__state`)).json()).telegram.map((m) => m.text);
  check(msgs.some((t) => /Server A \(ACTIVE\) is DOWN/.test(t)), 'Telegram alert: live server is DOWN');
  check(msgs.some((t) => /AUTO-FAILOVER/.test(t)), 'Telegram alert: auto-failover');
  check(msgs.some((t) => /traffic switched Server A → Server B/.test(t)), 'Telegram alert: switch done');
  sh('docker exec a-app rm -f /shared/broken');
  await api('PUT', `/projects/${project.id}`, { name: project.name, auto_failover: false });
});

await step('Deploy script, command, container logs', async () => {
  await api('PUT', `/projects/${project.id}`, { name: project.name, deploy_script: 'echo "deploying on $(hostname)"\nphp artisan migrate --force || true' });
  const { job } = await api('POST', `/projects/${project.id}/deploy`);
  const j = await waitJob(job);
  check(/deploying on/.test(j.log), 'deploy output streamed');
  const c = await api('POST', `/deployments/${depB.id}/command`, { command: 'php artisan about', where: 'app' });
  const cj = await waitJob(c.job);
  check(/fake/.test(cj.log), 'artisan command ran in the app container');
  const logs = await api('GET', `/servers/${srv.a.id}/containers/a-db/logs?tail=20`);
  check(logs.log.length > 0, 'container logs readable');
  const m = await api('POST', `/servers/${srv.a.id}/refresh`);
  check(m.ok && m.server.metrics.containers.length > 0 && m.server.metrics.mem_total > 0, `metrics: cpu ${m.server.metrics.cpu_pct}% mem ${m.server.metrics.mem_pct}% disk ${m.server.metrics.disk_pct}% · ${m.server.metrics.containers.length} containers`);
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);

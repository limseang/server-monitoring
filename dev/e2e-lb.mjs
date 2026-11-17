#!/usr/bin/env node
// End-to-end test for load balancing + shared database server + scale-out + busy alerts.
// Needs the lab (./dev/setup.sh) and the VPS set (./dev/clone-setup.sh). Then: node dev/e2e-lb.mjs
//   vps-src (.21) runs the app · vps-new (.22) blank → added with "Add server"
//   vps-db  (.23) becomes the database server · vps-lb (.24) blank → nginx load balancer
// Only touches those containers and the lab dashboard (it removes the lab's test projects/servers first).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SB_URL || 'http://localhost:8090';
const CF = 'http://localhost:8787';
const KEY = fs.readFileSync(path.join(DIR, '.keys/id_ed25519'), 'utf8');
const IP = { src: '172.30.0.21', new: '172.30.0.22', db: '172.30.0.23', lb: '172.30.0.24' };
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
const on = (vps, cmd) => sh(`docker exec ${vps} sh -c ${JSON.stringify(cmd)}`);
const onOk = (vps, cmd) => {
  try {
    on(vps, cmd);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cfState = async () => (await fetch(`${CF}/__state`)).json();
const viaLb = (host = 'shop.test') => on('vps-lb', `curl -s --max-time 5 -H 'Host: ${host}' http://localhost/`);
const canConnect = (from, ip, port) => onOk(from, `timeout 4 bash -c '</dev/tcp/${ip}/${port}'`);

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
async function waitJob(job, expect = 'success', minutes = 25) {
  for (let i = 0; i < minutes * 60; i++) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-40).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error.slice(0, 200)})` : ''}`);
      return j;
    }
    await sleep(1000);
  }
  throw new Error('job did not finish in time');
}
const proj = () => api('GET', `/projects/${project.id}`);
const dep = async (server) => (await proj()).deployments.find((d) => d.server_id === server.id);

let S = {};
let project;

await step('Reset the VPSs and the dashboard', async () => {
  sh(`${path.join(DIR, 'clone-setup.sh')} reset-lb`);
  // A previous (failed) run may have left vps-src's app stopped or its .env changed.
  on('vps-src', 'docker start shop-app-1 >/dev/null; f=/srv/shop/.env; [ -f $f.switchboard-bak ] && cp $f.switchboard-bak $f && rm -f $f.switchboard-bak; true');
  for (let i = 0; i < 20 && !onOk('vps-src', 'curl -sf localhost:8080/up'); i++) await sleep(500);
  await fetch(`${CF}/__reset`);
  for (let i = 0; i < 30 && !onOk('vps-lb', 'pgrep sshd'); i++) await sleep(500);
  check(on('vps-src', 'curl -s localhost:8080/up') === 'ok vps-src', 'vps-src app answers "ok vps-src"');
  await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
  await api('PUT', '/settings', { cf_token: 'test-token', check_interval: 15, telegram_token: '123456:TEST', telegram_chat_id: '987654', busy_cpu_pct: 80, busy_mem_pct: 90, busy_minutes: 10 });
  for (const p of await api('GET', '/projects')) if (!p.parent_id) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug }); // staging copies go with their project
  for (const s of await api('GET', '/servers')) await api('DELETE', `/servers/${s.id}`);
  const base = { ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY };
  for (const [k, name] of [['src', 'vps-src'], ['new', 'vps-new'], ['db', 'vps-db'], ['lb', 'vps-lb']]) S[k] = await api('POST', '/servers', { ...base, name, ip: IP[k] });
  check(Object.values(S).every((s) => s.id), 'four servers added');
});

await step('Project on vps-src (one live server)', async () => {
  const zones = await api('GET', '/cloudflare/zones');
  const zone = zones.find((z) => z.name === 'shop.test');
  const recs = (await api('GET', `/cloudflare/zones/${zone.id}/records`)).filter((r) => ['shop.test', 'www.shop.test'].includes(r.name));
  project = await api('POST', '/projects', {
    name: 'LB Shop',
    domain: 'shop.test',
    health_scheme: 'http',
    health_port: 8080,
    health_path: '/up',
    dns_records: recs.map((r) => ({ zone_id: zone.id, zone_name: zone.name, id: r.id, name: r.name, type: r.type })),
  });
  await api('PUT', `/projects/${project.id}`, { name: 'LB Shop', failover_threshold: 1, drain_seconds: 5, maintenance_on_cmd: '', maintenance_off_cmd: '', deploy_script: 'echo "deployed on $(hostname)"' });
  const d = await api('POST', `/projects/${project.id}/deployments`, { server_id: S.src.id, app_dir: '/srv/shop', app_container: 'shop-app-1', db_type: 'mysql', db_container: 'shop-db-1', db_name: 'shop' });
  await api('POST', `/projects/${project.id}/adopt`, { deployment: d.id });
  await api('POST', `/projects/${project.id}/check`);
  check((await dep(S.src)).health === 'up', 'vps-src healthy');
});

await step('Load balancing is refused while each server has its own database', async () => {
  const { job } = await api('POST', `/projects/${project.id}/lb/enable`, { provider: 'own', lb_server: S.lb.id });
  const j = await waitJob(job, 'failed');
  check(/share ONE database/.test(j.error || ''), 'explains that the database must be shared first');
  check((await proj()).traffic_mode === 'single', 'project still single-server');
});

await step('Set up the database server on vps-db (MySQL + Redis)', async () => {
  const { job } = await api('POST', '/db-servers', { server: S.db.id, engine: 'mysql', redis: true });
  await waitJob(job);
  const ps = on('vps-db', "docker ps --format '{{.Names}}'");
  check(ps.includes('switchboard-db') && ps.includes('switchboard-redis'), 'switchboard-db and switchboard-redis running');
  const list = await api('GET', '/db-servers');
  check(list.servers[0]?.status === 'ready', 'database server is ready');
  check(!JSON.stringify(list).includes('root_password'), 'passwords not sent to the browser');
});

await step('Move the shop database to vps-db', async () => {
  const before = on('vps-src', "docker exec shop-db-1 mysql -uroot -prootpass-c -N shop -e 'SELECT COUNT(*) FROM orders' 2>/dev/null");
  const dbs = (await api('GET', '/db-servers')).servers[0];
  const { job } = await api('POST', `/projects/${project.id}/db/move`, { db_server: dbs.id });
  await waitJob(job);
  const env = on('vps-src', 'cat /srv/shop/.env');
  check(env.includes(`DB_HOST=${IP.db}`) && env.includes('SESSION_DRIVER=redis') && env.includes(`REDIS_HOST=${IP.db}`), '.env points at the database server (DB + Redis)');
  check(env.includes('APP_KEY=base64:clonetestkey'), 'other .env lines kept');
  check(onOk('vps-src', 'test -f /srv/shop/.env.switchboard-bak'), 'old .env kept as .env.switchboard-bak');
  const user = env.match(/^DB_USERNAME=(.*)$/m)[1];
  const pw = env.match(/^DB_PASSWORD=(.*)$/m)[1];
  // Connect from the app server over the network, with the app's own credentials.
  const n = on('vps-src', `docker exec shop-db-1 mysql -h ${IP.db} -u${user} -p${pw} -N shop -e 'SELECT COUNT(*) FROM orders' 2>/dev/null`);
  check(n === before && n !== '', `vps-src reads the moved data over the network (${n} orders = ${before})`);
  check(canConnect('vps-src', IP.db, 3306), 'vps-src may connect to MySQL on vps-db');
  check(!canConnect('vps-lb', IP.db, 3306), 'vps-lb (not an app server) is blocked by the firewall');
  check(!canConnect('vps-lb', IP.db, 6379), 'Redis blocked for vps-lb too');
  const p = await proj();
  check(p.shared_db?.host === IP.db && !('password' in p.shared_db), 'project shows the shared database (no password)');
  const { job: b } = await api('POST', `/projects/${project.id}/backup-shared`);
  await waitJob(b);
});

await step('Turn on load balancing with my own nginx on vps-lb', async () => {
  const { job } = await api('POST', `/projects/${project.id}/lb/enable`, { provider: 'own', lb_server: S.lb.id, method: 'round_robin' });
  await waitJob(job);
  check(onOk('vps-lb', 'nginx -t'), 'nginx installed on vps-lb and config valid');
  check(viaLb() === 'ok vps-src', `request through the load balancer → "${viaLb()}"`);
  const recs = (await cfState()).records;
  check(recs.find((r) => r.name === 'shop.test').content === IP.lb && recs.find((r) => r.name === 'www.shop.test').content === IP.lb, 'Cloudflare DNS → vps-lb');
  check(recs.find((r) => r.name === 'mail.shop.test').content === '172.30.0.99', 'unrelated record untouched');
  const p = await proj();
  check(p.traffic_mode === 'lb' && p.deployments[0].lb_state === 'active', 'project is load balanced, vps-src gets visitors');
  const dns = await api('POST', `/projects/${project.id}/dns/refresh`);
  check(dns && !dns.drift, 'no DNS drift reported (records point at the LB)');
});

await step('Add server: clone vps-src onto blank vps-new and put it in the pool', async () => {
  const { job } = await api('POST', `/projects/${project.id}/lb/scale-out`, { server: S.new.id });
  await waitJob(job);
  const d = await dep(S.new);
  check(d?.lb_state === 'active', 'vps-new is in the load balancer');
  const seen = new Set();
  for (let i = 0; i < 12; i++) seen.add(viaLb());
  check(seen.has('ok vps-src') && seen.has('ok vps-new'), `visitors spread over both servers (${[...seen].join(', ')})`);
  check(canConnect('vps-new', IP.db, 3306), 'vps-new allowed through the database firewall');
  check(on('vps-new', 'cat /srv/shop/.env').includes(`DB_HOST=${IP.db}`), 'vps-new uses the shared database');
});

await step('Switch to vps-new with NO downtime (requests keep running during the switch)', async () => {
  on('vps-lb', 'rm -f /tmp/codes; touch /tmp/run');
  sh(`docker exec -d vps-lb sh -c ${JSON.stringify("while [ -f /tmp/run ]; do curl -s -o /dev/null -w '%{http_code}\\n' --max-time 5 -H 'Host: shop.test' http://localhost/ >> /tmp/codes; sleep 0.05; done")}`);
  await sleep(1500);
  const { job } = await api('POST', `/projects/${project.id}/switch`, { target: (await dep(S.new)).id });
  await waitJob(job);
  await sleep(1500);
  on('vps-lb', 'rm -f /tmp/run');
  await sleep(500);
  const codes = on('vps-lb', 'cat /tmp/codes').split('\n').filter(Boolean);
  const bad = codes.filter((c) => c !== '200');
  check(codes.length > 50 && bad.length === 0, `${codes.length} requests during the switch, ${bad.length} failed`);
  const seen = new Set();
  for (let i = 0; i < 8; i++) seen.add(viaLb());
  check(seen.size === 1 && seen.has('ok vps-new'), 'all visitors now on vps-new');
  check((await dep(S.src)).lb_state === 'off', 'vps-src is out of the pool');
  check(/172\.30\.0\.21:8080.* down;/.test(on('vps-lb', 'cat /etc/nginx/conf.d/switchboard-lb-shop.conf')), 'nginx marks vps-src down');
});

await step('Rolling deploy (one server at a time)', async () => {
  const { job: a } = await api('POST', `/projects/${project.id}/lb/member`, { deployment: (await dep(S.src)).id, action: 'add' });
  await waitJob(a);
  const { job } = await api('POST', `/projects/${project.id}/deploy`);
  const j = await waitJob(job);
  check(/rolling deploy/.test(j.log) && /deployed on vps-src/.test(j.log) && /deployed on vps-new/.test(j.log), 'deployed on both, one at a time');
  check(/Take vps-src out/.test(j.log) && /Take vps-new out/.test(j.log), 'each server was taken out during its deploy');
  const p = await proj();
  check(p.deployments.every((d) => d.lb_state === 'active'), 'both back in the pool afterwards');
});

await step('A broken server is taken out automatically and comes back', async () => {
  on('vps-src', 'docker stop shop-app-1 >/dev/null');
  let conf = '';
  for (let i = 0; i < 20; i++) {
    await api('POST', `/projects/${project.id}/check`);
    await sleep(2000);
    conf = on('vps-lb', 'cat /etc/nginx/conf.d/switchboard-lb-shop.conf');
    if (/172\.30\.0\.21:8080.* down;/.test(conf)) break;
  }
  check(/172\.30\.0\.21:8080.* down;/.test(conf), 'nginx took vps-src out when it went down');
  const seen = new Set();
  for (let i = 0; i < 6; i++) seen.add(viaLb());
  check(seen.size === 1 && seen.has('ok vps-new'), 'visitors only reach vps-new');
  on('vps-src', 'docker start shop-app-1 >/dev/null');
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    await api('POST', `/projects/${project.id}/check`);
    await sleep(1000);
    conf = on('vps-lb', 'cat /etc/nginx/conf.d/switchboard-lb-shop.conf');
    if (!/172\.30\.0\.21:8080.* down;/.test(conf)) break;
  }
  check(!/172\.30\.0\.21:8080.* down;/.test(conf), 'vps-src back in nginx once healthy');
  const ev = await api('GET', `/events?project=${project.id}&limit=50`);
  check(ev.some((e) => /load balancer updated — taking out vps-src/.test(e.message)), 'alert: vps-src taken out');
});

await step('Busy server alert', async () => {
  await api('PUT', '/settings', { busy_cpu_pct: 1, busy_mem_pct: 1, busy_minutes: 0 });
  await api('POST', `/servers/${S.new.id}/refresh`);
  const ev = await api('GET', '/events?limit=30');
  check(ev.some((e) => /Server vps-new is BUSY/.test(e.message) && /Add a server to the load balancer of LB Shop/.test(e.message)), 'busy alert suggests adding a server');
  check((await cfState()).telegram.some((m) => /vps-new is BUSY/.test(m.text)), 'busy alert sent to Telegram');
  const s = (await api('GET', '/servers')).find((x) => x.id === S.new.id);
  check(s.metrics?.busy === true, 'server marked BUSY');
  await api('PUT', '/settings', { busy_cpu_pct: 100, busy_mem_pct: 100, busy_minutes: 10 });
  await api('POST', `/servers/${S.new.id}/refresh`);
  check((await api('GET', '/events?limit=10')).some((e) => /vps-new is calm again/.test(e.message)), '"calm again" alert');
  await api('PUT', '/settings', { busy_cpu_pct: 80, busy_mem_pct: 90 });
});

await step('Turn load balancing off → vps-new is the single live server', async () => {
  const { job } = await api('POST', `/projects/${project.id}/lb/disable`, { target: (await dep(S.new)).id });
  await waitJob(job);
  const recs = (await cfState()).records;
  check(recs.find((r) => r.name === 'shop.test').content === IP.new, 'Cloudflare DNS → vps-new directly');
  check(!onOk('vps-lb', 'test -f /etc/nginx/conf.d/switchboard-lb-shop.conf'), 'nginx config removed from vps-lb');
  const p = await proj();
  check(p.traffic_mode === 'single' && p.active_deployment_id === (await dep(S.new)).id, 'project back to one live server');
});

await step('Cloudflare Load Balancing (fake Cloudflare API)', async () => {
  const ids = [(await dep(S.src)).id, (await dep(S.new)).id];
  const { job } = await api('POST', `/projects/${project.id}/lb/enable`, { provider: 'cloudflare', members: ids, sticky: true });
  await waitJob(job);
  let st = (await cfState()).lb;
  check(st.monitors.length === 1 && st.monitors[0].port === 8080 && st.monitors[0].path === '/up', 'health monitor created (port 8080, /up)');
  check(st.pools.length === 1 && st.pools[0].origins.length === 2 && st.pools[0].origins.every((o) => o.enabled), 'pool with both servers enabled');
  check(st.lbs.map((l) => l.name).sort().join(',') === 'shop.test,www.shop.test', 'one load balancer per hostname');
  check(st.lbs.every((l) => l.session_affinity === 'cookie' && l.proxied), 'sticky sessions + proxied');
  const info = await api('GET', `/projects/${project.id}/lb`);
  check(info.cloudflare_health?.[IP.src] === true && info.cloudflare_health?.[IP.new] === true, 'Cloudflare health shown for both');
  const { job: d } = await api('POST', `/projects/${project.id}/lb/member`, { deployment: ids[0], action: 'drain' });
  await waitJob(d);
  st = (await cfState()).lb;
  check(st.pools[0].origins.find((o) => o.address === IP.src).enabled === false && st.pools[0].origins.find((o) => o.address === IP.new).enabled, 'drain disables vps-src in the pool');
  const { job: off } = await api('POST', `/projects/${project.id}/lb/disable`, { target: ids[1] });
  await waitJob(off);
  st = await cfState();
  check(!st.lb.lbs.length && !st.lb.pools.length && !st.lb.monitors.length, 'load balancers, pool and monitor removed');
  check(st.records.find((r) => r.name === 'shop.test').content === IP.new, 'DNS points at vps-new');
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ All load balancer checks passed');
process.exit(failures ? 1 : 0);

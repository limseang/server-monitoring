#!/usr/bin/env node
// End-to-end test for "Database access" (another service uses a project's database through one
// host name that follows the live server). Needs the clone pair (./dev/clone-setup.sh: vps-src with
// the "shop" stack, vps-new with a copy of it — e.g. after e2e-clone or e2e-copy-project) and the
// fake Cloudflare (dev/cf-mock) on the Mac's port 8787. Run a Switchboard ON THE LAB NETWORK:
//   docker build -t sb-dbx-test:dev . && docker run -d --name sb-dbx-test --network switchboard-dev_lab \
//     -p 127.0.0.1:8094:8080 -v "$PWD/dev/.keys:/keys:ro" -e CF_API_BASE=http://host.docker.internal:8787/client/v4 \
//     -e ALLOW_PRIVATE_DNS=true -e ADMIN_USER=admin -e ADMIN_PASSWORD=admin-password-123 sb-dbx-test:dev
//   SB_URL=http://localhost:8094 node dev/e2e-dbaccess.mjs
// Fake "other services" are short-lived MySQL client containers on the lab network: 172.30.0.41
// (allowed) and 172.30.0.42 (not allowed). Everything the test adds is removed at the end.
import { execSync } from 'node:child_process';

const BASE = process.env.SB_URL || 'http://localhost:8094';
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:8787';
const NET = 'switchboard-dev_lab';
const SRC = '172.30.0.21';
const NEW = '172.30.0.22';
const OK_IP = '172.30.0.41';
const BAD_IP = '172.30.0.42';
const TAG = `dbx${Date.now().toString(36).slice(-4)}`;
const HOST = `db-${TAG}.shop.test`;
let cookie = '';
let failures = 0;

async function api(method, url, body) {
  const go = () =>
    fetch(`${BASE}/api${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // a kept-alive connection may have been closed while a slow step ran: retry once
  const res = await go().catch((e) => (e.message === 'fetch failed' ? go() : Promise.reject(e)));
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) cookie = c.split(';')[0];
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
  return data;
}
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
    console.log('  ✖ ERROR', e.message, e.cause?.message || '');
  }
}
async function waitJob(job, ms = 300000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (j.status !== 'success') console.log(String(j.log).split('\n').slice(-15).join('\n'));
      return j;
    }
    await sleep(1500);
  }
  throw new Error(`job ${job.id} timed out`);
}
/** SQL from a fake outside service with the given IP. Returns the output, or null when it can't connect. */
function query(fromIp, host, port, sql) {
  try {
    return sh(`docker run --rm --network ${NET} --ip ${fromIp} mysql:8.4 mysql -h ${host} -P ${port} -uroot -prootpass-c --connect-timeout=4 -N -B -e ${JSON.stringify(sql)} shop 2>/dev/null`);
  } catch {
    return null;
  }
}
const cfRecord = async (name) => {
  const zones = (await (await fetch(`${MOCK}/client/v4/zones`, { headers: { authorization: 'Bearer test-token' } })).json()).result;
  for (const z of zones) {
    const r = (await (await fetch(`${MOCK}/client/v4/zones/${z.id}/dns_records?name=${name}`, { headers: { authorization: 'Bearer test-token' } })).json()).result;
    if (r?.length) return r[0];
  }
  return null;
};
const onVps = (vps, cmd) => sh(`docker exec ${vps} sh -c ${JSON.stringify(cmd)}`);

const ids = {};
let view;

await step('set up: two servers, a project with the shop database on both, vps-src live', async () => {
  await api('POST', '/auth/login', { username: process.env.SB_USER || 'admin', password: process.env.SB_PASSWORD || 'admin-password-123' });
  await api('PUT', '/settings', { cf_token: 'test-token' });
  for (const [k, ip] of [['src', SRC], ['new', NEW]]) {
    const s = await api('POST', '/servers', { name: `${TAG}-${k}`, ip, auth_type: 'keyfile', ssh_key_path: '/keys/id_ed25519' });
    ids[k] = s.id;
  }
  const p = await api('POST', '/projects', { name: `${TAG} shop`, domain: `${TAG}.shop.test`, health_scheme: 'http', health_path: '/up' });
  ids.project = p.id;
  await api('PUT', `/projects/${p.id}`, { ...p, health_port: 8080 });
  for (const k of ['src', 'new']) {
    const d = await api('POST', `/projects/${p.id}/deployments`, { server_id: ids[k], app_dir: '/srv/shop', app_container: 'shop-app-1', db_type: 'mysql', db_container: 'shop-db-1', db_name: 'shop', db_user: 'root', db_password: 'rootpass-c', skip_backup: true });
    ids[`dep_${k}`] = d.id;
  }
  await api('POST', `/projects/${p.id}/adopt`, { deployment: ids.dep_src });
  view = await api('GET', `/projects/${p.id}/db-access`);
  check(!view.problem && view.default_port === 3306 && view.env.database === 'shop', 'project can use outside database access (MySQL, port 3306)');
  check(query(OK_IP, SRC, 3306, 'SELECT 1') === null, 'before: the database is not reachable from outside');
});

await step('bad input is refused', async () => {
  let n = 0;
  for (const body of [
    { host: `https://${HOST}`, port: 3306, ips: [] },
    { host: `${TAG}.shop.test`, port: 3306, ips: [] },
    { host: HOST, port: 3306, ips: [{ ip: '0.0.0.0' }] },
    { host: HOST, port: 3306, ips: [{ ip: 'media-server' }] },
    { host: HOST, port: 22, ips: [] },
    { host: 'db.not-my-zone.example', port: 3306, ips: [] },
  ]) {
    await api('PUT', `/projects/${ids.project}/db-access`, body).catch(() => n++);
  }
  check(n === 6, 'https://, the website name, 0.0.0.0, a non-IP, port 22 and an unknown zone are refused');
});

await step('turn on: only the live server is open, only for the allowed IP', async () => {
  const r = await api('PUT', `/projects/${ids.project}/db-access`, { host: HOST, port: 3306, ips: [{ ip: OK_IP, label: 'media server' }] });
  const j = await waitJob(r.job);
  check(j.status === 'success', `setup job ${j.status}`);
  check(/DB_HOST=db-/.test(j.log), 'job log shows the .env settings');
  const rec = await cfRecord(HOST);
  check(rec && rec.content === SRC && rec.proxied === false && rec.ttl === 60, `Cloudflare: ${HOST} → ${rec?.content}, DNS only, TTL ${rec?.ttl}`);
  const p = await api('GET', `/projects/${ids.project}`);
  check(p.dns_records.some((x) => x.name === HOST), 'the record is linked to the project (moves on switch)');
  view = await api('GET', `/projects/${ids.project}/db-access`);
  const src = view.servers.find((s) => s.id === ids.dep_src);
  const neu = view.servers.find((s) => s.id === ids.dep_new);
  check(src.state === 'open' && src.ok, 'vps-src (live): OPEN, database answers through the proxy');
  check(neu.state === 'closed' && neu.ok, 'vps-new (standby): closed');
  check(!view.issues.length, 'no problems listed');
  check(query(OK_IP, SRC, 3306, 'SELECT COUNT(*) FROM information_schema.TABLES') !== null, 'allowed IP connects to the live server');
  check(query(BAD_IP, SRC, 3306, 'SELECT 1') === null, 'other IP is blocked');
  check(query(OK_IP, NEW, 3306, 'SELECT 1') === null, 'standby is closed even for the allowed IP');
  const inside = onVps('vps-src', `docker run --rm --network shop_default mysql:8.4 mysql -h db -uroot -prootpass-c -N -e 'SELECT 7' 2>/dev/null`);
  check(inside === '7', 'containers on the server still reach the database (firewall only blocks outside)');
  check(onVps('vps-src', 'crontab -l').includes('switchboard-dbaccess'), 'rules come back after a reboot (crontab)');
});

await step('switch to vps-new with a database copy: outside access follows', async () => {
  query(OK_IP, SRC, 3306, `CREATE TABLE IF NOT EXISTS dbx_media (id INT PRIMARY KEY, note VARCHAR(40)); REPLACE INTO dbx_media VALUES (1, '${TAG}')`);
  const r = await api('POST', `/projects/${ids.project}/switch`, { target: ids.dep_new, syncDb: true, maintenance: false, backupTarget: false, force: true });
  const j = await waitJob(r.job);
  check(j.status === 'success', `switch job ${j.status}`);
  const closeAt = j.log.indexOf(`close ${TAG}-src`);
  const copyAt = j.log.search(/Safety backup|Copy(ing)? (the )?database|Dump/i);
  check(closeAt >= 0 && closeAt < j.log.indexOf('Point Cloudflare DNS') && (copyAt < 0 || closeAt < copyAt), 'the old server was closed before the database copy and the DNS change');
  const rec = await cfRecord(HOST);
  check(rec?.content === NEW, `Cloudflare: ${HOST} now → ${rec?.content}`);
  check(query(OK_IP, NEW, 3306, `SELECT note FROM dbx_media WHERE id = 1`) === TAG, 'allowed IP reaches the new live server, and the row written from outside was copied');
  check(query(OK_IP, SRC, 3306, 'SELECT 1') === null, 'the old server is closed now');
  view = await api('GET', `/projects/${ids.project}/db-access`);
  check(view.servers.find((s) => s.id === ids.dep_new).state === 'open' && view.servers.find((s) => s.id === ids.dep_src).state === 'closed', 'states: vps-new OPEN, vps-src closed');
});

await step('marking another server live by hand shows a problem until Apply', async () => {
  await api('POST', `/projects/${ids.project}/adopt`, { deployment: ids.dep_src });
  const o = await api('GET', '/overview');
  check(o.alerts.some((a) => a.message.includes(`${TAG} shop`) && /CLOSED on the live server/.test(a.message)), 'overview: "closed on the live server — press Apply"');
  const j = await waitJob((await api('POST', `/projects/${ids.project}/db-access/apply`)).job);
  check(j.status === 'success', 'Apply fixes it');
  check(query(OK_IP, SRC, 3306, 'SELECT 1') === '1' && query(OK_IP, NEW, 3306, 'SELECT 1') === null, 'vps-src open, vps-new closed again');
});

await step('change the allowed IPs and the port', async () => {
  const r = await api('PUT', `/projects/${ids.project}/db-access`, { host: HOST, port: 13306, ips: [{ ip: OK_IP }, { ip: `${BAD_IP}/32`, label: 'second' }] });
  const j = await waitJob(r.job);
  check(j.status === 'success', `apply job ${j.status}`);
  check(query(BAD_IP, SRC, 13306, 'SELECT 1') === '1', 'the newly allowed IP connects on the new port 13306');
  check(query(OK_IP, SRC, 3306, 'SELECT 1') === null, 'old port 3306 is not published any more');
  const rules = onVps('vps-src', 'iptables -S DOCKER-USER');
  check(rules.includes('--ctorigdstport 13306') && !rules.includes('--ctorigdstport 3306 '), 'firewall rule moved to the new port');
});

await step('turn off: everything removed', async () => {
  const j = await waitJob((await api('DELETE', `/projects/${ids.project}/db-access`, {})).job);
  check(j.status === 'success', `turn-off job ${j.status}`);
  for (const vps of ['vps-src', 'vps-new']) {
    check(!onVps(vps, 'docker ps -a --format "{{.Names}}"').includes(`sb-dbaccess-${ids.project}`), `${vps}: proxy container removed`);
    check(!onVps(vps, 'iptables -S').includes(`SB-DBX-${ids.project}`), `${vps}: firewall rules removed`);
    check(!onVps(vps, 'crontab -l 2>/dev/null || true').includes('switchboard-dbaccess'), `${vps}: reboot line removed`);
  }
  check(!(await cfRecord(HOST)), 'Cloudflare record deleted (Switchboard created it)');
  const p = await api('GET', `/projects/${ids.project}`);
  check(!p.dns_records.some((x) => x.name === HOST) && !p.db_access.enabled, 'unlinked from the project, feature off');
});

await step('a database that already publishes its own port (docker -p 3306:3306)', async () => {
  onVps('vps-new', 'docker rm -f dbx-pub >/dev/null 2>&1; docker run -d --name dbx-pub -p 3306:3306 -e MYSQL_ROOT_PASSWORD=rootpass-c -e MYSQL_DATABASE=shop mysql:8.4 >/dev/null');
  for (let i = 0; i < 60 && query(OK_IP, NEW, 3306, 'SELECT 1') !== '1'; i++) await sleep(2000);
  check(query(BAD_IP, NEW, 3306, 'SELECT 1') === '1', 'before: that database is open to everybody');
  const p = await api('POST', '/projects', { name: `${TAG} pub`, domain: `${TAG}pub.shop.test`, health_scheme: 'http', health_path: '/up' });
  ids.project2 = p.id;
  const d = await api('POST', `/projects/${p.id}/deployments`, { server_id: ids.new, db_type: 'mysql', db_container: 'dbx-pub', db_name: 'shop', db_user: 'root', db_password: 'rootpass-c', skip_backup: true });
  await api('POST', `/projects/${p.id}/adopt`, { deployment: d.id });
  const host = `db-${TAG}pub.shop.test`;
  let j = await waitJob((await api('PUT', `/projects/${p.id}/db-access`, { host, port: 3307, ips: [{ ip: OK_IP }] })).job);
  check(j.status === 'failed' && /already publishes its port on 3306/.test(j.log), 'another port is refused with "set the port to 3306"');
  j = await waitJob((await api('PUT', `/projects/${p.id}/db-access`, { host, port: 3306, ips: [{ ip: OK_IP }] })).job);
  check(j.status === 'success' && /publishes this port itself/.test(j.log), 'port 3306: uses the database\'s own port, no extra proxy');
  const v = await api('GET', `/projects/${p.id}/db-access`);
  check(v.servers[0].state === 'open' && v.servers[0].via === 'own-port' && v.servers[0].ok, 'state: OPEN via its own port, database answers');
  check(!onVps('vps-new', 'docker ps -a --format "{{.Names}}"').includes(`sb-dbaccess-${p.id}`), 'no proxy container');
  check(query(OK_IP, NEW, 3306, 'SELECT 1') === '1', 'allowed IP still connects');
  check(query(BAD_IP, NEW, 3306, 'SELECT 1') === null, 'everybody else is blocked now');
  check(onVps('vps-new', 'ip6tables -S INPUT 2>/dev/null || true').includes(`SB-DBX-${p.id}6`) || !onVps('vps-new', 'command -v ip6tables || true'), 'IPv6 to the port is closed too');
  j = await waitJob((await api('DELETE', `/projects/${p.id}/db-access`, {})).job);
  check(j.status === 'success' && !onVps('vps-new', 'iptables -S; ip6tables -S 2>/dev/null || true').includes(`SB-DBX-${p.id}`), 'turn off removes the IPv4 and IPv6 rules');
  check(onVps('vps-new', 'docker ps --format "{{.Names}}"').includes('dbx-pub'), "the user's database container is left alone");
});

await step('clean up', async () => {
  try {
    sh(`docker exec vps-src docker exec shop-db-1 mysql -uroot -prootpass-c -e 'DROP TABLE IF EXISTS shop.dbx_media' 2>/dev/null`);
    sh(`docker exec vps-new docker exec shop-db-1 mysql -uroot -prootpass-c -e 'DROP TABLE IF EXISTS shop.dbx_media' 2>/dev/null`);
  } catch {}
  for (const id of [ids.project, ids.project2].filter(Boolean)) {
    const p = await api('GET', `/projects/${id}`);
    await api('DELETE', `/projects/${id}`, { confirm: p.slug });
  }
  try {
    onVps('vps-new', 'docker rm -f dbx-pub >/dev/null 2>&1 || true');
  } catch {}
  for (const k of ['src', 'new']) if (ids[k]) await api('DELETE', `/servers/${ids[k]}`);
  check(true, 'test project and servers removed from the dashboard');
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all database access checks passed');
process.exit(failures ? 1 : 0);

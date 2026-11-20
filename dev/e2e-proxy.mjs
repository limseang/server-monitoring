#!/usr/bin/env node
// End-to-end test for the project "Web proxy (nginx)": domain → nginx → the app's port, on a project's servers —
// and for apps outside Docker: a built Vue-style front-end served from its folder, and a Node app under PM2, both
// deployed with the ready-made deploy scripts (public/app/deploypresets.js).
// Needs vps-src from the clone pair (./dev/clone-setup.sh): its shop app answers on port 8080 and a second app
// on 127.0.0.1:18000. Installs Node.js + PM2 on vps-src if missing and makes a user "deploy" with /var/www/sb-vue
// and ~/sb-api (local git remotes in /opt/sb-fe). Removes the web proxy sites it adds.
//   node dev/e2e-proxy.mjs
//   SB_URL=http://localhost:8096 SB_USER=… SB_PASSWORD=…   test another Switchboard instance (default: the lab on 8090)
//   SB_LAB_DIR=/path/to/dev                                where .keys is (default: this folder)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRONTEND_SCRIPT, PM2_SCRIPT } from '../public/app/deploypresets.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LAB = process.env.SB_LAB_DIR || DIR;
const BASE = process.env.SB_URL || 'http://localhost:8090';
const KEY = fs.readFileSync(path.join(LAB, '.keys/id_ed25519'), 'utf8');
let cookie = '';
let failures = 0;

async function api(method, url, body) {
  const go = () =>
    fetch(`${BASE}/api${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // a kept-alive connection can be closed while a long docker exec blocks this process: try once more
  const res = await go().catch((e) => (e.message === 'fetch failed' ? go() : Promise.reject(e)));
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) cookie = c.split(';')[0];
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
  return data;
}
const refused = (p) => p.then(() => '').catch((e) => e.message);
const on = (vps, cmd) => execSync(`docker exec ${vps} sh -c ${JSON.stringify(cmd)}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const curl = (host, p = '/') => on('vps-src', `curl -s -m 5 -H 'Host: ${host}' http://127.0.0.1${p} || true`);
const head = (host, p) => on('vps-src', `curl -s -m 5 -o /dev/null -D - -H 'Host: ${host}' http://127.0.0.1${p} || true`);

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
  for (let i = 0; i < 600; i++) {
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

const NAME = 'Proxy vps-src';
let srv, shop, other, dep, dep2;

await step('Set up: vps-src with its shop app, two projects', async () => {
  check(/shop-app-1/.test(on('vps-src', 'docker ps --format {{.Names}}')), 'vps-src runs the shop app (port 8080)');
  await api('POST', '/auth/login', { username: process.env.SB_USER || 'admin', password: process.env.SB_PASSWORD || 'admin-password-123' });
  for (const p of await api('GET', '/projects')) if (['proxy-shop', 'proxy-other'].includes(p.slug)) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  for (const s of await api('GET', '/servers')) if (s.name === NAME) await api('DELETE', `/servers/${s.id}`);
  srv = await api('POST', '/servers', { ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY, name: NAME, ip: '172.30.0.21' });
  shop = await api('POST', '/projects', { name: 'Proxy Shop', domain: 'shop.proxy.test' });
  dep = await api('POST', `/projects/${shop.id}/deployments`, { server_id: srv.id, app_container: 'shop-app-1', app_dir: '/srv/shop', db_type: 'none' });
  other = await api('POST', '/projects', { name: 'Proxy Other', domain: 'other.proxy.test' });
  dep2 = await api('POST', `/projects/${other.id}/deployments`, { server_id: srv.id, db_type: 'none' });
});

await step('Bad input is refused before anything runs', async () => {
  check(/not a domain/.test(await refused(api('POST', `/projects/${shop.id}/proxy`, { hosts: 'shop;rm -rf /', servers: [{ deployment: dep.id, port: 8080 }] }))), 'a bad domain');
  check(/not the app/.test(await refused(api('POST', `/projects/${shop.id}/proxy`, { hosts: 'shop.proxy.test', servers: [{ deployment: dep.id, port: 22 }] }))), 'port 22');
  check(/Unknown server/.test(await refused(api('POST', `/projects/${shop.id}/proxy`, { hosts: 'shop.proxy.test', servers: [{ deployment: dep2.id, port: 8080 }] }))), "another project's server");
  check(/No web proxy/.test(await refused(api('DELETE', `/projects/${shop.id}/proxy`))), 'remove when nothing is set up');
});

await step('Set up shop.proxy.test + www → port 8080 (no nginx on the server: the helper brings one)', async () => {
  const { job } = await api('POST', `/projects/${shop.id}/proxy`, { hosts: 'shop.proxy.test www.shop.proxy.test', servers: [{ deployment: dep.id, port: 8080 }] });
  const j = await waitJob(job);
  const prog = typeof j.progress === 'string' ? JSON.parse(j.progress) : j.progress;
  check(prog?.kind === 'proxy' && prog.servers[0].state === 'success' && prog.servers[0].code === 200, `live progress: ${JSON.stringify(prog?.servers?.[0])}`);
  check(/^ok /.test(curl('shop.proxy.test')), `shop.proxy.test → the shop app ("${curl('shop.proxy.test')}")`);
  check(/^ok /.test(curl('www.shop.proxy.test')), 'www.shop.proxy.test too');
  const p = await api('GET', `/projects/${shop.id}`);
  const d = p.deployments.find((x) => x.id === dep.id);
  check(d.proxy_state?.ok && d.proxy_state.port === 8080 && d.app_port === 8080, `saved: ${JSON.stringify(d.proxy_state)}, app_port ${d.app_port}`);
  check(JSON.stringify(p.proxy?.hosts) === '["shop.proxy.test","www.shop.proxy.test"]', 'project remembers its domains');
});

await step('Another project cannot take the same domain', async () => {
  const { job } = await api('POST', `/projects/${other.id}/proxy`, { hosts: 'shop.proxy.test', servers: [{ deployment: dep2.id, port: 18000 }] });
  const j = await waitJob(job, 'failed');
  check(/already used by the web proxy of project "Proxy Shop"/.test(j.log), 'the job names the project that has it');
  check(/^ok /.test(curl('shop.proxy.test')), 'shop.proxy.test still goes to the shop app');
});

await step('Change the port: our own site is replaced, not counted as a conflict', async () => {
  const { job } = await api('POST', `/projects/${shop.id}/proxy`, { hosts: 'shop.proxy.test', servers: [{ deployment: dep.id, port: 18000 }] });
  await waitJob(job);
  const body = curl('shop.proxy.test');
  check(body && !/^ok /.test(body), `shop.proxy.test now goes to port 18000 ("${body.slice(0, 40)}")`);
  check(!/www\.shop\.proxy\.test/.test(on('vps-src', 'cat /etc/switchboard/edge/conf.d/sb-proj-*.conf /etc/nginx/conf.d/sb-proj-*.conf 2>/dev/null || true')), 'www was dropped from the site');
});

await step('Remove: nginx no longer sends the domain to the app', async () => {
  const { job } = await api('POST', `/projects/${shop.id}/proxy`, { hosts: 'shop.proxy.test', servers: [{ deployment: dep.id, port: 8080 }] });
  await waitJob(job);
  const r = await api('DELETE', `/projects/${shop.id}/proxy`);
  await waitJob(r.job);
  check(!/^ok /.test(curl('shop.proxy.test')), 'shop.proxy.test no longer reaches the app');
  const p = await api('GET', `/projects/${shop.id}`);
  check(!p.proxy && !p.deployments[0].proxy_state, 'project and server records cleared');
  check(on('vps-src', 'ls /etc/switchboard/edge/conf.d /etc/nginx/conf.d 2>/dev/null | grep -c sb-proj- || true') === '0', 'no sb-proj-*.conf left');
});

let vue, vdep, apiP, adep;
await step('Apps outside Docker: a Vue-style front-end and a Node app under PM2 (user deploy)', async () => {
  const out = execSync('docker exec -i vps-src bash -s', { input: `set -e
export DEBIAN_FRONTEND=noninteractive
command -v node >/dev/null && command -v git >/dev/null || { apt-get update -q >/dev/null; apt-get install -y -q --no-install-recommends nodejs npm git >/dev/null; }
command -v pm2 >/dev/null || npm install -g --no-fund --no-audit pm2 >/dev/null 2>&1
id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash deploy
su - deploy -c "pm2 delete sb-api >/dev/null 2>&1 || true"
rm -rf /opt/sb-fe /var/www/sb-vue /home/deploy/sb-api
mkdir -p /opt/sb-fe /var/www/sb-vue
git init -q --bare -b main /opt/sb-fe/vue.git; git init -q --bare -b main /opt/sb-fe/api.git
for r in vue api; do git config --system --get-all safe.directory | grep -qx /opt/sb-fe/$r.git || git config --system --add safe.directory /opt/sb-fe/$r.git; done
W=$(mktemp -d); cd $W; git init -q -b main; git config user.email lab@test; git config user.name lab
cat > package.json <<'J'
{ "name": "sb-vue", "version": "1.0.0", "private": true, "scripts": { "build": "node build.js" } }
J
cat > build.js <<'J'
const fs = require('fs');
fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist/assets', { recursive: true });
const v = fs.readFileSync('VERSION', 'utf8').trim();
fs.writeFileSync('dist/index.html', '<!doctype html><title>sb-vue</title><div id="app">VUE ' + v + '</div><script src="/assets/app.js"></script>');
fs.writeFileSync('dist/assets/app.js', 'console.log("v' + v + '")');
J
echo 1 > VERSION
npm install --package-lock-only --no-fund --no-audit >/dev/null 2>&1
git add -A; git commit -qm v1; git push -q /opt/sb-fe/vue.git main
V=$(mktemp -d); cd $V; git init -q -b main; git config user.email lab@test; git config user.name lab
cat > package.json <<'J'
{ "name": "sb-api", "version": "1.0.0", "private": true, "scripts": { "start": "node server.js" } }
J
cat > server.js <<'J'
const v = require('fs').readFileSync(__dirname + '/VERSION', 'utf8').trim();
require('http').createServer((q, r) => r.end('API ' + v)).listen(3005);
J
echo 1 > VERSION
npm install --package-lock-only --no-fund --no-audit >/dev/null 2>&1
git add -A; git commit -qm v1; git push -q /opt/sb-fe/api.git main
chown -R deploy:deploy /var/www/sb-vue /opt/sb-fe
su - deploy -c "git clone -q /opt/sb-fe/vue.git /var/www/sb-vue && cd /var/www/sb-vue && npm ci --no-fund --no-audit >/dev/null 2>&1 && npm run build >/dev/null"
su - deploy -c "git clone -q /opt/sb-fe/api.git ~/sb-api && cd ~/sb-api && pm2 start server.js --name sb-api >/dev/null && pm2 save >/dev/null"
echo prepared`, encoding: 'utf8', timeout: 10 * 60000 });
  check(/prepared/.test(out), 'Node.js, PM2, user deploy, the two apps and their git remotes');
  check(/VUE 1/.test(on('vps-src', 'cat /var/www/sb-vue/dist/index.html')), 'front-end built once: dist/index.html');
  check(on('vps-src', 'curl -s -m 5 http://127.0.0.1:3005/') === 'API 1', 'PM2 app answers on port 3005');
  vue = await api('POST', '/projects', { name: 'Proxy Vue', domain: 'vue.proxy.test' });
  vdep = await api('POST', `/projects/${vue.id}/deployments`, { server_id: srv.id, app_dir: '/var/www/sb-vue', db_type: 'none' });
  apiP = await api('POST', '/projects', { name: 'Proxy Api', domain: 'api.proxy.test' });
  adep = await api('POST', `/projects/${apiP.id}/deployments`, { server_id: srv.id, app_dir: '/home/deploy/sb-api', db_type: 'none' });
});

await step('Website files: the built folder is found, served, refresh works, assets are cached', async () => {
  const f = await api('GET', `/projects/${vue.id}/proxy/folders`);
  check(f[vdep.id]?.folders?.[0] === '/var/www/sb-vue/dist', `found the build folder first (${JSON.stringify(f[vdep.id]?.folders?.slice(0, 3))})`);
  check(/can't be served/.test(await refused(api('POST', `/projects/${vue.id}/proxy`, { hosts: 'vue.proxy.test', servers: [{ deployment: vdep.id, folder: '/etc' }] }))), '/etc is refused');
  const { job } = await api('POST', `/projects/${vue.id}/proxy`, { hosts: 'vue.proxy.test', servers: [{ deployment: vdep.id, folder: '/var/www/sb-vue/dist', spa: true }] });
  const j = await waitJob(job);
  check(/folder \/var\/www\/sb-vue\/dist/.test(j.log), 'the job says it serves the folder');
  check(/VUE 1/.test(curl('vue.proxy.test')), `vue.proxy.test shows the site ("${curl('vue.proxy.test').slice(-30)}")`);
  check(/VUE 1/.test(curl('vue.proxy.test', '/products/42')), 'a page route (/products/42) gets index.html — refresh does not 404');
  const h = head('vue.proxy.test', '/assets/app.js');
  check(/ 200 /.test(h) && /Cache-Control: (max-age=2592000|public)/i.test(h), 'assets are served and cached');
  check(/ 404 /.test(head('vue.proxy.test', '/assets/missing.js')), 'a missing asset is a real 404 (not index.html)');
  const p = await api('GET', `/projects/${vue.id}`);
  check(p.deployments[0].proxy_state?.kind === 'folder' && p.deployments[0].proxy_state.spa === true, 'saved as a website folder (single-page app)');
});

await step('Deploy scripts for apps without Docker: front-end build and PM2 reload', async () => {
  execSync('docker exec -i vps-src bash -s', { input: `set -e
for r in vue api; do
  W=$(mktemp -d); git clone -q /opt/sb-fe/$r.git $W; cd $W; git config user.email lab@test; git config user.name lab
  echo 2 > VERSION; git commit -qam v2; git push -q origin main
done
chown -R deploy:deploy /opt/sb-fe`, encoding: 'utf8' });
  await api('PUT', `/projects/${vue.id}`, { ...(await api('GET', `/projects/${vue.id}`)), deploy_script: FRONTEND_SCRIPT });
  const d1 = await api('POST', `/deployments/${vdep.id}/deploy`);
  await waitJob(d1.job);
  check(/VUE 2/.test(curl('vue.proxy.test')), `after the deploy vue.proxy.test shows version 2 ("${curl('vue.proxy.test').slice(-30)}")`);
  check(on('vps-src', 'find /var/www/sb-vue ! -user deploy -not -path "*/node_modules/*" | head -3') === '', 'every file in the app folder still belongs to deploy');
  await api('PUT', `/projects/${apiP.id}`, { ...(await api('GET', `/projects/${apiP.id}`)), deploy_script: PM2_SCRIPT });
  const before = on('vps-src', `su - deploy -c "pm2 jlist" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.slice(s.indexOf("["))).find(p=>p.name==="sb-api").pm2_env.pm_uptime))'`);
  const d2 = await api('POST', `/deployments/${adep.id}/deploy`);
  await waitJob(d2.job);
  const after = on('vps-src', `su - deploy -c "pm2 jlist" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.slice(s.indexOf("["))).find(p=>p.name==="sb-api").pm2_env.pm_uptime))'`);
  check(before !== after, 'PM2 reloaded sb-api (as user deploy)');
  check(on('vps-src', 'curl -s -m 5 http://127.0.0.1:3005/') === 'API 2', 'the PM2 app runs version 2');
  const { job } = await api('POST', `/projects/${apiP.id}/proxy`, { hosts: 'api.proxy.test', servers: [{ deployment: adep.id, port: 3005 }] });
  await waitJob(job);
  check(curl('api.proxy.test') === 'API 2', 'api.proxy.test → the PM2 app');
});

await step('Remove the front-end and PM2 web proxies', async () => {
  for (const p of [vue, apiP]) {
    const r = await api('DELETE', `/projects/${p.id}/proxy`);
    await waitJob(r.job);
  }
  check(!/VUE/.test(curl('vue.proxy.test')) && !/API/.test(curl('api.proxy.test')), 'both domains no longer reach the apps');
  check(on('vps-src', 'ls /etc/switchboard/edge/static 2>/dev/null | wc -l') === '0', 'no website folder left in the proxy list');
});

await step('Clean up the test projects and server', async () => {
  for (const p of [shop, other, vue, apiP]) if (p) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  if (srv) await api('DELETE', `/servers/${srv.id}`);
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all web proxy checks passed');
process.exit(failures ? 1 : 0);

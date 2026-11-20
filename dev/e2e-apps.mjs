#!/usr/bin/env node
// End-to-end test for apps WITHOUT Docker made from GitHub ("+ Deploy from my GitHub"):
//   a Vue-style front-end (built on the server, nginx serves dist/) and a Node API run with PM2.
// Needs vps-src from the clone pair (./dev/clone-setup.sh) and the lab's fake GitHub (gh-mock, from ./dev/setup.sh
// or ./dev/ci-setup.sh). Installs Node.js on vps-src from nodejs.org when it has none. Removes what it adds.
//   node dev/e2e-apps.mjs
//   SB_URL=http://localhost:8096 SB_USER=… SB_PASSWORD=…   test another Switchboard instance (default: the lab on 8090)
//   SB_LAB_DIR=/path/to/dev                                where .keys is (default: this folder)
// The instance must use the fake GitHub: GITHUB_API_BASE=http://gh-mock:8788, GITHUB_GIT_URL=git://172.30.0.6/{repo}.git
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LAB = process.env.SB_LAB_DIR || DIR;
const BASE = process.env.SB_URL || 'http://localhost:8090';
const GH = 'http://localhost:8788';
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
  const res = await go().catch((e) => (e.message === 'fetch failed' ? go() : Promise.reject(e)));
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) cookie = c.split(';')[0];
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
  return data;
}
const ghPost = async (p, b) => (await fetch(GH + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer gh-test-token' }, body: JSON.stringify(b) })).json();
const commit = (repo, file, content, message) => ghPost('/__commit', { repo, branch: 'main', file, content, message });
const on = (cmd) => execSync(`docker exec vps-src sh -c ${JSON.stringify(cmd)}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const curl = (host, p = '/') => on(`curl -s -m 5 -H 'Host: ${host}' http://127.0.0.1${p} || true`);
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
    console.log('  ✖ ERROR', e.message);
  }
}
async function waitJob(job, expect = 'success') {
  for (let i = 0; i < 1200; i++) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-40).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error})` : ''}`);
      return j;
    }
    await sleep(1000);
  }
  throw new Error('job did not finish in time');
}

const SITE = 'lab-user/sb-vue-site';
const APIREPO = 'lab-user/sb-node-api';
const NAMES = ['Lab Vue Site', 'Lab Node Api'];
const BUILD = `const fs = require('fs');
fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist/assets', { recursive: true });
const v = fs.readFileSync('VERSION', 'utf8').trim();
fs.writeFileSync('dist/index.html', '<!doctype html><title>site</title><div id="app">VUE ' + v + '</div>');
fs.writeFileSync('dist/assets/app.js', 'console.log(' + v + ')');
`;
const SERVER = `const v = require('fs').readFileSync(__dirname + '/VERSION', 'utf8').trim();
require('http').createServer((q, r) => r.end('API ' + v + ' on ' + process.env.PORT)).listen(Number(process.env.PORT) || 3000);
`;
let srv, site, apiP;

await step('Set up: the server, the GitHub token and two repos', async () => {
  await api('POST', '/auth/login', { username: process.env.SB_USER || 'admin', password: process.env.SB_PASSWORD || 'admin-password-123' });
  for (const p of await api('GET', '/projects')) if (NAMES.includes(p.name)) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  for (const s of await api('GET', '/servers')) if (s.name === 'Apps vps-src') await api('DELETE', `/servers/${s.id}`);
  on('for a in lab-node-api; do (pm2 delete $a || true) >/dev/null 2>&1; done; rm -rf /srv/lab-vue-site /srv/lab-node-api /etc/switchboard/projects/lab-*');
  await api('PUT', '/settings', { github_token: 'gh-test-token' });
  srv = await api('POST', '/servers', { ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY, name: 'Apps vps-src', ip: '172.30.0.21' });
  for (const r of [SITE, APIREPO]) await ghPost('/user/repos', { name: r.split('/')[1], private: true });
  await commit(SITE, 'package.json', JSON.stringify({ name: 'sb-vue-site', private: true, scripts: { build: 'node build.js' }, dependencies: { vue: '3.5.13' } }, null, 2), 'package.json');
  await commit(SITE, 'build.js', BUILD, 'build');
  await commit(SITE, 'VERSION', '1\n', 'v1');
  await commit(APIREPO, 'package.json', JSON.stringify({ name: 'sb-node-api', private: true, scripts: { start: 'node server.js' } }, null, 2), 'package.json');
  await commit(APIREPO, 'server.js', SERVER, 'server');
  await commit(APIREPO, 'VERSION', '1\n', 'v1');
  check(true, `node on vps-src before: ${on('command -v node >/dev/null && node -v || echo none')}`);
});

await step('Repo detection: Vue front-end → no Docker; Node server → Node app', async () => {
  const a = await api('GET', `/github/repo-info?repo=${encodeURIComponent(SITE)}`);
  check(a.suggest === 'frontend' && a.js?.framework === 'Vue', `site: suggest ${a.suggest}, ${JSON.stringify(a.js)}`);
  const b = await api('GET', `/github/repo-info?repo=${encodeURIComponent(APIREPO)}`);
  check(b.js?.kind === 'server', `api: suggest ${b.suggest}, ${JSON.stringify(b.js)}`);
  const t = await api('GET', '/templates');
  check(t.templates.some((x) => x.id === 'frontend' && x.host) && t.templates.some((x) => x.id === 'pm2' && x.host), 'both no-Docker app types are offered');
});

await step('Front-end from GitHub: clone, Node.js, build, nginx serves dist/', async () => {
  const r = await api('POST', '/projects/from-template', { template: 'frontend', db: 'none', code: 'repo', repo: SITE, branch: 'main', name: NAMES[0], domain: 'vue-site.lab.test', www: false, servers: [srv.id], folder: '/srv/lab-vue-site', ci: '' });
  site = r.project;
  const j = await waitJob(r.job);
  const prog = typeof j.progress === 'string' ? JSON.parse(j.progress) : j.progress;
  check(prog?.kind === 'proxy' && prog.setup && prog.servers[0].state === 'success' && prog.servers[0].folder === '/srv/lab-vue-site/dist', `live picture: ${JSON.stringify(prog?.servers?.[0])}`);
  check(/Node\.js (v22|v\d+)/.test(j.log), `Node.js: ${(j.log.match(/Node\.js[^\n]*/) || [''])[0]}`);
  check(/VUE 1/.test(curl('vue-site.lab.test')), `vue-site.lab.test shows the site ("${curl('vue-site.lab.test').slice(-25)}")`);
  check(/VUE 1/.test(curl('vue-site.lab.test', '/about/team')), 'a page route gets index.html (refresh works)');
  check(curl('vue-site.lab.test', '/.git/config') === '' || !/\[core\]/.test(curl('vue-site.lab.test', '/.git/config')), '.git is never served');
  const p = await api('GET', `/projects/${site.id}`);
  const d = p.deployments[0];
  check(!d.app_container && d.proxy_state?.kind === 'folder' && p.proxy?.hosts?.[0] === 'vue-site.lab.test', 'no container; the Web proxy tab shows the folder');
  check(p.active_deployment_id === d.id, 'vps-src is the live server');
  await api('POST', `/projects/${site.id}/check`);
  const h = (await api('GET', `/projects/${site.id}`)).deployments[0].health;
  check(h === 'up', `health check through the web proxy: ${h}`);
});

await step('Node app with PM2 from GitHub: build, PM2 on a local port, nginx in front', async () => {
  const r = await api('POST', '/projects/from-template', { template: 'pm2', db: 'none', code: 'repo', repo: APIREPO, branch: 'main', name: NAMES[1], domain: 'api-site.lab.test', www: false, servers: [srv.id], folder: '/srv/lab-node-api', ci: '' });
  apiP = r.project;
  await waitJob(r.job);
  const body = curl('api-site.lab.test');
  check(/^API 1 on 18\d\d\d$/.test(body), `api-site.lab.test → the PM2 app ("${body}")`);
  check(/lab-node-api/.test(on('pm2 jlist')), 'PM2 runs lab-node-api');
  check(on('cat /srv/lab-node-api/.switchboard/pm2.config.cjs').includes("PORT: '18"), 'PM2 file keeps the port');
  check(/\.switchboard\//.test(on('cat /srv/lab-node-api/.git/info/exclude')), 'git ignores .switchboard/');
  await api('POST', `/projects/${apiP.id}/check`);
  check((await api('GET', `/projects/${apiP.id}`)).deployments[0].health === 'up', 'health check: up');
});

await step('New commits → Deploy: the site is rebuilt and the PM2 app reloaded (same port)', async () => {
  await commit(SITE, 'VERSION', '2\n', 'v2');
  await commit(APIREPO, 'VERSION', '2\n', 'v2');
  const before = curl('api-site.lab.test').split(' on ')[1];
  for (const p of [site, apiP]) {
    const r = await api('POST', `/projects/${p.id}/deploy`);
    await waitJob(r.job);
  }
  check(/VUE 2/.test(curl('vue-site.lab.test')), `site shows version 2 ("${curl('vue-site.lab.test').slice(-25)}")`);
  const after = curl('api-site.lab.test');
  check(after === `API 2 on ${before}`, `API runs version 2 on the same port ("${after}")`);
});

await step('Clean up', async () => {
  for (const p of [site, apiP]) {
    if (!p) continue;
    const r = await api('DELETE', `/projects/${p.id}/proxy`).catch(() => null);
    if (r) await waitJob(r.job);
    await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  }
  on('pm2 delete lab-node-api >/dev/null 2>&1 || true; pm2 save >/dev/null 2>&1 || true; rm -rf /srv/lab-vue-site /srv/lab-node-api');
  if (srv) await api('DELETE', `/servers/${srv.id}`);
  check(!/VUE|API/.test(curl('vue-site.lab.test') + curl('api-site.lab.test')), 'both domains are gone from nginx');
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all app checks passed');
process.exit(failures ? 1 : 0);

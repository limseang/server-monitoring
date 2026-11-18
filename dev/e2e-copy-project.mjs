#!/usr/bin/env node
// End-to-end test for "Copy project to another server". Needs the lab (./dev/setup.sh) and the
// clone pair (./dev/clone-setup.sh).
//   node dev/e2e-copy-project.mjs
// Copies two projects vps-src → vps-new (blanked first) through the real API, each on a NEW port:
//   • "Copy Notes" — a Node app outside Docker (PM2 as user deploy via nvm) + its nginx site: 3100 → 3200
//   • "Copy Shop"  — the Docker stack /srv/shop (app, MySQL, worker) + Switchboard's web proxy site: 8080 → 8085
// vps-src is only read (the notes app and a web proxy site are added there first, removed at the end).
//   SB_URL=http://localhost:8092  test another Switchboard instance (default: the lab on 8090)
//   SB_LAB_DIR=/path/to/dev      where .keys and clone-setup.sh are (default: this folder)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const res = await go().catch((e) => (e.message === 'fetch failed' ? go() : Promise.reject(e)));
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) cookie = c.split(';')[0];
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
  return data;
}
const refused = (p) => p.then(() => '').catch((e) => e.message);
const sh = (cmd, input) => execSync(cmd, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).trim();
const on = (vps, cmd) => sh(`docker exec ${vps} sh -c ${JSON.stringify(cmd)}`);
const onOk = (vps, cmd) => {
  try {
    on(vps, cmd);
    return true;
  } catch {
    return false;
  }
};
/** Run a multi-line script inside a pretend VPS (sent on stdin, so newlines and quotes survive). */
const onScript = (vps, script) => sh(`docker exec -i ${vps} sh -s`, script);
const onTry = (vps, cmd) => {
  try {
    return on(vps, cmd);
  } catch {
    return '';
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (vps, q) => on(vps, `docker exec shop-db-1 mysql -uroot -prootpass-c -N -B shop -e "${q}" 2>/dev/null`);
const listening = (vps, port) => onOk(vps, `ss -ltnH "sport = :${port}" | grep -q .`);

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
async function waitJob(job, expect = 'success', minutes = 30) {
  for (let i = 0; i < minutes * 60; i++) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-80).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error})` : ''}`);
      return j;
    }
    await sleep(1000);
  }
  throw new Error('job did not finish in time');
}

let src, dst, notes, shop;
const NAMES = ['vps-src', 'vps-new'];
const PROJECTS = ['copy-notes', 'copy-shop'];

await step('Prepare vps-src: a PM2 app that reads PORT + its nginx site, and a Switchboard web proxy site for the shop', async () => {
  check(onOk('vps-src', 'docker ps --format {{.Names}} | grep -qx shop-app-1'), 'vps-src runs the shop stack (./dev/clone-setup.sh)');
  onScript(
    'vps-src',
    `set -e
mkdir -p /srv/notes
cat > /srv/notes/server.mjs <<'JS'
import http from "node:http";
http.createServer((q, r) => r.end("notes ok")).listen(Number(process.env.PORT) || 3000);
JS
printf 'PORT=3100\\nNOTES_TITLE=demo\\n' > /srv/notes/.env
chown -R deploy /srv/notes
cat > /etc/nginx/sites-available/notes <<'NG'
server {
    listen 80;
    server_name notes.test;
    location / { proxy_pass http://127.0.0.1:3100; }
}
NG
ln -sf /etc/nginx/sites-available/notes /etc/nginx/sites-enabled/notes
nginx -t >/dev/null 2>&1 && nginx -s reload
su - deploy -c '. ~/.nvm/nvm.sh >/dev/null; cd /srv/notes; pm2 describe notes-api >/dev/null 2>&1 || PORT=3100 pm2 start server.mjs --name notes-api >/dev/null; pm2 save >/dev/null'`,
  );
  // Switchboard's own helper (from this repo), and its web proxy site for the shop on port 8080.
  const helperSh = fs.readFileSync(path.join(DIR, '../src/remote/switchboard-helper.sh'), 'utf8').replaceAll('__VERSION__', '3').replaceAll('__EDGE_IMAGE__', 'nginx:1.27-alpine');
  sh(`docker exec -i vps-src sh -c 'cat > /usr/local/bin/switchboard-helper && chmod 755 /usr/local/bin/switchboard-helper'`, helperSh);
  on('vps-src', 'switchboard-helper edge-site copy-shop 8080 copy-shop.test >/dev/null');
  for (let i = 0; i < 20 && !listening('vps-src', 3100); i++) await sleep(500);
  check(on('vps-src', 'curl -s 127.0.0.1:3100') === 'notes ok', 'notes app answers on 3100 on vps-src');
  check(on('vps-src', "curl -s -H 'Host: notes.test' 127.0.0.1") === 'notes ok', 'nginx site notes.test → 3100 on vps-src');
  check(on('vps-src', "curl -s -H 'Host: copy-shop.test' 127.0.0.1").startsWith('ok vps-src'), 'web proxy copy-shop.test → 8080 on vps-src');
});

await step('Blank vps-new, log in, add servers and the two projects', async () => {
  sh(`${path.join(LAB, 'clone-setup.sh')} reset-new`);
  for (let i = 0; i < 30 && !onOk('vps-new', 'pgrep sshd'); i++) await sleep(500);
  check(!onOk('vps-new', 'command -v docker'), 'vps-new is blank (no Docker)');
  await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
  for (const p of await api('GET', '/projects')) {
    if (PROJECTS.includes(p.slug) || p.deployments?.some((d) => NAMES.includes(d.server_name))) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  }
  for (const s of await api('GET', '/servers')) if (NAMES.includes(s.name)) await api('DELETE', `/servers/${s.id}`);
  const base = { ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY };
  src = await api('POST', '/servers', { ...base, name: 'vps-src', ip: '172.30.0.21' });
  dst = await api('POST', '/servers', { ...base, name: 'vps-new', ip: '172.30.0.22' });
  notes = await api('POST', '/projects', { name: 'Copy Notes', domain: 'notes.test', health_scheme: 'http', health_path: '/' });
  await api('POST', `/projects/${notes.id}/deployments`, { server_id: src.id, app_dir: '/srv/notes', db_type: 'none' });
  shop = await api('POST', '/projects', { name: 'Copy Shop', domain: 'copy-shop.test', health_scheme: 'http', health_path: '/up' });
  await api('POST', `/projects/${shop.id}/deployments`, { server_id: src.id, app_container: 'shop-app-1', app_dir: '/srv/shop', db_type: 'mysql', db_container: 'shop-db-1', db_name: 'shop' });
  check(notes.slug === 'copy-notes' && shop.slug === 'copy-shop', `project slugs ${notes.slug}, ${shop.slug}`);
});

const depOf = async (p, server) => (await api('GET', `/projects/${p.id}`)).deployments.find((d) => d.server_id === server.id);

await step('Preview the notes copy (reads only): ports, PM2 app, nginx site, user, Node.js', async () => {
  const d = await depOf(notes, src);
  const bad = await api('POST', `/projects/${notes.id}/copy/preview`, { deployment: d.id, target: dst.id, ports: { 3100: 22 } });
  check(bad.ok && bad.plan.problems.some((x) => /SSH/.test(x)), `port 22 is refused (${bad.plan?.problems.join(' | ')})`);
  check(/valid port/.test(await refused(api('POST', `/projects/${notes.id}/copy/preview`, { deployment: d.id, target: dst.id, ports: { 3100: 'abc' } }))), 'a non-number port is refused');
  const r = await api('POST', `/projects/${notes.id}/copy/preview`, { deployment: d.id, target: dst.id, ports: { 3100: 3200 } });
  check(r.ok, `preview ran${r.error ? `: ${r.error}` : ''}`);
  const plan = r.plan;
  check(plan.problems.length === 0, `no problems${plan.problems.length ? `: ${plan.problems.join(' | ')}` : ''}`);
  const p = plan.ports.find((x) => x.port === 3100);
  check(p && p.kind === 'pm2' && p.to === 3200 && !p.inUse, `port 3100 (PM2) → 3200, free (${JSON.stringify(plan.ports)})`);
  check(plan.pm2.some((a) => a.name === 'notes-api' && a.user === 'deploy') && !plan.pm2.some((a) => a.name === 'nuxt-site'), 'only the PM2 app of this project (notes-api, not nuxt-site)');
  check(plan.sites.length === 1 && plan.sites[0].names.includes('notes.test'), `only its nginx site (${JSON.stringify(plan.sites)})`);
  check(plan.folders.some((f) => f.path === '/srv/notes'), 'folder /srv/notes');
  check(plan.users.includes('deploy') && plan.node.paths.some((x) => x.endsWith('/.nvm')) && plan.packages.includes('nginx'), `user deploy, nvm and nginx will be set up (${plan.users} / ${plan.node.paths} / ${plan.packages})`);
  check(plan.stacks.length === 0, 'no Docker stack');
  check(!onOk('vps-new', 'id deploy'), 'preview changed nothing on vps-new');
});

await step('Copy the notes app to vps-new on port 3200', async () => {
  const d = await depOf(notes, src);
  const { job } = await api('POST', `/projects/${notes.id}/copy`, { deployment: d.id, target: dst.id, ports: { 3100: 3200 } });
  await waitJob(job);
  for (let i = 0; i < 20 && !listening('vps-new', 3200); i++) await sleep(500);
  check(onTry('vps-new', 'curl -s 127.0.0.1:3200') === 'notes ok', 'notes app answers on 3200 on vps-new');
  check(!listening('vps-new', 3100), 'nothing listens on the old port 3100 on vps-new');
  check(onTry('vps-new', "curl -s -H 'Host: notes.test' 127.0.0.1") === 'notes ok', 'nginx site notes.test → 3200 on vps-new');
  check(/proxy_pass http:\/\/127\.0\.0\.1:3200;/.test(onTry('vps-new', 'cat /etc/nginx/sites-enabled/copy-notes /etc/nginx/conf.d/copy-notes.conf 2>/dev/null; true')), 'copied nginx site points to 3200');
  check(!/nuxt\.test|vue\.test/.test(onTry('vps-new', 'cat /etc/nginx/sites-enabled/* 2>/dev/null')), 'other sites of vps-src were not copied');
  check(/^PORT=3200$/m.test(onTry('vps-new', 'cat /srv/notes/.env')) && /NOTES_TITLE=demo/.test(onTry('vps-new', 'cat /srv/notes/.env')), '.env of the app has PORT=3200');
  const list = onTry('vps-new', "su - deploy -c '. ~/.nvm/nvm.sh >/dev/null; pm2 jlist' | grep '^\\['");
  const apps = JSON.parse(list || '[]');
  check(apps.length === 1 && apps[0].name === 'notes-api' && apps[0].pm2_env.status === 'online', `PM2 of deploy on vps-new runs only notes-api (${apps.map((a) => a.name)})`);
  check(on('vps-src', 'curl -s 127.0.0.1:3100') === 'notes ok', 'vps-src still serves the notes app on 3100');
  const nd = await depOf(notes, dst);
  check(nd && /Copied from vps-src/.test(nd.data_note || ''), `vps-new added to Copy Notes (${nd?.data_note})`);
});

await step('Preview the shop copy: Docker ports, web proxy site, port already in use', async () => {
  const d = await depOf(shop, src);
  const taken = await api('POST', `/projects/${shop.id}/copy/preview`, { deployment: d.id, target: dst.id, ports: { 8080: 3200 } });
  check(taken.ok && taken.plan.problems.some((x) => /3200 is already used/.test(x)), `port 3200 (the notes app) is refused (${taken.plan?.problems.join(' | ')})`);
  const r = await api('POST', `/projects/${shop.id}/copy/preview`, { deployment: d.id, target: dst.id, ports: { 8080: 8085 } });
  const plan = r.plan;
  check(r.ok && plan.problems.length === 0, `no problems${plan?.problems.length ? `: ${plan.problems.join(' | ')}` : r.error || ''}`);
  const st = plan.stacks.find((s) => s.project === 'shop');
  check(st && st.volumes.length === 2 && st.binds.includes('/srv/shared-uploads'), 'stack "shop" with its 2 volumes and outside folder');
  check(plan.ports.some((x) => x.port === 8080 && x.kind === 'docker' && x.to === 8085), `port 8080 (Docker) → 8085 (${JSON.stringify(plan.ports)})`);
  check(plan.edgeSites.some((e) => e.name === 'copy-shop' && e.port === 8080 && e.hosts.includes('copy-shop.test')), 'web proxy site copy-shop.test found');
  check(!plan.pm2.length && !plan.sites.length, 'no PM2 apps / nginx sites of other projects');
  check(plan.target.docker === 'none', 'Docker will be installed on vps-new');
});

await step('Copy the shop to vps-new on port 8085 (Docker installed, data copied while paused)', async () => {
  const d = await depOf(shop, src);
  const { job } = await api('POST', `/projects/${shop.id}/copy`, { deployment: d.id, target: dst.id, ports: { 8080: 8085 }, freeze: true });
  await waitJob(job);
  for (let i = 0; i < 30 && !listening('vps-new', 8085); i++) await sleep(1000);
  check(onTry('vps-new', 'curl -s 127.0.0.1:8085').startsWith('ok vps-new'), 'shop app answers on 8085 on vps-new');
  check(!listening('vps-new', 8080), 'nothing listens on 8080 on vps-new');
  check(/"8085:80"/.test(onTry('vps-new', 'cat /srv/shop/docker-compose.yml')), 'compose file on vps-new publishes 8085');
  check(/"8080:80"/.test(on('vps-src', 'cat /srv/shop/docker-compose.yml')), 'compose file on vps-src unchanged (8080)');
  let tables = '';
  for (let i = 0; i < 30 && !tables; i++) {
    tables = onTry('vps-new', `docker exec shop-db-1 mysql -uroot -prootpass-c -N -B -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='shop'" 2>/dev/null`);
    if (!tables) await sleep(2000);
  }
  check(Number(tables) > 0 && tables === sql('vps-src', "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='shop'"), `database copied (${tables} tables)`);
  check(onTry('vps-new', 'docker exec shop-app-1 cat /var/www/html/storage/app/public/products/fan.jpg') === 'fan photo', 'storage volume copied');
  check(onTry('vps-new', 'cat /srv/shared-uploads/logo.txt') === 'logo', 'outside folder /srv/shared-uploads copied');
  check(onTry('vps-new', "docker inspect -f '{{.State.Status}}' shop-worker-1") === 'exited', 'worker kept stopped like on vps-src');
  check(onTry('vps-new', "curl -s -H 'Host: copy-shop.test' 127.0.0.1").startsWith('ok vps-new'), 'web proxy copy-shop.test → 8085 on vps-new');
  check(onTry('vps-new', 'cat /etc/nginx/conf.d/sb-copy-shop.conf /etc/switchboard/edge/conf.d/sb-copy-shop.conf 2>/dev/null; true').includes('127.0.0.1:8085'), 'web proxy site file points to 8085');
  check(on('vps-src', "docker inspect -f '{{.State.Status}}' shop-app-1") === 'running', 'shop on vps-src is running again (unpaused)');
  check(on('vps-src', 'curl -s 127.0.0.1:8080').startsWith('ok vps-src'), 'vps-src still serves the shop on 8080');
  const nd = await depOf(shop, dst);
  check(nd && nd.app_container === 'shop-app-1' && nd.db_container === 'shop-db-1', `vps-new added to Copy Shop with the same containers (${nd?.app_container}, ${nd?.db_container})`);
  // The project's health check (port 80, Host copy-shop.test) reaches the copy through the web proxy.
  let health = '';
  for (let i = 0; i < 5 && health !== 'up'; i++) {
    await sleep(1000);
    await api('POST', `/projects/${shop.id}/check`);
    health = (await depOf(shop, dst))?.health;
  }
  check(health === 'up', `health check of vps-new: ${health}`);
});

await step('A second copy to the same server is refused', async () => {
  const d = await depOf(shop, src);
  const r = await api('POST', `/projects/${shop.id}/copy/preview`, { deployment: d.id, target: dst.id });
  check(r.ok && r.plan.problems.some((x) => /already part of/.test(x)), `refused: ${r.plan?.problems[0]}`);
  check(/different server/.test(await refused(api('POST', `/projects/${shop.id}/copy`, { deployment: d.id, target: src.id }))), 'copying onto the same server is refused');
});

await step('Clean up vps-src (notes app, its nginx site, the web proxy site)', async () => {
  onScript(
    'vps-src',
    `su - deploy -c '. ~/.nvm/nvm.sh >/dev/null; pm2 delete notes-api >/dev/null 2>&1; pm2 save --force >/dev/null'
rm -rf /srv/notes /etc/nginx/sites-enabled/notes /etc/nginx/sites-available/notes
switchboard-helper edge-rm copy-shop >/dev/null 2>&1 || true
nginx -t >/dev/null 2>&1 && nginx -s reload; true`,
  );
  check(!listening('vps-src', 3100), 'notes app removed from vps-src');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

#!/usr/bin/env node
// End-to-end test for "Clone server" with only SOME projects picked. Needs the lab (./dev/setup.sh)
// and the clone pair (./dev/clone-setup.sh).
//   node dev/e2e-clone-pick.mjs
// vps-src gets a second small Docker project "extra" (removed at the end). The clone to vps-new
// (blanked first) picks only the "shop" stack and only the static Vue site folder — not "extra",
// not the PM2 Nuxt app. Host setup is not copied (keeps the test fast).
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
const sh = (cmd, input) => execSync(cmd, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).trim();
const on = (vps, cmd) => sh(`docker exec ${vps} sh -c ${JSON.stringify(cmd)}`);
const onScript = (vps, script) => sh(`docker exec -i ${vps} sh -s`, script);
const onOk = (vps, cmd) => {
  try {
    on(vps, cmd);
    return true;
  } catch {
    return false;
  }
};
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
async function waitJob(job, expect = 'success', minutes = 30) {
  for (let i = 0; i < minutes * 60; i++) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-60).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error})` : ''}`);
      return j;
    }
    await sleep(1000);
  }
  throw new Error('job did not finish in time');
}

let src, dst, shop, extra;
const NAMES = ['vps-src', 'vps-new'];
const VUE = '/var/www/vue-site/dist';
const NUXT = '/home/deploy/apps/nuxt-site';

await step('Prepare vps-src: a second Docker project "extra"', async () => {
  check(onOk('vps-src', 'docker ps --format {{.Names}} | grep -qx shop-app-1'), 'vps-src runs the shop stack (./dev/clone-setup.sh)');
  onScript(
    'vps-src',
    `set -e
mkdir -p /srv/extra && cd /srv/extra
cat > docker-compose.yml <<'YML'
name: extra
services:
  web:
    image: alpine:3.22
    command: ["sleep", "infinity"]
    volumes: [data:/data]
volumes:
  data: {}
YML
docker compose up -d --quiet-pull >/dev/null 2>&1`,
  );
  check(onOk('vps-src', 'docker ps --format {{.Names}} | grep -qx extra-web-1'), 'extra-web-1 runs on vps-src');
});

await step('Blank vps-new, log in, add servers and a project for each stack', async () => {
  sh(`${path.join(LAB, 'clone-setup.sh')} reset-new`);
  for (let i = 0; i < 30 && !onOk('vps-new', 'pgrep sshd'); i++) await sleep(500);
  await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
  for (const p of await api('GET', '/projects')) {
    if (['pick-shop', 'pick-extra'].includes(p.slug) || p.deployments?.some((d) => NAMES.includes(d.server_name))) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  }
  for (const s of await api('GET', '/servers')) if (NAMES.includes(s.name)) await api('DELETE', `/servers/${s.id}`);
  const base = { ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY };
  src = await api('POST', '/servers', { ...base, name: 'vps-src', ip: '172.30.0.21' });
  dst = await api('POST', '/servers', { ...base, name: 'vps-new', ip: '172.30.0.22' });
  shop = await api('POST', '/projects', { name: 'Pick Shop', health_scheme: 'http', health_port: 8080, health_path: '/up' });
  await api('POST', `/projects/${shop.id}/deployments`, { server_id: src.id, app_container: 'shop-app-1', app_dir: '/srv/shop', db_type: 'mysql', db_container: 'shop-db-1', db_name: 'shop' });
  extra = await api('POST', '/projects', { name: 'Pick Extra', health_scheme: 'http' });
  await api('POST', `/projects/${extra.id}/deployments`, { server_id: src.id, app_container: 'extra-web-1', app_dir: '/srv/extra', db_type: 'none' });
  check(!onOk('vps-new', 'command -v docker'), 'vps-new is blank');
});

const opts = { host: false, hostApps: true, freeze: true, installDocker: true, addToProjects: true };

await step('Scan without picks lists everything, picked', async () => {
  const r = await api('POST', `/servers/${src.id}/clone/preview`, { target: dst.id, ...opts });
  check(r.ok, `preview ran${r.error ? `: ${r.error}` : ''}`);
  const names = r.plan.stacks.map((s) => `${s.project}:${s.selected}`).sort();
  check(names.includes('shop:true') && names.includes('extra:true'), `stacks: ${names.join(', ')}`);
  const f = r.plan.hostApps.folders;
  check(f.some((x) => x.path === VUE && x.selected) && f.some((x) => x.path === NUXT && x.selected && x.apps.some((a) => a.includes('nuxt-site'))), `folders: ${JSON.stringify(f.map((x) => [x.path, x.selected, x.apps]))}`);
});

let picked;
await step('Scan with only "shop" and the Vue site picked', async () => {
  const r = await api('POST', `/servers/${src.id}/clone/preview`, { target: dst.id, ...opts, stacks: ['shop'], folders: [VUE] });
  picked = r.plan;
  check(r.ok && picked.problems.length === 0, `no problems${picked?.problems.length ? `: ${picked.problems.join(' | ')}` : ''}`);
  check(picked.partial === true, 'marked as a partial clone');
  check(picked.stacks.find((s) => s.project === 'extra')?.selected === false && picked.stacks.find((s) => s.project === 'shop')?.selected === true, 'extra listed but not picked, shop picked');
  check(picked.hostApps.folders.find((x) => x.path === NUXT)?.selected === false, 'Nuxt folder listed but not picked');
  check(picked.hostApps.nvm && !picked.hostApps.npmGlobals.length, 'no global npm packages needed (no PM2 app picked)');
});

await step('Clone only what was picked', async () => {
  const { job } = await api('POST', `/servers/${src.id}/clone`, { target: dst.id, ...opts, stacks: ['shop'], folders: [VUE] });
  const j = await waitJob(job);
  const pickLine = (j.log.match(/Picked: .*/) || [''])[0];
  check(/^Picked: shop, \/var\/www\/vue-site\/dist — left out: extra, .*\/home\/deploy\/apps\/nuxt-site/.test(pickLine), `the job log says what was picked and left out (${pickLine})`);
  for (let i = 0; i < 30 && !onOk('vps-new', 'curl -s 127.0.0.1:8080 | grep -q ok'); i++) await sleep(1000);
  check(onOk('vps-new', 'curl -s 127.0.0.1:8080 | grep -q "ok vps-new"'), 'shop runs on vps-new');
  check(!onOk('vps-new', 'docker ps -a --format {{.Names}} | grep -q extra'), 'no "extra" containers on vps-new');
  check(!onOk('vps-new', 'docker volume ls -q | grep -q extra'), 'no "extra" volume on vps-new');
  check(!onOk('vps-new', 'test -e /srv/extra'), '/srv/extra not copied');
  check(onOk('vps-new', `grep -q "vue ok" ${VUE}/index.html`), 'Vue site folder copied');
  check(!onOk('vps-new', `test -e ${NUXT}`), 'Nuxt folder not copied');
  check(!onOk('vps-new', 'test -e /home/deploy/.pm2/dump.pm2'), 'no PM2 apps set up on vps-new');
  const ps = await api('GET', `/projects/${shop.id}`);
  const pe = await api('GET', `/projects/${extra.id}`);
  check(ps.deployments.some((d) => d.server_id === dst.id), 'vps-new added to Pick Shop');
  check(!pe.deployments.some((d) => d.server_id === dst.id), 'vps-new NOT added to Pick Extra');
});

await step('Clean up vps-src ("extra" stack)', async () => {
  on('vps-src', 'cd /srv/extra && docker compose down -v >/dev/null 2>&1; rm -rf /srv/extra; true');
  check(!onOk('vps-src', 'docker ps -a --format {{.Names}} | grep -q extra'), '"extra" removed from vps-src');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

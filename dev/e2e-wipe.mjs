#!/usr/bin/env node
// End-to-end test for "Remove from server", "Delete project everywhere" and "Reset server".
// Needs the lab (./dev/setup.sh) and the clone pair (./dev/clone-setup.sh).
//   node dev/e2e-wipe.mjs
// Clones vps-src → vps-new, then deletes things ONLY on vps-new. vps-src is only read (and refused a reset).
// Server A (shared Docker socket) is only scanned, to check the "Switchboard runs here" guard.
//   SB_URL=http://localhost:8091  test another Switchboard instance (default: the lab on 8090)
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
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-60).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error})` : ''}`);
      return j;
    }
    await sleep(1000);
  }
  throw new Error('job did not finish in time');
}

let src, dst, srvA, shopP, miniP;
const NAMES = ['vps-src', 'vps-new', 'Wipe Server A'];

await step('Blank vps-new, log in, add servers', async () => {
  sh(`${path.join(LAB, 'clone-setup.sh')} reset-new`);
  for (let i = 0; i < 30 && !onOk('vps-new', 'pgrep sshd'); i++) await sleep(500);
  for (let i = 0; i < 60 && !onOk('vps-src', 'docker exec shop-db-1 true'); i++) await sleep(1000);
  // PM2 does not come back by itself when the lab container restarts.
  onOk('vps-src', "su - deploy -c '. ~/.nvm/nvm.sh >/dev/null; pm2 ping >/dev/null; pm2 resurrect >/dev/null'");
  check(onOk('vps-src', 'docker ps --format {{.Names}} | grep -q shop-app-1'), 'vps-src runs the shop stack');
  await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
  for (const p of await api('GET', '/projects')) {
    if (['wipe-shop', 'wipe-mini'].includes(p.slug) || p.deployments?.some((d) => NAMES.includes(d.server_name))) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  }
  for (const s of await api('GET', '/servers')) if (NAMES.includes(s.name)) await api('DELETE', `/servers/${s.id}`);
  const base = { ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY };
  src = await api('POST', '/servers', { ...base, name: 'vps-src', ip: '172.30.0.21' });
  dst = await api('POST', '/servers', { ...base, name: 'vps-new', ip: '172.30.0.22' });
  srvA = await api('POST', '/servers', { ...base, name: 'Wipe Server A', ip: '172.30.0.11' });
});

await step('Clone vps-src → vps-new, add a second small stack on vps-new', async () => {
  const { job } = await api('POST', `/servers/${src.id}/clone`, { target: dst.id, addToProjects: false });
  await waitJob(job);
  on(
    'vps-new',
    `mkdir -p /srv/mini && printf 'name: mini\\nservices:\\n  app:\\n    image: alpine:3.22\\n    command: [sleep, infinity]\\n    volumes: [data:/data]\\nvolumes:\\n  data: {}\\n' > /srv/mini/docker-compose.yml && cd /srv/mini && docker compose up -d -q 2>/dev/null || (cd /srv/mini && docker compose up -d)`,
  );
  check(/mini-app-1/.test(on('vps-new', 'docker ps --format {{.Names}}')), 'mini stack runs on vps-new');
  shopP = await api('POST', '/projects', { name: 'Wipe Shop', domain: 'wipe-shop.test', health_scheme: 'http', health_path: '/up', health_port: 8080 });
  const dep = { app_container: 'shop-app-1', app_dir: '/srv/shop', db_type: 'mysql', db_container: 'shop-db-1', db_name: 'shop', db_user: 'root', db_password: 'rootpass-c' };
  const a = await api('POST', `/projects/${shopP.id}/deployments`, { ...dep, server_id: src.id });
  await api('POST', `/projects/${shopP.id}/deployments`, { ...dep, server_id: dst.id });
  await api('POST', `/projects/${shopP.id}/adopt`, { deployment: a.id });
  miniP = await api('POST', '/projects', { name: 'Wipe Mini', domain: 'wipe-mini.test' });
  const m = await api('POST', `/projects/${miniP.id}/deployments`, { server_id: dst.id, app_container: 'mini-app-1', app_dir: '/srv/mini', db_type: 'none' });
  await api('POST', `/projects/${miniP.id}/adopt`, { deployment: m.id });
});

await step('Guards: live servers and Switchboard\'s own server cannot be wiped', async () => {
  const p = await api('GET', `/projects/${shopP.id}`);
  const live = p.deployments.find((d) => d.server_id === src.id);
  check(/LIVE|ACTIVE/.test(await refused(api('DELETE', `/deployments/${live.id}`, { remove_files: true }))), 'removing the live server is refused');
  const r = await api('POST', `/servers/${src.id}/reset/preview`, {});
  check(r.ok && r.plan.problems.some((x) => /live server of Wipe Shop/.test(x)), `reset preview of vps-src shows the problem (${r.plan?.problems.join(' | ')})`);
  check(/live server/.test(await refused(api('POST', `/servers/${src.id}/reset`, { confirm: 'vps-src' }))), 'reset of vps-src refused');
  check(/confirm/.test(await refused(api('POST', `/servers/${dst.id}/reset`, { confirm: 'wrong' }))), 'reset without the typed name refused');
  const a = await api('POST', `/servers/${srvA.id}/reset/preview`, {});
  check(a.ok && a.plan.problems.some((x) => /This Switchboard dashboard runs on this server/.test(x)), `Server A (shared Docker socket) is protected: ${a.plan?.problems[0] || a.error}`);
  check(onOk('vps-src', 'docker ps --format {{.Names}} | grep -q shop-app-1'), 'vps-src unchanged');
});

await step('Remove "Wipe Shop" from vps-new (backup, containers, volumes, folder)', async () => {
  const p = await api('GET', `/projects/${shopP.id}`);
  const d = p.deployments.find((x) => x.server_id === dst.id);
  const before = (await api('GET', `/projects/${shopP.id}/backups`)).length;
  const { job } = await api('DELETE', `/deployments/${d.id}`, { remove_files: true, backup: true });
  const j = await waitJob(job);
  const ps = on('vps-new', "docker ps -a --format '{{.Names}}'");
  check(!/shop-/.test(ps), 'shop containers gone from vps-new');
  check(/mini-app-1/.test(ps), 'mini stack untouched');
  check(!/shop_/.test(on('vps-new', 'docker volume ls -q')), 'shop volumes gone');
  check(/mini_data/.test(on('vps-new', 'docker volume ls -q')), 'mini volume kept');
  check(!onOk('vps-new', 'test -e /srv/shop'), '/srv/shop deleted');
  check(onOk('vps-new', 'test -f /srv/shared-uploads/logo.txt') && /Kept folders outside .*\/srv\/shared-uploads/.test(j.log), 'outside folder /srv/shared-uploads kept, and the log says so');
  check(onOk('vps-new', 'docker image inspect alpine:3.22'), 'alpine image kept (mini still uses it)');
  check(!onOk('vps-new', 'docker image inspect mysql:8.4'), 'mysql image removed (nothing uses it)');
  const after = await api('GET', `/projects/${shopP.id}/backups`);
  check(after.length === before + 1 && after[0].server_name === 'vps-new', 'a database backup of vps-new was taken first');
  const p2 = await api('GET', `/projects/${shopP.id}`);
  check(p2.deployments.length === 1 && p2.deployments[0].server_id === src.id, 'vps-new removed from the project');
  check(onOk('vps-src', 'docker ps --format {{.Names}} | grep -q shop-app-1') && onOk('vps-src', 'test -f /srv/shop/.env'), 'vps-src untouched');
});

await step('Delete "Wipe Mini" everywhere', async () => {
  check(/confirm/.test(await refused(api('DELETE', `/projects/${miniP.id}`, { confirm: 'nope', remove_files: true }))), 'needs the typed slug');
  const { job } = await api('DELETE', `/projects/${miniP.id}`, { confirm: 'wipe-mini', remove_files: true });
  await waitJob(job);
  check(!/mini/.test(on('vps-new', "docker ps -a --format '{{.Names}}'; docker volume ls -q")), 'mini containers and volume gone');
  check(!onOk('vps-new', 'test -e /srv/mini'), '/srv/mini deleted');
  check(/404/.test(await refused(api('GET', `/projects/${miniP.id}`))), 'project deleted from Switchboard');
});

await step('Reset vps-new', async () => {
  check(on('vps-new', 'crontab -l').includes('# schedule'), 'before: root crontab exists (copied by the clone)');
  check(on('vps-new', 'curl -s -H "Host: vue.test" localhost') === 'vue ok', 'before: nginx site vue.test works');
  const r = await api('POST', `/servers/${dst.id}/reset/preview`, {});
  check(r.ok && !r.plan.problems.length, `preview: no problems${r.plan?.problems.length ? `: ${r.plan.problems.join(' | ')}` : ''}${r.error ? r.error : ''}`);
  const plan = r.plan;
  check(plan.pm2.some((x) => x.startsWith('nuxt-site')), `preview lists PM2 apps (${plan.pm2.join(', ')})`);
  check(plan.folders.includes('/home/deploy/apps/nuxt-site') && plan.folders.includes('/var/www/vue-site/dist'), `preview lists app folders (${plan.folders.join(', ')})`);
  check(plan.crontabs.includes('root') && plan.crontabs.includes('deploy'), 'preview lists crontabs');
  check(plan.users.includes('deploy'), 'preview: user deploy is kept');
  check(onOk('vps-new', 'pgrep -f [s]erver.mjs'), 'preview changed nothing');
  const { job } = await api('POST', `/servers/${dst.id}/reset`, { confirm: 'vps-new' });
  await waitJob(job);
  check(on('vps-new', 'docker ps -aq | wc -l') === '0', 'no containers');
  check(on('vps-new', 'docker volume ls -q | wc -l') === '0', 'no volumes');
  check(on('vps-new', 'docker images -q | wc -l') === '0', 'no images');
  check(onOk('vps-new', 'docker info >/dev/null'), 'Docker still installed and running');
  check(!onOk('vps-new', 'test -e /home/deploy/apps/nuxt-site') && !onOk('vps-new', 'test -e /var/www/vue-site/dist'), 'app folders deleted');
  check(onOk('vps-new', 'test -d /var/www/html'), "nginx's stock /var/www/html kept");
  check(onOk('vps-new', 'test -d /home/deploy') && onOk('vps-new', 'id deploy'), 'user deploy and its home kept');
  check(!onOk('vps-new', 'pgrep -f [s]erver.mjs') && !onOk('vps-new', 'test -e /home/deploy/.pm2'), 'PM2 apps stopped and removed');
  check(!onOk('vps-new', 'test -e /etc/nginx/sites-enabled/apps'), 'nginx site removed');
  check(on('vps-new', 'curl -s -o /dev/null -w %{http_code} -H "Host: vue.test" localhost') !== '200' || !on('vps-new', 'curl -s -H "Host: vue.test" localhost').includes('vue ok'), 'vue.test no longer served');
  check(!onOk('vps-new', 'crontab -l 2>/dev/null | grep -q .') && !onOk('vps-new', 'crontab -u deploy -l 2>/dev/null | grep -q .'), 'crontabs cleared');
  check(onOk('vps-new', 'ls /root/switchboard-reset-*.tar.gz'), 'old configs saved in /root/switchboard-reset-*.tar.gz');
  const ok = await api('POST', `/servers/${dst.id}/refresh`);
  check(ok.ok, 'SSH still works after the reset');
  check(onOk('vps-src', 'docker ps --format {{.Names}} | grep -q shop-app-1') && onOk('vps-src', 'pgrep -f [s]erver.mjs'), 'vps-src untouched');
});

await step('Clean up', async () => {
  await api('DELETE', `/projects/${shopP.id}`, { confirm: 'wipe-shop' }).catch(() => {});
  for (const s of [src, dst, srvA]) await api('DELETE', `/servers/${s.id}`).catch(() => {});
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);

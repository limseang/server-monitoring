#!/usr/bin/env node
// End-to-end test for "Clone server". Needs the lab (./dev/setup.sh) and the clone pair (./dev/clone-setup.sh).
//   node dev/e2e-clone.mjs
// Clones vps-src → vps-new (blank, no Docker) through the real API, then checks the result inside vps-new.
// Only touches the vps-src / vps-new containers and the "Clone Shop" project + the two vps servers in the lab dashboard.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SB_URL || 'http://localhost:8090';
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
/** Run a shell command inside a pretend VPS. */
const on = (vps, cmd) => sh(`docker exec ${vps} sh -c ${JSON.stringify(cmd)}`);
const onOk = (vps, cmd) => shOk(`docker exec ${vps} sh -c ${JSON.stringify(cmd)}`);
const sql = (vps, q) => on(vps, `docker exec shop-db-1 mysql -uroot -prootpass-c -N -B --default-character-set=utf8mb4 shop -e "${q}" 2>/dev/null`);
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

let src;
let dst;
let project;

await step('Reset vps-new to a blank server', async () => {
  sh(`${path.join(DIR, 'clone-setup.sh')} reset-new`);
  for (let i = 0; i < 30 && !onOk('vps-new', 'pgrep sshd'); i++) await sleep(500);
  check(!onOk('vps-new', 'command -v docker'), 'vps-new has no Docker');
  check(onOk('vps-src', 'docker ps --format {{.Names}} | grep -q shop-app-1'), 'vps-src runs the shop stack');
});

await step('Log in, add both servers, create a project on vps-src', async () => {
  await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
  // Remove lab projects that use these two servers (other tests may have left some behind).
  for (const p of await api('GET', '/projects')) {
    if (p.slug === 'clone-shop' || p.deployments?.some((d) => ['vps-src', 'vps-new'].includes(d.server_name))) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  }
  for (const s of await api('GET', '/servers')) if (['vps-src', 'vps-new'].includes(s.name)) await api('DELETE', `/servers/${s.id}`);
  const base = { ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY };
  src = await api('POST', '/servers', { ...base, name: 'vps-src', ip: '172.30.0.21' });
  dst = await api('POST', '/servers', { ...base, name: 'vps-new', ip: '172.30.0.22' });
  project = await api('POST', '/projects', { name: 'Clone Shop', domain: 'clone-shop.test', health_scheme: 'http', health_path: '/up', health_port: 8080 });
  await api('POST', `/projects/${project.id}/deployments`, { server_id: src.id, app_container: 'shop-app-1', app_dir: '/srv/shop', db_type: 'mysql', db_container: 'shop-db-1', db_name: 'shop' });
  // The fake app answers one request at a time, so retry a few checks before judging.
  let p;
  for (let i = 0; i < 5; i++) {
    await sleep(1000);
    await api('POST', `/projects/${project.id}/check`);
    p = await api('GET', `/projects/${project.id}`);
    if (p.deployments[0]?.health === 'up') break;
  }
  check(p.deployments.length === 1 && p.deployments[0].health === 'up', `vps-src health: ${p.deployments[0]?.health}`);
});

await step('Preview the clone (scan only)', async () => {
  const r = await api('POST', `/servers/${src.id}/clone/preview`, { target: dst.id, extraPaths: '/opt/tools' });
  check(r.ok, `preview ran${r.error ? `: ${r.error}` : ''}`);
  const plan = r.plan;
  check(plan.problems.length === 0, `no blocking problems${plan.problems.length ? `: ${plan.problems.join(' | ')}` : ''}`);
  check(plan.target.docker === 'none', 'target has no Docker yet (will be installed)');
  const shop = plan.stacks.find((s) => s.project === 'shop');
  check(shop && shop.volumes.length === 2 && shop.binds.includes('/srv/shared-uploads'), `stack "shop" found with 2 volumes and the outside folder (${JSON.stringify(shop?.binds)})`);
  check(plan.host.packages.includes('jq') && plan.host.packages.includes('cron'), `packages to install include jq + cron (${plan.host.packages.join(' ')})`);
  check(plan.host.users.includes('deploy'), 'user deploy will be created');
  const ha = plan.hostApps;
  check(ha && ha.pm2.some((a) => a.name === 'nuxt-site' && a.user === 'deploy' && a.status === 'online'), 'PM2 app nuxt-site (user deploy) found');
  check(ha && ha.pm2.some((a) => a.name === 'nuxt-worker' && a.status === 'stopped'), 'stopped PM2 app nuxt-worker found');
  check(ha && ha.nvm.some((n) => n.user === 'deploy'), 'nvm Node.js of deploy found');
  check(ha && ha.sites.some((x) => x.names.includes('vue.test') && x.kind === 'static') && ha.sites.some((x) => x.names.includes('nuxt.test') && x.kind === 'proxy'), 'nginx sites vue.test (static) + nuxt.test (proxy) found');
  check(ha && ha.folders.includes('/home/deploy/apps/nuxt-site') && ha.folders.includes('/var/www/vue-site/dist'), `app folders: ${ha?.folders.join(', ')}`);
  check(plan.host.packages.includes('nginx'), 'nginx will be installed');
  check(onOk('vps-new', '! command -v docker'), 'preview changed nothing on vps-new');
});

await step('Clone vps-src → vps-new (installs Docker on the way)', async () => {
  const before = { orders: sql('vps-src', 'SELECT COUNT(*) FROM orders') };
  const { job } = await api('POST', `/servers/${src.id}/clone`, { target: dst.id, extraPaths: '/opt/tools' });
  await waitJob(job);
  const ps = on('vps-new', "docker ps -a --format '{{.Names}} {{.State}}'");
  check(/shop-app-1 running/.test(ps) && /shop-db-1 running/.test(ps), 'app and db running on vps-new');
  check(/shop-worker-1 (exited|created)/.test(ps), 'worker stays stopped, like on the source');
  let rows = '';
  for (let i = 0; i < 30; i++) {
    try {
      rows = sql('vps-new', 'SELECT COUNT(*) FROM orders');
      break;
    } catch {
      await sleep(2000);
    }
  }
  check(rows === before.orders, `database copied (orders: ${rows} = ${before.orders})`);
  check(sql('vps-new', 'SELECT note FROM orders WHERE id=2').includes('ទិញអំពូល'), 'unicode data intact');
  check(on('vps-new', 'docker exec shop-app-1 cat /var/www/html/storage/app/public/products/fan.jpg') === 'fan photo', 'named volume data copied');
  check(on('vps-new', 'cat /srv/shared-uploads/logo.txt') === 'logo', 'bind mount outside the stack folder copied');
  check(on('vps-new', 'cat /srv/shop/.env').includes('APP_KEY=base64:clonetestkey'), '.env copied');
  check(on('vps-new', 'id -u deploy') === '1001' && on('vps-new', 'id -nG deploy').includes('deployers'), 'user deploy (uid 1001, group deployers)');
  check(on('vps-new', 'cat /home/deploy/.ssh/authorized_keys').includes('deploy@laptop'), "deploy's SSH key copied");
  check(onOk('vps-new', 'test -f /etc/sudoers.d/deploy'), 'sudoers.d/deploy copied (passed visudo)');
  check(on('vps-new', 'crontab -l').includes('# schedule'), 'root crontab copied');
  check(on('vps-new', 'crontab -u deploy -l').includes('deploy-cron'), 'deploy crontab copied');
  check(on('vps-new', 'cat /etc/timezone') === 'Asia/Phnom_Penh', 'timezone Asia/Phnom_Penh');
  check(onOk('vps-new', 'command -v jq'), 'package jq installed');
  check(onOk('vps-new', 'test -f /etc/logrotate.d/shop'), '/etc/logrotate.d/shop copied');
  check(on('vps-new', '/opt/tools/hello.sh') === 'hello from tools', 'extra path /opt/tools copied');
  check(!/paused/i.test(on('vps-src', "docker ps --format '{{.Names}} {{.Status}}'")), 'nothing left paused on vps-src');
  check(/shop-app-1 running/.test(on('vps-src', "docker ps --format '{{.Names}} {{.State}}'")), 'vps-src still running');
  // Apps outside Docker
  const pm2 = (vps) => on(vps, `su - deploy -c '. ~/.nvm/nvm.sh >/dev/null; pm2 jlist' | grep '^\\[' | tail -1`);
  const list = JSON.parse(pm2('vps-new') || '[]');
  check(list.find((x) => x.name === 'nuxt-site')?.pm2_env.status === 'online', 'PM2 nuxt-site online on vps-new');
  check(list.find((x) => x.name === 'nuxt-worker')?.pm2_env.status === 'stopped', 'PM2 nuxt-worker stopped, like on the source');
  check(on('vps-new', 'curl -s localhost:3000') === 'nuxt ok', 'Nuxt-style app answers on port 3000');
  check(on('vps-new', 'curl -s -H "Host: vue.test" localhost') === 'vue ok', 'static Vue site served by nginx');
  check(on('vps-new', 'curl -s -H "Host: nuxt.test" localhost') === 'nuxt ok', 'nginx proxy to the Nuxt app works');
  check(on('vps-new', "su - deploy -c '. ~/.nvm/nvm.sh >/dev/null; node -v'") === on('vps-src', "su - deploy -c '. ~/.nvm/nvm.sh >/dev/null; node -v'"), 'same Node.js version (nvm)');
  const apps = await api('GET', `/servers/${dst.id}/apps`);
  const names = (apps.sites || []).flatMap((x) => x.names);
  check(apps.ok && apps.pm2.length === 2 && names.includes('vue.test') && names.includes('nuxt.test'), `server page sees ${apps.pm2?.length} PM2 apps and the sites ${names.join(', ')} on vps-new`);
  check(!JSON.stringify(apps).includes('pm2_env'), 'PM2 env (secrets) not sent to the browser');
  const act = await api('POST', `/servers/${dst.id}/apps/action`, { type: 'pm2', user: 'deploy', name: 'nuxt-worker', action: 'start' });
  await waitJob(act.job);
  check(JSON.parse(pm2('vps-new')).find((x) => x.name === 'nuxt-worker')?.pm2_env.status === 'online', 'Start button: nuxt-worker online');
  await waitJob((await api('POST', `/servers/${dst.id}/apps/action`, { type: 'pm2', user: 'deploy', name: 'nuxt-worker', action: 'stop' })).job);
  const logs = await api('GET', `/servers/${dst.id}/apps/logs?type=pm2&user=deploy&name=nuxt-worker&tail=50`);
  check(typeof logs.log === 'string', 'Logs button returns PM2 logs');
  let refused = false;
  try {
    await api('POST', `/servers/${dst.id}/apps/action`, { type: 'pm2', user: 'deploy', name: 'x; rm -rf /', action: 'restart' });
  } catch {
    refused = true;
  }
  check(refused, 'unsafe app name refused');

  const p = await api('GET', `/projects/${project.id}`);
  const dep = p.deployments.find((d) => d.server_id === dst.id);
  check(!!dep, 'vps-new added to "Clone Shop" as a standby');
  check(dep && dep.app_container === 'shop-app-1' && dep.db_container === 'shop-db-1', 'with the same container settings');
  let p2;
  for (let i = 0; i < 5; i++) {
    await sleep(1000);
    await api('POST', `/projects/${project.id}/check`);
    p2 = await api('GET', `/projects/${project.id}`);
    if (p2.deployments.find((d) => d.server_id === dst.id)?.health === 'up') break;
  }
  check(p2.deployments.find((d) => d.server_id === dst.id)?.health === 'up', 'vps-new passes the health check');
  check(p2.active_deployment_id !== dep?.id, 'traffic not moved (vps-new is standby)');
});

await step('Running it again is refused unless "replace" is ticked', async () => {
  const r = await api('POST', `/servers/${src.id}/clone/preview`, { target: dst.id });
  check(r.ok && r.plan.problems.some((p) => /already runs: shop/.test(p)), 'preview reports the stack already exists');
  const mark = `after first clone ${Date.now()}`;
  sql('vps-src', `INSERT INTO orders (user_id, product_id, qty, note) VALUES (1, 2, 3, '${mark}')`);
  const { job } = await api('POST', `/servers/${src.id}/clone`, { target: dst.id, replace: true, host: false });
  const j = await waitJob(job);
  check(/already on vps-new/.test(j.log), 'images not copied again');
  let n = '';
  for (let i = 0; i < 30; i++) {
    try {
      n = sql('vps-new', `SELECT COUNT(*) FROM orders WHERE note='${mark}'`);
      break;
    } catch {
      await sleep(2000);
    }
  }
  check(n === '1', 'new order is on vps-new after the re-clone');
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ All clone checks passed');
process.exit(failures ? 1 : 0);

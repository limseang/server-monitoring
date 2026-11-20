#!/usr/bin/env node
// End-to-end test: maintenance mode when the server card has no App container set.
// "php artisan down" can't run on the server itself (no PHP there): Switchboard must find the app's container in
// the Docker Compose project of the app folder, run it there, and save it on the server card.
// Needs vps-src from the clone pair (./dev/clone-setup.sh). Adds a small compose app in /srv/maint-lab and removes it.
//   node dev/e2e-maint.mjs
//   SB_URL=http://localhost:8096 SB_USER=… SB_PASSWORD=…   test another Switchboard instance (default: the lab on 8090)
//   SB_LAB_DIR=/path/to/dev                                where .keys is (default: this folder)
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
const on = (cmd) => execSync('docker exec -i vps-src sh -s', { input: cmd, encoding: 'utf8' }).trim();
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
  for (let i = 0; i < 300; i++) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-15).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error})` : ''}`);
      return j;
    }
    await sleep(1000);
  }
  throw new Error('job did not finish in time');
}

// A Laravel-like stack: app + queue have "php" (a tiny fake that records artisan down/up), db has none.
const FAKE_PHP = `#!/bin/sh
[ "$1" = artisan ] && echo "$2" > /tmp/artisan-last && echo "artisan $2 done" && exit 0
echo "php $*"`;
const STACK = `set -e
rm -rf /srv/maint-lab && mkdir -p /srv/maint-lab/docker
cat > /srv/maint-lab/fake-php <<'PHP'
${FAKE_PHP}
PHP
chmod 755 /srv/maint-lab/fake-php
cat > /srv/maint-lab/docker/docker-compose.yml <<'YML'
name: maintlab
services:
  app:
    image: alpine:3.22
    container_name: maintlab-app
    command: ["sleep", "infinity"]
    volumes: ["/srv/maint-lab/fake-php:/usr/local/bin/php:ro"]
  queue:
    image: alpine:3.22
    command: ["sleep", "infinity"]
    volumes: ["/srv/maint-lab/fake-php:/usr/local/bin/php:ro"]
  db:
    image: alpine:3.22
    command: ["sleep", "infinity"]
YML
cd /srv/maint-lab/docker && docker compose up -d --quiet-pull >/dev/null 2>&1
docker exec maintlab-app php artisan about
command -v php || echo no-php-on-host`;

let srv, proj, dep;
await step('Set up: a compose app in /srv/maint-lab/docker; the server card has NO app container', async () => {
  const out = on(STACK);
  check(/php artisan|artisan about done/.test(out) && /no-php-on-host/.test(out), `fake php in maintlab-app, none on the host (${out.split('\n').join(' | ')})`);
  await api('POST', '/auth/login', { username: process.env.SB_USER || 'admin', password: process.env.SB_PASSWORD || 'admin-password-123' });
  for (const p of await api('GET', '/projects')) if (p.slug === 'maint-lab') await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  for (const s of await api('GET', '/servers')) if (s.name === 'Maint vps-src') await api('DELETE', `/servers/${s.id}`);
  srv = await api('POST', '/servers', { ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY, name: 'Maint vps-src', ip: '172.30.0.21' });
  proj = await api('POST', '/projects', { name: 'Maint Lab', domain: 'maint.lab.test' });
  dep = await api('POST', `/projects/${proj.id}/deployments`, { server_id: srv.id, app_dir: '/srv/maint-lab', db_type: 'none' });
  const p = await api('GET', `/projects/${proj.id}`);
  check(!p.deployments[0].app_container && /php artisan down/.test(p.maintenance_on_cmd), `no app container; maintenance command: ${p.maintenance_on_cmd}`);
});

await step('Maintenance ON: finds maintlab-app (not queue or db), runs it there, saves it', async () => {
  const { job } = await api('POST', `/deployments/${dep.id}/maintenance`, { on: true });
  const j = await waitJob(job);
  check(/found it in the app container maintlab-app \(also: maintlab-queue-1\)/.test(j.log), 'the log says which container it found');
  check(on('docker exec maintlab-app cat /tmp/artisan-last') === 'down', '"php artisan down" ran in maintlab-app');
  check(on('docker exec maintlab-queue-1 cat /tmp/artisan-last 2>/dev/null || echo none') === 'none', 'not in the queue container');
  const p = await api('GET', `/projects/${proj.id}`);
  check(p.deployments[0].app_container === 'maintlab-app' && p.deployments[0].maintenance, 'saved on the server card; maintenance is on');
});

await step('Maintenance OFF: uses the saved container', async () => {
  const { job } = await api('POST', `/deployments/${dep.id}/maintenance`, { on: false });
  const j = await waitJob(job);
  check(!/found it in the app container/.test(j.log), 'no search needed this time');
  check(on('docker exec maintlab-app cat /tmp/artisan-last') === 'up', '"php artisan up" ran in maintlab-app');
});

await step('No container has php: still a clear message', async () => {
  await api('PUT', `/deployments/${dep.id}`, { ...(await api('GET', `/projects/${proj.id}`)).deployments[0], app_container: '' }).catch(() => null);
  on('cd /srv/maint-lab/docker && docker compose stop app queue >/dev/null 2>&1');
  const p = await api('GET', `/projects/${proj.id}`);
  if (p.deployments[0].app_container) {
    check(true, '(skipped: the server card could not be cleared through the API)');
    return;
  }
  const { job } = await api('POST', `/deployments/${dep.id}/maintenance`, { on: true });
  const j = await waitJob(job, 'failed');
  check(/no running container of \/srv\/maint-lab has it/.test(j.log), 'the error says the app may not be running');
});

await step('Clean up', async () => {
  on('cd /srv/maint-lab/docker && docker compose down -v >/dev/null 2>&1; rm -rf /srv/maint-lab');
  if (proj) await api('DELETE', `/projects/${proj.id}`, { confirm: proj.slug });
  if (srv) await api('DELETE', `/servers/${srv.id}`);
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all maintenance checks passed');
process.exit(failures ? 1 : 0);

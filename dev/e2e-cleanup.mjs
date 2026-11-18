#!/usr/bin/env node
// End-to-end test for "Clean up / free memory" (server page → More → Clean up).
// Uses ONE isolated Docker-in-Docker lab server with its own Docker daemon (default vps-db,
// 172.30.0.23, from ./dev/clone-setup.sh) — never srv-a/srv-b (they share your Mac's Docker)
// and never your own Switchboard. It fills that server with junk (build cache, dangling images,
// a stopped container, an unused network, big log files) plus a small "Laravel" app, cleans up,
// and checks that the junk is gone while volumes, running apps and project containers stay.
//   docker compose --profile clone up -d vps-db     (in ./dev; or run ./dev/clone-setup.sh)
//   SB_URL=http://localhost:8095 node dev/e2e-cleanup.mjs
//   SB_VPS=vps-new SB_VPS_IP=172.30.0.22   use another isolated lab server (needs Docker in it)
//   SB_LAB_DIR=/path/to/dev                 where .keys is (default: this folder)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LAB = process.env.SB_LAB_DIR || DIR;
const BASE = process.env.SB_URL || 'http://localhost:8090';
const VPS = process.env.SB_VPS || 'vps-db';
const VPS_IP = process.env.SB_VPS_IP || '172.30.0.23';
const KEY = fs.readFileSync(path.join(LAB, '.keys/id_ed25519'), 'utf8');
const NAME = `Cleanup ${VPS}`;
let cookie = '';
let failures = 0;

async function api(method, url, body, jar) {
  const res = await fetch(`${BASE}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard', Cookie: jar?.cookie ?? cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) (jar ? (jar.cookie = c.split(';')[0]) : (cookie = c.split(';')[0]));
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
  return data;
}
const refused = (p) => p.then(() => '').catch((e) => e.message);
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
const on = (cmd) => sh(`docker exec ${VPS} sh -c ${JSON.stringify(cmd)}`);
const onIn = (script) => execSync(`docker exec -i ${VPS} sh -s`, { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
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
async function waitJob(job, expect = 'success', minutes = 10) {
  for (let i = 0; i < minutes * 60; i++) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-70).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error})` : ''}`);
      return j;
    }
    await sleep(1000);
  }
  throw new Error('job did not finish in time');
}

// A fake Laravel app: "php artisan …" only writes down what it was asked to do.
const SEED = `set -e
docker rm -f clean-junk >/dev/null 2>&1 || true
docker network rm clean-net >/dev/null 2>&1 || true
mkdir -p /srv/clean/storage/logs /srv/clean/img
cd /srv/clean/img
cat > php <<'PHP'
#!/bin/sh
# fake php: "php artisan <cmd>" → remember it
shift; echo "$*" >> /app/artisan-calls.log
[ "$1" = "optimize:clear" ] && rm -f /app/bootstrap/cache/config.php
[ "$1" = "optimize" ] && echo cached > /app/bootstrap/cache/config.php
exit 0
PHP
build() {
  printf 'FROM redis:7-alpine\\nCOPY php /usr/local/bin/php\\nRUN chmod +x /usr/local/bin/php && mkdir -p /app/bootstrap/cache && touch /app/artisan && echo cached > /app/bootstrap/cache/config.php\\nRUN head -c 8000000 /dev/urandom > /junk-%s\\nWORKDIR /app\\n' "$1" > Dockerfile
  docker build -q -t clean-app:latest . >/dev/null
}
build one; build two   # two builds leave build cache
# An image without a name ("dangling"), like the leftover of a rebuild.
printf 'FROM redis:7-alpine\\nRUN head -c 4000000 /dev/urandom > /dangling\\n' | docker build -q - >/dev/null
cat > /srv/clean/docker-compose.yml <<'YML'
name: clean
services:
  app:
    image: clean-app:latest
    container_name: clean-app
    volumes: [data:/data]
  worker:
    image: clean-app:latest
    command: ["true"]
volumes:
  data: {}
YML
cd /srv/clean && docker compose up -d --quiet-pull >/dev/null 2>&1 || docker compose up -d
docker exec clean-app sh -c 'echo precious > /data/keep.txt'
docker run --name clean-junk redis:7-alpine true
docker network create clean-net >/dev/null
head -c 31457280 /dev/urandom > /var/log/clean-big.log
head -c 26214400 /dev/urandom > /srv/clean/storage/logs/laravel.log
echo "small but important" > /var/log/clean-small.log
# A file name that would run a command if it were not quoted.
head -c 22020096 /dev/urandom > '/var/log/clean-$(echo PWNED >&2).log'
mkdir -p /var/cache/apt/archives && head -c 3000000 /dev/urandom > /var/cache/apt/archives/clean-fake.deb
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Status}}' clean-worker-1 2>/dev/null)" = exited ] && break; sleep 1; done
echo seeded`;

let srv, proj;
// Images the lab server had before the test: "all unused images" removes them, the end puts them back.
const imagesBefore = on("docker images --format '{{.Repository}}:{{.Tag}}'").split('\n').filter((x) => x && !x.includes('<none>') && !x.startsWith('clean-'));
function loadImage(img) {
  if (on(`docker image inspect ${img} >/dev/null 2>&1 && echo yes || true`) === 'yes') return;
  try {
    sh(`docker image inspect ${img} >/dev/null 2>&1 || docker pull -q ${img}`);
    sh(`docker save ${img} | docker exec -i ${VPS} docker load -q`);
  } catch (e) {
    console.log(`  (could not load ${img} into ${VPS}: ${e.message.split('\n')[0]})`);
  }
}
loadImage('redis:7-alpine');

await step(`Seed ${VPS} with junk, log in, add the server and a project`, async () => {
  check(/seeded/.test(onIn(SEED)), `${VPS}: junk + fake Laravel app "clean-app" created`);
  check(Number(on('docker images -f dangling=true -q | wc -l')) >= 1, 'there is a dangling image');
  check(on("docker inspect -f '{{.State.Status}}' clean-worker-1") === 'exited', 'compose service clean-worker-1 is stopped (belongs to the project)');
  await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
  for (const p of await api('GET', '/projects')) if (p.slug === 'clean-shop') await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  for (const s of await api('GET', '/servers')) if (s.name === NAME) await api('DELETE', `/servers/${s.id}`);
  srv = await api('POST', '/servers', { name: NAME, ip: VPS_IP, ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY });
  proj = await api('POST', '/projects', { name: 'Clean Shop', domain: 'clean-shop.test' });
  await api('POST', `/projects/${proj.id}/deployments`, { server_id: srv.id, app_container: 'clean-app', app_dir: '/srv/clean', db_type: 'none' });
});

let plan;
await step('Preview shows what can be freed (and changes nothing)', async () => {
  const r = await api('POST', `/servers/${srv.id}/cleanup/preview`, {});
  check(r.ok, `preview ok${r.error ? ` (${r.error})` : ''}`);
  plan = r.plan;
  check(plan.disk?.avail > 0 && plan.mem?.total > 0, `disk ${plan.disk?.pct}% full, memory ${Math.round(plan.mem?.available / 1e6)} MB available`);
  check(plan.buildCache > 0, `build cache ${plan.buildCache} bytes`);
  check(plan.images.dangling >= 1 && plan.images.danglingBytes > 0, `dangling images: ${plan.images.dangling} (${plan.images.danglingBytes} bytes)`);
  const junk = plan.stopped.find((c) => c.name === 'clean-junk');
  const worker = plan.stopped.find((c) => c.name === 'clean-worker-1');
  check(junk && !junk.kept, 'clean-junk is listed as removable');
  check(worker && worker.kept, 'clean-worker-1 (stopped, part of the Clean Shop project) is kept');
  check(plan.networks >= 1, `unused networks: ${plan.networks}`);
  check(plan.logs.some((l) => l.path === '/var/log/clean-big.log') && plan.logs.some((l) => l.path === '/srv/clean/storage/logs/laravel.log'), 'big logs listed: /var/log/clean-big.log and the Laravel storage/logs file');
  check(!plan.logs.some((l) => l.path === '/var/log/clean-small.log'), 'small log not listed');
  check(plan.apt > 0, `apt cache ${plan.apt} bytes`);
  check(plan.laravel.length === 1 && plan.laravel[0].cached, `Laravel app found: ${JSON.stringify(plan.laravel)}`);
  check(plan.top.some((c) => c.name === 'clean-app'), `top containers by memory include clean-app (${plan.top.map((c) => c.name).join(', ')})`);
  check(on('ls /srv/clean/storage/logs/laravel.log && docker ps -aq --filter name=clean-junk | wc -l') .endsWith('1'), 'preview changed nothing');
});

await step('Guards: who may run it, empty choice, busy', async () => {
  check(/Tick at least one/.test(await refused(api('POST', `/servers/${srv.id}/cleanup`, {}))), 'nothing ticked → refused');
  const { users } = await api('GET', '/users');
  const old = users.find((u) => u.username === 'dev-clean');
  if (old) await api('DELETE', `/users/${old.id}`);
  await api('POST', '/users', { username: 'dev-clean', password: 'dev-password-123', role: 'developer' });
  const jar = { cookie: '' };
  await api('POST', '/auth/login', { username: 'dev-clean', password: 'dev-password-123' }, jar);
  check(/role/.test(await refused(api('POST', `/servers/${srv.id}/cleanup`, { logs: true }, jar))), 'a developer cannot start a cleanup');
  check(/role/.test(await refused(api('PUT', `/servers/${srv.id}/cleanup/schedule`, { cron: '0 4 * * 0', options: { logs: true } }, jar))), 'a developer cannot change the schedule');
  const u = (await api('GET', '/users')).users.find((x) => x.username === 'dev-clean');
  if (u) await api('DELETE', `/users/${u.id}`);
});

await step('Clean up: Docker, system, Laravel, memory (+ restart clean-app)', async () => {
  const startedBefore = on("docker inspect -f '{{.State.StartedAt}}' clean-app");
  const opts = { buildCache: true, images: true, containers: true, networks: true, journal: true, apt: true, logs: true, laravel: true, dropCaches: true, swap: false, restart: ['clean-app', 'no-such-container'] };
  const { job } = await api('POST', `/servers/${srv.id}/cleanup`, opts);
  check(/already running/.test(await refused(api('POST', `/servers/${srv.id}/cleanup`, { logs: true }))), 'a second cleanup of the same server is refused while one runs');
  const j = await waitJob(job);
  check(/Before: disk/.test(j.log) && /After: {2}disk/.test(j.log) && /Result: disk: .*; memory available/.test(j.log), 'log shows before / after / result');
  console.log(`      ${(j.log.match(/Result: .*/) || [''])[0]}`);
  check(/no-such-container: no such container — skipped/.test(j.log), 'unknown container to restart → skipped with a warning');
  check(Number(on('docker images -f dangling=true -q | wc -l')) === 0, 'dangling images gone');
  check(/clean-app:latest/.test(on("docker images --format '{{.Repository}}:{{.Tag}}'")), 'the used image clean-app:latest is still there');
  check(on("docker buildx du 2>/dev/null | tail -1").match(/Total:\s+0B?/) !== null || /0B/.test(on("docker system df --format '{{.Type}} {{.Reclaimable}}' | grep 'Build Cache'")), 'build cache emptied');
  check(on('docker ps -aq --filter name=^clean-junk$ | wc -l') === '0', 'stopped container clean-junk removed');
  check(on("docker inspect -f '{{.State.Status}}' clean-worker-1") === 'exited', 'clean-worker-1 (project) kept');
  check(on('docker network ls -q --filter name=^clean-net$ | wc -l') === '0', 'unused network clean-net removed');
  check(on("docker exec clean-app cat /data/keep.txt") === 'precious', 'volume data kept');
  check(on("docker inspect -f '{{.State.Running}}' clean-app") === 'true', 'clean-app runs');
  check(on("docker inspect -f '{{.State.StartedAt}}' clean-app") !== startedBefore, 'clean-app was restarted');
  check(on('stat -c %s /var/log/clean-big.log') === '0' && on('stat -c %s /srv/clean/storage/logs/laravel.log') === '0', 'big logs emptied (files still exist)');
  check(on('cat /var/log/clean-small.log') === 'small but important', 'small log untouched');
  // Through stdin, so the Mac's shell never sees the $(…).
  check(!/│ PWNED$/m.test(j.log) && onIn("stat -c %s '/var/log/clean-$(echo PWNED >&2).log'") === '0', 'a log file name with $(…) is emptied, not run as a command');
  check(on('ls /var/cache/apt/archives/clean-fake.deb 2>/dev/null | wc -l') === '0', 'apt cache cleaned');
  check(on('docker exec clean-app cat /app/artisan-calls.log').split('\n').join(' ') === 'optimize:clear optimize', 'Laravel: optimize:clear, then optimize again (it was optimized before)');
  check(/Drop the page cache/.test(j.log), 'page cache step ran');
});

await step('"All unused images" removes named images no container uses', async () => {
  on('docker tag redis:7-alpine clean-unused:1');
  const { job } = await api('POST', `/servers/${srv.id}/cleanup`, { allImages: true });
  await waitJob(job);
  check(!/clean-unused:1/.test(on("docker images --format '{{.Repository}}:{{.Tag}}'")), 'unused image clean-unused:1 removed');
  check(/clean-app:latest/.test(on("docker images --format '{{.Repository}}:{{.Tag}}'")), 'image of the running app kept');
});

await step('Weekly schedule: save, runs by itself, turn off', async () => {
  check(/Cleanup schedule/.test(await refused(api('PUT', `/servers/${srv.id}/cleanup/schedule`, { cron: 'not a cron', options: { logs: true } }))), 'bad cron refused');
  let r = await api('PUT', `/servers/${srv.id}/cleanup/schedule`, { cron: '0 4 * * 0', options: { logs: true, journal: true, restart: ['clean-app'] } });
  check(r.schedule?.cron === '0 4 * * 0' && r.next_run && new Date(r.next_run).getDay() === 0, `weekly on Sunday 04:00 → next ${r.next_run}`);
  check(Array.isArray(r.schedule.options.restart) && r.schedule.options.restart.length === 0, 'a schedule never restarts containers');
  const p = await api('POST', `/servers/${srv.id}/cleanup/preview`, {});
  check(p.plan.schedule?.cron === '0 4 * * 0', 'preview shows the saved schedule');
  // Every minute, to see the scheduler start it by itself.
  on('head -c 26214400 /dev/urandom > /var/log/clean-big.log');
  r = await api('PUT', `/servers/${srv.id}/cleanup/schedule`, { cron: '* * * * *', options: { logs: true } });
  let job = null;
  for (let i = 0; i < 80 && !job; i++) {
    await sleep(1000);
    job = (await api('GET', `/jobs?server=${srv.id}&limit=5`)).find((j) => j.user === 'scheduler' && j.type === 'server-cleanup');
  }
  check(!!job, 'the scheduler started "Weekly cleanup" by itself');
  if (job) await waitJob(job);
  check(on('stat -c %s /var/log/clean-big.log') === '0', 'scheduled run emptied the big log');
  r = await api('PUT', `/servers/${srv.id}/cleanup/schedule`, { cron: '' });
  check(!r.schedule && !r.next_run, 'schedule turned off');
});

await step('Clean up the test', async () => {
  await api('DELETE', `/projects/${proj.id}`, { confirm: 'clean-shop' });
  await api('DELETE', `/servers/${srv.id}`);
  onIn(`cd /srv/clean && docker compose down -v >/dev/null 2>&1; docker rmi -f clean-app:latest >/dev/null 2>&1; rm -rf /srv/clean /var/log/clean-*.log; docker builder prune -af >/dev/null 2>&1; true`);
  for (const img of imagesBefore) loadImage(img);
  const now = on("docker images --format '{{.Repository}}:{{.Tag}}'");
  check(imagesBefore.every((i) => now.includes(i)), `test server, project and junk removed from ${VPS}; its images are back (${imagesBefore.join(', ')})`);
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ All cleanup checks passed');
process.exit(failures ? 1 : 0);

#!/usr/bin/env node
// End-to-end test: deploy an existing GitHub repo that has its own docker-compose.yml, with
// "Switchboard deploys" CI (no runner). Needs the lab (./dev/setup.sh) and ./dev/ci-setup.sh.
//   node dev/e2e-github.mjs
// Only touches vps-ci, the fake GitHub, the "Compose App" project and the vps-ci server entry.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SB_URL || 'http://localhost:8090';
const GH = 'http://localhost:8788';
const KEY = fs.readFileSync(path.join(DIR, '.keys/id_ed25519'), 'utf8');
const REPO = 'lab-user/compose-app';
let failures = 0;
let cookie = '';

async function api(method, url, body, { raw = false } = {}) {
  const go = () => fetch(`${BASE}/api${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await go().catch((e) => (e.message === 'fetch failed' ? go() : Promise.reject(e)));
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) cookie = c.split(';')[0];
  const data = await res.json().catch(() => null);
  if (raw) return { status: res.status, data };
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
  return data;
}
const fetch2 = (u, o) => fetch(u, o).catch((e) => (e.message === 'fetch failed' ? fetch(u, o) : Promise.reject(e)));
const ghPost = async (p, b) => (await fetch2(GH + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const on = (cmd) => sh(`docker exec vps-ci sh -c ${JSON.stringify(cmd)}`);
const onTry = (cmd) => {
  try {
    return { ok: true, out: on(cmd) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
};
const page = () => on('curl -s -m 5 http://127.0.0.1:18800/ || true');
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
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-30).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error})` : ''}`);
      return j;
    }
    await sleep(1000);
  }
  throw new Error('job did not finish in time');
}
const jobsOf = async (id) => api('GET', `/jobs?project=${id}&limit=20`);
async function waitNewJob(id, type, after) {
  for (let i = 0; i < 30; i++) {
    const j = (await jobsOf(id)).find((x) => x.type === type && x.id > after);
    if (j) return j;
    await sleep(1000);
  }
  return null;
}
const commitPage = (text, message) => ghPost('/__commit', { repo: REPO, branch: 'main', file: 'site/index.html', content: `<h1>${text}</h1>\n`, message }).then((r) => r.sha);

let server;
let project;
let lastJob = 0;

await step('A repo with its own docker-compose.yml', async () => {
  await fetch2(`${GH}/__reset`);
  await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
  for (const p of await api('GET', '/projects')) if (p.slug.startsWith('compose-app') && !p.parent_id) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  // Projects that use vps-ci (left by other tests) go first, then the server itself.
  for (const p of await api('GET', '/projects')) if (!p.parent_id && p.deployments?.some((d) => d.server_name === 'vps-ci')) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  for (const s of await api('GET', '/servers')) if (s.name === 'vps-ci') await api('DELETE', `/servers/${s.id}`);
  on('cd /srv/compose-app 2>/dev/null && docker compose down -v >/dev/null 2>&1; rm -rf /srv/compose-app /etc/switchboard/projects/compose-app.* /etc/switchboard/ports/compose-app; true');
  await api('PUT', '/settings', { github_token: 'gh-test-token' });
  server = await api('POST', '/servers', { name: 'vps-ci', ip: '172.30.0.25', ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY });
  // the "existing" repo in the user's GitHub account
  const gh = (method, p, body) => fetch2(`${GH}${p}`, { method, headers: { Authorization: 'Bearer gh-test-token', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  await gh('POST', '/user/repos', { name: 'compose-app', private: true });
  await ghPost('/__commit', { repo: REPO, branch: 'main', file: 'docker-compose.yml', content: 'services:\n  web:\n    image: nginx:1.27-alpine\n    ports: ["18800:80"]\n    volumes: ["./site:/usr/share/nginx/html:ro"]\n    restart: unless-stopped\n', message: 'compose' });
  await ghPost('/__commit', { repo: REPO, branch: 'main', file: '.env.example', content: 'GREETING=hello\n', message: 'env example' });
  await commitPage('Version 1', 'v1');
  const repos = await api('GET', '/github/repos');
  check(repos.some((r) => r.full_name === REPO), 'the repo shows up in "my GitHub repositories"');
  const info = await api('GET', `/github/repo-info?repo=${encodeURIComponent(REPO)}`);
  check(info.suggest === 'compose' && info.compose === 'docker-compose.yml' && info.ports[0] === 18800, `detected: ${info.suggest}, ${info.compose}, ports ${info.ports}`);
  check(info.branches.includes('main'), 'branches listed');
});

await step('Deploy it to a server with "Switchboard deploys" CI', async () => {
  const r = await api('POST', '/projects/from-template', { template: 'compose', code: 'repo', repo: REPO, branch: 'main', name: 'Compose App', servers: [server.id], app_port: 18800, health_path: '/', ci: 'pull' });
  project = r.project;
  await waitJob(r.job);
  const ciJob = await waitNewJob(project.id, 'ci-setup', 0);
  check(!!ciJob, 'CI/CD setup started right after the first deploy');
  if (ciJob) await waitJob(ciJob);
  check(/Version 1/.test(page()), 'the app runs on the server (port 18800)');
  check(on('cat /srv/compose-app/.env') === 'GREETING=hello', '.env created from .env.example');
  const p = await api('GET', `/projects/${project.id}`);
  check(p.deployments[0]?.app_container === 'compose-app-web-1' && p.ci_mode === 'pull' && p.ci_enabled, `container ${p.deployments[0]?.app_container}, CI mode ${p.ci_mode}`);
  await api('POST', `/projects/${project.id}/check`);
  check((await api('GET', `/projects/${project.id}`)).deployments[0].health === 'up', 'health check on the app port is up');
  check(!(await fetch2(`${GH}/__state`).then((x) => x.json())).runners[REPO]?.length, 'no runner was installed');
  lastJob = Math.max(0, ...(await jobsOf(project.id)).map((j) => j.id));
});

await step('A new commit is deployed by itself', async () => {
  const sha = await commitPage('Version 2', 'v2');
  await api('POST', `/projects/${project.id}/ci/refresh`);
  const j = await waitNewJob(project.id, 'deploy', lastJob);
  check(!!j && j.user === 'github', 'deploy started for the new commit');
  if (j) await waitJob(j);
  lastJob = j?.id || lastJob;
  check(/Version 2/.test(page()), 'the new version is live');
  check(on('git -C /srv/compose-app rev-parse HEAD') === sha, 'server is at exactly that commit');
  await api('POST', `/projects/${project.id}/ci/refresh`);
  await sleep(1500);
  check(!(await jobsOf(project.id)).some((x) => x.type === 'deploy' && x.id > lastJob), 'the same commit is not deployed twice');
});

await step('With tests: a failing commit is not deployed', async () => {
  await api('PUT', `/projects/${project.id}/ci`, { ci_test_on: 'github', ci_test_cmd: 'echo test' });
  const { job } = await api('POST', `/projects/${project.id}/ci/setup`, {});
  await waitJob(job);
  const yml = sh(`docker exec gh-mock git -C /repos/${REPO}.git show main:.github/workflows/switchboard.yml`);
  check(/test:/.test(yml) && !/self-hosted/.test(yml), 'workflow has only the test job (no runner)');
  const bad = await commitPage('Version 3 (broken)', 'v3');
  await ghPost('/__runs', { repo: REPO, run: { head_sha: bad, display_title: 'v3', conclusion: 'failure' } });
  await api('POST', `/projects/${project.id}/ci/refresh`);
  await sleep(1500);
  check(!(await jobsOf(project.id)).some((x) => x.type === 'deploy' && x.id > lastJob), 'failing commit NOT deployed');
  check(/Version 2/.test(page()), 'site still on Version 2');
  const ev = await api('GET', `/events?project=${project.id}&limit=10`);
  check(ev.some((e) => /NOT deployed/.test(e.message)), 'alert: not deployed because tests failed');
  const good = await commitPage('Version 4', 'v4');
  await api('POST', `/projects/${project.id}/ci/refresh`);
  await sleep(1500);
  check(!(await jobsOf(project.id)).some((x) => x.type === 'deploy' && x.id > lastJob), 'waits while the tests are still running');
  await ghPost('/__runs', { repo: REPO, run: { head_sha: good, display_title: 'v4', conclusion: 'success' } });
  await api('POST', `/projects/${project.id}/ci/refresh`);
  const j = await waitNewJob(project.id, 'deploy', lastJob);
  if (j) await waitJob(j);
  check(/Version 4/.test(page()), 'passing commit deployed');
});

await step('Code from a pull request can never be deployed', async () => {
  const evil = (await ghPost('/__commit', { repo: REPO, branch: 'evil', file: 'site/index.html', content: '<h1>HACKED</h1>\n', message: 'evil' })).sha;
  await ghPost('/__pulls', { repo: REPO, number: 9, title: 'evil', head_ref: 'evil' });
  const r = onTry(`/usr/local/bin/switchboard-helper deploy compose-app ${evil} 2>&1`);
  check(!r.ok && /not on branch main/.test(r.out), 'helper refuses a commit that is not on the branch');
  check(/Version 4/.test(page()), 'site unchanged');
});

// Leave vps-ci clean for the other tests.
await api('DELETE', `/projects/${project.id}`, { confirm: project.slug }).catch(() => {});
on('cd /srv/compose-app 2>/dev/null && docker compose down -v >/dev/null 2>&1; rm -rf /srv/compose-app; true');
console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);

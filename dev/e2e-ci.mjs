#!/usr/bin/env node
// End-to-end test for roles, templates, GitHub CI/CD (self-hosted runner), staging and PR previews.
// Needs the lab (./dev/setup.sh) and the CI pair (./dev/ci-setup.sh: vps-ci + fake GitHub).
//   node dev/e2e-ci.mjs
// Only touches vps-ci, the fake GitHub, its own "CI Lab" projects, the vps-ci server entry and the lab
// users "dev-lab" / "view-lab". The runner is a stand-in: the test runs the commands the GitHub
// workflow would run (sudo switchboard-helper …) as the runner user on vps-ci.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SB_URL || 'http://localhost:8090';
const GH = 'http://localhost:8788';
const CF = 'http://localhost:8787';
const KEY = fs.readFileSync(path.join(DIR, '.keys/id_ed25519'), 'utf8');
const REPO = 'lab-user/ci-lab';
let failures = 0;

function client() {
  let cookie = '';
  return async function api(method, url, body, { raw = false } = {}) {
    const go = () =>
      fetch(`${BASE}/api${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard', Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const res = await go().catch((e) => (e.message === 'fetch failed' ? go() : Promise.reject(e)));
    for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) cookie = c.split(';')[0];
    const data = await res.json().catch(() => null);
    if (raw) return { status: res.status, data };
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
    return data;
  };
}
const api = client();
// Node reuses idle connections; one the server just closed fails with "fetch failed" — retry once.
const fetch2 = (url, opt) => fetch(url, opt).catch((e) => (e.message === 'fetch failed' ? fetch(url, opt) : Promise.reject(e)));
const ghPost = async (p, b) => (await fetch2(GH + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const ghState = async () => (await fetch2(`${GH}/__state`)).json();
const cfRecords = async () => (await (await fetch2(`${CF}/__state`)).json()).records;
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const on = (cmd) => sh(`docker exec vps-ci sh -c ${JSON.stringify(cmd)}`);
const onOk = (cmd) => {
  try {
    on(cmd);
    return true;
  } catch {
    return false;
  }
};
/** Run what the GitHub workflow runs, as the runner user. */
const asRunner = (args) => sh(`docker exec vps-ci runuser -u sb-runner -- sudo -n /usr/local/bin/switchboard-helper ${args} 2>&1`);
const asRunnerOk = (args) => {
  try {
    return { ok: true, out: asRunner(args) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
};
const gitInMock = (cmd) => sh(`docker exec gh-mock sh -c ${JSON.stringify(cmd)}`);
const web = (host, p = '/') => on(`curl -s -m 10 -H 'Host: ${host}' http://127.0.0.1${p}`);
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
async function waitJob(job, expect = 'success', minutes = 20) {
  for (let i = 0; i < minutes * 60; i++) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-50).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error})` : ''}`);
      return j;
    }
    await sleep(1000);
  }
  throw new Error('job did not finish in time');
}
const lastJob = async (projectId, type) => (await api('GET', `/jobs?project=${projectId}&limit=20`)).find((j) => j.type === type);

let server;
let project;
let zone;
let staging;

await step('Clean up, log in, settings, add vps-ci', async () => {
  await fetch2(`${GH}/__reset`);
  await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
  for (const p of await api('GET', '/projects')) if (p.slug.startsWith('ci-lab') && !p.parent_id) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  for (const p of await api('GET', '/projects')) if (p.slug.startsWith('ci-lab')) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  for (const s of await api('GET', '/servers')) if (s.name === 'vps-ci') await api('DELETE', `/servers/${s.id}`);
  const { users } = await api('GET', '/users');
  for (const u of users) if (['dev-lab', 'view-lab'].includes(u.username)) await api('DELETE', `/users/${u.id}`);
  await api('PUT', '/settings', { cf_token: 'test-token', github_token: 'gh-test-token' });
  const t = await api('POST', '/settings/github/test', {});
  check(t.ok && t.login === 'lab-user', `GitHub token works (${t.login || t.error})`);
  server = await api('POST', '/servers', { name: 'vps-ci', ip: '172.30.0.25', ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY });
  zone = (await api('GET', '/cloudflare/zones')).find((z) => z.name === 'shop.test');
  check(!!zone, 'Cloudflare zone shop.test found');
});

await step('Roles: developer and viewer', async () => {
  await api('POST', '/users', { username: 'dev-lab', password: 'dev-password-123', role: 'developer' });
  await api('POST', '/users', { username: 'view-lab', password: 'view-password-123', role: 'viewer' });
  const dev = client();
  const view = client();
  await dev('POST', '/auth/login', { username: 'dev-lab', password: 'dev-password-123' });
  await view('POST', '/auth/login', { username: 'view-lab', password: 'view-password-123' });
  const st = await dev('GET', '/auth/state');
  check(st.user.role === 'developer', 'developer sees its role');
  check((await dev('GET', '/projects', undefined, { raw: true })).status === 200, 'developer can list projects');
  check((await dev('POST', '/servers', { name: 'x', ip: '1.2.3.4' }, { raw: true })).status === 403, 'developer cannot add a server');
  check((await dev('PUT', '/settings', {}, { raw: true })).status === 403, 'developer cannot change settings');
  check((await dev('GET', '/users', undefined, { raw: true })).status === 403, 'developer cannot list users');
  check((await view('POST', `/servers/${server.id}/refresh`, {}, { raw: true })).status === 403, 'viewer cannot refresh a server');
  check((await view('POST', '/deployments/999999/deploy', {}, { raw: true })).status === 403, 'viewer cannot deploy');
  check((await dev('POST', '/deployments/999999/deploy', {}, { raw: true })).status === 404, 'developer may deploy (gets past the role check)');
  check((await dev('POST', '/deployments/999999/command', { where: 'host', command: 'id' }, { raw: true })).status === 403, 'developer cannot run server shell commands');
  check((await dev('POST', '/deployments/999999/command', { where: 'app', command: 'id' }, { raw: true })).status === 404, 'developer may run app-container commands');
  const admins = (await api('GET', '/users')).users.filter((u) => u.role === 'admin');
  if (admins.length === 1) check((await api('PUT', `/users/${admins[0].id}`, { role: 'viewer' }, { raw: true })).status === 400, 'the last admin cannot be demoted');
});

await step('New project from the Node.js + MySQL template, new GitHub repo', async () => {
  const r = await api('POST', '/projects/from-template', {
    template: 'node',
    db: 'mysql',
    name: 'CI Lab',
    domain: 'cilab.shop.test',
    www: false,
    zone: { zone_id: zone.id, zone_name: zone.name },
    servers: [server.id],
    code: 'new',
    repo: REPO,
    branch: 'main',
  });
  project = r.project;
  await waitJob(r.job, 'success', 25);
  const s = await ghState();
  check(!!s.repos[REPO], 'repository created in GitHub');
  check(on("grep ^SB_REPO_URL= /etc/switchboard/projects/ci-lab.conf") === "SB_REPO_URL='git://172.30.0.6/lab-user/ci-lab.git'", 'server clones from the repo (lab: git://, so no deploy key needed)');
  const files = gitInMock(`git -C /repos/${REPO}.git ls-tree -r --name-only main`);
  check(/package\.json/.test(files) && /compose\.switchboard\.yml/.test(files) && /\.switchboard\/Dockerfile/.test(files), 'first commit has the app and the Docker files');
  check(onOk('docker ps --format {{.Names}} | grep -qx ci-lab-app-1') && onOk('docker ps --format {{.Names}} | grep -qx ci-lab-db-1'), 'app + database containers run on vps-ci');
  check(onOk('docker ps --format {{.Names}} | grep -qx switchboard-edge'), 'web proxy container runs');
  check(/Hello from CI Lab/.test(web('cilab.shop.test')), 'site answers through the web proxy');
  check(!files.split('\n').includes('.env'), '.env is not in the repo');
  const rec = (await cfRecords()).find((x) => x.name === 'cilab.shop.test');
  check(rec?.content === '172.30.0.25', `DNS record created → ${rec?.content}`);
  await api('POST', `/projects/${project.id}/check`);
  project = await api('GET', `/projects/${project.id}`);
  const d = project.deployments[0];
  check(d?.health === 'up', `health check: ${d?.health} ${JSON.stringify(d?.health_detail)}`);
  check(project.active_deployment_id === d?.id && project.dns_records.length === 1, 'live server and DNS record linked');
});

await step('Run the template setup again (nothing breaks, nothing is redone)', async () => {
  const before = on('grep ^DB_PASSWORD= /srv/ci-lab/.env');
  const { job } = await api('POST', `/projects/${project.id}/provision`, {});
  await waitJob(job);
  check(on('grep ^DB_PASSWORD= /srv/ci-lab/.env') === before, '.env kept (same database password)');
});

await step('Set up CI/CD (runner + workflow)', async () => {
  await api('PUT', `/projects/${project.id}/ci`, { ci_test_on: 'github', ci_test_cmd: 'npm ci\nnpm test --if-present' });
  const { job } = await api('POST', `/projects/${project.id}/ci/setup`, {});
  await waitJob(job);
  const s = await ghState();
  const runner = s.runners[REPO]?.[0];
  check(runner && /switchboard,sb-vps-ci-\d+/.test(runner.labels) && runner.user === 'sb-runner', `runner registered (${runner?.name}, ${runner?.labels}, as ${runner?.user})`);
  check(onOk('pgrep -u sb-runner -f run.sh'), 'runner process is running (as sb-runner)');
  check(onOk('visudo -cqf /etc/sudoers.d/switchboard-runner'), 'sudoers rule is valid');
  const yml = gitInMock(`git -C /repos/${REPO}.git show main:.github/workflows/switchboard.yml`);
  check(/switchboard-helper deploy ci-lab "\$GITHUB_SHA"/.test(yml) && /runs-on: \[self-hosted, switchboard/.test(yml) && /needs: test/.test(yml), 'workflow committed with test + deploy jobs');
  fs.writeFileSync('/tmp/sb-workflow.yml', yml);
  check(sh(`ruby -ryaml -e 'y = YAML.load_file("/tmp/sb-workflow.yml"); puts y["jobs"].keys.join(",")'`) === 'test,deploy-ci-lab', 'workflow is valid YAML with jobs test, deploy-ci-lab');
  const ci = await api('GET', `/projects/${project.id}/ci?live=1`);
  check(ci.enabled && ci.up_to_date, 'CI/CD on, workflow up to date');
  check(ci.runners[0]?.live?.status === 'online', `runner status from GitHub: ${ci.runners[0]?.live?.status}`);
});

let v2;
await step('Deploy a new commit the way the runner does', async () => {
  v2 = (await ghPost('/__commit', { repo: REPO, branch: 'main', file: 'server.js', content: on('cat /srv/ci-lab/server.js').replace('Hello from CI Lab', 'Hello v2 from CI Lab'), message: 'v2' })).sha;
  const r = asRunnerOk(`deploy ci-lab ${v2}`);
  if (!r.ok) console.log(r.out.split('\n').slice(-25).map((l) => `      ${l}`).join('\n'));
  check(r.ok && /Healthy: HTTP 200/.test(r.out), 'deploy + health check passed');
  check(on('git -C /srv/ci-lab rev-parse HEAD') === v2, 'server is at the exact commit');
  check(/Hello v2/.test(web('cilab.shop.test')), 'new version is live');
  check(!asRunnerOk('setup ci-lab').ok, 'runner may NOT run other helper commands');
  check(!onOk('runuser -u sb-runner -- sudo -n id'), 'runner has no other sudo rights');
  check(!asRunnerOk("deploy ci-lab 'abc;id'").ok, 'bad commit values are refused');
});

await step('CI results are read back from GitHub', async () => {
  await ghPost('/__runs', { repo: REPO, run: { head_sha: v2, display_title: 'v2', conclusion: 'success' } });
  await ghPost('/__runs', { repo: REPO, run: { head_sha: v2, display_title: 'broken change', conclusion: 'failure' } });
  await api('POST', `/projects/${project.id}/ci/refresh`);
  const ci = await api('GET', `/projects/${project.id}/ci`);
  check(ci.runs.length === 2 && ci.runs.some((r) => r.conclusion === 'failure'), 'runs listed');
  const ev = await api('GET', `/events?project=${project.id}&limit=20`);
  check(ev.some((e) => /CI run #\d+ .*FAILED/.test(e.message)), 'failed run raised an alert');
  const dev = client();
  await dev('POST', '/auth/login', { username: 'dev-lab', password: 'dev-password-123' });
  await dev('POST', `/projects/${project.id}/ci/run`, { branch: 'main' });
  check((await ghState()).dispatches.some((d) => d.ref === 'main'), 'developer started a run by hand');
});

await step('Staging copy + copy live data (no backup on staging)', async () => {
  const r = await api('POST', `/projects/${project.id}/staging`, { server_id: server.id, domain: 'staging-cilab.shop.test', branch: 'staging', zone: { zone_id: zone.id, zone_name: zone.name } });
  staging = r.project;
  await waitJob(r.job, 'success', 15);
  check(!!gitInMock(`git -C /repos/${REPO}.git rev-parse --verify refs/heads/staging`), 'branch staging created');
  check(/Hello v2/.test(web('staging-cilab.shop.test')), 'staging site answers on its own address');
  const sp = await api('GET', `/projects/${staging.id}`);
  check(sp.deployments[0]?.skip_backup === 1 && sp.parent_id === project.id && sp.env === 'staging', 'staging server is "no backup needed", linked to the main project');
  const pw = (dir) => on(`grep ^DB_ROOT_PASSWORD= ${dir}/.env | cut -d= -f2`);
  on(`docker exec ci-lab-db-1 mysql -uroot -p${pw('/srv/ci-lab')} app -e "CREATE TABLE orders (id INT PRIMARY KEY); INSERT INTO orders VALUES (1),(2),(3);" 2>/dev/null`);
  const before = (await api('GET', `/projects/${staging.id}/backups`)).length;
  const { job } = await api('POST', `/projects/${project.id}/staging/${staging.id}/data`);
  await waitJob(job);
  const n = on(`docker exec ci-lab-staging-db-1 mysql -uroot -p${pw('/srv/ci-lab-staging')} app -N -e "SELECT COUNT(*) FROM orders" 2>/dev/null`);
  check(n === '3', `staging has the live data (${n} orders)`);
  const kinds = (await api('GET', `/projects/${staging.id}/backups`)).slice(0, (await api('GET', `/projects/${staging.id}/backups`)).length - before).map((b) => b.kind);
  check(!kinds.includes('pre-sync'), `no safety backup of staging was made (${kinds.join(', ')})`);
  await api('POST', `/projects/${project.id}/ci/commit`);
  const yml = gitInMock(`git -C /repos/${REPO}.git show staging:.github/workflows/switchboard.yml`);
  check(/deploy-ci-lab-staging/.test(yml) && /refs\/heads\/staging/.test(yml), 'workflow on the staging branch deploys staging');
  check(asRunnerOk(`deploy ci-lab-staging ${gitInMock(`git -C /repos/${REPO}.git rev-parse staging`)}`).ok, 'runner deploys staging');
});

let prSha;
await step('Pull request preview', async () => {
  await api('PUT', `/projects/${project.id}/ci`, { preview_server_id: server.id, preview_zone: { zone_id: zone.id, zone_name: zone.name } });
  const { job } = await api('POST', `/projects/${project.id}/ci/setup`, {});
  await waitJob(job);
  const yml = gitInMock(`git -C /repos/${REPO}.git show main:.github/workflows/switchboard.yml`);
  check(/preview-up ci-lab/.test(yml) && /preview-down ci-lab/.test(yml), 'workflow has preview jobs');
  prSha = (await ghPost('/__commit', { repo: REPO, branch: 'feature-x', file: 'server.js', content: on('cat /srv/ci-lab/server.js').replace('Hello v2', 'Hello feature-x'), message: 'feature x' })).sha;
  await ghPost('/__pulls', { repo: REPO, number: 7, title: 'Feature X', head_ref: 'feature-x' });
  await api('POST', `/projects/${project.id}/previews/sync`);
  const rec = (await cfRecords()).find((x) => x.name === 'pr-7-ci-lab.shop.test');
  check(rec?.content === '172.30.0.25', 'DNS record for the preview created');
  const r = asRunnerOk(`preview-up ci-lab 7 ${prSha}`);
  if (!r.ok) console.log(r.out.split('\n').slice(-25).map((l) => `      ${l}`).join('\n'));
  check(r.ok, 'runner built and started the preview');
  check(/Hello feature-x/.test(web('pr-7-ci-lab.shop.test')), 'preview shows the pull request code');
  check(/Hello v2/.test(web('cilab.shop.test')), 'live site unchanged');
  await ghPost('/__runs', { repo: REPO, run: { event: 'pull_request', head_branch: 'feature-x', head_sha: prSha, display_title: 'Feature X', conclusion: 'success' } });
  await api('POST', `/projects/${project.id}/previews/sync`);
  const ci = await api('GET', `/projects/${project.id}/ci`);
  check(ci.previews[0]?.pr === 7 && ci.previews[0]?.status === 'ready', `preview listed as ${ci.previews[0]?.status}`);
});

await step('Closing the pull request removes the preview', async () => {
  await ghPost('/__pulls/close', { repo: REPO, number: 7 });
  await api('POST', `/projects/${project.id}/previews/sync`);
  check(!(await cfRecords()).some((x) => x.name === 'pr-7-ci-lab.shop.test'), 'preview DNS record removed');
  await sleep(1500);
  const j = await lastJob(project.id, 'preview-down');
  if (j) await waitJob(j);
  check(!onOk('docker ps -a --format {{.Names}} | grep -q ci-lab-pr-7'), 'preview containers removed');
  check(!onOk('test -d /srv/previews/ci-lab/pr-7'), 'preview folder removed');
  check(/Hello v2/.test(web('cilab.shop.test')), 'live site still fine');
});

await step('Remove the runner', async () => {
  const ci = await api('GET', `/projects/${project.id}/ci`);
  const { job } = await api('DELETE', `/projects/${project.id}/ci/runners/${ci.runners[0].id}`);
  await waitJob(job);
  check(!(await ghState()).runners[REPO]?.length, 'runner unregistered from GitHub');
  check(!onOk('test -d /opt/switchboard-runner/lab-user_ci-lab'), 'runner folder removed');
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);

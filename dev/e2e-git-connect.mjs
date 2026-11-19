#!/usr/bin/env node
// End-to-end test for "Connect a server to Git" (CI/CD tab): a backup server that can't pull from GitHub.
// Needs the lab (./dev/setup.sh) and the CI pair (./dev/ci-setup.sh: vps-ci + fake GitHub).
//   node dev/e2e-git-connect.mjs
// Only touches vps-ci (folders /srv/gc-*), the fake GitHub repo lab-user/gc-app, its own "Git Connect Lab"
// project and the server entries gc-live / gc-backup / gc-empty (all three point at vps-ci).
//   SB_URL=http://localhost:8091   test another Switchboard instance (default: the lab on 8090)
//   SB_LAB_DIR=/path/to/dev        where .keys are (default: this folder)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LAB = process.env.SB_LAB_DIR || DIR;
const BASE = process.env.SB_URL || 'http://localhost:8090';
const GH = 'http://localhost:8788';
const KEY = fs.readFileSync(path.join(LAB, '.keys/id_ed25519'), 'utf8');
const REPO = 'lab-user/gc-app';
const URL_GIT = `git://172.30.0.6/${REPO}.git`;
let failures = 0;

let cookie = '';
async function api(method, url, body, { raw = false } = {}) {
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
}
const gh = async (method, p, b) =>
  (await fetch(GH + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer gh-test-token' }, body: b ? JSON.stringify(b) : undefined })).json();
/** An empty repo in the fake GitHub (it keeps known repos in memory, so the folder is emptied by hand). */
async function freshRepo(full) {
  await gh('POST', '/user/repos', { name: full.split('/')[1], private: true });
  sh(`docker exec gh-mock sh -c 'rm -rf /repos/${full}.git && git init -q --bare -b main /repos/${full}.git'`);
}
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
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-40).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error})` : ''}`);
      return j;
    }
    await sleep(1000);
  }
  throw new Error('job did not finish in time');
}
const jobsOf = async (projectId) => api('GET', `/jobs?project=${projectId}&limit=30`);
const ci = () => api('GET', `/projects/${project.id}/ci`);
const gitOf = (c, serverName) => {
  const s = c.servers.find((x) => x.name === serverName);
  return s && c.git[s.deps[0]?.id];
};

let project;
const srv = {};

await step('Clean up, log in, repo with two commits, three server entries for vps-ci', async () => {
  await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
  for (const p of await api('GET', '/projects')) if (p.slug.startsWith('git-connect-lab')) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  for (const s of await api('GET', '/servers')) if (s.name.startsWith('gc-')) await api('DELETE', `/servers/${s.id}`);
  on('rm -rf /srv/gc-live /srv/gc-backup /srv/gc-empty /srv/gc-owned /srv/gc-owned2');
  await api('PUT', '/settings', { github_token: 'gh-test-token' });
  await freshRepo(REPO);
  await gh('POST', '/__commit', { repo: REPO, branch: 'main', file: 'index.html', content: 'v1\n' });
  await gh('POST', '/__commit', { repo: REPO, branch: 'main', file: 'README.md', content: '# gc-app\n' });
  for (const name of ['gc-live', 'gc-backup', 'gc-empty']) srv[name] = await api('POST', '/servers', { name, ip: '172.30.0.25', ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY });
  // Live server: a working checkout. Backup server: the same files copied over WITHOUT .git, one file edited, plus .env.
  on(`git clone -q ${URL_GIT} /srv/gc-live`);
  on('mkdir -p /srv/gc-backup && cp -a /srv/gc-live/. /srv/gc-backup/ && rm -rf /srv/gc-backup/.git && echo "v1 edited on backup" > /srv/gc-backup/index.html && echo SECRET=1 > /srv/gc-backup/.env');
  check(onOk('test -d /srv/gc-live/.git') && !onOk('test -d /srv/gc-backup/.git'), 'live is a Git checkout, backup is not');
});

await step('Project from an existing app (no template), live server only', async () => {
  project = await api('POST', '/projects', {
    name: 'Git Connect Lab',
    domain: '',
    health_scheme: 'http',
    health_path: '/',
    git_repo: REPO,
    git_branch: 'main',
    deploy_script: 'git pull -q --ff-only\ngit log -1 --format=%h',
  });
  await api('POST', `/projects/${project.id}/deployments`, { server_id: srv['gc-live'].id, app_dir: '/srv/gc-live', db_type: 'none' });
  await api('PUT', `/projects/${project.id}/ci`, { git_repo: REPO, git_branch: 'main', ci_mode: 'pull', ci_test_on: 'none' });
  const r = await api('POST', `/projects/${project.id}/ci/git-check`);
  const c = await ci();
  check(Object.keys(r.git).length === 1, 'check looked at one server');
  check(gitOf(c, 'gc-live')?.state === 'ok' && /^[0-9a-f]{40}$/.test(gitOf(c, 'gc-live')?.commit || ''), `live: connected (${JSON.stringify(gitOf(c, 'gc-live'))})`);
});

await step('Connect the backup server (not in the project yet; folder has files but no Git)', async () => {
  const bad = await api('POST', `/projects/${project.id}/ci/connect`, { server_id: srv['gc-backup'].id, app_dir: 'relative/path' }, { raw: true });
  check(bad.status === 400, 'a relative folder is refused');
  const { job } = await api('POST', `/projects/${project.id}/ci/connect`, { server_id: srv['gc-backup'].id, app_dir: '/srv/gc-backup', deploy: false });
  const j = await waitJob(job);
  check(/without changing any file/.test(j.log), 'log says the files are kept');
  const p = await api('GET', `/projects/${project.id}`);
  const dep = p.deployments.find((d) => d.server_id === srv['gc-backup'].id);
  check(dep && dep.app_dir === '/srv/gc-backup' && p.active_deployment_id !== dep.id, 'backup added to the project as a standby with its folder');
  check(onOk('test -d /srv/gc-backup/.git'), 'backup folder is now a Git checkout');
  check(on('cat /srv/gc-backup/index.html') === 'v1 edited on backup' && on('cat /srv/gc-backup/.env') === 'SECRET=1', 'files untouched (edited index.html and .env kept)');
  check(on('git -C /srv/gc-backup remote get-url origin') === URL_GIT && on('git -C /srv/gc-backup rev-parse --abbrev-ref HEAD') === 'main', 'origin = the repo, branch main');
  check(on('git -C /srv/gc-backup status --porcelain --untracked-files=no') === 'M index.html', 'git status shows the edited file as changed');
  const st = gitOf(await ci(), 'gc-backup');
  check(st?.state === 'ok' && st.changed === 1 && st.done === 'attached', `state saved: ${JSON.stringify(st)}`);
  check(/1 file\(s\) in \/srv\/gc-backup differ/.test(j.log), 'warns about the local change');
});

await step('New commit → the backup server can pull it now (deploy)', async () => {
  const sha = (await gh('POST', '/__commit', { repo: REPO, branch: 'main', file: 'v2.txt', content: 'v2\n' })).sha;
  const p = await api('GET', `/projects/${project.id}`);
  const dep = p.deployments.find((d) => d.server_id === srv['gc-backup'].id);
  const { job } = await api('POST', `/deployments/${dep.id}/deploy`, {});
  await waitJob(job);
  check(on('cat /srv/gc-backup/v2.txt') === 'v2' && on('git -C /srv/gc-backup rev-parse HEAD') === sha, `backup pulled the new commit ${sha.slice(0, 7)}`);
  check(on('cat /srv/gc-backup/index.html') === 'v1 edited on backup', 'local edit still there');
});

await step('Empty folder on a new server: cloned, then deployed', async () => {
  const { job } = await api('POST', `/projects/${project.id}/ci/connect`, { server_id: srv['gc-empty'].id, app_dir: '/srv/gc-empty', deploy: true });
  const j = await waitJob(job);
  check(/clone/.test(j.log) && /Deploy of Git Connect Lab on gc-empty queued/.test(j.log), 'cloned and a deploy was queued');
  check(on('cat /srv/gc-empty/v2.txt') === 'v2' && on('git -C /srv/gc-empty remote get-url origin') === URL_GIT, 'files of the newest commit are there');
  const dj = (await jobsOf(project.id)).find((x) => x.type === 'deploy' && /gc-empty/.test(x.title));
  check(!!dj, 'deploy job exists');
  if (dj) await waitJob(dj);
});

await step('Broken checkout (wrong origin) → check shows it, Connect fixes it', async () => {
  on('git -C /srv/gc-live remote set-url origin git://172.30.0.6/lab-user/does-not-exist.git');
  await api('POST', `/projects/${project.id}/ci/git-check`);
  const st = gitOf(await ci(), 'gc-live');
  check(st?.state === 'no_access' && !!st.error, `check: ${st?.state} (${st?.error})`);
  const { job } = await api('POST', `/projects/${project.id}/ci/connect`, { server_id: srv['gc-live'].id });
  await waitJob(job);
  check(on('git -C /srv/gc-live remote get-url origin') === URL_GIT, 'origin fixed');
  check(gitOf(await ci(), 'gc-live')?.state === 'ok', 'live: connected again');
});

await step('A working checkout of ANOTHER repo is left alone', async () => {
  await freshRepo('lab-user/gc-other');
  await gh('POST', '/__commit', { repo: 'lab-user/gc-other', branch: 'main', file: 'x.txt', content: 'x\n' });
  on('git -C /srv/gc-live remote set-url origin git://172.30.0.6/lab-user/gc-other.git');
  const { job } = await api('POST', `/projects/${project.id}/ci/connect`, { server_id: srv['gc-live'].id });
  const j = await waitJob(job);
  check(/not lab-user\/gc-app — left as it is/.test(j.log), 'warns that it pulls from another repo');
  check(on('git -C /srv/gc-live remote get-url origin') === 'git://172.30.0.6/lab-user/gc-other.git', 'origin not changed');
  check(gitOf(await ci(), 'gc-live')?.state === 'other_repo', 'state: other repository');
  on(`git -C /srv/gc-live remote set-url origin ${URL_GIT}`);
});

await step('Set up CI/CD (Switchboard deploys) checks every server and changes nothing that works', async () => {
  const before = on('cat /srv/gc-backup/index.html');
  const { job } = await api('POST', `/projects/${project.id}/ci/setup`, {});
  const j = await waitJob(job);
  check((j.log.match(/already a Git checkout of lab-user\/gc-app and can pull/g) || []).length === 3, 'all three servers: already connected');
  check(on('cat /srv/gc-backup/index.html') === before, 'backup files untouched');
  const c = await ci();
  check(c.enabled && c.servers.length === 3 && c.servers.every((s) => c.git[s.deps[0].id]?.state === 'ok'), 'CI/CD on, all three servers connected');
});

await step('Folder owned by another user ("dubious ownership") → marked safe, then it can pull and deploy', async () => {
  // Like files created inside a Docker container (uid 1000) while Switchboard logs in as root.
  on('rm -rf /srv/gc-owned && id -u gc-other >/dev/null 2>&1 || useradd -M gc-other');
  on(`git clone -q ${URL_GIT} /srv/gc-owned && chown -R gc-other: /srv/gc-owned`);
  on("git config --global --unset-all safe.directory /srv/gc-owned || true");
  check(/dubious ownership/.test(sh('docker exec vps-ci git -C /srv/gc-owned status 2>&1 || true')), 'git refuses the folder for root (as on the real server)');
  const p = await api('GET', `/projects/${project.id}`);
  const dep = p.deployments.find((d) => d.server_id === srv['gc-empty'].id);
  await api('PUT', `/deployments/${dep.id}`, { ...dep, app_dir: '/srv/gc-owned' });
  await api('POST', `/projects/${project.id}/ci/git-check`);
  const st = gitOf(await ci(), 'gc-empty');
  check(st?.state === 'unsafe_owner' && /gc-other/.test(st.error || ''), `check: ${st?.state} (${st?.error})`);
  const { job } = await api('POST', `/projects/${project.id}/ci/connect`, { server_id: srv['gc-empty'].id, deploy: true });
  const j = await waitJob(job);
  check(/marked as safe for git/.test(j.log), 'log: marked as safe');
  check(on('git config --global --get-all safe.directory').split('\n').includes('/srv/gc-owned'), 'safe.directory set for root, for this folder only');
  check(on("stat -c %U /srv/gc-owned") === 'gc-other', 'folder owner not changed');
  const sha = (await gh('POST', '/__commit', { repo: REPO, branch: 'main', file: 'v3.txt', content: 'v3\n' })).sha;
  const { job: dj } = await api('POST', `/deployments/${dep.id}/deploy`, {});
  await waitJob(dj);
  check(on('git -C /srv/gc-owned rev-parse HEAD') === sha, `deploy pulled ${sha.slice(0, 7)} into the folder`);
  check(gitOf(await ci(), 'gc-empty')?.state === 'ok', 'state: connected');
  // Let every deploy of this project finish first (a deploy marks the folder safe again).
  for (const x of (await jobsOf(project.id)).filter((x) => ['queued', 'running'].includes(x.status))) await waitJob(x);
  // A refused folder that is a checkout of ANOTHER repo is not re-pointed.
  on('git config --global --unset-all safe.directory /srv/gc-owned');
  on('git -C /srv/gc-owned config --file .git/config remote.origin.url git://172.30.0.6/lab-user/gc-other.git || git config --file /srv/gc-owned/.git/config remote.origin.url git://172.30.0.6/lab-user/gc-other.git');
  const { job: j2 } = await api('POST', `/projects/${project.id}/ci/connect`, { server_id: srv['gc-empty'].id });
  const l2 = await waitJob(j2);
  // (A background auto-deploy may have marked the folder safe again meanwhile: then it is reported as "pulls from".)
  check(/gc-other\.git, not lab-user\/gc-app — left as it is/.test(l2.log), 'other repo in a refused folder: left alone');
  check(on('git config --file /srv/gc-owned/.git/config remote.origin.url') === 'git://172.30.0.6/lab-user/gc-other.git', 'origin unchanged');
  await api('PUT', `/deployments/${dep.id}`, { ...dep, app_dir: '/srv/gc-empty' });
  on('rm -rf /srv/gc-owned');
});

await step('Deploy straight away into a sub-folder of a checkout owned by another user (no Connect first)', async () => {
  on('rm -rf /srv/gc-owned2 && id -u gc-other >/dev/null 2>&1 || useradd -M gc-other');
  on(`git clone -q ${URL_GIT} /srv/gc-owned2 && mkdir -p /srv/gc-owned2/docker && chown -R gc-other: /srv/gc-owned2`);
  on('git config --global --unset-all safe.directory /srv/gc-owned2 || true');
  const p = await api('GET', `/projects/${project.id}`);
  const dep = p.deployments.find((d) => d.server_id === srv['gc-empty'].id);
  await api('PUT', `/deployments/${dep.id}`, { ...dep, app_dir: '/srv/gc-owned2/docker' });
  const sha = (await gh('POST', '/__commit', { repo: REPO, branch: 'main', file: 'v4.txt', content: 'v4\n' })).sha;
  const { job } = await api('POST', `/deployments/${dep.id}/deploy`, {});
  const j = await waitJob(job);
  check(/\/srv\/gc-owned2 belongs to user gc-other, not the SSH user: marked as safe for git/.test(j.log), 'deploy marked the checkout safe first');
  check(on('git -C /srv/gc-owned2 rev-parse HEAD') === sha && on('stat -c %U /srv/gc-owned2') === 'gc-other', `pulled ${sha.slice(0, 7)}, owner unchanged`);
  const { job: j2 } = await api('POST', `/deployments/${dep.id}/deploy`, {});
  check(!/marked as safe/.test((await waitJob(j2)).log), 'second deploy: nothing to mark');
  await api('PUT', `/deployments/${dep.id}`, { ...dep, app_dir: '/srv/gc-empty' });
  on('rm -rf /srv/gc-owned2');
});

await step('Compose folder inside the repo + "pull from Git and rebuild" deploy script (Docker)', async () => {
  // From here on no background CI/CD: its own deploys of the test's new commits would race the checks.
  await api('POST', `/projects/${project.id}/ci/disable`);
  for (const j of (await jobsOf(project.id)).filter((x) => ['queued', 'running'].includes(x.status))) await waitJob(j);
  const compose = (port) => `services:\n  web:\n    image: nginx:1.27-alpine\n    container_name: gc-web\n    ports: ["${port}:80"]\n`;
  on('docker rm -f gc-web >/dev/null 2>&1 || true');
  await gh('POST', '/__commit', { repo: REPO, branch: 'main', file: 'docker/docker-compose.yml', content: compose(18080) });
  on('git -C /srv/gc-live pull -q --ff-only');
  const sha = (await gh('POST', '/__commit', { repo: REPO, branch: 'main', file: 'docker/docker-compose.yml', content: compose(18081) })).sha;
  const p = await api('GET', `/projects/${project.id}`);
  const dep = p.deployments.find((d) => d.server_id === srv['gc-live'].id);
  await api('PUT', `/deployments/${dep.id}`, { ...dep, app_dir: '/srv/gc-live/docker' });
  await api('POST', `/projects/${project.id}/ci/git-check`);
  const st = gitOf(await ci(), 'gc-live');
  check(st?.state === 'ok' && st.top === '/srv/gc-live' && st.behind === 1, `the repo is found one folder up (${st?.state}, top ${st?.top}, behind ${st?.behind})`);
  await api('POST', `/projects/${project.id}/docker-deploy-script`);
  const ps = await api('GET', `/projects/${project.id}`);
  check(/docker compose up -d --build --remove-orphans/.test(ps.deploy_script) && /SB_COMMIT/.test(ps.deploy_script), 'deploy script set to "pull + rebuild"');
  const { job } = await api('POST', `/deployments/${dep.id}/deploy`, {});
  await waitJob(job);
  check(on('git -C /srv/gc-live rev-parse HEAD') === sha, `pulled ${sha.slice(0, 7)}`);
  check(/18081/.test(on("docker port gc-web 80 || true")), `container rebuilt with the new compose file (${on('docker port gc-web 80 || true')})`);
  on('docker rm -f gc-web >/dev/null 2>&1 || true');
  await api('PUT', `/deployments/${dep.id}`, { ...dep, app_dir: '/srv/gc-live' });
  await api('PUT', `/projects/${project.id}`, { name: 'Git Connect Lab', deploy_script: 'git pull -q --ff-only\ngit log -1 --format=%h' });
});

await step('Your own workflow: example, commit to GitHub, its runs, Run now', async () => {
  const w = await api('GET', `/projects/${project.id}/ci/workflows`);
  check(/runs-on: \[self-hosted, '\$\{\{ matrix\.server \}\}'\]/.test(w.example) && /server: 'gc-live', dir: '\/srv\/gc-live'/.test(w.example) && /docker compose up -d --build/.test(w.example), 'example: one job per server on its own runner, git + docker compose');
  fs.writeFileSync('/tmp/sb-own-workflow.yml', w.example);
  check(sh(`ruby -ryaml -e 'y = YAML.load_file("/tmp/sb-own-workflow.yml"); puts y["jobs"]["deploy"]["strategy"]["matrix"]["include"].map { |x| x["server"] }.join(",")'`) === 'gc-live,gc-backup,gc-empty', 'example is valid YAML, servers in order');
  check((await api('PUT', `/projects/${project.id}/ci/workflow`, { path: '../evil.yml', content: w.example }, { raw: true })).status === 400, 'a path outside .github/workflows is refused');
  check((await api('PUT', `/projects/${project.id}/ci/workflow`, { path: 'switchboard.yml', content: w.example }, { raw: true })).status === 400, "Switchboard's own file name is refused");
  check((await api('PUT', `/projects/${project.id}/ci/workflow`, { path: 'deploy.yml', content: 'hello' }, { raw: true })).status === 400, 'text that is not a workflow is refused');
  const r = await api('PUT', `/projects/${project.id}/ci/workflow`, { path: 'deploy.yml', content: w.example });
  check(r.changed && r.path === '.github/workflows/deploy.yml', 'committed .github/workflows/deploy.yml');
  check(sh(`docker exec gh-mock git -C /repos/${REPO}.git show main:.github/workflows/deploy.yml`) === w.example.trim(), 'file in the repo = what was saved');
  const c = await ci();
  check(c.own_workflow && c.workflow_path === '.github/workflows/deploy.yml', 'project follows deploy.yml');
  const w2 = await api('GET', `/projects/${project.id}/ci/workflows?path=.github/workflows/deploy.yml`);
  check(w2.files.includes('.github/workflows/deploy.yml') && w2.content === w.example, 'file listed and read back');
  await api('POST', `/projects/${project.id}/ci/commit`);
  check(!/switchboard\.yml/.test(sh(`docker exec gh-mock git -C /repos/${REPO}.git ls-tree -r --name-only main`)), "Switchboard's workflow is not committed in own mode");
  await gh('POST', '/__runs', { repo: REPO, run: { workflow: 'deploy.yml', head_sha: 'a'.repeat(40), display_title: 'own workflow run' } });
  await gh('POST', '/__runs', { repo: REPO, run: { workflow: 'switchboard.yml', head_sha: 'b'.repeat(40), display_title: 'other file' } });
  await api('POST', `/projects/${project.id}/ci/refresh`);
  const runs = (await ci()).runs;
  check(runs.some((x) => x.title === 'own workflow run') && !runs.some((x) => x.title === 'other file'), 'runs shown are those of deploy.yml');
  await api('POST', `/projects/${project.id}/ci/run`, { branch: 'main' });
  const d = (await (await fetch(`${GH}/__state`)).json()).dispatches.pop();
  check(d?.workflow === 'deploy.yml', `Run now starts deploy.yml (${d?.workflow})`);
});

await step('Runner: full access (SSH user) with the server name as label, then back to restricted', async () => {
  await api('PUT', `/projects/${project.id}/ci`, { ci_mode: 'runner', ci_runner_access: 'full' });
  const runnerOf = async () => (await (await fetch(`${GH}/__state`)).json()).runners[REPO]?.find((x) => x.name === `sb-gc-live-${srv['gc-live'].id}`);
  let { job } = await api('POST', `/projects/${project.id}/ci/connect`, { server_id: srv['gc-live'].id, runner: true });
  let j = await waitJob(job);
  let r = await runnerOf();
  check(r && r.user === 'root' && r.labels.split(',').includes('gc-live'), `runner as root with label gc-live (${r?.user}, ${r?.labels})`);
  check(/runs-on: \[self-hosted, gc-live\]/.test(j.log) && /use runs-on/.test(j.log), 'log tells which runs-on to use');
  check(onOk('pgrep -u root -f "./run.sh" >/dev/null'), 'runner process runs as root');
  const c = await ci();
  check(c.servers.find((x) => x.name === 'gc-live')?.runner_user === 'root', 'CI tab shows the runner user');
  await api('PUT', `/projects/${project.id}/ci`, { ci_runner_access: 'restricted' });
  ({ job } = await api('POST', `/projects/${project.id}/ci/connect`, { server_id: srv['gc-live'].id, runner: true }));
  j = await waitJob(job);
  r = await runnerOf();
  check(/register it again/.test(j.log) && r?.user === 'sb-runner', `switched to restricted: registered again as ${r?.user}`);
  check(onOk('visudo -cqf /etc/sudoers.d/switchboard-runner'), 'sudo rule for sb-runner in place');
  const rid = (await ci()).runners.find((x) => x.server_id === srv['gc-live'].id)?.id;
  ({ job } = await api('DELETE', `/projects/${project.id}/ci/runners/${rid}`));
  await waitJob(job);
  check(!onOk('test -d /opt/switchboard-runner/lab-user_gc-app'), 'runner removed');
  await api('PUT', `/projects/${project.id}/ci`, { ci_mode: 'pull', ci_workflow_path: null });
  // "+ Self-hosted runner" while Switchboard deploys: the runner is installed anyway (for your own workflow).
  ({ job } = await api('POST', `/projects/${project.id}/ci/connect`, { server_id: srv['gc-live'].id, runner: true, runner_access: 'full' }));
  await waitJob(job);
  r = await runnerOf();
  check(r?.user === 'root' && (await ci()).runner_access === 'full', `runner asked for in "Switchboard deploys" mode: installed as ${r?.user}`);
  const rid2 = (await ci()).runners.find((x) => x.server_id === srv['gc-live'].id)?.id;
  ({ job } = await api('DELETE', `/projects/${project.id}/ci/runners/${rid2}`));
  await waitJob(job);
  await api('PUT', `/projects/${project.id}/ci`, { ci_runner_access: 'restricted' });
});

await step('Live run view: jobs and steps, self-hosted jobs matched to servers', async () => {
  const t = (s) => new Date(Date.now() - s * 1000).toISOString();
  const run = await gh('POST', '/__runs', { repo: REPO, run: {
    status: 'in_progress', conclusion: null, head_sha: 'c'.repeat(40), display_title: 'live view test', run_started_at: t(60),
    jobs: [
      { name: 'Build Docker Images', status: 'completed', conclusion: 'success', started_at: t(60), completed_at: t(30), labels: ['ubuntu-latest'], runner_name: 'GitHub Actions 3',
        steps: [{ number: 1, name: 'Checkout', status: 'completed', conclusion: 'success', started_at: t(60), completed_at: t(55) }] },
      { name: 'Deploy to public (gc-live)', status: 'in_progress', conclusion: null, started_at: t(20), labels: ['self-hosted', 'gc-live'], runner_name: 'some-hand-made-runner',
        steps: [{ number: 1, name: 'Pull images', status: 'completed', conclusion: 'success', started_at: t(20), completed_at: t(10) }, { number: 2, name: 'Deploy', status: 'in_progress', started_at: t(10) }] },
      { name: 'Deploy to backup', status: 'queued', conclusion: null, labels: ['self-hosted', `sb-gc-backup-${srv['gc-backup'].id}`], steps: [] },
    ] } });
  await api('POST', `/projects/${project.id}/ci/refresh`);
  const live = await api('GET', `/projects/${project.id}/ci/runs/${run.id}/live`);
  check(live.run.status === 'in_progress' && live.jobs.length === 3, `run + 3 jobs (${live.jobs.map((j) => j.name).join(' | ')})`);
  const byName = Object.fromEntries(live.jobs.map((j) => [j.name, j]));
  check(byName['Build Docker Images'].where === 'github' && !byName['Build Docker Images'].server, 'build runs on GitHub');
  check(byName['Deploy to public (gc-live)'].server?.name === 'gc-live', 'job with label gc-live → server gc-live');
  check(byName['Deploy to backup'].server?.name === 'gc-backup', 'job with the runner label sb-gc-backup-<id> → server gc-backup');
  check(byName['Deploy to public (gc-live)'].steps[1].status === 'in_progress', 'steps come through');
  check(live.jobs[0].name === 'Build Docker Images', 'jobs in start order');
  check((await api('GET', `/projects/${project.id}/ci/runs/999999/live`, undefined, { raw: true })).status === 404, 'unknown run → 404');
  await gh('POST', `/__runs/${run.id}`, { status: 'completed', conclusion: 'success' });
  await sleep(2700); // the viewer's short cache
  const done = await api('GET', `/projects/${project.id}/ci/runs/${run.id}/live`);
  check(done.run.conclusion === 'success' && (await ci()).runs.find((r) => r.run_id === run.id)?.conclusion === 'success', 'finished run: the runs list is updated too');
});

await step('Deploy plan: standby now, live later (same commit), at a time, and the live-server policy', async () => {
  const SCRIPT = 'if [ -n "${SB_COMMIT:-}" ]; then git fetch -q origin && git merge -q --ff-only "$SB_COMMIT"; else git pull -q --ff-only; fi';
  await api('PUT', `/projects/${project.id}`, { name: 'Git Connect Lab', deploy_script: SCRIPT });
  // No background CI/CD meanwhile: its own deploys of new test commits would clear the waits this step checks.
  // (/ci/refresh below still runs a check when the test asks for one.)
  await api('POST', `/projects/${project.id}/ci/disable`);
  for (const j of (await jobsOf(project.id)).filter((x) => ['queued', 'running'].includes(x.status))) await waitJob(j);
  let p = await api('GET', `/projects/${project.id}`);
  const dep = (name) => p.deployments.find((d) => d.server_id === srv[name].id);
  await api('POST', `/projects/${project.id}/adopt`, { deployment: dep('gc-live').id });
  for (const d of ['gc-live', 'gc-backup', 'gc-empty']) on(`git -C /srv/${d} pull -q --ff-only || true`);
  const head = (d) => on(`git -C /srv/${d} rev-parse HEAD`);
  const heldNow = async () => (await ci()).held;

  // 1. plan: two standbys now, the live one later (when I click)
  const v5 = (await gh('POST', '/__commit', { repo: REPO, branch: 'main', file: 'v5.txt', content: 'v5\n' })).sha;
  const r = await api('POST', `/projects/${project.id}/deploy-plan`, { now: [dep('gc-backup').id, dep('gc-empty').id], later: [{ deployment: dep('gc-live').id }] });
  check(r.commit === v5, `plan pinned to the newest commit ${v5.slice(0, 7)}`);
  await waitJob(r.job);
  check(head('gc-backup') === v5 && head('gc-empty') === v5 && head('gc-live') !== v5, 'standbys updated now, live untouched');
  let held = await heldNow();
  check(held.length === 1 && held[0].server_name === 'gc-live' && held[0].commit_sha === v5 && !held[0].run_at && held[0].live, 'live waits for a click, with the same commit');

  // 2. a newer commit meanwhile — "Deploy now" still brings the pinned one
  await gh('POST', '/__commit', { repo: REPO, branch: 'main', file: 'v6.txt', content: 'v6\n' });
  const { job: rel } = await api('POST', `/held-deploys/${held[0].id}/deploy`);
  await waitJob(rel);
  check(head('gc-live') === v5, 'Deploy now: live gets exactly the commit the standbys got');
  check(!(await heldNow()).length, 'waiting deploy gone');
  check((await api('POST', `/held-deploys/${held[0].id}/deploy`, {}, { raw: true })).status === 404, 'it cannot be started twice');

  // 3. later at a time: started by Switchboard's 30-second timer
  const at = new Date(Date.now() + 5000).toISOString();
  const r2 = await api('POST', `/projects/${project.id}/deploy-plan`, { now: [], later: [{ deployment: dep('gc-live').id, at }] });
  check(!r2.job && (await heldNow())[0]?.run_at === at, 'nothing now, one waiting with its time');
  let started = null;
  for (let i = 0; i < 80 && !started; i++) {
    await sleep(1000);
    started = (await jobsOf(project.id)).find((j) => j.type === 'deploy' && /scheduled/.test(j.title) && j.id > rel.id);
  }
  check(!!started, `the timer started it (${started?.title})`);
  if (started) await waitJob(started);
  check(r2.commit && head('gc-live') === r2.commit, `live updated at its time, to the commit pinned then (${r2.commit?.slice(0, 7)})`);
  check((await api('POST', `/projects/${project.id}/deploy-plan`, { later: [{ deployment: dep('gc-live').id, at: '2000-01-01T00:00:00Z' }] }, { raw: true })).status === 400, 'a time in the past is refused');

  // 4. policy "waits for me" in "Switchboard deploys" mode: a new commit updates the standbys, the live one waits
  await api('PUT', `/projects/${project.id}/ci`, { ci_mode: 'pull', ci_test_on: 'none', ci_live_policy: 'hold' });
  const v7 = (await gh('POST', '/__commit', { repo: REPO, branch: 'main', file: 'v7.txt', content: 'v7\n' })).sha;
  await api('POST', `/projects/${project.id}/ci/refresh`);
  let auto = null;
  for (let i = 0; i < 30 && !auto; i++) {
    auto = (await jobsOf(project.id)).find((j) => j.type === 'deploy' && j.title.includes(v7.slice(0, 7)));
    if (!auto) await sleep(1000);
  }
  check(auto && /gc-live later/.test(auto.title), `automatic deploy leaves the live server out (${auto?.title})`);
  if (auto) await waitJob(auto);
  held = await heldNow();
  check(head('gc-backup') === v7 && head('gc-live') !== v7 && held[0]?.commit_sha === v7 && !held[0].run_at, 'standbys have the new commit, live waits for a click');

  // 5. policy "quiet time": the live server's deploy gets the next 03:00 (UTC here)
  await api('PUT', `/projects/${project.id}/ci`, { ci_live_policy: 'quiet', ci_quiet_time: '03:00', tz_offset: 0 });
  const v8 = (await gh('POST', '/__commit', { repo: REPO, branch: 'main', file: 'v8.txt', content: 'v8\n' })).sha;
  await api('POST', `/projects/${project.id}/ci/refresh`);
  for (let i = 0; i < 30; i++) {
    held = await heldNow();
    if (held[0]?.commit_sha === v8) break;
    await sleep(1000);
  }
  const ra = held[0]?.run_at ? new Date(held[0].run_at) : null;
  check(held.length === 1 && held[0].commit_sha === v8 && ra && ra.getUTCHours() === 3 && ra.getUTCMinutes() === 0 && ra > new Date() && ra - new Date() <= 86400000, `newer commit replaces the waiting one, at the next 03:00 UTC (${held[0]?.run_at})`);
  check((await api('PUT', `/projects/${project.id}/ci`, { ci_live_policy: 'quiet', ci_quiet_time: '25:00' }, { raw: true })).status === 400, 'a wrong quiet time is refused');
  for (const j of (await jobsOf(project.id)).filter((x) => ['queued', 'running'].includes(x.status))) await waitJob(j);

  // 6. a deploy of the live server by hand makes its waiting deploy unnecessary
  const { job: manual } = await api('POST', `/deployments/${dep('gc-live').id}/deploy`, {});
  const mj = await waitJob(manual);
  check(/its waiting deploy is done by this one/.test(mj.log) && !(await heldNow()).length, 'deploying it by hand clears the wait');

  // 7. Switchboard's workflow (runner mode): the live server is not in the deploy job when it waits
  await api('PUT', `/projects/${project.id}/ci`, { ci_mode: 'runner', ci_live_policy: 'hold' });
  let c = await ci();
  check(!c.workflow.includes(`sb-gc-live-${srv['gc-live'].id}`) && c.workflow.includes(`sb-gc-backup-${srv['gc-backup'].id}`), 'workflow deploys the standbys only');
  await api('PUT', `/projects/${project.id}/ci`, { ci_live_policy: 'now' });
  c = await ci();
  check(c.workflow.includes(`sb-gc-live-${srv['gc-live'].id}`), 'policy "with the others": live is back in the workflow');
  await api('PUT', `/projects/${project.id}/ci`, { ci_mode: 'pull' });
  await api('PUT', `/projects/${project.id}`, { name: 'Git Connect Lab', deploy_script: 'git pull -q --ff-only\ngit log -1 --format=%h' });
});

await step('Roll back: errors after a deploy → deploy an older commit of main again', async () => {
  const SCRIPT = 'if [ -n "${SB_COMMIT:-}" ]; then git fetch -q origin && git reset -q --keep "$SB_COMMIT"; else git pull -q --ff-only; fi';
  await api('PUT', `/projects/${project.id}`, { name: 'Git Connect Lab', deploy_script: SCRIPT });
  await api('PUT', `/projects/${project.id}/ci`, { ci_live_policy: 'now' });
  for (const h of (await ci()).held) await api('DELETE', `/held-deploys/${h.id}`);
  for (const j of (await jobsOf(project.id)).filter((x) => ['queued', 'running'].includes(x.status))) await waitJob(j);
  const p = await api('GET', `/projects/${project.id}`);
  const ids = p.deployments.map((d) => d.id);
  const head = (d) => on(`git -C /srv/${d} rev-parse HEAD`);
  const good = on('git -C /srv/gc-live rev-parse origin/main') && (await api('GET', `/projects/${project.id}/commits`)).commits[0].sha;
  const bad = (await gh('POST', '/__commit', { repo: REPO, branch: 'main', file: 'broken.txt', content: 'oops\n' })).sha;
  let r = await api('POST', `/projects/${project.id}/deploy-plan`, { now: ids });
  await waitJob(r.job);
  check(['gc-live', 'gc-backup', 'gc-empty'].every((d) => head(d) === bad), `all servers on the new (bad) commit ${bad.slice(0, 7)}`);

  const list = await api('GET', `/projects/${project.id}/commits`);
  check(list.commits[0].sha === bad && list.commits[0].newest && list.commits[1].sha === good, 'commit list: newest first, the one before next');
  check(list.commits[0].on.length === 3 && list.servers.find((x) => x.live)?.commit === bad, `each server's commit is known after the deploy (${list.commits[0].on.join(', ')})`);

  r = await api('POST', `/projects/${project.id}/deploy-plan`, { now: ids, commit: good, rollback: true, live_first: true });
  check(/^Roll back .* to /.test(r.job.title), `job: ${r.job.title}`);
  const j = await waitJob(r.job);
  check(['gc-live', 'gc-backup', 'gc-empty'].every((d) => head(d) === good), `all servers back on ${good.slice(0, 7)}`);
  check(/going BACK from/.test(j.log), 'log says it goes back');
  check(j.log.indexOf('Deploy on gc-live') < j.log.indexOf('Deploy on gc-backup'), 'live server first');
  check(on('cat /srv/gc-backup/index.html') === 'v1 edited on backup', 'edits made on a server are kept');
  check((await api('GET', `/projects/${project.id}/commits`)).commits[1].on.length === 3, 'commit list shows the servers on the older commit');

  // A deploy script with a plain "git pull" moves the code forward again: the deploy says so.
  await api('PUT', `/projects/${project.id}`, { name: 'Git Connect Lab', deploy_script: 'git pull -q --ff-only' });
  const dep = p.deployments.find((d) => d.server_id === srv['gc-empty'].id);
  r = await api('POST', `/projects/${project.id}/deploy-plan`, { now: [dep.id], commit: good, rollback: true });
  const j2 = await waitJob(r.job);
  check(/is at .*, not .*: the deploy script moved the code/.test(j2.log), 'warns when the deploy script ignores the chosen commit');

  // Forward again: the newest commit
  await api('PUT', `/projects/${project.id}`, { name: 'Git Connect Lab', deploy_script: SCRIPT });
  r = await api('POST', `/projects/${project.id}/deploy-plan`, { now: ids });
  await waitJob(r.job);
  check(['gc-live', 'gc-backup', 'gc-empty'].every((d) => head(d) === bad), 'and forward again to the newest');
  await api('PUT', `/projects/${project.id}`, { name: 'Git Connect Lab', deploy_script: 'git pull -q --ff-only\ngit log -1 --format=%h' });
});

await step('Developer may check but not connect', async () => {
  const { users } = await api('GET', '/users');
  let dev = users.find((u) => u.username === 'gc-dev');
  if (!dev) await api('POST', '/users', { username: 'gc-dev', password: 'dev-password-123', role: 'developer' });
  const adminCookie = cookie;
  cookie = '';
  await api('POST', '/auth/login', { username: 'gc-dev', password: 'dev-password-123' });
  check((await api('POST', `/projects/${project.id}/ci/git-check`, {}, { raw: true })).status === 200, 'developer: check → 200');
  check((await api('POST', `/projects/${project.id}/ci/connect`, { server_id: srv['gc-live'].id }, { raw: true })).status === 403, 'developer: connect → 403');
  cookie = adminCookie;
  dev = (await api('GET', '/users')).users.find((u) => u.username === 'gc-dev');
  if (dev) await api('DELETE', `/users/${dev.id}`);
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);

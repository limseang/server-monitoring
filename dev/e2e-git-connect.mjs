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
  on('rm -rf /srv/gc-live /srv/gc-backup /srv/gc-empty /srv/gc-owned');
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
  // A refused folder that is a checkout of ANOTHER repo is not re-pointed.
  on('git config --global --unset-all safe.directory /srv/gc-owned');
  on('git -C /srv/gc-owned config --file .git/config remote.origin.url git://172.30.0.6/lab-user/gc-other.git || git config --file /srv/gc-owned/.git/config remote.origin.url git://172.30.0.6/lab-user/gc-other.git');
  const { job: j2 } = await api('POST', `/projects/${project.id}/ci/connect`, { server_id: srv['gc-empty'].id });
  const l2 = await waitJob(j2);
  check(/is a checkout of git:\/\/172.30.0.6\/lab-user\/gc-other.git, not lab-user\/gc-app — left as it is/.test(l2.log), 'other repo in a refused folder: left alone');
  check(on('git config --file /srv/gc-owned/.git/config remote.origin.url') === 'git://172.30.0.6/lab-user/gc-other.git', 'origin unchanged');
  await api('PUT', `/deployments/${dep.id}`, { ...dep, app_dir: '/srv/gc-empty' });
  on('rm -rf /srv/gc-owned');
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

import crypto from 'node:crypto';
import { all, get, insert, run, update, now } from '../db.js';
import { bus } from '../bus.js';
import { alert, logEvent } from '../events.js';
import { defineJob, enqueue } from '../jobs.js';
import { getProject, getServer, deploymentsOf, parseJSON } from '../models.js';
import * as cf from '../cloudflare.js';
import * as gh from '../github.js';
import { exec } from '../ssh.js';
import { slugify } from '../util.js';
import { connectTo, runRemote, asRoot, shq } from './remote.js';
import { TEMPLATES, installHelper, pushProjectConf, ensureRepoAccess, helper } from './stack.js';

/**
 * GitHub CI/CD with self-hosted runners.
 *
 *  push to main ──► GitHub Actions: "test" job on GitHub's machines
 *                   └► "deploy-<project>" jobs run on the self-hosted runner of each server
 *                      (standby servers first, the live one last, one at a time):
 *                      sudo switchboard-helper deploy <project> <commit>  → deploy script + health check
 *  pull request ───► "preview" job on the preview server's runner → switchboard-helper preview-up
 *
 * The runner runs as user sb-runner, which may only run those helper commands through sudo.
 * Switchboard reads the results back from the GitHub API (no inbound connection needed).
 */

export const RUNNER_USER = 'sb-runner';
export const runnerLabel = (server) => `sb-${slugify(server.name)}-${server.id}`;
const repoDir = (repo) => `/opt/switchboard-runner/${repo.replace(/[^A-Za-z0-9_.-]+/g, '_')}`;
const ci = (p) => parseJSON(p.ci_state, {}) || {};
const saveCi = (id, patch) => update('projects', id, { ci_state: JSON.stringify({ ...ci(getProject(id)), ...patch }) });

/** The main project and its staging copies that deploy from the same repository. */
export function ciProjects(root) {
  return [root, ...all('SELECT * FROM projects WHERE parent_id = ? ORDER BY id', root.id).filter((c) => c.git_repo === root.git_repo)];
}
export const rootOf = (p) => (p.parent_id ? getProject(p.parent_id) || p : p);

/** Every server that needs a runner: the projects' servers and the preview server. */
export function ciServers(root) {
  const ids = new Set();
  for (const p of ciProjects(root)) for (const d of deploymentsOf(p.id)) ids.add(d.server_id);
  if (root.preview_server_id) ids.add(root.preview_server_id);
  return [...ids].map(getServer).filter(Boolean);
}

/* ------------------------------------------------------------------ workflow file */
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const indent = (text, n) =>
  String(text)
    .split('\n')
    .map((l) => (l ? ' '.repeat(n) + l : l))
    .join('\n');

export function workflowYaml(root) {
  const projects = ciProjects(root).filter((p) => deploymentsOf(p.id).length);
  const tpl = TEMPLATES[root.template];
  const tests = String(root.ci_test_cmd || '').trim();
  const testJob = root.ci_test_on !== 'none' && tests;
  const zone = parseJSON(root.preview_zone);
  const previewServer = root.ci_mode !== 'pull' && root.preview_server_id && root.template && zone?.zone_name ? getServer(root.preview_server_id) : null;
  const branches = [...new Set(projects.map((p) => p.git_branch || 'main'))];
  const needs = testJob ? '    needs: test\n' : '';
  const L = [];
  L.push(`# Made by Switchboard for ${root.name}. Change it in Switchboard (project → CI/CD) — edits here are overwritten.`);
  L.push('name: Switchboard');
  L.push('on:');
  L.push('  push:');
  L.push(`    branches: [${branches.map(q).join(', ')}]`);
  if (testJob || previewServer) {
    L.push('  pull_request:');
    L.push(`    types: [opened, synchronize, reopened${previewServer ? ', closed' : ''}]`);
  }
  L.push('  workflow_dispatch:');
  L.push('permissions:');
  L.push('  contents: read');
  L.push('jobs:');
  if (testJob) {
    L.push('  test:');
    L.push("    if: github.event_name != 'pull_request' || github.event.action != 'closed'");
    L.push('    runs-on: ubuntu-latest');
    L.push('    timeout-minutes: 30');
    L.push('    steps:');
    L.push('      - uses: actions/checkout@v4');
    if (root.template === 'laravel') {
      L.push('      - uses: shivammathur/setup-php@v2');
      L.push("        with: { php-version: '8.4', coverage: none }");
    } else if (root.template) {
      L.push('      - uses: actions/setup-node@v4');
      L.push("        with: { node-version: '24' }");
    }
    L.push('      - name: Tests');
    L.push('        run: |');
    L.push(indent(tests, 10));
  }
  for (const p of root.ci_mode === 'pull' ? [] : projects) {
    // Standby servers first, the live server last; one at a time, stop at the first failure.
    const deps = deploymentsOf(p.id).sort((a, b) => (a.id === p.active_deployment_id) - (b.id === p.active_deployment_id));
    const labels = deps.map((d) => runnerLabel(getServer(d.server_id)));
    const job = `deploy-${p.slug}`.slice(0, 90);
    L.push(`  ${job}:`);
    L.push(`    name: Deploy ${p.name.replace(/[:#]/g, ' ')} (\${{ matrix.server }})`);
    L.push(needs.trimEnd() || null);
    L.push(`    if: github.event_name != 'pull_request' && github.ref == ${q(`refs/heads/${p.git_branch || 'main'}`)}`);
    L.push('    strategy:');
    L.push('      max-parallel: 1');
    L.push('      fail-fast: true');
    L.push('      matrix:');
    L.push(`        server: [${labels.map(q).join(', ')}]`);
    L.push("    runs-on: [self-hosted, switchboard, '${{ matrix.server }}']");
    L.push(`    environment: { name: ${q(p.env === 'production' ? 'production' : p.env || 'staging')}${p.domain ? `, url: ${q(`https://${p.domain}`)}` : ''} }`);
    L.push(`    concurrency: { group: ${q(`deploy-${p.slug}`)}, cancel-in-progress: false }`);
    L.push('    timeout-minutes: 60');
    L.push('    steps:');
    L.push('      - name: Deploy');
    L.push(`        run: sudo -n /usr/local/bin/switchboard-helper deploy ${p.slug} "$GITHUB_SHA"`);
  }
  if (previewServer && root.ci_mode !== 'pull') {
    const label = q(runnerLabel(previewServer));
    const sameRepo = 'github.event.pull_request.head.repo.full_name == github.repository';
    L.push('  preview:');
    L.push(needs.trimEnd() || null);
    L.push(`    if: github.event_name == 'pull_request' && github.event.action != 'closed' && ${sameRepo}`);
    L.push(`    runs-on: [self-hosted, switchboard, ${label}]`);
    L.push(`    concurrency: { group: 'preview-\${{ github.event.number }}', cancel-in-progress: true }`);
    L.push('    timeout-minutes: 45');
    L.push('    steps:');
    L.push(`      - name: Preview at https://pr-\${{ github.event.number }}-${root.slug}.${zone.zone_name}`);
    L.push(`        run: sudo -n /usr/local/bin/switchboard-helper preview-up ${root.slug} "\${{ github.event.number }}" "\${{ github.event.pull_request.head.sha }}"`);
    L.push('  preview-remove:');
    L.push(`    if: github.event_name == 'pull_request' && github.event.action == 'closed' && ${sameRepo}`);
    L.push(`    runs-on: [self-hosted, switchboard, ${label}]`);
    L.push('    steps:');
    L.push('      - name: Remove preview');
    L.push(`        run: sudo -n /usr/local/bin/switchboard-helper preview-down ${root.slug} "\${{ github.event.number }}"`);
  }
  if ((!projects.length || root.ci_mode === 'pull') && !previewServer && !testJob) {
    L.push('  nothing:');
    L.push('    runs-on: ubuntu-latest');
    L.push('    steps: [{ run: "echo No servers in this project yet" }]');
  }
  return `${L.filter((l) => l !== null).join('\n')}\n`;
}

export const workflowHash = (yaml) => crypto.createHash('sha256').update(yaml).digest('hex').slice(0, 16);

/** Commit the workflow file to every deploy branch (push events use the file of the pushed commit). */
export async function commitWorkflow(ctx, root) {
  const yaml = workflowYaml(root);
  for (const branch of [...new Set(ciProjects(root).map((p) => p.git_branch || 'main'))]) {
    const changed = await gh.putFile(root.git_repo, gh.WORKFLOW_PATH, yaml, { branch, message: 'Switchboard CI/CD workflow' });
    ctx?.log(`${gh.WORKFLOW_PATH} on ${branch}: ${changed ? 'committed' : 'already up to date'}`);
  }
  saveCi(root.id, { committed_hash: workflowHash(yaml), committed_at: now() });
  return yaml;
}

/* ------------------------------------------------------------------ runner on a server */
function runnerScript({ repo, server, url }) {
  const dir = repoDir(repo);
  const safe = repo.replace(/[^A-Za-z0-9_.-]+/g, '_');
  return `set -e
read -r TOKEN
U=${RUNNER_USER}; DIR=${shq(dir)}
command -v sudo >/dev/null 2>&1 || { echo '>>> Installing sudo'; DEBIAN_FRONTEND=noninteractive apt-get install -y -q sudo >/dev/null 2>&1 || dnf install -y -q sudo; }
id -u "$U" >/dev/null 2>&1 || { useradd -m -s /bin/bash "$U"; echo ">>> Created user $U (runs the GitHub runner, no other rights)"; }
cat > /etc/sudoers.d/switchboard-runner.tmp <<'EOF'
# Written by Switchboard: the GitHub runner may only run these helper commands as root.
Defaults:${RUNNER_USER} !requiretty
${RUNNER_USER} ALL=(root) NOPASSWD: /usr/local/bin/switchboard-helper deploy *, /usr/local/bin/switchboard-helper preview-up *, /usr/local/bin/switchboard-helper preview-down *
EOF
chmod 440 /etc/sudoers.d/switchboard-runner.tmp
visudo -cqf /etc/sudoers.d/switchboard-runner.tmp
mv /etc/sudoers.d/switchboard-runner.tmp /etc/sudoers.d/switchboard-runner
mkdir -p "$DIR"; chown "$U": "$DIR"; cd "$DIR"
if [ ! -x ./config.sh ]; then
  echo ">>> Download the GitHub Actions runner"
  curl -fsSL ${shq(url)} -o /tmp/sb-runner.tgz
  tar xzf /tmp/sb-runner.tgz -C "$DIR"; rm -f /tmp/sb-runner.tgz
  chown -R "$U": "$DIR"
  if [ -x ./bin/installdependencies.sh ]; then ./bin/installdependencies.sh >/dev/null 2>&1 || echo '(installdependencies.sh failed — the runner may still work)'; fi
fi
if [ -f .runner ]; then echo '>>> Runner already registered'; else
  echo ">>> Register the runner ${runnerLabel(server)} with ${repo}"
  runuser -u "$U" -- ./config.sh --unattended --url ${shq(gh.webUrl(repo))} --token "$TOKEN" --name ${shq(runnerLabel(server))} --labels ${shq(`switchboard,${runnerLabel(server)}`)} --work _work --replace
fi
if [ -d /run/systemd/system ]; then
  [ -f .service ] || ./svc.sh install "$U"
  ./svc.sh start >/dev/null 2>&1 || true
  echo ">>> Runner runs as a systemd service ($(cat .service 2>/dev/null))"
else
  if [ -f runner.pid ] && kill -0 "$(cat runner.pid)" 2>/dev/null; then echo '>>> Runner is running'; else
    # setsid: its own session, so it keeps running after this SSH command ends.
    setsid nohup runuser -u "$U" -- ./run.sh >> runner.log 2>&1 < /dev/null &
    echo $! > runner.pid
    sleep 2; kill -0 "$(cat runner.pid)" 2>/dev/null || { echo 'The runner stopped right away:' >&2; tail -n 20 runner.log >&2; exit 1; }
    echo ">>> Runner started (no systemd here: started now and by cron at boot)"
  fi
  echo "@reboot root cd $DIR && runuser -u $U -- ./run.sh >> $DIR/runner.log 2>&1" > /etc/cron.d/switchboard-runner-${safe}
fi`;
}

async function serverArch(conn) {
  const m = (await exec(conn, 'uname -m')).stdout.trim();
  return /aarch64|arm64/.test(m) ? 'arm64' : /armv7|armhf/.test(m) ? 'arm' : 'x64';
}

async function installRunner(ctx, conn, server, repo) {
  const arch = await serverArch(conn);
  const rel = await gh.latestRunner(arch);
  const token = await gh.runnerRegistrationToken(repo);
  await runRemote(ctx, conn, asRoot(server, runnerScript({ repo, server, url: rel.url })), { stdin: `${token}\n`, timeout: 15 * 60000 });
  const row = { repo, server_id: server.id, name: runnerLabel(server), label: runnerLabel(server), version: rel.version, status: 'installed', error: null, installed_at: now() };
  const ex = get('SELECT id FROM runners WHERE repo = ? AND server_id = ?', repo, server.id);
  if (ex) update('runners', ex.id, row);
  else insert('runners', row);
}

/** Helper + project settings on every server; runners too when `runners` is set. */
async function setupServers(ctx, root, { runners }) {
  const projects = ciProjects(root);
  for (const server of ciServers(root)) {
    ctx.step(`${runners ? 'Runner and settings' : 'Settings'} on ${server.name}`);
    const conn = await connectTo(ctx, server);
    try {
      await installHelper(ctx, conn, server);
      let wroteRoot = false;
      for (const p of projects) {
        const dep = deploymentsOf(p.id).find((d) => d.server_id === server.id);
        if (!dep) continue;
        await pushProjectConf(ctx, conn, server, p, dep);
        if (p.id === root.id) wroteRoot = true;
        ctx.log(`Settings of ${p.name} written`);
      }
      // Preview server that doesn't run the app itself still needs the project's settings.
      if (!wroteRoot && root.preview_server_id === server.id) await pushProjectConf(ctx, conn, server, root, { app_dir: '' });
      if (root.git_repo && root.template) await ensureRepoAccess(ctx, conn, server, root.git_repo, { addKey: gh.addDeployKey });
      if (runners) await installRunner(ctx, conn, server, root.git_repo);
    } finally {
      conn.end();
    }
  }
}

defineJob('ci-setup', async (ctx, p) => {
  const root = rootOf(getProject(ctx.job.project_id));
  if (!root.git_repo) throw new Error('Set the GitHub repository first');
  if (!gh.hasToken()) throw new Error('Add a GitHub token first (Settings → GitHub)');
  try {
    ctx.step(`Check access to ${root.git_repo}`);
    const r = await gh.getRepo(root.git_repo);
    ctx.log(`${r.full_name} — ${r.private ? 'private' : 'public'}, default branch ${r.default_branch}`);
    for (const c of ciProjects(root).slice(1)) {
      if (await gh.ensureBranch(root.git_repo, c.git_branch, root.git_branch)) ctx.log(`Created branch ${c.git_branch} for ${c.name}`);
    }
    const pull = root.ci_mode === 'pull';
    saveCi(root.id, { repo_private: !!r.private });
    if (!pull && !r.private) ctx.warn('This repository is PUBLIC: a self-hosted runner can be targeted by pull requests from strangers. Prefer the "Switchboard pulls" mode, or require approval for outside contributors in GitHub → Settings → Actions.');
    await setupServers(ctx, root, { runners: !pull });
    const tests = root.ci_test_on !== 'none' && String(root.ci_test_cmd || '').trim();
    if (p.commit !== false && (!pull || tests)) {
      ctx.step(pull ? 'Commit the workflow file (tests only — Switchboard deploys)' : 'Commit the workflow file');
      await commitWorkflow(ctx, root);
    }
    if (pull) {
      // Start from what is on the branch now; every newer commit gets deployed.
      const deployed = { ...(ci(getProject(root.id)).deployed || {}) };
      for (const x of ciProjects(root)) deployed[x.slug] = await gh.branchSha(root.git_repo, x.git_branch || 'main');
      saveCi(root.id, { deployed });
      ctx.log(`Switchboard checks ${root.git_repo} every minute and deploys new commits${tests ? ' after the tests on GitHub pass' : ''} — no runner on your servers, nothing has to reach them from outside`);
    }
    update('projects', root.id, { ci_enabled: 1 });
    logEvent('success', `${root.name}: CI/CD set up (${pull ? 'Switchboard deploys new commits' : `runners on ${ciServers(root).map((s) => s.name).join(', ')}`})`, { projectId: root.id, jobId: ctx.id, user: ctx.user });
    pollProject(root.id).catch(() => {});
  } catch (e) {
    alert('error', `${root.name}: CI/CD setup FAILED — ${e.message}`, { projectId: root.id, jobId: ctx.id, link: `#/projects/${root.id}` });
    throw e;
  } finally {
    bus.emit('state', { projectId: root.id });
  }
});

/** Push the latest helper + project settings + deploy scripts to the servers (no runner changes). */
defineJob('ci-servers', async (ctx) => {
  const root = rootOf(getProject(ctx.job.project_id));
  await setupServers(ctx, root, { runners: false });
  ctx.log('Servers are up to date');
});

defineJob('runner-remove', async (ctx, p) => {
  const r = get('SELECT * FROM runners WHERE id = ?', Number(p.runner));
  if (!r) throw new Error('Runner not found');
  const server = getServer(r.server_id);
  const dir = repoDir(r.repo);
  const token = await gh.runnerRemoveToken(r.repo).catch((e) => (ctx.warn(`Could not get a removal token: ${e.message}`), ''));
  ctx.step(`Remove the runner from ${server.name}`);
  const conn = await connectTo(ctx, server);
  try {
    await runRemote(
      ctx,
      conn,
      asRoot(
        server,
        `read -r TOKEN; DIR=${shq(dir)}; [ -d "$DIR" ] || { echo 'Runner folder already gone'; exit 0; }
cd "$DIR"
if [ -f .service ]; then ./svc.sh stop || true; ./svc.sh uninstall || true; fi
if [ -f runner.pid ]; then kill -- "-$(cat runner.pid)" 2>/dev/null || kill "$(cat runner.pid)" 2>/dev/null || true; pkill -u ${RUNNER_USER} 2>/dev/null || true; fi
[ -z "$TOKEN" ] || runuser -u ${RUNNER_USER} -- ./config.sh remove --token "$TOKEN" || echo '(could not unregister — remove it in GitHub → Settings → Actions → Runners)'
rm -f /etc/cron.d/switchboard-runner-${r.repo.replace(/[^A-Za-z0-9_.-]+/g, '_')}
cd / && rm -rf "$DIR"
echo 'Runner removed'`,
      ),
      { stdin: `${token}\n` },
    );
  } finally {
    conn.end();
  }
  run('DELETE FROM runners WHERE id = ?', r.id);
  logEvent('warn', `GitHub runner removed from ${server.name} (${r.repo})`, { jobId: ctx.id, user: ctx.user });
});

defineJob('preview-down', async (ctx, p) => {
  const root = getProject(ctx.job.project_id);
  const server = getServer(Number(p.server));
  if (!server) throw new Error('Preview server not found');
  const conn = await connectTo(ctx, server);
  try {
    await helper(ctx, conn, server, ['preview-down', root.slug, String(Number(p.pr))]);
  } finally {
    conn.end();
  }
});

/* ------------------------------------------------------------------ reading results from GitHub */
const RECENT_MS = 15 * 60000;

async function pollRuns(root) {
  const runs = await gh.listRuns(root.git_repo, { perPage: 30 });
  for (const r of runs) {
    const prev = get('SELECT * FROM ci_runs WHERE project_id = ? AND run_id = ?', root.id, r.id);
    const row = {
      run_number: r.run_number,
      event: r.event,
      branch: r.head_branch,
      sha: r.head_sha,
      title: String(r.display_title || r.head_commit?.message || '').split('\n')[0].slice(0, 200),
      actor: r.actor?.login || r.triggering_actor?.login || '',
      status: r.status,
      conclusion: r.conclusion,
      html_url: r.html_url,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
    if (prev) update('ci_runs', prev.id, row);
    else insert('ci_runs', { project_id: root.id, run_id: r.id, ...row });
    const justFinished = r.status === 'completed' && (prev ? prev.status !== 'completed' : Date.now() - Date.parse(r.updated_at) < RECENT_MS);
    if (!justFinished) continue;
    const what = `${root.name}: CI run #${r.run_number} (${r.event === 'pull_request' ? 'pull request' : r.head_branch}: ${row.title})`;
    if (r.conclusion === 'success') logEvent('success', `${what} passed`, { projectId: root.id });
    else if (r.conclusion === 'failure' || r.conclusion === 'timed_out') alert('error', `${what} FAILED — ${r.html_url}`, { projectId: root.id, link: r.html_url });
    else if (r.conclusion !== 'skipped') logEvent('warn', `${what} ${r.conclusion}`, { projectId: root.id });
  }
  run('DELETE FROM ci_runs WHERE project_id = ? AND id NOT IN (SELECT id FROM ci_runs WHERE project_id = ? ORDER BY run_id DESC LIMIT 200)', root.id, root.id);
  return runs;
}

export const previewHost = (root, pr) => `pr-${pr}-${root.slug}.${parseJSON(root.preview_zone)?.zone_name}`;

/** Keep one DNS record per open pull request, remove the preview when it is closed. */
async function syncPreviews(root, runs) {
  const zone = parseJSON(root.preview_zone);
  const server = getServer(root.preview_server_id);
  if (!zone?.zone_id || !server) return;
  const pulls = (await gh.listOpenPulls(root.git_repo)).filter((pr) => pr.head?.repo?.full_name === root.git_repo);
  const open = new Set();
  for (const pr of pulls) {
    open.add(pr.number);
    const host = previewHost(root, pr.number);
    let row = get('SELECT * FROM previews WHERE project_id = ? AND pr = ?', root.id, pr.number);
    if (!row) {
      insert('previews', { project_id: root.id, pr: pr.number, host, zone_id: zone.zone_id, status: 'waiting', created_at: now() });
      row = get('SELECT * FROM previews WHERE project_id = ? AND pr = ?', root.id, pr.number);
      logEvent('info', `${root.name}: preview for pull request #${pr.number} → https://${host}`, { projectId: root.id });
    }
    if (!row.record_id) {
      const ex = (await cf.findRecords(zone.zone_id, host)).find((r) => r.name === host && r.type === 'A');
      const rec = ex || (await cf.createRecord(zone.zone_id, { type: 'A', name: host, content: server.ip, proxied: true, comment: `Switchboard preview: ${root.name} #${pr.number}` }));
      update('previews', row.id, { record_id: rec.id });
    }
    const runFor = runs.filter((r) => r.event === 'pull_request' && r.head_sha === pr.head.sha).sort((a, b) => b.id - a.id)[0];
    const status = !runFor ? 'waiting' : runFor.status !== 'completed' ? 'building' : runFor.conclusion === 'success' ? 'ready' : 'failed';
    update('previews', row.id, { title: String(pr.title || '').slice(0, 200), branch: pr.head.ref, sha: pr.head.sha, author: pr.user?.login || '', status, updated_at: now() });
  }
  for (const row of all('SELECT * FROM previews WHERE project_id = ?', root.id)) {
    if (open.has(row.pr)) continue;
    await removePreview(root, row, 'pull request closed').catch((e) => logEvent('warn', `${root.name}: could not remove the preview of #${row.pr}: ${e.message}`, { projectId: root.id }));
  }
}

export async function removePreview(root, row, why, user = 'system') {
  if (row.record_id && row.zone_id) await cf.deleteRecord(row.zone_id, row.record_id).catch((e) => (e.message.includes('81044') ? null : Promise.reject(e)));
  run('DELETE FROM previews WHERE id = ?', row.id);
  // The runner removes it when the pull request is closed; this also covers a missed job.
  if (root.preview_server_id) enqueue({ type: 'preview-down', title: `Remove preview #${row.pr} (${root.name})`, projectId: root.id, params: { server: root.preview_server_id, pr: row.pr }, user });
  logEvent('info', `${root.name}: preview of pull request #${row.pr} removed (${why})`, { projectId: root.id, user });
}

/** Pull mode: deploy the newest commit of each branch (after its tests passed, when there are tests). */
async function autoDeploy(root, runs) {
  const tests = root.ci_test_on !== 'none' && String(root.ci_test_cmd || '').trim();
  const deployed = { ...(ci(root).deployed || {}) };
  for (const p of ciProjects(root)) {
    if (!deploymentsOf(p.id).length || !String(p.deploy_script || '').trim()) continue;
    const sha = await gh.branchSha(root.git_repo, p.git_branch || 'main');
    if (!sha || sha === deployed[p.slug]) continue;
    if (get("SELECT 1 AS x FROM jobs WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1", p.id)) continue;
    if (tests) {
      const run = runs.filter((r) => r.head_sha === sha && r.event !== 'pull_request').sort((a, b) => b.id - a.id)[0];
      if (!run || run.status !== 'completed') continue; // wait for the tests
      if (run.conclusion !== 'success') {
        deployed[p.slug] = sha;
        alert('error', `${p.name}: commit ${sha.slice(0, 7)} was NOT deployed — its tests ${run.conclusion} (${run.html_url})`, { projectId: p.id, link: run.html_url });
        continue;
      }
    }
    deployed[p.slug] = sha;
    enqueue({ type: 'deploy', title: `Deploy ${p.name} @ ${sha.slice(0, 7)} (new commit on ${p.git_branch})`, projectId: p.id, params: { all: true, commit: sha }, user: 'github' });
    logEvent('info', `${p.name}: new commit ${sha.slice(0, 7)} on ${p.git_branch} — deploying`, { projectId: p.id });
  }
  saveCi(root.id, { deployed });
}

export async function pollProject(id) {
  const root = rootOf(getProject(id));
  if (!root?.git_repo || !gh.hasToken()) return;
  try {
    const runs = await pollRuns(root);
    if (root.ci_mode === 'pull') await autoDeploy(root, runs);
    else if (root.preview_server_id) await syncPreviews(root, runs);
    saveCi(root.id, { polled_at: now(), error: null });
  } catch (e) {
    saveCi(root.id, { polled_at: now(), error: e.message });
    throw e;
  } finally {
    bus.emit('state', { projectId: root.id });
  }
}

let polling = false;
export async function pollAllCi() {
  if (polling || !gh.hasToken()) return;
  polling = true;
  try {
    for (const p of all('SELECT id FROM projects WHERE ci_enabled = 1 AND git_repo IS NOT NULL AND parent_id IS NULL')) {
      await pollProject(p.id).catch((e) => console.warn(`[ci] project ${p.id}: ${e.message}`));
    }
  } finally {
    polling = false;
  }
}

/** Live runner status from GitHub (online / offline / busy), best effort. */
export async function runnerStatus(repo) {
  try {
    const list = await gh.listRunners(repo);
    return Object.fromEntries(list.map((r) => [r.name, { status: r.status, busy: !!r.busy }]));
  } catch {
    return null;
  }
}

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
import { connectTo, runRemote, asRoot, shq, shellScript } from './remote.js';
import { splitForPolicy, POLICIES, holdDeploy, nextQuietTime } from './deployplan.js';
import { TEMPLATES, installHelper, pushProjectConf, ensureRepoAccess, helper, gitSshCommand, appUser } from './stack.js';

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
/** Labels of a server's runner: also its plain name, so your own workflow can say runs-on: [self-hosted, <server name>]. */
export const runnerLabels = (server) => [...new Set(['switchboard', runnerLabel(server), slugify(server.name)])];
/** 'full': the runner runs as the SSH user (your own workflow can use Docker and the app files). */
export const runnerUser = (root, server) => (root.ci_runner_access === 'full' ? appUser(server) : RUNNER_USER);
/** The workflow file GitHub runs: your own (Switchboard never rewrites it) or Switchboard's. */
export const ownWorkflow = (root) => !!root.ci_workflow_path;
export const workflowPathOf = (root) => root.ci_workflow_path || gh.WORKFLOW_PATH;
export const workflowFileOf = (root) => workflowPathOf(root).split('/').pop();
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
    // The live server waits (Switchboard deploys it later) when the project says so.
    const deps = deploymentsOf(p.id)
      .filter((d) => !liveWaits(root, p) || d.id !== p.active_deployment_id)
      .sort((a, b) => (a.id === p.active_deployment_id) - (b.id === p.active_deployment_id));
    if (!deps.length) continue;
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

/** Deploy script for an app that runs with Docker Compose: get the new code, rebuild and restart the containers. */
export const DOCKER_DEPLOY_SCRIPT = `# Get the code: the exact commit when one was chosen (newer, or older for a rollback), else the newest
if [ -n "\${SB_COMMIT:-}" ]; then git fetch -q origin && git reset -q --keep "$SB_COMMIT"; else git pull -q --ff-only; fi
# Rebuild the images that have a build: section and restart what changed
docker compose up -d --build --remove-orphans
# Remove old image layers so the disk does not fill up
docker image prune -f`;

/**
 * A starting point for your own workflow: tests on GitHub (optional), then on each server's own runner
 * (standby first, live last): git pull in the app folder + docker compose up --build. Edit it as you like.
 */
export function exampleWorkflow(root) {
  const projects = ciProjects(root).filter((p) => deploymentsOf(p.id).length);
  const p = projects.find((x) => x.id === root.id) || projects[0] || root;
  const deps = deploymentsOf(p.id).sort((a, b) => (a.id === p.active_deployment_id) - (b.id === p.active_deployment_id));
  const branch = p.git_branch || 'main';
  const tests = root.ci_test_on !== 'none' && String(root.ci_test_cmd || '').trim();
  // What kind of app: from its deploy script (the Settings presets), Docker Compose when unknown.
  const script = String(p.deploy_script || '');
  const kind = /docker compose|docker-compose/.test(script) || !script.trim() ? 'docker' : /pm2/i.test(script) ? 'pm2' : /npm|pnpm|yarn/.test(script) ? 'node' : 'docker';
  const rows = deps.map((d) => {
    const s = getServer(d.server_id);
    return `          - { server: ${q(slugify(s.name))}, dir: ${q(d.app_dir || '/srv/app')} }${d.id === p.active_deployment_id ? '   # live — deployed last' : ''}`;
  });
  const L = [
    `# Deploy ${root.name}: made from Switchboard's example — yours to change. Switchboard never rewrites this file.`,
    '# Each server runs a GitHub self-hosted runner (Switchboard → CI/CD → Servers and Git) with its own name as a label.',
    kind === 'docker'
      ? '# The runner must be allowed to run Docker: Switchboard → CI/CD → "What the runner may do" → "Full — for my own workflow".'
      : '# The runner must be allowed to write the app folder: Switchboard → CI/CD → "What the runner may do" → "Full — for my own workflow".',
    'name: Deploy',
    'on:',
    '  push:',
    `    branches: [${q(branch)}]`,
    '  workflow_dispatch:',
    'permissions:',
    '  contents: read',
    'jobs:',
  ];
  if (tests) {
    L.push('  test:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4');
    if (root.template === 'laravel') L.push('      - uses: shivammathur/setup-php@v2', "        with: { php-version: '8.4', coverage: none }");
    L.push('      - name: Tests', '        run: |', indent(tests, 10));
  }
  L.push(
    '  deploy:',
    ...(tests ? ['    needs: test'] : []),
    '    name: Deploy on ${{ matrix.server }}',
    '    strategy:',
    '      max-parallel: 1      # one server at a time',
    '      fail-fast: true      # stop at the first server that fails',
    '      matrix:',
    '        include:',
    ...(rows.length ? rows : ["          - { server: 'my-server', dir: '/srv/app' }"]),
    "    runs-on: [self-hosted, '${{ matrix.server }}']",
    "    concurrency: { group: 'deploy-${{ matrix.server }}', cancel-in-progress: false }",
    '    timeout-minutes: 45',
    '    defaults:',
    '      run:',
    '        working-directory: ${{ matrix.dir }}',
    '    steps:',
    '      - name: Get the new code',
    '        run: |',
    `          git fetch -q origin ${branch}`,
    '          git reset -q --keep "$GITHUB_SHA"   # also works when you re-run an older run (rollback)',
    '          git log -1 --format="Now at %h: %s"',
  );
  if (kind === 'docker') L.push('      - name: Rebuild and restart the containers', '        run: docker compose up -d --build --remove-orphans');
  else {
    // No Docker (Vue / React / Nuxt…): install exactly what the lock file says and build, with the runner user's Node.js (nvm).
    L.push(
      '      - name: Install and build',
      '        run: |',
      '          if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; nvm use -s >/dev/null 2>&1 || true; fi',
      '          export COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
      '          if [ -f pnpm-lock.yaml ]; then corepack pnpm install --frozen-lockfile',
      '          elif [ -f yarn.lock ]; then corepack yarn install --frozen-lockfile',
      '          elif [ -f package-lock.json ]; then npm ci --no-audit --no-fund',
      '          else npm install --no-audit --no-fund; fi',
      kind === 'pm2' ? '          npm run build --if-present' : '          npm run build   # nginx serves the build folder (dist) — Switchboard → Web proxy → Website files',
    );
    if (kind === 'pm2')
      L.push(
        '      - name: Restart the app (PM2)',
        '        run: |',
        '          if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; nvm use -s >/dev/null 2>&1 || true; fi',
        '          F=$(ls ecosystem.config.* .switchboard/pm2.config.cjs 2>/dev/null | head -1)',
        '          if [ -n "$F" ]; then npx --no-install pm2 startOrReload "$F" --update-env; else echo "No PM2 ecosystem file here: reload your app by name, e.g. pm2 reload my-app"; exit 1; fi',
        '          npx --no-install pm2 save',
      );
  }
  if (kind === 'docker' && (root.template === 'laravel' || /laravel|php/i.test(p.deploy_script || '')))
    L.push('      - name: Laravel', '        run: |', '          docker compose exec -T app php artisan migrate --force', '          docker compose exec -T app php artisan optimize');
  L.push(
    '      # - name: Health check',
    `      #   run: curl -fsS --retry 10 --retry-delay 3 --retry-all-errors http://localhost${p.health_port ? `:${p.health_port}` : ''}${p.health_path || '/'} > /dev/null`,
  );
  if (kind === 'docker') L.push('      - name: Clean up old images', '        run: docker image prune -f');
  return `${L.join('\n')}\n`;
}

/** The live server of this project is not deployed together with the others (it waits for a click or a quiet time). */
export const liveWaits = (root, p) => POLICIES.includes(root.ci_live_policy) && root.ci_live_policy !== 'now' && !!p.active_deployment_id && !!String(p.deploy_script || '').trim();

export const workflowHash = (yaml) => crypto.createHash('sha256').update(yaml).digest('hex').slice(0, 16);

/** Commit the workflow file to every deploy branch (push events use the file of the pushed commit). */
export async function commitWorkflow(ctx, root) {
  if (ownWorkflow(root)) {
    ctx?.log(`Your own workflow ${root.ci_workflow_path} is used — Switchboard does not change it`);
    return null;
  }
  const yaml = workflowYaml(root);
  for (const branch of [...new Set(ciProjects(root).map((p) => p.git_branch || 'main'))]) {
    const changed = await gh.putFile(root.git_repo, gh.WORKFLOW_PATH, yaml, { branch, message: 'Switchboard CI/CD workflow' });
    ctx?.log(`${gh.WORKFLOW_PATH} on ${branch}: ${changed ? 'committed' : 'already up to date'}`);
  }
  saveCi(root.id, { committed_hash: workflowHash(yaml), committed_at: now() });
  return yaml;
}

/* ------------------------------------------------------------------ runner on a server */
function runnerScript({ repo, server, url, user }) {
  const dir = repoDir(repo);
  const safe = repo.replace(/[^A-Za-z0-9_.-]+/g, '_');
  const labels = runnerLabels(server).join(',');
  return `set -e
read -r TOKEN; read -r RTOKEN
U=${shq(user)}; DIR=${shq(dir)}; LABELS=${shq(labels)}; WANT="$U|$LABELS"
id -u "$U" >/dev/null 2>&1 || [ "$U" != ${RUNNER_USER} ] || { useradd -m -s /bin/bash "$U"; echo ">>> Created user $U (runs the GitHub runner, no other rights)"; }
id -u "$U" >/dev/null 2>&1 || { echo "User $U does not exist on this server" >&2; exit 1; }
if [ "$U" = ${RUNNER_USER} ]; then
  command -v sudo >/dev/null 2>&1 || { echo '>>> Installing sudo'; DEBIAN_FRONTEND=noninteractive apt-get install -y -q sudo >/dev/null 2>&1 || dnf install -y -q sudo; }
  cat > /etc/sudoers.d/switchboard-runner.tmp <<'EOF'
# Written by Switchboard: the GitHub runner may only run these helper commands as root.
Defaults:${RUNNER_USER} !requiretty
${RUNNER_USER} ALL=(root) NOPASSWD: /usr/local/bin/switchboard-helper deploy *, /usr/local/bin/switchboard-helper preview-up *, /usr/local/bin/switchboard-helper preview-down *
EOF
  chmod 440 /etc/sudoers.d/switchboard-runner.tmp
  visudo -cqf /etc/sudoers.d/switchboard-runner.tmp
  mv /etc/sudoers.d/switchboard-runner.tmp /etc/sudoers.d/switchboard-runner
  echo ">>> Runner user $U: may only run Switchboard's deploy commands"
else
  echo ">>> Runner user $U: full access (your workflow can use Docker and the app files like $U can)"
fi
# The GitHub runner refuses root unless told otherwise.
[ "$U" != root ] || export RUNNER_ALLOW_RUNASROOT=1
mkdir -p "$DIR"; cd "$DIR"
if [ ! -x ./config.sh ]; then
  echo ">>> Download the GitHub Actions runner"
  curl -fsSL ${shq(url)} -o /tmp/sb-runner.tgz
  tar xzf /tmp/sb-runner.tgz -C "$DIR"; rm -f /tmp/sb-runner.tgz
  if [ -x ./bin/installdependencies.sh ]; then ./bin/installdependencies.sh >/dev/null 2>&1 || echo '(installdependencies.sh failed — the runner may still work)'; fi
fi
stop_runner() {
  if [ -f .service ]; then ./svc.sh stop >/dev/null 2>&1 || true; ./svc.sh uninstall >/dev/null 2>&1 || true; fi
  if [ -f runner.pid ]; then kill -- "-$(cat runner.pid)" 2>/dev/null || kill "$(cat runner.pid)" 2>/dev/null || true; rm -f runner.pid; fi
}
if [ -f .runner ] && [ "$(cat .sb-config 2>/dev/null)" != "$WANT" ]; then
  echo ">>> Runner user or labels changed: register it again as $U with labels $LABELS"
  OLDU="$(stat -c %U .runner 2>/dev/null || echo "$U")"
  stop_runner
  runuser -u "$OLDU" -- ./config.sh remove --token "$RTOKEN" >/dev/null 2>&1 || rm -f .runner .credentials .credentials_rsaparams
fi
chown -R "$U": "$DIR"
[ "$U" != root ] || { grep -qs '^RUNNER_ALLOW_RUNASROOT=' .env || echo 'RUNNER_ALLOW_RUNASROOT=1' >> .env; }
if [ -f .runner ]; then echo '>>> Runner already registered'; else
  echo ">>> Register the runner ${runnerLabel(server)} with ${repo} (labels $LABELS)"
  runuser -u "$U" -- env RUNNER_ALLOW_RUNASROOT="\${RUNNER_ALLOW_RUNASROOT:-}" ./config.sh --unattended --url ${shq(gh.webUrl(repo))} --token "$TOKEN" --name ${shq(runnerLabel(server))} --labels "$LABELS" --work _work --replace
  echo "$WANT" > .sb-config
fi
if [ -d /run/systemd/system ]; then
  [ -f .service ] || ./svc.sh install "$U"
  ./svc.sh start >/dev/null 2>&1 || true
  echo ">>> Runner runs as a systemd service ($(cat .service 2>/dev/null)), as $U"
else
  if [ -f runner.pid ] && kill -0 "$(cat runner.pid)" 2>/dev/null; then echo '>>> Runner is running'; else
    # setsid: its own session, so it keeps running after this SSH command ends.
    setsid nohup runuser -u "$U" -- env RUNNER_ALLOW_RUNASROOT="\${RUNNER_ALLOW_RUNASROOT:-}" ./run.sh >> runner.log 2>&1 < /dev/null &
    echo $! > runner.pid
    sleep 2; kill -0 "$(cat runner.pid)" 2>/dev/null || { echo 'The runner stopped right away:' >&2; tail -n 20 runner.log >&2; exit 1; }
    echo ">>> Runner started as $U (no systemd here: started now and by cron at boot)"
  fi
  echo "@reboot root cd $DIR && runuser -u $U -- env RUNNER_ALLOW_RUNASROOT=\${RUNNER_ALLOW_RUNASROOT:-} ./run.sh >> $DIR/runner.log 2>&1" > /etc/cron.d/switchboard-runner-${safe}
fi`;
}

async function serverArch(conn) {
  const m = (await exec(conn, 'uname -m')).stdout.trim();
  return /aarch64|arm64/.test(m) ? 'arm64' : /armv7|armhf/.test(m) ? 'arm' : 'x64';
}

async function installRunner(ctx, conn, server, repo, root) {
  const arch = await serverArch(conn);
  const rel = await gh.latestRunner(arch);
  const token = await gh.runnerRegistrationToken(repo);
  const rtoken = await gh.runnerRemoveToken(repo).catch(() => '');
  const user = runnerUser(root, server);
  await runRemote(ctx, conn, asRoot(server, runnerScript({ repo, server, url: rel.url, user })), { stdin: `${token}\n${rtoken}\n`, timeout: 15 * 60000 });
  ctx.log(`Runner on ${server.name}: labels ${runnerLabels(server).join(', ')} — in your own workflow use runs-on: [self-hosted, ${slugify(server.name)}]`);
  const row = { repo, server_id: server.id, name: runnerLabel(server), label: runnerLabel(server), version: rel.version, status: 'installed', error: null, installed_at: now() };
  const ex = get('SELECT id FROM runners WHERE repo = ? AND server_id = ?', repo, server.id);
  if (ex) update('runners', ex.id, row);
  else insert('runners', row);
}

/** Helper + project settings on every server; runners too when `runners` is set, Git checkouts when `git` is set. */
async function setupServers(ctx, root, { runners, git = false, only = null }) {
  for (const server of ciServers(root)) {
    if (only && server.id !== only) continue;
    ctx.step(`${runners ? 'Runner and settings' : 'Settings'} on ${server.name}`);
    const conn = await connectTo(ctx, server);
    try {
      await installHelper(ctx, conn, server);
      const deps = depsOn(root, server);
      for (const { project, dep } of deps) {
        await pushProjectConf(ctx, conn, server, project, dep);
        ctx.log(`Settings of ${project.name} written`);
      }
      // Preview server that doesn't run the app itself still needs the project's settings.
      if (!deps.some((x) => x.project.id === root.id) && root.preview_server_id === server.id) await pushProjectConf(ctx, conn, server, root, { app_dir: '' });
      if (git) for (const { project, dep } of deps) await connectGit(ctx, conn, server, root, project, dep);
      else if (root.git_repo && root.template) await ensureRepoAccess(ctx, conn, server, root.git_repo, { addKey: gh.addDeployKey });
      // A preview-only server has no checkout of its own, but builds previews from the repo.
      if (git && !deps.length && root.git_repo && gh.hasToken()) await ensureRepoAccess(ctx, conn, server, root.git_repo, { addKey: gh.addDeployKey });
      if (runners) await installRunner(ctx, conn, server, root.git_repo, root);
    } finally {
      conn.end();
    }
  }
}

/* ------------------------------------------------------------------ Git checkout on a server */
/** The project (and staging copies) deployed on this server. */
export const depsOn = (root, server) =>
  ciProjects(root).flatMap((project) => deploymentsOf(project.id).filter((d) => d.server_id === server.id).map((dep) => ({ project, dep })));

/** "git@github.com:Acme/Shop.git", "https://github.com/acme/shop" → "acme/shop" */
export const repoOfUrl = (u) =>
  String(u || '').trim().replace(/\.git$/, '').replace(/\/+$/, '').split(/[:/]/).slice(-2).join('/').toLowerCase();

/**
 * check:   look at the app folder (is it a checkout of the repo? can it fetch?) — changes nothing but origin/<branch>.
 * connect: make it a checkout that can pull: clone into an empty folder, or attach an existing folder
 *          (git init + reset to the branch: files stay exactly as they are), and use the deploy key.
 * Runs as the SSH user, like the deploy script. Prints "SB_GIT key=value" lines.
 */
function gitScript({ mode, dir, url, branch, sshCmd }) {
  return `DIR=${shq(dir)}; URL=${shq(url)}; BRANCH=${shq(branch)}; SSHC=${shq(sshCmd)}
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_ASKPASS=true SSH_ASKPASS=true SSH_ASKPASS_REQUIRE=never
out() { printf 'SB_GIT %s=%s\\n' "$1" "$(printf %s "$2" | tr '\\n' ' ')"; }
gssh() { s="$(git config --get core.sshCommand 2>/dev/null || true)"; echo "\${s:-\${SSHC:-ssh}} -o BatchMode=yes -o ConnectTimeout=20"; }
# The checkout that holds the app folder: the folder itself, or a parent (e.g. the compose file lives in <repo>/docker).
top() { d="$DIR"; while [ -n "$d" ] && [ "$d" != / ]; do [ -e "$d/.git" ] && { echo "$d"; return 0; }; d="$(dirname "$d")"; done; return 0; }
# A folder owned by another user (e.g. files made inside a Docker container): git refuses it ("dubious
# ownership") for every command, also the deploy script's git pull. Mark just this folder as safe for the SSH user.
trust() {
  if git -C "$1" rev-parse --git-dir 2>&1 | grep -q 'dubious ownership'; then
    git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$1" || git config --global --add safe.directory "$1"
    echo ">>> $1 belongs to user $(ls -ld "$1" | awk '{print $3}'), not $(id -un): marked as safe for git (git config --global safe.directory) — no owner changed"
  fi
}
fetch() { GIT_SSH_COMMAND="$(gssh)" git fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"; }
report() {
  out branch "$(git symbolic-ref -q --short HEAD || echo detached)"
  out commit "$(git rev-parse -q --verify HEAD 2>/dev/null || true)"
  out remote_commit "$(git rev-parse -q --verify "refs/remotes/origin/$BRANCH" 2>/dev/null || true)"
  out behind "$(git rev-list --count "HEAD..refs/remotes/origin/$BRANCH" 2>/dev/null || true)"
  out changed "$(git status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')"
}
command -v git >/dev/null 2>&1 || { out state no_git_tool; exit 0; }
${
  mode === 'check'
    ? `[ -d "$DIR" ] || { out state missing; exit 0; }
G="$(top)"
[ -n "$G" ] || { out state not_git; out files "$(ls -A "$DIR" 2>/dev/null | wc -l | tr -d ' ')"; exit 0; }
cd "$G" || { out state error; out error "cannot open $G"; exit 0; }
out top "$G"
out remote "$(git config -f .git/config --get remote.origin.url 2>/dev/null || true)"
if err="$(fetch 2>&1)"; then out state ok
elif printf %s "$err" | grep -q 'dubious ownership'; then out state unsafe_owner; out error "the folder belongs to user $(ls -ld . | awk '{print $3}'), git refuses it for $(id -un)"
else out state no_access; out error "$(printf %s "$err" | tail -n 3)"; fi
report`
    : `set -e
G="$(top)"
if [ -n "$G" ]; then
  cd "$G"
  trust "$G"
  OLD="$(git remote get-url origin 2>/dev/null || true)"
  if [ -z "$OLD" ]; then git remote add origin "$URL"; echo ">>> origin set to $URL"
  elif [ "$OLD" != "$URL" ]; then git remote set-url origin "$URL"; echo ">>> origin was $OLD — now $URL"; fi
  if [ -n "$SSHC" ]; then git config core.sshCommand "$SSHC"; echo '>>> git uses the Switchboard deploy key for this repository'; fi
  fetch
  git config "branch.$BRANCH.remote" >/dev/null 2>&1 || { git config "branch.$BRANCH.remote" origin; git config "branch.$BRANCH.merge" "refs/heads/$BRANCH"; }
elif [ -z "$(ls -A "$DIR" 2>/dev/null)" ]; then
  echo ">>> $DIR is empty: clone $URL (branch $BRANCH)"
  GIT_SSH_COMMAND="$(gssh)" git clone -q --branch "$BRANCH" "$URL" "$DIR"
  cd "$DIR"; G="$DIR"
  trust "$G"
  [ -z "$SSHC" ] || git config core.sshCommand "$SSHC"
  out done cloned
else
  echo ">>> $DIR already has files but no Git: connect it to $URL ($BRANCH) — no file is changed"
  cd "$DIR"; G="$DIR"
  git init -q
  trust "$G"
  git symbolic-ref HEAD "refs/heads/$BRANCH"
  git remote add origin "$URL"
  [ -z "$SSHC" ] || git config core.sshCommand "$SSHC"
  fetch
  # Attaching keeps every file as it is, so it only works when the folder already holds a copy of the code.
  # A folder with only the built site (index.html, assets… no package.json) would never get the code: refuse, and undo the git init.
  TOTAL="$(git ls-tree -r --name-only "refs/remotes/origin/$BRANCH" | wc -l | tr -d ' ')"
  HAVE="$(git ls-tree -r --name-only "refs/remotes/origin/$BRANCH" | while IFS= read -r f; do [ -e "$f" ] && echo x; done | wc -l | tr -d ' ')"
  if [ $((HAVE * 2)) -lt "$TOTAL" ]; then
    rm -rf "$DIR/.git"
    echo "$DIR is not a copy of the code: only $HAVE of the $TOTAL files of $BRANCH are in it (a folder with just the built site?). Nothing was changed. Use an empty folder for the code instead (e.g. $DIR-src): Switchboard clones the repository into it, and the website can then serve its build folder (dist)." >&2
    exit 1
  fi
  git reset -q "refs/remotes/origin/$BRANCH"
  git config "branch.$BRANCH.remote" origin; git config "branch.$BRANCH.merge" "refs/heads/$BRANCH"
  out done attached
fi
out state ok
out top "$G"
out remote "$URL"
report`
}`;
}

const parseGit = (stdout) => {
  const o = {};
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^SB_GIT (\w+)=(.*)$/);
    if (m) o[m[1]] = m[2].trim();
  }
  for (const k of ['behind', 'changed', 'files']) if (o[k] !== undefined && o[k] !== '') o[k] = Number(o[k]);
  return o;
};

/** Git state of one deployment, as last seen (kept in the root project's ci_state.git, by deployment id). */
export const gitStates = (root) => ci(root).git || {};
function saveGit(root, dep, st) {
  const fresh = getProject(root.id);
  const git = { ...gitStates(fresh), [dep.id]: { ...st, server_id: dep.server_id, project_id: dep.project_id, dir: dep.app_dir || '', at: now() } };
  // Forget deployments that are gone.
  const live = new Set(ciProjects(fresh).flatMap((p) => deploymentsOf(p.id).map((d) => String(d.id))));
  for (const k of Object.keys(git)) if (!live.has(k)) delete git[k];
  saveCi(root.id, { git });
}

export async function checkGit(conn, root, project, dep) {
  if (!dep.app_dir) return { state: 'no_dir' };
  const branch = project.git_branch || root.git_branch || 'main';
  const r = await runRemote(null, conn, shellScript(gitScript({ mode: 'check', dir: dep.app_dir, url: gh.gitUrl(root.git_repo), branch, sshCmd: gitSshCommand(root.git_repo) })), { timeout: 3 * 60000, quiet: true, okCodes: [0, 1, 2, 126, 127, 128] });
  const st = parseGit(r.stdout);
  if (!st.state) return { state: 'error', error: (r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ') || `exit ${r.code}` };
  return st;
}

/** Make the app folder a checkout of the repo that this server can pull — or leave it if it already is one. */
export async function connectGit(ctx, conn, server, root, project, dep) {
  const where = `${server.name}:${dep.app_dir || '?'}${project.id === root.id ? '' : ` (${project.name})`}`;
  if (!dep.app_dir) {
    ctx.warn(`${server.name}: no app folder set for ${project.name} — set it on the project's Servers tab, then connect again`);
    saveGit(root, dep, { state: 'no_dir' });
    return { state: 'no_dir' };
  }
  if (!root.git_repo) throw new Error('Set the GitHub repository first');
  const branch = project.git_branch || root.git_branch || 'main';
  ctx.step(`Git in ${where}`);
  const before = await checkGit(conn, root, project, dep);
  const sameRepo = !before.remote || repoOfUrl(before.remote) === repoOfUrl(root.git_repo);
  if (before.state === 'ok' && sameRepo) {
    ctx.log(`${where} is already a Git checkout of ${root.git_repo}${before.top && before.top !== dep.app_dir.replace(/\/+$/, '') ? ` (repository folder ${before.top})` : ''} and can pull — left as it is`);
    saveGit(root, dep, before);
    return before;
  }
  if (before.top && before.top !== dep.app_dir.replace(/\/+$/, '') && !sameRepo) {
    ctx.warn(`${dep.app_dir} is inside ${before.top}, a checkout of ${before.remote || 'another repository'} — not ${root.git_repo}. Left as it is: check the app folder (Servers tab).`);
    saveGit(root, dep, { ...before, state: 'other_repo' });
    return before;
  }
  if (before.state === 'unsafe_owner' && !sameRepo) {
    ctx.warn(`${where} is a checkout of ${before.remote}, not ${root.git_repo} — left as it is. Is the app folder right? (Servers tab → the server → folder)`);
    saveGit(root, dep, { ...before, state: 'other_repo' });
    return before;
  }
  if (before.state === 'ok') {
    // It works, but with another repository: don't silently re-point a working setup.
    ctx.warn(`${where} pulls from ${before.remote}, not ${root.git_repo} — left as it is. Change the repository in CI/CD settings, or fix the folder's origin by hand.`);
    saveGit(root, dep, { ...before, state: 'other_repo' });
    return before;
  }
  ctx.log(
    {
      missing: `${dep.app_dir} does not exist yet — it will be created and the repository cloned into it`,
      not_git: before.files ? `${dep.app_dir} has ${before.files} files but is not a Git checkout — it is connected to the repository without changing any file` : `${dep.app_dir} is empty — the repository is cloned into it`,
      unsafe_owner: `${dep.app_dir} is a Git checkout, but ${before.error || 'it belongs to another user'} — marking it as safe`,
      no_access: `${dep.app_dir} is a Git checkout but cannot pull${before.error ? ` (${before.error})` : ''} — giving it access`,
      no_git_tool: 'git is not installed — installing it',
    }[before.state] || `State: ${before.state}${before.error ? ` — ${before.error}` : ''}`,
  );
  // Root part: git installed, the folder exists and belongs to the SSH user (it runs the deploy script).
  const user = appUser(server);
  await runRemote(
    ctx,
    conn,
    asRoot(
      server,
      `set -e
if ! command -v git >/dev/null 2>&1; then
  echo '>>> Installing git'
  if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-get update -q >/dev/null && apt-get install -y -q git ca-certificates >/dev/null
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q git >/dev/null
  elif command -v yum >/dev/null 2>&1; then yum install -y -q git >/dev/null
  elif command -v apk >/dev/null 2>&1; then apk add -q git; fi
fi
D=${shq(dep.app_dir)}
[ -e "$D" ] || { mkdir -p "$D"; chown ${shq(user)}: "$D"; echo ">>> Created $D (owner ${user})"; }${
        before.state === 'not_git' && user !== 'root'
          ? `
# A folder made with sudo (e.g. a Vue/Nuxt site outside Docker) belongs to root: the SSH user can't add .git
# or pull into it. Hand a root-owned folder to the SSH user (file contents stay the same); never take one from another user.
if ! su ${shq(user)} -s /bin/sh -c ${shq(`test -w ${shq(dep.app_dir)}`)}; then
  O="$(stat -c %U "$D")"
  if [ "$O" = root ]; then
    chown -R ${shq(user)}: "$D"
    echo ">>> $D belonged to root and ${user} could not write it: owner changed to ${user} (no file content changed)"
  else
    echo "$D belongs to user $O and ${user} cannot write it. Give ${user} write access (e.g. sudo chown -R ${user}: $D), then try again." >&2
    exit 1
  fi
fi`
          : ''
      }`,
    ),
    { timeout: 10 * 60000 },
  );
  if (gh.hasToken()) await ensureRepoAccess(ctx, conn, server, root.git_repo, { addKey: gh.addDeployKey });
  else if (gitSshCommand(root.git_repo)) ctx.warn('No GitHub token: Switchboard cannot add a deploy key — the server must already be allowed to read the repository');
  try {
    // quiet: the SB_GIT lines are for Switchboard; the readable ">>>" lines go to the log.
    const r = await runRemote(ctx, conn, shellScript(gitScript({ mode: 'connect', dir: dep.app_dir, url: gh.gitUrl(root.git_repo), branch, sshCmd: gitSshCommand(root.git_repo) })), { timeout: 30 * 60000, quiet: true });
    for (const line of String(r.stdout).split('\n')) if (line.startsWith('>>> ')) ctx.log(line.slice(4));
    const st = parseGit(r.stdout);
    saveGit(root, dep, st);
    const head = st.commit ? `${st.branch} @ ${st.commit.slice(0, 7)}` : st.branch;
    ctx.log(`${where} is connected to ${root.git_repo} — ${head}${st.behind ? `, ${st.behind} commit(s) behind origin/${branch}` : ', up to date with GitHub'}`);
    if (st.done === 'attached' && st.changed) ctx.warn(`${st.changed} file(s) in ${dep.app_dir} differ from ${branch} on GitHub (kept as they are). If your deploy script runs "git pull", local edits to tracked files can block it — "git status" in that folder shows them.`);
    if (st.branch && st.branch !== branch && st.branch !== 'detached') ctx.warn(`${dep.app_dir} has branch ${st.branch} checked out, the project deploys ${branch}`);
    return st;
  } catch (e) {
    for (const line of String(e.result?.stdout || '').split('\n')) if (line.startsWith('>>> ')) ctx.log(line.slice(4));
    const err = `${e.result?.stderr || ''}\n${e.result?.stdout || ''}`.trim().split('\n').slice(-3).join(' ');
    saveGit(root, dep, { state: 'no_access', error: err || e.message });
    throw e;
  }
}

/** After a deploy: remember which commit this server is on now (shown in Servers and Git and the commit list). */
export function noteGitCommit(project, dep, sha) {
  const root = rootOf(project);
  const st = gitStates(root)[dep.id] || {};
  saveGit(root, dep, { ...st, state: st.state && st.state !== 'ok' && st.state !== 'other_repo' ? st.state : st.state || 'ok', commit: sha, behind: st.remote_commit === sha ? 0 : st.behind });
}

/** Read-only look at every server of the project (in parallel). */
export async function checkAllGit(root) {
  await Promise.all(
    ciServers(root).map(async (server) => {
      const deps = depsOn(root, server);
      if (!deps.length) return;
      let conn;
      try {
        conn = await connectTo(null, server);
        for (const { project, dep } of deps) saveGit(root, dep, await checkGit(conn, root, project, dep).catch((e) => ({ state: 'error', error: e.message })));
      } catch (e) {
        for (const { dep } of deps) saveGit(root, dep, { state: 'unreachable', error: e.message });
      } finally {
        conn?.end();
      }
    }),
  );
  bus.emit('state', { projectId: root.id });
  return gitStates(getProject(root.id));
}

/** Connect one server (e.g. a backup server added later) to the repo + CI/CD, optionally deploy the newest commit. */
defineJob('ci-connect', async (ctx, p) => {
  const root = rootOf(getProject(ctx.job.project_id));
  if (!root.git_repo) throw new Error('Set the GitHub repository first');
  const server = getServer(Number(p.server));
  if (!server) throw new Error('Server not found');
  const deps = depsOn(root, server);
  if (!deps.length) throw new Error(`${server.name} is not part of ${root.name} — add it to the project first`);
  // p.runner: the self-hosted runner was asked for (even when CI/CD isn't on or Switchboard deploys).
  const runner = !!p.runner || (root.ci_enabled && root.ci_mode !== 'pull');
  if (p.runner && !gh.hasToken()) throw new Error('A self-hosted runner needs a GitHub token (Settings → GitHub)');
  try {
    if (gh.hasToken()) {
      ctx.step(`Check access to ${root.git_repo}`);
      const r = await gh.getRepo(root.git_repo);
      ctx.log(`${r.full_name} — ${r.private ? 'private' : 'public'}, default branch ${r.default_branch}`);
    } else ctx.warn('No GitHub token (Settings → GitHub): no deploy key, runner or workflow update — only the folder is connected');
    await setupServers(ctx, root, { runners: runner && gh.hasToken(), git: true, only: server.id });
    if (runner && gh.hasToken() && !ownWorkflow(root) && root.ci_mode !== 'pull') {
      ctx.step('Commit the workflow file (adds this server to the deploy jobs)');
      await commitWorkflow(ctx, root);
    } else if (runner && ownWorkflow(root)) ctx.log(`Your own workflow ${root.ci_workflow_path} decides what runs — use runs-on: [self-hosted, ${slugify(server.name)}] for this server`);
    const how = !root.ci_enabled ? 'CI/CD is not on for this project: deploys run when you click Deploy (or turn on CI/CD)' : runner ? 'every push now also deploys here, through the GitHub runner' : 'Switchboard now deploys every new commit here too';
    ctx.log(`${server.name} is connected — ${how}`);
    if (p.deploy) {
      for (const { project, dep } of deps) {
        if (!String(project.deploy_script || '').trim()) {
          ctx.warn(`${project.name} has no deploy script (Settings → Deploy script) — not deployed`);
          continue;
        }
        const sha = gh.hasToken() ? await gh.branchSha(root.git_repo, project.git_branch || 'main').catch(() => null) : null;
        const job = enqueue({ type: 'deploy', title: `Deploy ${project.name} on ${server.name}${sha ? ` @ ${sha.slice(0, 7)}` : ''} (just connected to Git)`, projectId: project.id, params: { deployment: dep.id, ...(sha ? { commit: sha } : {}) }, user: ctx.user });
        ctx.log(`Deploy of ${project.name} on ${server.name} queued (job #${job.id})`);
      }
    }
    logEvent('success', `${root.name}: ${server.name} connected to ${root.git_repo}${runner ? ' (runner + workflow)' : ''}`, { projectId: root.id, serverId: server.id, jobId: ctx.id, user: ctx.user });
  } catch (e) {
    alert('error', `${root.name}: connecting ${server.name} to Git FAILED — ${e.message}`, { projectId: root.id, jobId: ctx.id, link: `#/projects/${root.id}` });
    throw e;
  } finally {
    bus.emit('state', { projectId: root.id });
  }
});

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
    await setupServers(ctx, root, { runners: !pull, git: true });
    const tests = root.ci_test_on !== 'none' && String(root.ci_test_cmd || '').trim();
    if (p.commit !== false && (!pull || tests)) {
      ctx.step(ownWorkflow(root) ? `Workflow: your own ${root.ci_workflow_path}` : pull ? 'Commit the workflow file (tests only — Switchboard deploys)' : 'Commit the workflow file');
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
OU="$(stat -c %U .runner 2>/dev/null || echo ${RUNNER_USER})"
if [ -f runner.pid ]; then kill -- "-$(cat runner.pid)" 2>/dev/null || kill "$(cat runner.pid)" 2>/dev/null || true; [ "$OU" != ${RUNNER_USER} ] || pkill -u ${RUNNER_USER} 2>/dev/null || true; fi
[ "$OU" != root ] || export RUNNER_ALLOW_RUNASROOT=1
[ -z "$TOKEN" ] || runuser -u "$OU" -- env RUNNER_ALLOW_RUNASROOT="\${RUNNER_ALLOW_RUNASROOT:-}" ./config.sh remove --token "$TOKEN" || echo '(could not unregister — remove it in GitHub → Settings → Actions → Runners)'
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
  const runs = await gh.listRuns(root.git_repo, { perPage: 30, file: workflowFileOf(root) });
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
    // The live server may wait (click / quiet time): the others are deployed now.
    const plan = splitForPolicy(p, root, { commit: sha });
    if (plan.now.length) enqueue({ type: 'deploy', title: `Deploy ${p.name} @ ${sha.slice(0, 7)} (new commit on ${p.git_branch})${plan.held ? ` — ${plan.held.server_name} later` : ''}`, projectId: p.id, params: { deployments: plan.now.map((d) => d.id), commit: sha }, user: 'github' });
    logEvent('info', `${p.name}: new commit ${sha.slice(0, 7)} on ${p.git_branch} — deploying${plan.now.length ? ` on ${plan.now.map((d) => d.server_name).join(', ')}` : ''}${plan.held ? `; ${plan.held.server_name} (live) waits` : ''}`, { projectId: p.id });
  }
  saveCi(root.id, { deployed });
}

/** Runner mode with Switchboard's workflow: the live server is not in it — hold it after the run of a new commit passes. */
function holdAfterRuns(root, runs) {
  const held = { ...(ci(root).held_from || {}) };
  let changed = false;
  for (const p of ciProjects(root)) {
    if (!liveWaits(root, p)) continue;
    const r = runs.filter((x) => x.event !== 'pull_request' && x.head_branch === (p.git_branch || 'main') && x.status === 'completed').sort((a, b) => b.id - a.id)[0];
    if (!r || held[p.slug] === r.head_sha) continue;
    if (Date.parse(r.created_at) < Date.parse(ci(root).policy_at || 0)) continue; // from before "the live server waits" was turned on
    held[p.slug] = r.head_sha;
    changed = true;
    if (r.conclusion !== 'success') continue; // nothing to bring to the live server
    splitForPolicy(p, root, { commit: r.head_sha });
  }
  if (changed) saveCi(root.id, { held_from: held });
}

/* ------------------------------------------------------------------ your own workflow asks Switchboard which servers */
/**
 * Your own workflow reads the repository variable SWITCHBOARD_SERVERS to know where to deploy after you approve:
 *   { branch, now: [servers deployed right away — standby first, live last unless it waits],
 *     live: the live server when it waits for you (else null), servers: every server of the project }
 * Each server: { name, label (its runner label = its name as a slug), app_dir, live }.
 * The workflow then marks the live server with a job named "Live server waits…"; Switchboard sees it and holds the live
 * server (Deploy now / quiet time), which starts the same workflow again for that server only (deploy_sha + deploy_to).
 */
export const SERVERS_VAR = 'SWITCHBOARD_SERVERS';
export const HOLD_JOB_RE = /^live server waits\b/i;
const livePolicy = (root) => (POLICIES.includes(root.ci_live_policy) ? root.ci_live_policy : 'now');

export function serversPlan(root) {
  const deps = deploymentsOf(root.id);
  const live = deps.find((d) => d.id === root.active_deployment_id) || null;
  const entry = (d) => ({ name: d.server_name, label: slugify(getServer(d.server_id)?.name || d.server_name), app_dir: d.app_dir || '', live: d.id === live?.id });
  const standby = deps.filter((d) => d !== live);
  // One server only: there is nothing to try first, so it is deployed after you approve.
  const waits = !!live && standby.length > 0 && livePolicy(root) !== 'now';
  return {
    branch: root.git_branch || 'main',
    now: [...standby, ...(live && !waits ? [live] : [])].map(entry),
    live: waits ? entry(live) : null,
    servers: deps.map(entry),
  };
}

async function publishServers(root) {
  const value = JSON.stringify(serversPlan(root));
  const st = ci(root);
  if (st.servers_var === value && !st.servers_var_error) return;
  try {
    await gh.setVariable(root.git_repo, SERVERS_VAR, value);
    saveCi(root.id, { servers_var: value, servers_var_error: null, servers_var_at: now() });
  } catch (e) {
    saveCi(root.id, { servers_var_error: `Could not save the repository variable ${SERVERS_VAR}: ${e.message}${e.status === 403 ? ' — give the GitHub token "Variables: read and write" on this repository' : ''}` });
  }
}

/** Own workflow: a run whose "Live server waits…" job passed → hold the live server for that commit. */
async function holdFromOwnRuns(root, runs) {
  const branch = root.git_branch || 'main';
  const st = ci(root);
  const last = Number(st.hold_checked_run || 0);
  const done = runs.filter((r) => r.status === 'completed' && r.conclusion === 'success' && r.head_branch === branch && r.event !== 'pull_request').sort((a, b) => a.id - b.id);
  if (!done.length) return;
  // First time: start from now (don't hold for runs from before this was turned on).
  if (!last) return saveCi(root.id, { hold_checked_run: done.at(-1).id });
  for (const r of done.filter((x) => x.id > last)) {
    const jobs = await gh.listRunJobs(root.git_repo, r.id);
    if (jobs.some((j) => HOLD_JOB_RE.test(j.name || '') && j.conclusion === 'success')) {
      const live = deploymentsOf(root.id).find((d) => d.id === root.active_deployment_id);
      if (live) {
        const policy = livePolicy(root);
        const runAt = policy === 'quiet' ? nextQuietTime(root.ci_quiet_time) : null;
        holdDeploy({ project: root, dep: live, commit: r.head_sha, runAt, reason: policy === 'quiet' ? 'quiet time' : 'live server waits', user: 'github', via: 'workflow' });
        alert('info', `${root.name}: commit ${r.head_sha.slice(0, 7)} is on the other servers — ${live.server_name} (live) waits for you. CI/CD tab → Deploy now`, { projectId: root.id, link: `#/projects/${root.id}` });
      }
    }
    saveCi(root.id, { hold_checked_run: r.id });
  }
}

/**
 * Deploy one commit to one server of the project: your own workflow (for that server only), else Switchboard's
 * deploy over SSH. A held deploy of that server is dropped (this replaces it). Returns the Switchboard job or null.
 */
export async function deployCommitTo(project, dep, sha, { user = 'system', why = '' } = {}) {
  run('DELETE FROM held_deploys WHERE deployment_id = ?', dep.id);
  const root = rootOf(project);
  if (ownWorkflow(root)) {
    await startWorkflowDeploy(project, dep, sha, { user, why });
    bus.emit('state', { projectId: project.id });
    return null;
  }
  if (!String(project.deploy_script || '').trim()) throw new Error(`${project.name} has no deploy script yet (Settings → Deploy script)`);
  bus.emit('state', { projectId: project.id });
  return enqueue({ type: 'deploy', title: `Deploy ${project.name} @ ${dep.server_name} @ ${sha.slice(0, 7)}${why ? ` (${why})` : ''}`, projectId: project.id, params: { deployment: dep.id, commit: sha }, user });
}

/** Start your own workflow for one server and one commit (the images of that commit are already built). */
export async function startWorkflowDeploy(project, dep, sha, { user = 'system', why = '' } = {}) {
  const root = rootOf(project);
  if (!ownWorkflow(root) || !root.git_repo) throw new Error('This project does not use its own workflow file');
  if (!/^[0-9a-f]{7,40}$/.test(String(sha || ''))) throw new Error('No commit to deploy');
  const label = slugify(getServer(dep.server_id)?.name || dep.server_name);
  await gh.dispatchWorkflow(root.git_repo, project.git_branch || root.git_branch || 'main', workflowFileOf(root), { deploy_sha: sha, deploy_to: label });
  logEvent('info', `${project.name}: ${dep.server_name} — GitHub deploys commit ${sha.slice(0, 7)} now${why ? ` (${why})` : ''}`, { projectId: project.id, user });
  activeCache.delete(root.id);
  setTimeout(() => pollProject(root.id).catch(() => {}), 5000);
}

export async function pollProject(id) {
  const root = rootOf(getProject(id));
  if (!root?.git_repo || !gh.hasToken()) return;
  try {
    const runs = await pollRuns(root);
    if (root.ci_mode === 'pull') await autoDeploy(root, runs);
    else {
      if (!ownWorkflow(root)) holdAfterRuns(root, runs);
      else {
        await publishServers(root);
        await holdFromOwnRuns(root, runs);
      }
      if (root.preview_server_id) await syncPreviews(root, runs);
    }
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

/* ------------------------------------------------------------------ live view of one run */
const liveCache = new Map(); // run id → { at, data }: several open viewers share one GitHub call
const GATE_JOB_RE = /^(approve|choose)\b/i;
const T = (x) => (x ? Date.parse(x) : null);

/** A run with its jobs and steps; each job on a self-hosted runner is matched to the project's server. */
export async function liveRun(root, runId) {
  const hit = liveCache.get(runId);
  if (hit && Date.now() - hit.at < 2500) return hit.data;
  const [run, jobs] = await Promise.all([gh.getRun(root.git_repo, runId), gh.listRunJobs(root.git_repo, runId)]);
  const servers = ciServers(root);
  const labelsOf = (j) => (Array.isArray(j.labels) ? j.labels : String(j.labels || '').split(',')).map((l) => String(l?.name ?? l).trim().toLowerCase()).filter(Boolean);
  const serverOf = (j) => {
    const labels = labelsOf(j);
    // The approval job only waits on a server's runner; it does not deploy there.
    if (GATE_JOB_RE.test(j.name || '')) return null;
    if (!labels.includes('self-hosted') && !j.runner_name?.startsWith('sb-')) return null;
    return servers.find((s) => j.runner_name === runnerLabel(s) || labels.includes(runnerLabel(s).toLowerCase()) || labels.includes(slugify(s.name))) || null;
  };
  const data = {
    run: {
      id: run.id,
      number: run.run_number,
      title: String(run.display_title || run.head_commit?.message || '').split('\n')[0].slice(0, 200),
      event: run.event,
      branch: run.head_branch,
      sha: run.head_sha,
      actor: run.actor?.login || run.triggering_actor?.login || '',
      status: run.status,
      conclusion: run.conclusion,
      html_url: run.html_url,
      created_at: run.created_at,
      started_at: run.run_started_at || run.created_at,
      updated_at: run.updated_at,
    },
    jobs: jobs.map((j) => {
      const s = serverOf(j);
      const labels = labelsOf(j);
      return {
        id: j.id,
        name: j.name,
        status: j.status,
        conclusion: j.conclusion,
        started_at: j.started_at,
        completed_at: j.completed_at,
        html_url: j.html_url,
        runner: j.runner_name || '',
        where: s ? 'server' : labels.includes('self-hosted') ? 'self-hosted' : 'github',
        hold: HOLD_JOB_RE.test(j.name || ''),
        server: s ? { id: s.id, name: s.name } : null,
        steps: (j.steps || []).map((x) => ({ number: x.number, name: x.name, status: x.status, conclusion: x.conclusion, started_at: x.started_at, completed_at: x.completed_at })),
      };
    }).sort((a, b) => (T(a.started_at) ?? 9e15) - (T(b.started_at) ?? 9e15) || a.id - b.id),
    servers: servers.map((s) => ({ id: s.id, name: s.name, label: slugify(s.name) })),
    // Where this commit can still go: the project's servers, which got it in this run, and why the live one did
    // (or did not) wait — so the run view always has a button to deploy it.
    targets: deploymentsOf(root.id).map((d) => ({
      deployment: d.id,
      server_id: d.server_id,
      name: d.server_name,
      live: d.id === root.active_deployment_id,
      got: jobs.some((j) => !HOLD_JOB_RE.test(j.name || '') && !GATE_JOB_RE.test(j.name || '') && j.conclusion === 'success' && serverOf(j)?.id === d.server_id),
    })),
    own_workflow: ownWorkflow(root),
    waits: (() => {
      const st = ci(root);
      const holdJob = jobs.find((j) => HOLD_JOB_RE.test(j.name || ''));
      return {
        policy: livePolicy(root),
        servers_var_at: st.servers_var_at || null,
        servers_var_error: st.servers_var_error || null,
        hold_job: holdJob ? holdJob.conclusion || holdJob.status : null,
        var_after_run: !st.servers_var_at || Date.parse(st.servers_var_at) > Date.parse(run.run_started_at || run.created_at),
      };
    })(),
    // Servers that wait for you with this run's commit (Deploy now).
    held: all('SELECT h.id, h.run_at, h.via, d.server_id FROM held_deploys h JOIN deployments d ON d.id = h.deployment_id WHERE h.commit_sha = ? AND (h.project_id = ? OR h.project_id IN (SELECT id FROM projects WHERE parent_id = ?))', run.head_sha, root.id, root.id).map((h) => ({ ...h, server_name: getServer(h.server_id)?.name || '' })),
    at: new Date().toISOString(),
  };
  liveCache.set(runId, { at: Date.now(), data });
  for (const [k, v] of liveCache) if (Date.now() - v.at > 60000) liveCache.delete(k);
  // Keep the runs list in step with what the viewer sees.
  const row = get('SELECT id, status FROM ci_runs WHERE project_id = ? AND run_id = ?', root.id, run.id);
  if (row && (row.status !== run.status || run.status === 'completed')) update('ci_runs', row.id, { status: run.status, conclusion: run.conclusion, updated_at: run.updated_at });
  return data;
}

/**
 * Every run of the repo that is not finished yet (any workflow, not just the tracked one), with the servers of
 * this project its jobs run on and the step running now. Shared by all viewers for a few seconds.
 */
const activeCache = new Map(); // project id → { at, data }
export async function activeRuns(root) {
  const hit = activeCache.get(root.id);
  if (hit && Date.now() - hit.at < 4000) return hit.data;
  const runs = await gh.listActiveRuns(root.git_repo);
  const data = await Promise.all(
    runs.slice(0, 10).map(async (r) => {
      const live = await liveRun(root, r.id).catch(() => null);
      const jobs = live?.jobs || [];
      const step = jobs.flatMap((j) => j.steps.filter((s) => s.status === 'in_progress').map((s) => `${j.name}: ${s.name}`))[0] || '';
      const servers = new Map();
      for (const j of jobs) if (j.server) servers.set(j.server.id, { id: j.server.id, name: j.server.name, status: j.status, conclusion: j.conclusion });
      return {
        run_id: r.id,
        run_number: r.run_number,
        workflow: r.name || '',
        title: String(r.display_title || r.head_commit?.message || '').split('\n')[0].slice(0, 200),
        event: r.event,
        branch: r.head_branch,
        sha: r.head_sha,
        actor: r.actor?.login || r.triggering_actor?.login || '',
        status: r.status,
        html_url: r.html_url,
        started_at: r.run_started_at || r.created_at,
        jobs: { total: jobs.length, done: jobs.filter((j) => j.status === 'completed').length },
        step,
        servers: [...servers.values()],
      };
    }),
  );
  activeCache.set(root.id, { at: Date.now(), data });
  return data;
}
export const forgetActive = (root, runId) => {
  activeCache.delete(root.id);
  liveCache.delete(runId);
};

/** Live runner status from GitHub (online / offline / busy), best effort. */
export async function runnerStatus(repo) {
  try {
    const list = await gh.listRunners(repo);
    return Object.fromEntries(list.map((r) => [r.name, { status: r.status, busy: !!r.busy }]));
  } catch {
    return null;
  }
}

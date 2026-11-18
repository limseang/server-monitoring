import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getProject, getServer, parseJSON } from '../models.js';
import { gitUrl } from '../github.js';
import { asRoot, runRemote, shq } from './remote.js';

/**
 * Project templates and the switchboard-helper that runs them on a server.
 * Files on the server:
 *   /usr/local/bin/switchboard-helper               (src/remote/switchboard-helper.sh)
 *   /etc/switchboard/templates/<template>/          Dockerfile, Dockerfile.dockerignore, compose-<db>.yml
 *   /etc/switchboard/projects/<slug>.conf           project settings (shell variables)
 *   /etc/switchboard/projects/<slug>.deploy.sh      the project's deploy script
 */

export const HELPER_VERSION = '5';
export const HELPER = '/usr/local/bin/switchboard-helper';
export const EDGE_IMAGE = 'nginx:1.27-alpine';
const REMOTE_DIR = path.join(config.root, 'src/remote');

export const TEMPLATES = {
  laravel: {
    label: 'Laravel (PHP 8.4)',
    hint: 'PHP-FPM + nginx image, queue worker, scheduler, Redis and a database. Migrations run on every deploy.',
    dbs: ['mysql', 'postgres'],
    port: 8080,
    health: '/up',
    tests: 'cp .env.example .env\ncomposer install --no-interaction --prefer-dist --no-progress\nphp artisan key:generate\nphp artisan test',
  },
  node: {
    label: 'Node.js / Nuxt',
    hint: 'npm ci + npm run build, then Nuxt (.output/server) or "npm start" on port 3000.',
    dbs: ['none', 'mysql', 'postgres'],
    port: 3000,
    health: '/',
    tests: 'npm ci\nnpm test --if-present',
  },
  compose: {
    label: 'Docker Compose (the repo\'s own file)',
    hint: 'For a repo that already has a docker-compose.yml (like Switchboard itself): it is cloned and started with docker compose up -d --build. Give the port the app listens on.',
    dbs: ['none'],
    port: null,
    health: '/',
    tests: '',
    own: true, // uses the repo's own Dockerfile / compose file — Switchboard adds none
  },
  static: {
    label: 'Static site / Vue SPA',
    hint: 'npm run build and serve dist/ with nginx (or plain HTML files as they are).',
    dbs: ['none'],
    port: 80,
    health: '/',
    tests: 'if [ -f package.json ]; then npm ci && npm run build; fi',
  },
};

export const DB_NAMES = { none: 'No database', mysql: 'MySQL 8.4', postgres: 'PostgreSQL 17' };

/* ------------------------------------------------------------------ compose files */
function dbService(db) {
  if (db === 'mysql') {
    return `  db:
    image: mysql:8.4
    environment:
      MYSQL_DATABASE: \${DB_DATABASE}
      MYSQL_USER: \${DB_USERNAME}
      MYSQL_PASSWORD: \${DB_PASSWORD}
      MYSQL_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes: [db:/var/lib/mysql]
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -p$$MYSQL_ROOT_PASSWORD --silent"]
      interval: 5s
      timeout: 5s
      retries: 40
    restart: unless-stopped
`;
  }
  if (db === 'postgres') {
    return `  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: \${DB_DATABASE}
      POSTGRES_USER: \${DB_USERNAME}
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes: [db:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 5s
      timeout: 5s
      retries: 40
    restart: unless-stopped
`;
  }
  return '';
}

export function composeFile(template, db) {
  const t = TEMPLATES[template];
  const head = `# Made by Switchboard (template: ${t.label}${db !== 'none' ? `, ${DB_NAMES[db]}` : ''}).
# Edit freely — Switchboard never overwrites it. Values come from .env (APP_PORT = local port the web proxy uses).
name: \${COMPOSE_PROJECT_NAME}

x-app: &app
  build: { context: ., dockerfile: .switchboard/Dockerfile }
  image: \${COMPOSE_PROJECT_NAME}-app
  env_file: .env
  restart: unless-stopped
`;
  const dependsDb = db !== 'none' ? '      db: { condition: service_healthy }\n' : '';
  const vols = [];
  let services = '';
  if (template === 'laravel') {
    vols.push('storage');
    services = `  app:
    <<: *app
    environment:
      AUTORUN_ENABLED: "true"
    ports: ["127.0.0.1:\${APP_PORT}:8080"]
    volumes: [storage:/var/www/html/storage/app]
    depends_on:
${dependsDb}      redis: { condition: service_started }
  queue:
    <<: *app
    command: ["php", "/var/www/html/artisan", "queue:work", "--tries=3", "--sleep=3"]
    stop_signal: SIGTERM
    volumes: [storage:/var/www/html/storage/app]
    depends_on: [app]
  scheduler:
    <<: *app
    command: ["php", "/var/www/html/artisan", "schedule:work"]
    stop_signal: SIGTERM
    depends_on: [app]
  redis:
    image: redis:7-alpine
    restart: unless-stopped
`;
  } else {
    services = `  app:
    <<: *app
    ports: ["127.0.0.1:\${APP_PORT}:${t.port}"]
${dependsDb ? `    depends_on:\n${dependsDb}` : ''}`;
  }
  services += dbService(db);
  if (db !== 'none') vols.push('db');
  return `${head}\nservices:\n${services}${vols.length ? `\nvolumes:\n${vols.map((v) => `  ${v}: {}`).join('\n')}\n` : ''}`;
}

/* ------------------------------------------------------------------ fresh app files (no repo yet) */
export function scaffoldFiles(template, name) {
  const gitignore = '.env\nnode_modules/\ndist/\n.output/\n.nuxt/\n';
  if (template === 'static') {
    return {
      '.gitignore': gitignore,
      'index.html': `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}</style></head>
<body><main><h1>${name}</h1><p>Deployed with Switchboard. Replace this page with your site.</p></main></body>
</html>
`,
    };
  }
  if (template === 'node') {
    return {
      '.gitignore': gitignore,
      'package.json': `${JSON.stringify({ name: name.toLowerCase().replace(/[^a-z0-9-]+/g, '-'), private: true, version: '1.0.0', type: 'module', scripts: { start: 'node server.js' } }, null, 2)}\n`,
      'server.js': `// Starter app made by Switchboard — replace with your own (Nuxt, Express, Fastify…).
import http from 'node:http';

const port = Number(process.env.PORT) || 3000;
http
  .createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(req.url === '/up' ? 'ok' : 'Hello from ${name.replace(/'/g, '')}!\\n');
  })
  .listen(port, '0.0.0.0', () => console.log('listening on ' + port));
`,
    };
  }
  return {};
}

/* ------------------------------------------------------------------ install on a server */
const b64 = (s) => Buffer.from(s).toString('base64');
const writeCmd = (file, content, mode = '644') => `printf %s ${shq(b64(content))} | base64 -d > ${shq(`${file}.tmp`)} && chmod ${mode} ${shq(`${file}.tmp`)} && mv ${shq(`${file}.tmp`)} ${shq(file)}`;

/** Install/refresh the helper and every template on a server (as root). */
export async function installHelper(ctx, conn, server) {
  const helper = fs
    .readFileSync(path.join(REMOTE_DIR, 'switchboard-helper.sh'), 'utf8')
    .replaceAll('__VERSION__', HELPER_VERSION)
    .replaceAll('__EDGE_IMAGE__', EDGE_IMAGE);
  const cmds = ['set -e', 'mkdir -p /etc/switchboard/projects /etc/switchboard/ports', 'chmod 700 /etc/switchboard/projects', writeCmd(HELPER, helper, '755')];
  for (const [name, t] of Object.entries(TEMPLATES)) {
    if (t.own) continue;
    const dir = `/etc/switchboard/templates/${name}`;
    cmds.push(`mkdir -p ${dir}`);
    for (const f of ['Dockerfile', 'Dockerfile.dockerignore']) cmds.push(writeCmd(`${dir}/${f}`, fs.readFileSync(path.join(REMOTE_DIR, 'templates', name, f), 'utf8')));
    for (const db of t.dbs) cmds.push(writeCmd(`${dir}/compose-${db}.yml`, composeFile(name, db)));
  }
  // Tools the helper uses (git for checkouts, curl for health checks, ss for ports, runuser for the app user).
  cmds.push(`missing=''; for c in git curl ss openssl runuser; do command -v $c >/dev/null 2>&1 || missing="$missing $c"; done
if [ -n "$missing" ]; then
  echo ">>> Installing:$missing"
  if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-get update -q >/dev/null && apt-get install -y -q git curl iproute2 openssl util-linux ca-certificates >/dev/null
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q git curl iproute openssl util-linux >/dev/null; fi
fi`);
  ctx?.log(`Install switchboard-helper v${HELPER_VERSION} and templates on ${server.name}`);
  await runRemote(ctx, conn, asRoot(server, cmds.join('\n')), { timeout: 10 * 60000 });
}

/** The URL Switchboard / the helper use to check the app on its own server. */
function healthTarget(project) {
  const scheme = project.health_scheme === 'http' ? 'http' : 'https';
  const port = project.health_port ? `:${project.health_port}` : '';
  return { url: `${scheme}://127.0.0.1${port}${project.health_path || '/'}`, host: project.domain || '' };
}

export const projectHosts = (project) => {
  const opts = parseJSON(project.template_opts, {}) || {};
  return [project.domain, ...(opts.extra_hosts || [])].filter(Boolean);
};

/** The server user that owns the app files and runs the deploy script. */
export const appUser = (server) => server.ssh_user || 'root';

export function projectConf(project, dep, server) {
  const opts = parseJSON(project.template_opts, {}) || {};
  const root = project.parent_id ? getProject(project.parent_id) : project;
  const previewZone = parseJSON(root.preview_zone);
  const h = healthTarget(project);
  const vars = {
    SB_SLUG: project.slug,
    SB_NAME: project.name,
    SB_DIR: dep.app_dir || '',
    SB_USER: appUser(server),
    SB_REPO_URL: project.git_repo ? gitUrl(project.git_repo) : '',
    SB_BRANCH: project.git_branch || 'main',
    SB_GIT_SSH: project.git_repo && /^(git@|ssh:)/.test(gitUrl(project.git_repo)) ? `ssh -i ~/.ssh/${keyName(project.git_repo)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` : '',
    SB_TEMPLATE: project.template || '',
    SB_DB: opts.db || 'none',
    SB_ENV: project.env || 'production',
    SB_HOSTS: project.template && !(project.template === 'compose' && !opts.app_port) ? projectHosts(project).join(' ') : '',
    SB_URL: project.domain ? `https://${project.domain}` : '',
    SB_HEALTH_PATH: project.health_path || '/',
    SB_HEALTH_URL: h.url,
    SB_HEALTH_HOST: h.host,
    SB_PREVIEW: root.preview_server_id && root.preview_server_id === server.id && project.id === root.id ? '1' : '0',
    SB_PREVIEW_ZONE: previewZone?.zone_name || '',
    SB_APP_PORT: String(opts.app_port || ''),
  };
  return `# Switchboard project settings — written by Switchboard, don't edit.\n${Object.entries(vars)
    .map(([k, v]) => `${k}=${shq(v)}`)
    .join('\n')}\n`;
}

/** SSH key the server uses to read (or push) the repo: one per repo, GitHub allows a key on one repo only. */
export const keyName = (repo) => `switchboard-${repo.replace(/[^A-Za-z0-9_.-]+/g, '_')}`;

/**
 * Write the project's settings + deploy script to the server. `dep` may be a plain object
 * { app_dir } for a project that is only being previewed there.
 */
export async function pushProjectConf(ctx, conn, server, project, dep) {
  const base = `/etc/switchboard/projects/${project.slug}`;
  const script = String(project.deploy_script || '').trim();
  await runRemote(
    ctx,
    conn,
    asRoot(server, ['set -e', 'mkdir -p /etc/switchboard/projects', writeCmd(`${base}.conf`, projectConf(project, dep, server), '600'), script ? writeCmd(`${base}.deploy.sh`, `${script}\n`, '600') : `rm -f ${shq(`${base}.deploy.sh`)}`].join('\n')),
    { quiet: true },
  );
}

/** Run a helper command as root, output into the job log. */
export const helper = (ctx, conn, server, args, opts = {}) => runRemote(ctx, conn, asRoot(server, `${HELPER} ${args.map(shq).join(' ')}`), { timeout: 45 * 60000, ...opts });

/**
 * Make sure the server can read the GitHub repo over SSH: create its key (once) and add it as
 * a deploy key. `write` = allowed to push (needed once, for the first commit of a new project).
 */
export async function ensureRepoAccess(ctx, conn, server, repo, { write = false, addKey }) {
  if (!/^(git@|ssh:)/.test(gitUrl(repo))) return; // e.g. the test lab clones over git://
  const user = appUser(server);
  const r = await runRemote(
    ctx,
    conn,
    asRoot(
      server,
      `set -e
U=${shq(user)}; D="$(getent passwd "$U" | cut -d: -f6)/.ssh"; K="$D/${keyName(repo)}"
mkdir -p "$D" && chmod 700 "$D" && chown "$U": "$D"
[ -f "$K" ] || runuser -u "$U" -- ssh-keygen -q -t ed25519 -N '' -C ${shq(`switchboard@${server.name}`)} -f "$K"
grep -qs '^github.com ' "$D/known_hosts" || { ssh-keyscan -t ed25519,rsa github.com 2>/dev/null >> "$D/known_hosts"; chown "$U": "$D/known_hosts"; }
cat "$K.pub"`,
    ),
    { quiet: true },
  );
  const pub = r.stdout.trim().split('\n').pop();
  await addKey(repo, `Switchboard · ${server.name}`, pub, { readOnly: !write });
  ctx?.log(`Deploy key of ${server.name} added to ${repo}${write ? ' (with write access, for the first push)' : ' (read-only)'}`);
}

export const serverOf = (dep) => getServer(dep.server_id);

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

export const HELPER_VERSION = '7';
export const HELPER = '/usr/local/bin/switchboard-helper';
export const EDGE_IMAGE = 'nginx:1.27-alpine';
const REMOTE_DIR = path.join(config.root, 'src/remote');

export const TEMPLATES = {
  laravel: {
    label: 'Laravel (PHP 8.4)',
    hint: 'One Docker stack: PHP-FPM + nginx, a database, and (your choice) queue worker, scheduler and Redis. Migrations run on every deploy. Comes with a Makefile: make start, make stop, make logs, make artisan…',
    // Parts you can leave out ("profiles" in the compose file; COMPOSE_PROFILES in .env says which run)
    services: [
      { key: 'queue', label: 'Queue worker', hint: 'Runs jobs in the background (php artisan queue:work)' },
      { key: 'scheduler', label: 'Scheduler', hint: 'Runs your scheduled tasks every minute (php artisan schedule:work)' },
      { key: 'redis', label: 'Redis', hint: 'Fast cache, sessions and queue. Without it the database is used for them.' },
    ],
    dbs: ['mysql', 'postgres'],
    port: 8080,
    health: '/up',
    tests: 'cp .env.example .env\ncomposer install --no-interaction --prefer-dist --no-progress\nphp artisan key:generate\nphp artisan test',
  },
  node: {
    label: 'Node.js / Nuxt (Docker)',
    hint: 'npm ci + npm run build, then Nuxt (.output/server) or "npm start" on port 3000.',
    dbs: ['none', 'mysql', 'postgres'],
    port: 3000,
    health: '/',
    tests: 'if [ -f package-lock.json ]; then npm ci; else npm install; fi\nnpm test --if-present',
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
  frontend: {
    label: 'Front-end, no Docker (Vue / React / Vite)',
    hint: 'Built on the server (npm ci + npm run build), then nginx serves the built folder (dist…) — refreshing a page works. Node.js is installed if missing. No Docker for the app.',
    dbs: ['none'],
    port: null,
    health: '/',
    tests: 'if [ -f package-lock.json ]; then npm ci; else npm install; fi\nnpm run build',
    host: true, // runs on the server itself, not in Docker
  },
  pm2: {
    label: 'Node app with PM2, no Docker (Nuxt / Next / Express)',
    hint: 'Built on the server, then run with PM2 ("npm start", or Nuxt\'s .output) on a local port, with nginx in front. Node.js and PM2 are installed if missing.',
    dbs: ['none'],
    port: null,
    health: '/',
    tests: 'if [ -f package-lock.json ]; then npm ci; else npm install; fi\nnpm test --if-present',
    host: true,
  },
  static: {
    label: 'Static site / Vue SPA (Docker)',
    hint: 'npm run build and serve dist/ with nginx (or plain HTML files as they are).',
    dbs: ['none'],
    port: 80,
    health: '/',
    tests: 'if [ -f package.json ]; then (if [ -f package-lock.json ]; then npm ci; else npm install; fi) && npm run build; fi',
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
${dependsDb}      redis: { condition: service_started, required: false }
  # The parts below run only when their name is in COMPOSE_PROFILES (.env), e.g. COMPOSE_PROFILES=queue,scheduler,redis
  queue:
    <<: *app
    profiles: [queue]
    command: ["php", "/var/www/html/artisan", "queue:work", "--tries=3", "--sleep=3"]
    stop_signal: SIGTERM
    volumes: [storage:/var/www/html/storage/app]
    depends_on: [app]
  scheduler:
    <<: *app
    profiles: [scheduler]
    command: ["php", "/var/www/html/artisan", "schedule:work"]
    stop_signal: SIGTERM
    depends_on: [app]
  redis:
    image: redis:7-alpine
    profiles: [redis]
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
  const pkgName = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  const safe = name.replace(/[<>`$\\]/g, '');
  const gitignore = '.env\nnode_modules/\ndist/\n.output/\n.nuxt/\n.DS_Store\n';
  const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
  const readme = (how) => `# ${safe}\n\nMade with Switchboard. Every push to the main branch can be deployed automatically (project → CI/CD).\n\n## Run it on your computer\n\n${how}\n`;
  if (template === 'frontend') {
    // A real Vite + Vue project: the server installs the packages and runs "npm run build"; nginx serves dist/.
    return {
      '.gitignore': gitignore,
      'README.md': readme('```bash\nnpm install\nnpm run dev      # http://localhost:5173 — changes show at once\nnpm run build    # what the server runs: makes dist/\n```'),
      'package.json': json({
        name: pkgName,
        private: true,
        version: '1.0.0',
        type: 'module',
        scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        dependencies: { vue: '^3.5.13' },
        devDependencies: { vite: '^6.0.7', '@vitejs/plugin-vue': '^5.2.1' },
      }),
      'vite.config.js': `import { defineConfig } from 'vite';\nimport vue from '@vitejs/plugin-vue';\n\nexport default defineConfig({\n  plugins: [vue()],\n});\n`,
      'index.html': `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <link rel="icon" href="/favicon.svg" />\n    <title>${safe}</title>\n  </head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/src/main.js"></script>\n  </body>\n</html>\n`,
      'public/favicon.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#41b883"/><path d="M8 9h4l4 7 4-7h4l-8 14z" fill="#fff"/></svg>\n`,
      'src/main.js': `import { createApp } from 'vue';\nimport App from './App.vue';\nimport './assets/main.css';\n\ncreateApp(App).mount('#app');\n`,
      'src/App.vue': `<script setup>\nimport HelloCard from './components/HelloCard.vue';\n</script>\n\n<template>\n  <main>\n    <HelloCard title="${safe}" />\n  </main>\n</template>\n`,
      'src/components/HelloCard.vue': `<script setup>\nimport { ref } from 'vue';\n\ndefineProps({ title: String });\nconst count = ref(0);\n</script>\n\n<template>\n  <section class="card">\n    <h1>{{ title }}</h1>\n    <p>Deployed with Switchboard. Edit <code>src/App.vue</code>, push, and it goes live.</p>\n    <button @click="count++">Clicked {{ count }} times</button>\n  </section>\n</template>\n`,
      'src/assets/main.css': `body {\n  margin: 0;\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n  font-family: system-ui, sans-serif;\n  background: #0f172a;\n  color: #e2e8f0;\n}\n.card { text-align: center; }\nbutton { font: inherit; padding: 8px 16px; border-radius: 8px; border: 0; background: #41b883; color: #fff; cursor: pointer; }\ncode { background: #1e293b; padding: 2px 6px; border-radius: 4px; }\n`,
    };
  }
  if (template === 'node' || template === 'pm2') {
    return {
      '.gitignore': gitignore,
      'README.md': readme('```bash\nnpm install\nnpm start        # http://localhost:3000 (PORT=4000 npm start for another port)\n```\n\n`/up` answers "ok" — Switchboard uses it as the health check.'),
      'package.json': json({ name: pkgName, private: true, version: '1.0.0', type: 'module', scripts: { start: 'node src/server.js', dev: 'node --watch src/server.js' } }),
      'src/server.js': `// Starter app made by Switchboard — replace with your own (Nuxt, Express, Fastify…).\nimport http from 'node:http';\nimport { routes } from './routes.js';\n\nconst port = Number(process.env.PORT) || 3000;\nhttp\n  .createServer((req, res) => {\n    const handler = routes[req.url] || routes['*'];\n    handler(req, res);\n  })\n  .listen(port, '0.0.0.0', () => console.log('listening on ' + port));\n`,
      'src/routes.js': `// Add your pages here: path → (req, res) => { … }\nexport const routes = {\n  '/up': (req, res) => res.end('ok'),\n  '*': (req, res) => {\n    res.setHeader('Content-Type', 'text/plain; charset=utf-8');\n    res.end('Hello from ${safe.replace(/'/g, '')}!\\n');\n  },\n};\n`,
    };
  }
  // static (Docker): plain HTML, nothing to build
  return {
    '.gitignore': gitignore,
    'README.md': readme('Open `index.html` in your browser, or run `npx serve .` for http://localhost:3000.'),
    'index.html': `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${safe}</title>
<link rel="stylesheet" href="css/style.css"></head>
<body><main><h1>${safe}</h1><p>Deployed with Switchboard. Replace this page with your site.</p></main></body>
</html>
`,
    'css/style.css': 'body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}\n',
  };
}

/* ------------------------------------------------------------------ Makefile (Docker apps) */
/**
 * A Makefile so the whole Docker stack is run with short commands — the same on the server and on a PC:
 * make start / stop / restart / logs / shell / artisan … ("make" alone lists them).
 * Plus .switchboard/local-env.sh: makes a .env for running the stack on a PC (make setup).
 */
export function makeFiles(template, slug, db = 'none', services = null) {
  if (!['laravel', 'node', 'static'].includes(template)) return {};
  const laravel = template === 'laravel';
  const on = (k) => !services || services.includes(k);
  const tab = (lines) => lines.map((l) => `\t${l}`).join('\n');
  const target = (name, help, lines) => `${name}: ## ${help}\n${tab(lines)}\n`;
  let dbShell = '';
  if (db === 'mysql') dbShell = `$(DC) exec db sh -c 'mysql -uroot -p"$$MYSQL_ROOT_PASSWORD" "$$MYSQL_DATABASE"'`;
  if (db === 'postgres') dbShell = `$(DC) exec db sh -c 'psql -U "$$POSTGRES_USER" "$$POSTGRES_DB"'`;
  const parts = laravel
    ? ['app (PHP + nginx)', db !== 'none' ? 'database' : '', on('queue') ? 'queue worker' : '', on('scheduler') ? 'scheduler' : '', on('redis') ? 'Redis' : ''].filter(Boolean).join(', ')
    : 'the app';
  const phony = ['help', 'setup', 'start', 'stop', 'restart', 'build', 'ps', 'logs', 'shell', 'down', ...(laravel ? ['artisan', 'migrate', 'tinker', 'queue-restart'] : []), ...(dbShell ? ['db'] : [])];
  const mk = [
    `# Made by Switchboard — the commands for this app's Docker stack (${parts}).`,
    '# Works the same on the server and on your computer. Type "make" to see them all.',
    ...(laravel ? ['# Which parts run is set in .env: COMPOSE_PROFILES (e.g. queue,scheduler,redis).'] : []),
    'DC = docker compose',
    '.DEFAULT_GOAL := help',
    `.PHONY: ${phony.join(' ')}`,
    '',
    target('help', 'Show these commands', [`@grep -E '^[a-z-]+:.*## ' Makefile | awk 'BEGIN{FS=":.*## "}{printf "  make %-14s %s\\n", $$1, $$2}'`]),
    target('setup', 'First time on a new computer: make .env, build and start', ['@sh .switchboard/local-env.sh', '$(DC) up -d --build', `@echo "Open http://localhost:$$(grep -E '^APP_PORT=' .env | cut -d= -f2)"`]),
    target('start', 'Start everything', ['$(DC) up -d']),
    target('stop', 'Stop everything (data is kept)', ['$(DC) stop']),
    target('restart', 'Restart everything', ['$(DC) restart']),
    target('build', 'Rebuild after code or Dockerfile changes, then start', ['$(DC) up -d --build']),
    target('ps', 'What is running', ['$(DC) ps']),
    target('logs', 'Follow the logs (Ctrl+C to leave)', ['$(DC) logs -f --tail=100']),
    target('shell', 'A shell inside the app container', ['$(DC) exec app sh']),
  ];
  if (laravel) {
    mk.push(
      target('artisan', 'Any artisan command: make artisan c="route:list"', ['$(DC) exec app php artisan $(c)']),
      target('migrate', 'Run the database migrations', ['$(DC) exec app php artisan migrate --force']),
      target('tinker', 'Laravel tinker', ['$(DC) exec app php artisan tinker']),
      target('queue-restart', 'Restart the queue workers after a code change', ['$(DC) exec app php artisan queue:restart']),
    );
  }
  if (dbShell) mk.push(target('db', 'Open the database console', [dbShell]));
  mk.push(target('down', 'Remove the containers (data volumes are kept)', ['$(DC) down']));

  // .env for a PC: start from .env.example when there is one, then set what the Docker stack needs.
  const vals = [
    ['COMPOSE_PROJECT_NAME', slug],
    ['COMPOSE_FILE', 'compose.switchboard.yml'],
    ['APP_PORT', laravel ? '8000' : '3000'],
  ];
  if (laravel) {
    const redis = on('redis');
    vals.push(
      ['COMPOSE_PROFILES', (services || ['queue', 'scheduler', 'redis']).join(',')],
      ['APP_ENV', 'local'],
      ['APP_DEBUG', 'true'],
      ['APP_URL', 'http://localhost:8000'],
      ['LOG_CHANNEL', 'stderr'],
      ['CACHE_STORE', redis ? 'redis' : 'database'],
      ['SESSION_DRIVER', redis ? 'redis' : 'database'],
      ['QUEUE_CONNECTION', redis ? 'redis' : 'database'],
    );
    if (redis) vals.push(['REDIS_HOST', 'redis']);
  }
  if (db === 'mysql') vals.push(['DB_CONNECTION', 'mysql'], ['DB_HOST', 'db'], ['DB_PORT', '3306'], ['DB_DATABASE', 'app'], ['DB_USERNAME', 'app'], ['DB_PASSWORD', 'secret'], ['DB_ROOT_PASSWORD', 'secret']);
  if (db === 'postgres') vals.push(['DB_CONNECTION', 'pgsql'], ['DB_HOST', 'db'], ['DB_PORT', '5432'], ['DB_DATABASE', 'app'], ['DB_USERNAME', 'app'], ['DB_PASSWORD', 'secret']);
  const env = [
    '#!/bin/sh',
    '# Made by Switchboard: writes .env for running this app on your computer with Docker ("make setup").',
    '# The server has its own .env with real passwords — this one is only for your computer.',
    'set -e',
    'if [ -f .env ]; then echo ".env already exists — left as it is"; exit 0; fi',
    'if [ -f .env.example ]; then cp .env.example .env; else : > .env; fi',
    'setv() {',
    '  if grep -qE "^#? *$1=" .env; then',
    `    awk -v k="$1" -v v="$2" '$0 ~ "^#? *"k"=" { if (!done) print k"="v; done = 1; next } { print }' .env > .env.tmp && mv .env.tmp .env`,
    '  else',
    '    echo "$1=$2" >> .env',
    '  fi',
    '}',
    ...vals.map(([k, v]) => `setv ${k} '${v}'`),
    ...(laravel ? ['setv APP_KEY "base64:$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)"'] : []),
    'echo "Wrote .env for your computer"',
    '',
  ].join('\n');
  return { Makefile: mk.join('\n'), '.switchboard/local-env.sh': env };
}

/* ------------------------------------------------------------------ install on a server */
const b64 =(s) => Buffer.from(s).toString('base64');
const writeCmd = (file, content, mode = '644') => `printf %s ${shq(b64(content))} | base64 -d > ${shq(`${file}.tmp`)} && chmod ${mode} ${shq(`${file}.tmp`)} && mv ${shq(`${file}.tmp`)} ${shq(file)}`;

/** Install/refresh the helper and every template on a server (as root). */
export async function installHelper(ctx, conn, server) {
  const helper = fs
    .readFileSync(path.join(REMOTE_DIR, 'switchboard-helper.sh'), 'utf8')
    .replaceAll('__VERSION__', HELPER_VERSION)
    .replaceAll('__EDGE_IMAGE__', EDGE_IMAGE);
  const cmds = ['set -e', 'mkdir -p /etc/switchboard/projects /etc/switchboard/ports', 'chmod 700 /etc/switchboard/projects', writeCmd(HELPER, helper, '755')];
  for (const [name, t] of Object.entries(TEMPLATES)) {
    if (t.own || t.host) continue;
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
    SB_GIT_SSH: project.git_repo ? gitSshCommand(project.git_repo) : '',
    SB_TEMPLATE: project.template || '',
    SB_DB: opts.db || 'none',
    // Laravel: which optional parts run (queue, scheduler, redis) — all of them for projects made before the choice
    SB_SERVICES: (Array.isArray(opts.services) ? opts.services : (TEMPLATES[project.template]?.services || []).map((s) => s.key)).join(','),
    SB_ENV: project.env || 'production',
    // apps without Docker get their web proxy from Switchboard after the build (as the project's Web proxy)
    SB_HOSTS: project.template && !TEMPLATES[project.template]?.host && !(project.template === 'compose' && !opts.app_port) ? projectHosts(project).join(' ') : '',
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

/** core.sshCommand that makes git use the repo's deploy key ('' when the server clones over another protocol). */
export const gitSshCommand = (repo) => (/^(git@|ssh:)/.test(gitUrl(repo)) ? `ssh -i ~/.ssh/${keyName(repo)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` : '');

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

/**
 * SERVER TOOLS — a small "marketplace" of useful programs for a server (Node.js, PM2, Docker…):
 *  - checkTools: what is installed (one SSH call), kept in servers.tools for the Tools tab and the warnings
 *  - the 'tools-install' job: installs the chosen tools as root (Ubuntu/Debian with apt, or dnf/yum)
 *  - projectNeeds / missingFor: which tools a project's deploy script needs, and which of its servers lack one,
 *    so the project page can say "Backup 2 has no Node.js — Install" BEFORE a deploy fails, and a deploy stops early.
 */
import { update, now } from '../db.js';
import { bus } from '../bus.js';
import { logEvent } from '../events.js';
import { defineJob } from '../jobs.js';
import { getServer, parseJSON, deploymentsOf } from '../models.js';
import { connectTo, runRemote, asRoot, shellScript } from './remote.js';

// apt / dnf / yum, whichever the server has. `pkgs` is one or more package names.
const PKG = `pkg_install() {
  if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-get update -q >/dev/null; apt-get install -y -q "$@" >/dev/null
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q "$@" >/dev/null
  elif command -v yum >/dev/null 2>&1; then yum install -y -q "$@" >/dev/null
  else echo "No apt-get, dnf or yum on this server: install $* by hand" >&2; exit 1; fi
}`;

// Node.js may be the system one or nvm's (for root or any user) — the deploy presets find both, so both count.
const NODE_PATH = `for h in /root /home/*; do [ -s "$h/.nvm/nvm.sh" ] || continue; NB="$(ls -d "$h"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"; [ -n "$NB" ] && PATH="$PATH:$NB"; done; export PATH`;

/**
 * The catalog. check: prints a version (or nothing when missing). install: runs as root.
 * needs: installed first (PM2 needs Node.js).
 */
export const TOOLS = [
  {
    key: 'node',
    name: 'Node.js',
    icon: '🟩',
    desc: 'Runs and builds JavaScript apps: Vue, React, Vite, Nuxt, Next, Express. Version 22 (LTS), from NodeSource.',
    check: `${NODE_PATH}; command -v node >/dev/null && echo "$(node -v) · $(command -v node)"`,
    install: `${PKG}
pkg_install curl ca-certificates
if command -v apt-get >/dev/null 2>&1; then curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/sb-nodesource.sh
else curl -fsSL https://rpm.nodesource.com/setup_22.x -o /tmp/sb-nodesource.sh; fi
bash /tmp/sb-nodesource.sh >/dev/null; rm -f /tmp/sb-nodesource.sh
pkg_install nodejs`,
  },
  {
    key: 'pm2',
    name: 'PM2',
    icon: '♻️',
    desc: 'Keeps Node.js apps (Nuxt, Next, Express…) running, restarts them when they crash and after a reboot.',
    needs: ['node'],
    check: `${NODE_PATH}; command -v pm2 >/dev/null && echo "$(pm2 -v 2>/dev/null | tail -1) · $(command -v pm2)"`,
    install: `npm install -g pm2 --no-audit --no-fund --loglevel=error >/dev/null
echo "PM2 installed. To start your apps after a reboot, run once as the user that runs them: pm2 startup && pm2 save"`,
  },
  {
    key: 'pnpm',
    name: 'pnpm & Yarn',
    icon: '📦',
    desc: 'Other package managers some projects use (pnpm-lock.yaml or yarn.lock). Turned on with Corepack, which comes with Node.js.',
    needs: ['node'],
    check: `${NODE_PATH}; command -v pnpm >/dev/null && echo "pnpm $(pnpm -v 2>/dev/null) · yarn $(yarn -v 2>/dev/null || echo '?')"`,
    install: `command -v corepack >/dev/null 2>&1 || npm install -g corepack --no-audit --no-fund >/dev/null
corepack enable
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; pnpm -v >/dev/null; yarn -v >/dev/null`,
  },
  {
    key: 'docker',
    name: 'Docker',
    icon: '🐳',
    desc: 'Runs apps in containers with Docker Compose (Laravel, databases, the media server…). Official install script from get.docker.com.',
    check: `command -v docker >/dev/null && echo "$(docker --version 2>/dev/null | sed 's/Docker version //; s/,.*//') · compose $(docker compose version --short 2>/dev/null || echo 'missing')"`,
    install: `${PKG}
pkg_install curl ca-certificates
curl -fsSL https://get.docker.com -o /tmp/sb-get-docker.sh
sh /tmp/sb-get-docker.sh >/dev/null; rm -f /tmp/sb-get-docker.sh
systemctl enable --now docker >/dev/null 2>&1 || true`,
  },
  {
    key: 'git',
    name: 'Git',
    icon: '🔀',
    desc: 'Gets your code from GitHub. Needed for "Connect to Git" and CI/CD.',
    check: `command -v git >/dev/null && git --version | sed 's/git version //'`,
    install: `${PKG}
pkg_install git`,
  },
  {
    key: 'nginx',
    name: 'Nginx',
    icon: '🌐',
    desc: 'Web server for static sites and a proxy in front of Node.js apps. Not installed when something else already uses port 80.',
    check: `command -v nginx >/dev/null && nginx -v 2>&1 | sed 's/.*nginx\\///'`,
    install: `if (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE '[:.]80[[:space:]]'; then
  echo "Port 80 is already used on this server (another web server or a container) — Nginx was not installed, so nothing breaks." >&2; exit 1
fi
${PKG}
pkg_install nginx
systemctl enable --now nginx >/dev/null 2>&1 || true`,
  },
  {
    key: 'certbot',
    name: 'Certbot',
    icon: '🔒',
    desc: "Free HTTPS certificates from Let's Encrypt, renewed automatically.",
    check: `command -v certbot >/dev/null && certbot --version 2>&1 | sed 's/certbot //'`,
    install: `${PKG}
pkg_install certbot`,
  },
];
const BY_KEY = Object.fromEntries(TOOLS.map((t) => [t.key, t]));
export const toolName = (k) => BY_KEY[k]?.name || k;
/** "nginx|docker" → "Nginx (or Docker)" */
export const needName = (n) => n.split('|').map(toolName).join(' (or ') + (n.includes('|') ? ')' : '');

/** Public view of the catalog (no scripts). */
export const toolCatalog = () => TOOLS.map(({ key, name, icon, desc, needs = [] }) => ({ key, name, icon, desc, needs }));

/** One script that checks every tool: lines "SB_TOOL <key> <version…>" (empty version = missing). */
const checkScript = () => TOOLS.map((t) => `v="$( (${t.check}) 2>/dev/null | head -1)"; echo "SB_TOOL ${t.key} $v"`).join('\n');

export const toolsOf = (server) => parseJSON(server?.tools, null);

/** Check a server over an open connection and remember the result. Returns { at, list: { key: version|null } }. */
export async function checkTools(conn, server) {
  // As the SSH user: "command -v" needs no root, and it works on servers without sudo too.
  const r = await runRemote(null, conn, shellScript(checkScript()), { quiet: true, okCodes: [0, 1, 2, 127], timeout: 60000 });
  const list = {};
  for (const t of TOOLS) list[t.key] = null;
  for (const line of String(r.stdout).split('\n')) {
    const m = line.match(/^SB_TOOL (\w+) ?(.*)$/);
    if (m && m[1] in list) list[m[1]] = m[2].trim() || null;
  }
  const state = { at: now(), list };
  update('servers', server.id, { tools: JSON.stringify(state) });
  bus.emit('state', { serverId: server.id });
  return state;
}

/**
 * What an app made from a template needs on its server. "a|b" = either one is enough
 * (an app without Docker needs a web server: the server's own nginx, or Docker for a small nginx container).
 */
export const TEMPLATE_NEEDS = {
  laravel: ['docker', 'git'],
  node: ['docker', 'git'],
  compose: ['docker', 'git'],
  static: ['docker', 'git'],
  frontend: ['node', 'nginx|docker', 'git'],
  pm2: ['node', 'pm2', 'nginx|docker', 'git'],
};
export const templateNeeds = (id) => TEMPLATE_NEEDS[id] || [];

/** The needs a server's tool list lacks ("a|b" is met by either). */
export const lacking = (needs, list = {}) => needs.filter((n) => !n.split('|').some((k) => list[k]));

/**
 * Which tools a project needs on its servers, from its deploy script (and template):
 * Docker Compose → docker · npm / pnpm / yarn → node · pm2 → node + pm2 · git → git.
 */
export function projectNeeds(project) {
  const s = String(project?.deploy_script || '');
  const t = String(project?.template || '');
  const needs = new Set(templateNeeds(t));
  if (/\bdocker\b|docker-compose/.test(s)) needs.add('docker');
  if (/\b(npm|npx|pnpm|yarn)\b/.test(s)) needs.add('node');
  if (/\bpm2\b/i.test(s)) needs.add('pm2');
  if (/\bgit (pull|fetch|reset|clone)\b/.test(s) || project?.git_repo) needs.add('git');
  return [...needs];
}

/** For each server of the project: the needed tools it lacks (only for servers checked already). */
export function missingFor(project) {
  const needs = projectNeeds(project);
  return deploymentsOf(project.id).map((d) => {
    const st = toolsOf(getServer(d.server_id));
    const missing = st ? lacking(needs, st.list) : [];
    return { deployment_id: d.id, server_id: d.server_id, server_name: d.server_name, checked_at: st?.at || null, missing };
  });
}

/** Install order: what a tool needs comes first; unknown keys are refused. */
export function installPlan(keys, have = {}) {
  const out = [];
  const add = (k0) => {
    const k = String(k0).split('|')[0];
    const t = BY_KEY[k];
    if (!t) throw new Error(`Unknown tool "${k}"`);
    for (const n of t.needs || []) if (!have[n]) add(n);
    if (!out.includes(k)) out.push(k);
  };
  for (const k of keys) add(k);
  return out;
}

/**
 * Before a deploy runs the script: stop early with a clear message when the server lacks a tool the script needs.
 * Re-checks the server (cheap) so a tool installed by hand a minute ago counts.
 */
export async function requireTools(ctx, conn, server, project) {
  const needs = projectNeeds(project);
  if (!needs.length) return;
  const st = await checkTools(conn, server).catch(() => null);
  if (!st) return; // could not check: let the script itself decide
  const missing = lacking(needs, st.list);
  if (!missing.length) return;
  const names = missing.map(needName).join(' and ');
  const err = new Error(`${names} ${missing.length > 1 ? 'are' : 'is'} not installed on ${server.name}, and this project's deploy script needs ${missing.length > 1 ? 'them' : 'it'}. Install: project page → "Install" button, or Servers → ${server.name} → Tools.`);
  err.missingTools = { server_id: server.id, tools: missing };
  throw err;
}

defineJob('tools-install', async (ctx, p) => {
  const server = getServer(Number(p.server));
  if (!server) throw new Error('Server not found');
  const conn = await connectTo(ctx, server);
  try {
    const before = await checkTools(conn, server);
    const plan = installPlan(p.tools || [], before.list);
    let failed = 0;
    for (const k of plan) {
      const t = BY_KEY[k];
      if (before.list[k]) {
        ctx.log(`${t.name} is already installed (${before.list[k]}) — skipped`);
        continue;
      }
      const missingNeed = (t.needs || []).find((n) => !before.list[n]);
      if (missingNeed) {
        failed++;
        ctx.warn(`${t.name} skipped: it needs ${toolName(missingNeed)}, which is not installed`);
        continue;
      }
      ctx.step(`Install ${t.name}`);
      try {
        await runRemote(ctx, conn, asRoot(server, shellScript(`set -e\n${t.install}`)), { timeout: 20 * 60000 });
        const now1 = await checkTools(conn, server);
        if (!now1.list[k]) throw new Error(`${t.name} still not found after installing`);
        ctx.log(`${t.name} ${now1.list[k]} ✓`);
        before.list[k] = now1.list[k];
      } catch (e) {
        failed++;
        ctx.warn(`${t.name} could not be installed: ${e.message}`);
      }
    }
    // Docker: let the SSH user run it without sudo (Switchboard's deploys run as that user).
    if (plan.includes('docker') && server.ssh_user && server.ssh_user !== 'root') {
      await runRemote(ctx, conn, asRoot(server, `usermod -aG docker ${server.ssh_user} 2>/dev/null || true`), { quiet: true }).catch(() => {});
    }
    await checkTools(conn, server);
    if (failed) throw new Error(`${failed} of ${plan.length} tool(s) could not be installed — see the log`);
    logEvent('success', `${server.name}: installed ${plan.map(toolName).join(', ')}`, { serverId: server.id, jobId: ctx.id, user: ctx.user });
  } finally {
    conn.end();
  }
});

/**
 * HOST APPS — apps that run directly on the server, not in Docker
 * (Vue/Nuxt/Node apps under PM2, systemd services, static sites served by nginx).
 *
 * Used by: the server page (list + start/stop/restart/logs), the project dialog
 * (pick an app folder) and "Clone server" (copy Node.js, the app folders and the
 * PM2 process list, then start them the same way).
 */
import path from 'node:path';
import { runRemote, asRoot, shq } from './remote.js';

const SAFE_USER = /^[a-z_][a-z0-9_.-]{0,31}$/i;
export const SAFE_PM2_NAME = /^[A-Za-z0-9_.@:-]{1,100}$/;
export const SAFE_UNIT = /^[A-Za-z0-9_.@-]{1,100}\.(service|timer)$/;
/** Units that belong to the OS/provider, not to the user's apps. */
const UNIT_SKIP = /^(cloud|snap|docker|containerd|getty|serial-getty|ssh|sshd|netplan|systemd-|network|dbus|display-manager)/;
/** Folders that are never "an app folder". */
const DIR_SKIP = /^\/(etc|usr|bin|sbin|lib|lib64|boot|proc|sys|dev|run|tmp|var\/lib\/docker|snap)(\/|$)|^\/$|^\/usr\/share\/nginx(\/|$)/;

/**
 * Shell helper that runs pm2 as a given user, finding pm2 in that user's nvm,
 * the system PATH or /usr/local/bin. Usage: pm2run <user> '<already quoted args>'
 */
export const PM2RUN = `pm2run() {
  u="$1"; a="$2"; h=$(getent passwd "$u" | cut -d: -f6)
  bin=$(ls -d "$h"/.nvm/versions/node/*/bin/pm2 2>/dev/null | tail -1)
  [ -n "$bin" ] || bin=$(command -v pm2 2>/dev/null)
  [ -n "$bin" ] || for b in /usr/local/bin/pm2 /usr/bin/pm2; do [ -x "$b" ] && bin="$b"; done
  [ -n "$bin" ] || { echo "pm2 is not installed for $u" >&2; return 127; }
  # cd home first: PM2 starts its daemon in the current folder, and root's /root is not readable by other users.
  c="cd \\"$h\\" && PATH=\\"$(dirname "$bin"):\\$PATH\\" HOME=\\"$h\\" \\"$bin\\" $a"
  if [ "$u" = root ]; then sh -c "$c"; else su -s /bin/sh "$u" -c "$c"; fi
}
`;

const lines = (s) =>
  String(s || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function sections(out) {
  const s = {};
  let cur = null;
  for (const line of String(out).split('\n')) {
    const m = line.match(/^@@(\w+)$/);
    if (m) {
      cur = m[1];
      s[cur] = [];
    } else if (cur) s[cur].push(line);
  }
  for (const k of Object.keys(s)) s[k] = s[k].join('\n').trim();
  return s;
}

/* ------------------------------------------------------------------ nginx */

/** Very small nginx config reader: server blocks with server_name, root/alias and proxy_pass. */
export function parseNginx(text) {
  const clean = String(text || '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, ''))
    .join('\n');
  const tokens = clean.match(/"[^"]*"|'[^']*'|[{};]|[^\s{};]+/g) || [];
  const sites = [];
  const stack = [];
  let words = [];
  let site = null;
  for (const t of tokens) {
    if (t === '{') {
      stack.push(words[0] || '');
      // nginx -T prints included files (sites-enabled/*) after the main file, so their server
      // blocks show up outside http {}. Only stream/mail servers are not websites.
      if (words[0] === 'server' && stack.filter((x) => x === 'server').length === 1 && !stack.includes('stream') && !stack.includes('mail')) {
        site = { names: [], listen: [], roots: [], proxies: [] };
        sites.push(site);
      }
      words = [];
    } else if (t === '}') {
      const closed = stack.pop();
      if (closed === 'server' && !stack.includes('server')) site = null;
      words = [];
    } else if (t === ';') {
      if (site && words.length) {
        const [d, ...args] = words.map((w) => w.replace(/^["']|["']$/g, ''));
        if (d === 'server_name') site.names.push(...args.filter((a) => a !== '_' && a !== '""'));
        else if (d === 'listen') site.listen.push(args[0]);
        else if (d === 'root' || d === 'alias') site.roots.push(args[0].replace(/\/+$/, '') || '/');
        else if (d === 'proxy_pass') site.proxies.push(args[0]);
      }
      words = [];
    } else words.push(t);
  }
  return sites
    .filter((s) => s.roots.length || s.proxies.length)
    .map((s) => ({
      names: [...new Set(s.names)],
      listen: [...new Set(s.listen)],
      roots: [...new Set(s.roots)],
      proxies: [...new Set(s.proxies)],
      kind: s.proxies.length ? 'proxy' : 'static',
    }));
}

/* ------------------------------------------------------------------ detect */

/** Find every non-Docker app on a server. Read-only (never starts the PM2 daemon). */
export async function detectHostApps(ctx, conn, server) {
  const script = `${PM2RUN}
users="root $(getent passwd 2>/dev/null | awk -F: '$3>=1000 && $3<60000 {print $1}')"
echo @@node
p=$(command -v node 2>/dev/null); [ -z "$p" ] && [ -x /usr/local/bin/node ] && p=/usr/local/bin/node
if [ -n "$p" ]; then r=$(readlink -f "$p"); printf '%s\\t%s\\t%s\\n' "$r" "$("$p" -v 2>/dev/null)" "$(dpkg -S "$r" 2>/dev/null | cut -d: -f1 | head -1)"; fi
echo @@nvm
for u in $users; do h=$(getent passwd "$u" | cut -d: -f6); [ -d "$h/.nvm/versions/node" ] && printf '%s\\t%s\\t%s\\n' "$u" "$h" "$(ls "$h/.nvm/versions/node" | tr '\\n' ' ')"; done
echo @@npmg
command -v npm >/dev/null 2>&1 && npm ls -g --depth=0 --json 2>/dev/null | tr -d '\\n'
echo
echo @@pm2
for u in $users; do h=$(getent passwd "$u" | cut -d: -f6); [ -d "$h/.pm2" ] || continue
  pid=$(cat "$h/.pm2/pm2.pid" 2>/dev/null); alive=0; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && alive=1
  echo "@@user $u $h $alive"
  [ $alive = 1 ] && pm2run "$u" jlist 2>/dev/null | grep '^\\[' | tail -1
done
echo @@units
for f in /etc/systemd/system/*.service; do [ -f "$f" ] && [ ! -L "$f" ] || continue; n=$(basename "$f")
  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$n" "$(systemctl is-active "$n" 2>/dev/null || echo unknown)" "$(grep -m1 '^User=' "$f" | cut -d= -f2-)" "$(grep -m1 '^WorkingDirectory=' "$f" | cut -d= -f2- | sed 's/^-//')" "$(grep -m1 '^ExecStart=' "$f" | cut -d= -f2-)"
done
echo @@nginx
command -v nginx >/dev/null 2>&1 && nginx -T 2>/dev/null
echo @@end
true`;
  const r = await runRemote(ctx, conn, asRoot(server, script), { quiet: true, timeout: 60000 });
  const s = sections(r.stdout);

  const [nodePath, nodeVersion, nodePkg] = (lines(s.node)[0] || '').split('\t');
  const node = nodePath
    ? { path: nodePath, version: nodeVersion || '?', kind: nodePkg ? 'apt' : nodePath.startsWith('/usr/local/') ? 'manual' : 'other', pkg: nodePkg || null }
    : null;
  const nvm = lines(s.nvm).map((l) => {
    const [user, home, versions] = l.split('\t');
    return { user, home, versions: (versions || '').split(' ').filter(Boolean) };
  });
  let npmGlobals = [];
  try {
    const deps = JSON.parse(s.npmg || '{}').dependencies || {};
    npmGlobals = Object.entries(deps)
      .filter(([n]) => !['npm', 'corepack'].includes(n))
      .map(([n, v]) => ({ name: n, version: v.version }));
  } catch {}

  // PM2: "@@user <u> <home> <alive>" followed by one JSON line (jlist).
  const pm2 = [];
  let cur = null;
  for (const l of String(s.pm2 || '').split('\n')) {
    const m = l.match(/^@@user (\S+) (\S+) ([01])$/);
    if (m) {
      cur = { user: m[1], home: m[2], alive: m[3] === '1', list: [] };
      pm2.push(cur);
    } else if (cur && l.startsWith('[')) {
      try {
        cur.list = JSON.parse(l);
      } catch {}
    }
  }

  const services = lines(s.units)
    .map((l) => {
      const [name, active, user, cwd, exec] = l.split('\t');
      return { name, active, user: user || 'root', cwd: cwd || '', exec: exec || '' };
    })
    .filter((u) => !UNIT_SKIP.test(u.name) && !/^pm2-/.test(u.name));

  const sites = parseNginx(s.nginx);
  return { node, nvm, npmGlobals, pm2, services, sites };
}

/** Safe summary for the browser (PM2 env vars hold secrets and are never sent). */
export function publicHostApps(d) {
  const now = Date.now();
  return {
    node: d.node,
    nvm: d.nvm.map((n) => ({ user: n.user, versions: n.versions })),
    npmGlobals: d.npmGlobals,
    pm2: d.pm2.flatMap((u) =>
      u.list.map((p) => ({
        user: u.user,
        id: p.pm_id,
        name: p.name,
        status: p.pm2_env?.status || '?',
        cwd: p.pm2_env?.pm_cwd || '',
        script: p.pm2_env?.pm_exec_path || '',
        mode: p.pm2_env?.exec_mode === 'cluster_mode' ? 'cluster' : 'fork',
        restarts: p.pm2_env?.restart_time ?? 0,
        uptime_ms: p.pm2_env?.status === 'online' && p.pm2_env?.pm_uptime ? now - p.pm2_env.pm_uptime : null,
        cpu: p.monit?.cpu ?? null,
        memory: p.monit?.memory ?? null,
      })),
    ),
    pm2Users: d.pm2.map((u) => ({ user: u.user, running: u.alive })),
    services: d.services,
    sites: d.sites,
  };
}

/** Folders that hold the apps (PM2 cwd, service WorkingDirectory, static nginx roots), nested ones merged. */
export function appFolders(d, { exclude = [] } = {}) {
  const homes = new Set(d.pm2.map((u) => u.home));
  const dirs = [];
  for (const u of d.pm2) {
    for (const p of u.list) {
      const cwd = p.pm2_env?.pm_cwd || '';
      const script = p.pm2_env?.pm_exec_path || '';
      // Started from the home folder itself → take the script's folder instead of the whole home.
      dirs.push(homes.has(cwd) || cwd === '/root' ? path.posix.dirname(script) : cwd);
    }
  }
  for (const s of d.services) if (s.cwd) dirs.push(s.cwd);
  for (const site of d.sites) for (const r of site.roots) dirs.push(r);
  const clean = [...new Set(dirs.filter((x) => x && x.startsWith('/') && !DIR_SKIP.test(x)).map((x) => x.replace(/\/+$/, '')))]
    .filter((x) => !exclude.some((e) => x === e || x.startsWith(`${e}/`)))
    .sort((a, b) => a.length - b.length);
  const out = [];
  for (const x of clean) if (!out.some((o) => x === o || x.startsWith(`${o}/`))) out.push(x);
  return out;
}

/**
 * The PM2 "dump" (what `pm2 save` writes) built from a live `pm2 jlist`,
 * so the source's own saved list is never touched.
 */
export function pm2Dump(list) {
  return list
    .filter((p) => !p.pm2_env?.pmx_module)
    .map((p) => {
      const e = { ...p.pm2_env };
      delete e.instances;
      delete e.pm_id;
      delete e.prev_restart_delay;
      return e;
    });
}

/* ------------------------------------------------------------------ actions */

export function hostAppScript({ type, user, name, action }) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Unknown action');
  if (type === 'pm2') {
    if (!SAFE_USER.test(user || '')) throw new Error('Invalid user');
    if (!SAFE_PM2_NAME.test(name || '')) throw new Error('Invalid PM2 app name');
    return `${PM2RUN}\npm2run ${shq(user)} ${shq(`${action} ${shq(name)}`)}`;
  }
  if (type === 'service') {
    if (!SAFE_UNIT.test(name || '')) throw new Error('Invalid service name');
    return `systemctl ${action} ${shq(name)} && systemctl is-active ${shq(name)}`;
  }
  throw new Error('Unknown app type');
}

export function hostAppLogsScript({ type, user, name, tail = 200 }) {
  const n = Math.min(5000, Math.max(10, Number(tail) || 200));
  if (type === 'pm2') {
    if (!SAFE_USER.test(user || '') || !SAFE_PM2_NAME.test(name || '')) throw new Error('Invalid app');
    return `${PM2RUN}\npm2run ${shq(user)} ${shq(`logs ${shq(name)} --lines ${n} --nostream --raw`)} 2>&1`;
  }
  if (type === 'service') {
    if (!SAFE_UNIT.test(name || '')) throw new Error('Invalid service name');
    return `journalctl -u ${shq(name)} -n ${n} --no-pager 2>&1 || echo 'journalctl is not available on this server'`;
  }
  throw new Error('Unknown app type');
}

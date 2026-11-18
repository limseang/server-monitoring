/**
 * COPY ONE PROJECT TO ANOTHER SERVER — like "Clone server", but only the pieces of one project:
 *
 *  • Docker: the compose stack(s) of the project (its folder, outside bind mounts, named volumes
 *    with the database data, the exact images), started the same way on the target.
 *  • Outside Docker: its PM2 apps, systemd services and nginx sites (only the server blocks that
 *    belong to the project), the app folder, the user that runs it and the Node.js it needs.
 *  • Switchboard's own pieces: the web proxy ("edge") sites that point to the app, the project's
 *    helper settings, and a new deployment record so the copy shows up in the project.
 *
 * Ports: every port the project listens on can be kept or changed for the target. A changed
 * port is written into the copied compose file / .env, the PM2 environment, the systemd unit,
 * the nginx proxy_pass/listen lines and the edge site — so the copy really runs on it.
 *
 * The source is only read (with "freeze", the project's containers are paused while their
 * data is copied, then always unpaused). On the target nothing that exists is overwritten
 * unless "replace" is ticked.
 */
import path from 'node:path';
import { get, insert, now } from '../db.js';
import { bus } from '../bus.js';
import { alert, logEvent } from '../events.js';
import { defineJob } from '../jobs.js';
import { getProject, getServer, getDeployment, parseJSON } from '../models.js';
import { fmtBytes, sleep } from '../util.js';
import { connectTo, runRemote, asRoot, shq } from './remote.js';
import {
  scanServer,
  buildStacks,
  sizes,
  ensureDocker,
  installPackages,
  copyUsers,
  copyHostFiles,
  copyImages,
  copyStack,
  startStack,
  verifyStacks,
  copyNodeRuntime,
  rootDocker,
} from './clone.js';
import { appFolders, pm2Dump, PM2RUN } from './hostapps.js';
import { installHelper, pushProjectConf, helper, HELPER } from './stack.js';
import { refreshDnsState } from './dns.js';
import { checkProjectNow } from '../monitor.js';

const SAFE_USER = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const SAFE_UNIT = /^[A-Za-z0-9_.@-]{1,100}\.(service|timer)$/;
const SAFE_SITE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;
const LOCAL_HOST = '(?:127\\.0\\.0\\.1|localhost|0\\.0\\.0\\.0|\\[::1\\])';

const lines = (s) =>
  String(s || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const clean = (d) => String(d || '').replace(/\/+$/, '');
const under = (p, dir) => !!dir && (p === dir || String(p || '').startsWith(`${dir}/`));
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  for (const k of Object.keys(s)) s[k] = s[k].join('\n');
  return s;
}

/** "@@file <path>" blocks inside one section → [{ path, text }]. */
function files(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^@@file (.+)$/);
    if (m) {
      cur = { path: m[1], text: [] };
      out.push(cur);
    } else if (cur) cur.text.push(line);
  }
  return out.map((f) => ({ path: f.path, text: f.text.join('\n') }));
}

async function root(ctx, conn, server, script, opts = {}) {
  return (await runRemote(ctx, conn, asRoot(server, script), { quiet: true, timeout: 120000, ...opts })).stdout;
}

const b64 = (s) => Buffer.from(String(s)).toString('base64');
const writeFileCmd = (file, content) => `printf %s ${shq(b64(content))} | base64 -d > ${shq(file)}`;

/* ------------------------------------------------------------------ text rewriting (pure, tested) */

/**
 * Change published host ports in a docker-compose file: "8080:80", "127.0.0.1:8080:80",
 * "published: 8080" and "${APP_PORT:-8080}:80". Returns { text, n, vars } where `vars` are the
 * variables used as a published port (their value lives in .env).
 */
export function rewriteCompose(text, map) {
  let n = 0;
  let out = String(text);
  const vars = new Set();
  for (const m of out.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-[^}]*)?\}(?=:\d)/g)) vars.add(m[1]);
  for (const m of out.matchAll(/published:\s*["']?\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) vars.add(m[1]);
  for (const [from, to] of Object.entries(map)) {
    if (String(from) === String(to)) continue;
    const f = reEsc(from);
    // short syntax: [ip:]FROM:container — FROM must be followed by ":<digits>"
    out = out.replace(new RegExp(`(^|[\\s"'\\[,:])${f}(?=:\\d+(?:/(?:tcp|udp))?(?:["'\\s,\\]]|$))`, 'gm'), (_, a) => {
      n++;
      return `${a}${to}`;
    });
    // long syntax
    out = out.replace(new RegExp(`(published:[ \\t]*["']?)${f}(?=["']?[ \\t]*$)`, 'gm'), (_, a) => {
      n++;
      return `${a}${to}`;
    });
    // default value of a variable: ${APP_PORT:-8080}:80
    out = out.replace(new RegExp(`(\\$\\{[A-Za-z_][A-Za-z0-9_]*:?-)${f}(\\})`, 'g'), (_, a, b) => {
      n++;
      return `${a}${to}${b}`;
    });
  }
  return { text: out, n, vars: [...vars] };
}

/**
 * Change port values in an env-style file (.env, systemd Environment=). With `vars`, only those
 * variable names; without, any name containing PORT.
 */
export function rewriteEnv(text, map, vars = null) {
  let n = 0;
  let out = String(text);
  const name = vars && vars.length ? `(?:${vars.map(reEsc).join('|')})` : '[A-Za-z0-9_]*PORT[A-Za-z0-9_]*';
  for (const [from, to] of Object.entries(map)) {
    if (String(from) === String(to)) continue;
    const f = reEsc(from);
    // .env line: NAME=8080 / NAME="8080" / export NAME=8080
    out = out.replace(new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=\\s*)(["']?)${f}\\2(\\s*(?:#.*)?)$`, 'gm'), (_, a, q, c) => {
      n++;
      return `${a}${q}${to}${q}${c}`;
    });
    // systemd: Environment=PORT=8080 or Environment="PORT=8080" "HOST=…"
    out = out.replace(new RegExp(`^(Environment=.*?\\b${name}=)${f}(?=["'\\s]|$)`, 'gm'), (_, a) => {
      n++;
      return `${a}${to}`;
    });
  }
  return { text: out, n };
}

/** Port lines in a PM2 ecosystem file (PORT: 3000, port = "3000"). */
export function rewriteEcosystem(text, map) {
  let n = 0;
  let out = String(text);
  for (const [from, to] of Object.entries(map)) {
    if (String(from) === String(to)) continue;
    out = out.replace(new RegExp(`(\\b[A-Za-z_]*PORT[A-Za-z_]*["']?\\s*[:=]\\s*["']?)${reEsc(from)}(?![0-9])`, 'gi'), (_, a) => {
      n++;
      return `${a}${to}`;
    });
  }
  return { text: out, n };
}

/** nginx: proxy_pass/fastcgi_pass to a local FROM port, and "listen FROM". */
export function rewriteNginx(text, map) {
  let n = 0;
  let out = String(text);
  for (const [from, to] of Object.entries(map)) {
    if (String(from) === String(to)) continue;
    const f = reEsc(from);
    out = out.replace(new RegExp(`(${LOCAL_HOST}):${f}(?![0-9])`, 'g'), (_, h) => {
      n++;
      return `${h}:${to}`;
    });
    out = out.replace(new RegExp(`(\\blisten\\s+(?:[^\\s;]*:)?)${f}(?=[\\s;])`, 'g'), (_, a) => {
      n++;
      return `${a}${to}`;
    });
  }
  return { text: out, n };
}

/** Top-level "server { … }" blocks of an nginx file (with their text), comments and quotes respected. */
export function nginxServerBlocks(text) {
  const src = String(text);
  const blocks = [];
  let depth = 0;
  let i = 0;
  let start = -1;
  let word = '';
  let lastWord = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (/[A-Za-z0-9_]/.test(c)) word += c;
    else {
      if (word) lastWord = word;
      word = '';
    }
    if (c === '{') {
      if (depth === 0 && lastWord === 'server') {
        // back up to the "server" keyword
        start = src.lastIndexOf('server', i);
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        blocks.push(src.slice(start, i + 1));
        start = -1;
      }
    } else if (c === ';') lastWord = '';
    i++;
  }
  return blocks;
}

/** PM2 dump entries with the port env vars / --port args changed. */
export function pm2DumpWithPorts(list, map) {
  const dump = pm2Dump(list);
  const fix = (env) => {
    if (!env || typeof env !== 'object') return;
    for (const k of Object.keys(env)) {
      if (!/port/i.test(k)) continue;
      const v = String(env[k]);
      if (map[v] !== undefined && String(map[v]) !== v) env[k] = typeof env[k] === 'number' ? Number(map[v]) : String(map[v]);
    }
  };
  for (const e of dump) {
    fix(e);
    fix(e.env);
    if (Array.isArray(e.args)) {
      e.args = e.args.map((a, i) => {
        const s = String(a);
        const prev = String(e.args[i - 1] || '');
        if (/^(-p|--port)$/.test(prev) && map[s] !== undefined) return String(map[s]);
        const m = s.match(/^(--port=)(\d+)$/);
        if (m && map[m[2]] !== undefined) return `${m[1]}${map[m[2]]}`;
        return a;
      });
    }
  }
  return dump;
}

/** Published host ports of a container (works for stopped ones too). */
function containerPorts(c) {
  const out = [];
  const b = c.HostConfig?.PortBindings || {};
  for (const [k, arr] of Object.entries(b)) {
    const [, proto = 'tcp'] = k.split('/');
    for (const x of arr || []) {
      const port = Number(x.HostPort);
      if (port && !out.some((o) => o.port === port && o.proto === proto)) out.push({ port, proto, target: Number(k.split('/')[0]) });
    }
  }
  return out;
}

/** Port map from the browser: { "8080": 8085 } → validated { "8080": "8085" }. */
export function portMap(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const from = Number(k);
    const to = Number(v);
    if (!Number.isInteger(from) || from < 1 || from > 65535) continue;
    if (v === '' || v === null || v === undefined) continue;
    if (!Number.isInteger(to) || to < 1 || to > 65535) throw new Error(`Port "${v}" is not a valid port (1–65535)`);
    out[String(from)] = String(to);
  }
  return out;
}

export function copyOptions(p = {}) {
  return {
    installDocker: p.installDocker !== false,
    freeze: p.freeze !== false,
    replace: !!p.replace,
    ports: portMap(p.ports),
  };
}

/* ------------------------------------------------------------------ scan */

/** Extra facts the project copy needs (listening ports by process, edge sites, nginx files). */
async function scanExtra(ctx, conn, server, slug) {
  const s = sections(
    await root(
      ctx,
      conn,
      server,
      `echo @@ss; ss -ltnpH 2>/dev/null || ss -ltnp 2>/dev/null | tail -n +2
echo @@ps; ps -eo pid=,ppid= 2>/dev/null
echo @@svc; for f in /etc/systemd/system/*.service; do [ -f "$f" ] || continue; n=$(basename "$f"); echo "$n $(systemctl show -p MainPID --value "$n" 2>/dev/null || echo 0)"; done
echo @@edgemode; cat /etc/switchboard/edge/mode 2>/dev/null
echo @@edge; d=/etc/switchboard/edge/conf.d; [ "$(cat /etc/switchboard/edge/mode 2>/dev/null)" = host ] && d=/etc/nginx/conf.d
for f in "$d"/sb-*.conf; do [ -f "$f" ] && { echo "@@file $f"; cat "$f"; }; done
echo @@nginx; for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do [ -f "$f" ] || continue; case "$(basename "$f")" in sb-*|00-switchboard.conf) continue;; esac; echo "@@file $(readlink -f "$f")"; cat "$f"; echo; done
echo @@sbport; cat /etc/switchboard/ports/${slug} 2>/dev/null
echo @@sbconf; [ -f /etc/switchboard/projects/${slug}.conf ] && echo yes
echo @@helper; [ -x ${HELPER} ] && echo yes
echo @@end
true`,
      { timeout: 60000 },
    ),
  );
  const listen = [];
  for (const l of lines(s.ss)) {
    const f = l.split(/\s+/);
    const local = f.find((x) => /:\d+$/.test(x));
    if (!local) continue;
    const port = Number(local.match(/:(\d+)$/)[1]);
    const pids = [...l.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    listen.push({ port, pids, addr: local.replace(/:\d+$/, '') });
  }
  const children = new Map();
  for (const l of lines(s.ps)) {
    const [pid, ppid] = l.split(/\s+/).map(Number);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const svcPid = Object.fromEntries(lines(s.svc).map((l) => [l.split(' ')[0], Number(l.split(' ')[1]) || 0]));
  const edge = files(s.edge).map((f) => {
    const name = path.posix.basename(f.path).replace(/^sb-/, '').replace(/\.conf$/, '');
    const hosts = (f.text.match(/server_name\s+([^;]+);/) || [])[1]?.trim().split(/\s+/) || [];
    const port = Number((f.text.match(new RegExp(`proxy_pass\\s+https?://${LOCAL_HOST}:(\\d+)`)) || [])[1]) || null;
    return { name, hosts, port, file: f.path };
  });
  return {
    listen,
    children,
    svcPid,
    edgeMode: lines(s.edgemode)[0] || '',
    edge,
    nginxFiles: files(s.nginx),
    sbPort: Number(lines(s.sbport)[0]) || null,
    sbConf: lines(s.sbconf)[0] === 'yes',
    helper: lines(s.helper)[0] === 'yes',
  };
}

/** Ports a set of processes (and their children) listen on. */
function portsOfPids(extra, pids) {
  const all = new Set();
  const walk = (p) => {
    if (!p || all.has(p)) return;
    all.add(p);
    for (const c of extra.children.get(p) || []) walk(c);
  };
  for (const p of pids) walk(p);
  return [...new Set(extra.listen.filter((l) => l.pids.some((p) => all.has(p))).map((l) => l.port))];
}

/* ------------------------------------------------------------------ plan */

/** Work out what belongs to the project on the source and what the copy will do. Reads only. */
export async function makeCopyPlan(ctx, { project, dep, src, dst, srcConn, dstConn, srcScan, dstScan, opts }) {
  const problems = [];
  const warnings = [];
  const dir = clean(dep.app_dir);
  const [sx, dx] = await Promise.all([scanExtra(ctx, srcConn, src, project.slug), scanExtra(ctx, dstConn, dst, project.slug)]);

  if (srcScan.uid !== 0) problems.push(`${src.name}: needs root or passwordless sudo for ${src.ssh_user}`);
  if (dstScan.uid !== 0) problems.push(`${dst.name}: needs root or passwordless sudo for ${dst.ssh_user}`);
  if (get('SELECT id FROM deployments WHERE project_id = ? AND server_id = ?', project.id, dst.id)) {
    problems.push(`${dst.name} is already part of ${project.name}. Remove it from the project first, or pick another server.`);
  }

  // Docker stacks of the project: same folder, or a container the deployment names.
  const named = new Set([dep.app_container, dep.db_container].filter(Boolean));
  const { stacks: allStacks } = buildStacks(srcScan);
  const stacks = allStacks.filter((st) => (dir && clean(st.dir) === dir) || st.containers.some((c) => named.has(c.name)));
  const loose = srcScan.containers
    .filter((c) => !c.Config?.Labels?.['com.docker.compose.project'] && named.has(String(c.Name || '').replace(/^\//, '')))
    .map((c) => String(c.Name || '').replace(/^\//, ''));
  if (loose.length) warnings.push(`Not copied (not started by Docker Compose): ${loose.join(', ')} — recreate those by hand`);
  for (const st of stacks) {
    if (!st.dir) warnings.push(`${st.project}: no compose folder recorded — only its volumes are copied, it can't be started automatically`);
    if (st.anon.length) warnings.push(`${st.project}: anonymous volumes are not copied (${st.anon.join(', ')})`);
  }
  if (stacks.length) {
    if (srcScan.arch !== dstScan.arch) problems.push(`CPU types differ (${src.name} is ${srcScan.arch}, ${dst.name} is ${dstScan.arch}) — the copied images would not run`);
    if (dstScan.docker === 'none' && !opts.installDocker) problems.push(`${dst.name} has no Docker — tick "Install Docker" or install it first`);
    if (dstScan.docker === 'none' && dstScan.os.id === 'alpine') problems.push(`${dst.name} runs Alpine — install Docker there first`);
  }
  const dstProjects = new Set(dstScan.containers.map((c) => c.Config?.Labels?.['com.docker.compose.project']).filter(Boolean));
  const clash = stacks.filter((s) => dstProjects.has(s.project)).map((s) => s.project);
  if (clash.length) {
    if (opts.replace) warnings.push(`${dst.name} already runs ${clash.join(', ')} — those containers are removed and their volumes replaced`);
    else problems.push(`${dst.name} already runs the Docker stack ${clash.join(', ')}. Tick "Replace what exists on the target" to overwrite it.`);
  }

  // Apps outside Docker that run from the project folder.
  const ha = srcScan.hostApps;
  const pm2 = [];
  for (const u of ha.pm2) {
    const list = u.list.filter((p) => !p.pm2_env?.pmx_module && (under(p.pm2_env?.pm_cwd, dir) || under(p.pm2_env?.pm_exec_path, dir)));
    if (list.length) pm2.push({ ...u, list });
  }
  const services = ha.services.filter((s) => under(clean(s.cwd), dir) || (dir && s.exec.includes(`${dir}/`)));
  for (const u of pm2) if (!u.alive) warnings.push(`PM2 of ${u.user} is not running on ${src.name} — its apps can't be read, start PM2 there first`);

  // Ports the project listens on.
  const ports = [];
  const addPort = (port, kind, what) => {
    if (!port || port === 22) return;
    const p = ports.find((x) => x.port === port);
    if (p) {
      if (!p.what.includes(what)) p.what.push(what);
    } else ports.push({ port, kind, what: [what] });
  };
  for (const st of stacks) {
    for (const c of st.containers) {
      const raw = srcScan.containers.find((x) => String(x.Name || '').replace(/^\//, '') === c.name);
      for (const pp of containerPorts(raw || {})) addPort(pp.port, 'docker', `${c.name} → ${pp.target}/${pp.proto}`);
    }
  }
  for (const u of pm2) {
    for (const p of u.list) {
      const found = portsOfPids(sx, [p.pid].filter(Boolean));
      const env = p.pm2_env || {};
      const envPort = Number(env.PORT || env.env?.PORT) || null;
      for (const port of found.length ? found : [envPort].filter(Boolean)) addPort(port, 'pm2', `PM2 ${p.name} (${u.user})`);
    }
  }
  for (const s of services) for (const port of portsOfPids(sx, [sx.svcPid[s.name]].filter(Boolean))) addPort(port, 'service', `systemd ${s.name}`);
  if (sx.sbPort) addPort(sx.sbPort, 'switchboard', 'Switchboard app port');
  if (dep.app_port) addPort(dep.app_port, 'record', 'Port saved in Switchboard');

  // nginx server blocks on the source that belong to the project (proxy to its port, or root in its folder).
  const portSet = new Set(ports.map((p) => p.port));
  const nginxBlocks = [];
  for (const f of sx.nginxFiles) {
    for (const block of nginxServerBlocks(f.text)) {
      const proxies = [...block.matchAll(new RegExp(`(?:proxy_pass|fastcgi_pass|grpc_pass)\\s+(?:https?://)?${LOCAL_HOST}:(\\d+)`, 'g'))].map((m) => Number(m[1]));
      const roots = [...block.matchAll(/^\s*(?:root|alias)\s+["']?([^"';\s]+)/gm)].map((m) => clean(m[1]));
      if (proxies.some((p) => portSet.has(p)) || roots.some((r) => under(r, dir))) {
        const names = ((block.match(/server_name\s+([^;]+);/) || [])[1] || '').trim().split(/\s+/).filter((x) => x && x !== '_');
        nginxBlocks.push({ file: f.path, text: block, names });
        for (const m of block.matchAll(/\blisten\s+(?:[^\s;]*:)?(\d+)/g)) {
          const lp = Number(m[1]);
          if (![80, 443].includes(lp)) addPort(lp, 'nginx', `nginx site ${names[0] || ''}`.trim());
        }
      }
    }
  }
  const edgeSites = sx.edge.filter((e) => e.name === project.slug || (e.port && portSet.has(e.port)));

  // Port choices and whether they are free on the target.
  const dstUsed = new Set(dx.listen.map((l) => l.port));
  for (const c of dstScan.containers) for (const pp of containerPorts(c)) dstUsed.add(pp.port);
  const replacedContainers = new Set(opts.replace ? dstScan.containers.filter((c) => clash.includes(c.Config?.Labels?.['com.docker.compose.project'])).flatMap((c) => containerPorts(c).map((x) => x.port)) : []);
  const map = {};
  const seen = new Map();
  for (const p of ports) {
    const to = Number(opts.ports[String(p.port)] || p.port);
    p.to = to;
    map[String(p.port)] = String(to);
    p.inUse = dstUsed.has(to) && !replacedContainers.has(to);
    if (to === 22) problems.push(`Port 22 is SSH — pick another port for ${p.what[0]}`);
    else if (p.inUse) problems.push(`Port ${to} is already used on ${dst.name} — type another port for ${p.what.join(', ')}`);
    if (seen.has(to) && seen.get(to) !== p.port) problems.push(`Port ${to} is chosen twice — each port can only be used once`);
    seen.set(to, p.port);
  }
  for (const k of Object.keys(opts.ports)) {
    if (!ports.some((p) => String(p.port) === k)) warnings.push(`Port ${k} is not used by ${project.name} on ${src.name} — ignored`);
  }

  // What already exists on the target.
  const dstPm2Names = new Set((dstScan.hostApps?.pm2 || []).flatMap((u) => u.list.map((p) => `${u.user}/${p.name}`)));
  for (const u of pm2) {
    for (const p of u.list) {
      if (dstPm2Names.has(`${u.user}/${p.name}`)) {
        if (opts.replace) warnings.push(`PM2 app ${p.name} (${u.user}) exists on ${dst.name} — it is replaced`);
        else problems.push(`PM2 app ${p.name} (${u.user}) already exists on ${dst.name}. Tick "Replace what exists on the target" to overwrite it.`);
      }
    }
  }
  const dstUnits = new Set((dstScan.units || []).map((u) => u.name));
  for (const s of services) {
    if (dstUnits.has(s.name)) {
      if (opts.replace) warnings.push(`systemd service ${s.name} exists on ${dst.name} — it is replaced`);
      else problems.push(`systemd service ${s.name} already exists on ${dst.name}. Tick "Replace what exists on the target" to overwrite it.`);
    }
  }
  const dstNames = new Set((dstScan.hostApps?.sites || []).flatMap((x) => x.names));
  for (const b of nginxBlocks) {
    const dup = b.names.filter((n) => dstNames.has(n));
    if (dup.length && !opts.replace) warnings.push(`${dst.name} already has an nginx site for ${dup.join(', ')} — nginx uses the first one it reads`);
  }

  // Folders.
  const filtered = { pm2: pm2.map((u) => ({ ...u })), services, sites: [] };
  let appDirs = appFolders(filtered, { exclude: stacks.map((s) => clean(s.dir)).filter(Boolean) });
  const staticRoots = nginxBlocks.flatMap((b) => [...b.text.matchAll(/^\s*(?:root|alias)\s+["']?([^"';\s]+)/gm)].map((m) => clean(m[1]))).filter((r) => under(r, dir));
  appDirs = [...new Set([...appDirs, ...staticRoots])];
  if (dir && !stacks.some((s) => clean(s.dir) === dir) && !appDirs.some((d) => under(dir, d))) appDirs.push(dir);
  appDirs = appDirs.filter((d, i, a) => !a.some((o, j) => j !== i && under(d, o) && d !== o)).filter((d) => d.split('/').filter(Boolean).length >= 2);
  const dirExists = lines(await root(ctx, dstConn, dst, `for p in ${[...appDirs, ...stacks.map((s) => s.dir).filter(Boolean)].map(shq).join(' ') || "''"}; do [ -n "$p" ] && [ -e "$p" ] && echo "$p"; done; true`));
  if (dirExists.length) {
    if (opts.replace) warnings.push(`Folder(s) already on ${dst.name}: ${dirExists.join(', ')} — files with the same name are overwritten`);
    else problems.push(`${dst.name} already has ${dirExists.join(', ')}. Tick "Replace what exists on the target" to copy over it.`);
  }
  if (!stacks.length && !pm2.length && !services.length && !nginxBlocks.length) {
    if (!dir) problems.push(`Nothing of ${project.name} found on ${src.name}: the deployment has no app folder and no container that Docker Compose started`);
    else warnings.push(`No containers or running apps of ${project.name} found on ${src.name} — only the folder ${dir} is copied`);
  }

  // Users, Node.js and nginx the apps need on the target.
  const needUsers = [...new Set([...pm2.map((u) => u.user), ...services.map((s) => s.user)].filter((u) => u && u !== 'root'))];
  const users = srcScan.users.filter((u) => needUsers.includes(u.name) && !dstScan.users.some((d) => d.name === u.name));
  const nodePaths = [];
  let npmGlobals = [];
  const packages = [];
  if (pm2.length || services.some((s) => /node|npm|pm2|nuxt/.test(s.exec))) {
    const dha = dstScan.hostApps || { nvm: [], npmGlobals: [] };
    for (const u of pm2) {
      const nv = ha.nvm.find((n) => n.user === u.user);
      const have = dha.nvm.find((n) => n.user === u.user);
      if (nv && !(have && nv.versions.every((v) => have.versions.includes(v)))) nodePaths.push(`${nv.home}/.nvm`);
    }
    if (ha.node?.kind === 'manual' && !dha.node) nodePaths.push('/usr/local/bin', '/usr/local/lib/node_modules', '/usr/local/include/node');
    if (ha.node?.kind === 'apt' && ha.node.pkg && !dstScan.installed.has(ha.node.pkg)) {
      if (dstScan.pkgmgr === 'apt') packages.push(ha.node.pkg);
      else warnings.push(`Node.js (${ha.node.pkg}) must be installed on ${dst.name} by hand`);
    }
    if (ha.node && ha.node.kind !== 'manual' && !nodePaths.some((p) => p.endsWith('/.nvm'))) {
      const have = new Set((dha.npmGlobals || []).map((g) => `${g.name}@${g.version}`));
      npmGlobals = ha.npmGlobals.filter((g) => !have.has(`${g.name}@${g.version}`));
    }
    if (ha.node?.kind === 'other') warnings.push(`Node.js on ${src.name} is at ${ha.node.path} — install it on ${dst.name} by hand`);
  }
  if (nginxBlocks.length && !dstScan.installed.has('nginx') && !(dstScan.hostApps?.sites || []).length) {
    if (dstScan.pkgmgr === 'apt') packages.push('nginx');
    else warnings.push(`nginx must be installed on ${dst.name} by hand for the site(s) ${nginxBlocks.flatMap((b) => b.names).join(', ')}`);
  }

  // Images and sizes.
  const neededIds = [...new Set(stacks.flatMap((s) => s.containers.map((c) => c.imageId)))];
  const images = neededIds.map((id) => srcScan.images.get(id)).filter(Boolean);
  const toCopy = images.filter((i) => !dstScan.images.has(i.id));
  const pathList = [...stacks.map((s) => s.dir).filter(Boolean), ...stacks.flatMap((s) => s.binds), ...stacks.flatMap((s) => s.volumes.map((v) => v.Mountpoint)).filter(Boolean), ...appDirs, ...nodePaths];
  const sz = await sizes(ctx, srcConn, src, [...new Set(pathList)]);
  const imgBytes = toCopy.reduce((n, i) => n + i.size, 0);
  const dataBytes = Object.values(sz).reduce((n, b) => n + b, 0);
  const free = dstScan.diskFreeKb * 1024;
  if (free && (imgBytes + dataBytes) * 1.15 > free) problems.push(`${dst.name} has ${fmtBytes(free)} free but the copy needs about ${fmtBytes((imgBytes + dataBytes) * 1.15)}`);

  // Health checks are one setting for every server of the project.
  const changed = ports.filter((p) => p.to !== p.port);
  if (project.health_port && changed.some((p) => p.port === project.health_port)) {
    warnings.push(
      `Health checks of ${project.name} use port ${project.health_port} on every server. The copy answers on ${changed.find((p) => p.port === project.health_port).to}, so Switchboard's check of ${dst.name} will fail unless a web proxy (domain) in front of it answers on ${project.health_port} — or set the check to port 80/443 with the domain.`,
    );
  }
  const opts2 = parseJSON(project.template_opts, {}) || {};
  if (project.template === 'compose' && opts2.app_port && changed.some((p) => p.port === Number(opts2.app_port))) {
    warnings.push(`This project's template runs the app on port ${opts2.app_port} for every server — a later "Deploy" on ${dst.name} would point the web proxy back to ${opts2.app_port}.`);
  }

  return {
    problems,
    warnings,
    dir,
    stacks,
    pm2,
    services,
    nginxBlocks,
    edgeSites,
    edgeMode: sx.edgeMode,
    sbPort: sx.sbPort,
    sbConf: sx.sbConf,
    ports,
    map,
    appDirs,
    users,
    nodePaths,
    npmGlobals,
    packages,
    images,
    toCopy,
    clash,
    sizes: sz,
    bytes: { images: imgBytes, data: dataBytes, total: imgBytes + dataBytes, free },
  };
}

/** Plain summary for the browser. */
export function copySummary(plan, { project, dep, src, dst, srcScan, dstScan }) {
  return {
    project: { id: project.id, name: project.name, slug: project.slug },
    source: { name: src.name, deployment: dep.id, dir: plan.dir, os: srcScan.os.pretty, arch: srcScan.arch },
    target: { id: dst.id, name: dst.name, os: dstScan.os.pretty, arch: dstScan.arch, docker: dstScan.docker, free: plan.bytes.free },
    problems: plan.problems,
    warnings: plan.warnings,
    ports: plan.ports.map((p) => ({ port: p.port, to: p.to, kind: p.kind, what: p.what, inUse: p.inUse })),
    stacks: plan.stacks.map((s) => ({
      project: s.project,
      dir: s.dir,
      running: s.running,
      containers: s.containers.map((c) => c.name),
      volumes: s.volumes.map((v) => v.Name),
      binds: s.binds,
      bytes: (plan.sizes[s.dir] || 0) + s.binds.reduce((n, b) => n + (plan.sizes[b] || 0), 0) + s.volumes.reduce((n, v) => n + (plan.sizes[v.Mountpoint] || 0), 0),
    })),
    pm2: plan.pm2.flatMap((u) => u.list.map((p) => ({ user: u.user, name: p.name, status: p.pm2_env?.status || '?' }))),
    services: plan.services.map((s) => s.name),
    sites: plan.nginxBlocks.map((b) => ({ names: b.names, file: b.file })),
    edgeSites: plan.edgeSites.map((e) => ({ name: e.name, hosts: e.hosts, port: e.port })),
    folders: plan.appDirs.map((d) => ({ path: d, bytes: plan.sizes[d] || 0 })),
    users: plan.users.map((u) => u.name),
    node: { paths: plan.nodePaths, npmGlobals: plan.npmGlobals.map((g) => `${g.name}@${g.version}`) },
    packages: plan.packages,
    images: { count: plan.images.length, toCopy: plan.toCopy.length, bytes: plan.bytes.images },
    bytes: plan.bytes,
  };
}

/** Preview: scan both servers, change nothing. */
export async function previewCopy(project, dep, dst, raw) {
  const opts = copyOptions(raw);
  const src = getServer(dep.server_id);
  const quiet = { log() {}, warn() {}, step() {}, output() {}, signal: new AbortController().signal };
  const [srcConn, dstConn] = await Promise.all([connectTo(null, src), connectTo(null, dst)]);
  try {
    const [srcScan, dstScan] = await Promise.all([scanServer(null, srcConn, src), scanServer(null, dstConn, dst)]);
    const plan = await makeCopyPlan(quiet, { project, dep, src, dst, srcConn, dstConn, srcScan, dstScan, opts });
    return copySummary(plan, { project, dep, src, dst, srcScan, dstScan });
  } finally {
    srcConn.end();
    dstConn.end();
  }
}

/* ------------------------------------------------------------------ steps */

/** Read files from a server: { path: text } (missing ones left out). */
async function readFiles(ctx, conn, server, list) {
  if (!list.length) return {};
  const out = await root(ctx, conn, server, `for f in ${list.map(shq).join(' ')}; do [ -f "$f" ] && { echo "@@file $f"; base64 < "$f" | tr -d '\\n'; echo; }; done; true`);
  return Object.fromEntries(files(out).map((f) => [f.path, Buffer.from(f.text.trim(), 'base64').toString('utf8')]));
}

/** Change the published ports in the copied compose files / .env, before the stack is started. */
async function rewriteStackPorts(ctx, conn, server, st, map) {
  if (!st.dir || !Object.entries(map).some(([a, b]) => a !== b)) return;
  const composeFiles = st.configFiles.length ? st.configFiles : [`${st.dir}/docker-compose.yml`];
  const envFile = `${st.dir}/.env`;
  const got = await readFiles(ctx, conn, server, [...composeFiles, envFile]);
  const writes = [];
  const vars = new Set();
  let n = 0;
  for (const f of composeFiles) {
    if (got[f] === undefined) continue;
    const r = rewriteCompose(got[f], map);
    r.vars.forEach((v) => vars.add(v));
    if (r.n) {
      writes.push(writeFileCmd(f, r.text));
      ctx.log(`  ${f}: ${r.n} port mapping(s) changed`);
      n += r.n;
    }
  }
  if (got[envFile] !== undefined && vars.size) {
    const r = rewriteEnv(got[envFile], map, [...vars]);
    if (r.n) {
      writes.push(writeFileCmd(envFile, r.text));
      ctx.log(`  ${envFile}: ${r.n} port variable(s) changed (${[...vars].join(', ')})`);
      n += r.n;
    }
  }
  const wanted = st.containers.length ? Object.entries(map).filter(([a, b]) => a !== b) : [];
  if (!n && wanted.length) ctx.warn(`${st.project}: no port mapping found to change in ${composeFiles.join(', ')} — check the published ports by hand`);
  if (writes.length) await root(ctx, conn, server, `set -e\n${writes.join('\n')}`);
}

/** .env / ecosystem files in copied app folders. */
async function rewriteFolderPorts(ctx, conn, server, dirs, map) {
  if (!dirs.length || !Object.entries(map).some(([a, b]) => a !== b)) return;
  const list = lines(await root(ctx, conn, server, `for d in ${dirs.map(shq).join(' ')}; do for f in "$d"/.env "$d"/.env.production "$d"/ecosystem.config.js "$d"/ecosystem.config.cjs "$d"/ecosystem.json; do [ -f "$f" ] && echo "$f"; done; done; true`));
  const got = await readFiles(ctx, conn, server, list);
  const writes = [];
  for (const [f, text] of Object.entries(got)) {
    const r = /ecosystem/.test(f) ? rewriteEcosystem(text, map) : rewriteEnv(text, map);
    if (r.n) {
      writes.push(`${writeFileCmd(`${f}.sb-tmp`, r.text)} && cat ${shq(`${f}.sb-tmp`)} > ${shq(f)} && rm -f ${shq(`${f}.sb-tmp`)}`);
      ctx.log(`  ${f}: ${r.n} port value(s) changed`);
    }
  }
  if (writes.length) await root(ctx, conn, server, `set -e\n${writes.join('\n')}`);
}

/** Bring the project's PM2 apps up on the target (merged into what PM2 already runs there). */
async function startPm2(ctx, conn, server, plan, replace) {
  for (const u of plan.pm2) {
    if (!u.alive || !u.list.length || !SAFE_USER.test(u.user)) continue;
    const dump = pm2DumpWithPorts(u.list, plan.map);
    const names = u.list.map((p) => p.name);
    const stopped = u.list.filter((p) => p.pm2_env?.status === 'stopped').map((p) => p.name);
    ctx.step(`Start PM2 app(s) of ${u.user} on ${server.name}: ${names.join(', ')}`);
    const del = replace ? names.map((n) => `pm2run "$u" ${shq(`delete ${shq(n)}`)} >/dev/null 2>&1`).join('\n') : '';
    const stop = stopped.map((n) => `pm2run "$u" ${shq(`stop ${shq(n)}`)} >/dev/null`).join('\n');
    try {
      await runRemote(
        ctx,
        conn,
        asRoot(
          server,
          `${PM2RUN}
set -e
u=${shq(u.user)}; h=$(getent passwd "$u" | cut -d: -f6); [ -n "$h" ] || { echo "user $u does not exist" >&2; exit 3; }
D="$h/.pm2/dump.pm2"; mkdir -p "$h/.pm2"
pid=$(cat "$h/.pm2/pm2.pid" 2>/dev/null || true)
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then :; elif [ -s "$D" ]; then echo ">>> Starting PM2 of $u with its saved apps first"; pm2run "$u" resurrect >/dev/null; fi
${del}
[ -f "$D" ] && cp -p "$D" "$D.sb-keep" || rm -f "$D.sb-keep"
cat > "$D"; chown -R "$u" "$h/.pm2"
pm2run "$u" resurrect
if [ -f "$D.sb-keep" ]; then mv "$D.sb-keep" "$D"; fi
${stop}
pm2run "$u" 'save --force' >/dev/null`,
        ),
        { stdin: JSON.stringify(dump), timeout: 5 * 60000 },
      );
      if (stopped.length) ctx.log(`Kept stopped like on the source: ${stopped.join(', ')}`);
    } catch (e) {
      ctx.warn(`PM2 app(s) of ${u.user} not started: ${e.message}`);
    }
  }
}

/** Copy the project's systemd units with the new ports, then enable them like on the source. */
async function copyServices(ctx, { src, dst, srcConn, dstConn, plan }) {
  const units = plan.services.filter((s) => SAFE_UNIT.test(s.name));
  if (!units.length) return;
  ctx.step(`systemd service(s): ${units.map((s) => s.name).join(', ')}`);
  const got = await readFiles(ctx, srcConn, src, units.map((s) => `/etc/systemd/system/${s.name}`));
  const writes = [];
  for (const [f, text] of Object.entries(got)) {
    const r = rewriteEnv(text, plan.map);
    writes.push(writeFileCmd(f, r.text));
    if (r.n) ctx.log(`  ${f}: ${r.n} port value(s) changed`);
  }
  await root(ctx, dstConn, dst, `set -e\n${writes.join('\n')}`);
  const active = units.filter((s) => s.active === 'active').map((s) => s.name);
  try {
    await root(ctx, dstConn, dst, `command -v systemctl >/dev/null && [ -d /run/systemd/system ] || { echo 'no systemd on this server' >&2; exit 3; }; systemctl daemon-reload; for u in ${units.map((s) => shq(s.name)).join(' ')}; do systemctl enable "$u" >/dev/null 2>&1 || true; done${active.length ? `; systemctl restart ${active.map(shq).join(' ')}` : ''}`, { timeout: 5 * 60000 });
    ctx.log(`systemd units enabled${active.length ? `, started: ${active.join(', ')}` : ''}`);
  } catch (e) {
    ctx.warn(`systemd units copied but not started (${e.message}): ${units.map((s) => s.name).join(', ')}`);
  }
}

/** Write the project's nginx server blocks into one site file on the target, with the new ports. */
async function copyNginxSites(ctx, { src, dst, srcConn, dstConn, plan, project }) {
  if (!plan.nginxBlocks.length) return;
  const name = `${project.slug}`;
  if (!SAFE_SITE.test(name)) return;
  ctx.step(`nginx site(s) ${plan.nginxBlocks.flatMap((b) => b.names).join(', ') || ''} on ${dst.name}`);
  const parts = [`# Copied by Switchboard from ${src.name} (${[...new Set(plan.nginxBlocks.map((b) => b.file))].join(', ')})`];
  let n = 0;
  for (const b of plan.nginxBlocks) {
    const r = rewriteNginx(b.text, plan.map);
    n += r.n;
    parts.push(r.text);
  }
  // Certificates the blocks use (outside the copied folders).
  const certs = [...new Set(plan.nginxBlocks.flatMap((b) => [...b.text.matchAll(/^\s*ssl_(?:certificate|certificate_key|trusted_certificate|dhparam)\s+["']?([^"';\s]+)/gm)].map((m) => m[1])))].filter((p) => p.startsWith('/'));
  const extra = [];
  for (const c of certs) {
    const le = c.match(/^\/etc\/letsencrypt\/live\/([^/]+)\//);
    if (le) extra.push(`/etc/letsencrypt/live/${le[1]}`, `/etc/letsencrypt/archive/${le[1]}`, `/etc/letsencrypt/renewal/${le[1]}.conf`, '/etc/letsencrypt/options-ssl-nginx.conf', '/etc/letsencrypt/ssl-dhparams.pem');
    else extra.push(c);
  }
  if (extra.length) await copyHostFiles(ctx, { src, dst, srcConn, dstConn, paths: extra, title: `Copy certificate files: ${[...new Set(extra)].join(', ')}` });
  const text = `${parts.join('\n\n')}\n`;
  const out = await root(
    ctx,
    dstConn,
    dst,
    `set -e
command -v nginx >/dev/null || { echo 'nginx is not installed' >&2; exit 3; }
if [ -d /etc/nginx/sites-available ] && grep -qs 'sites-enabled' /etc/nginx/nginx.conf; then F=/etc/nginx/sites-available/${name}; L=/etc/nginx/sites-enabled/${name}; else F=/etc/nginx/conf.d/${name}.conf; L=''; fi
[ -f "$F" ] && cp -p "$F" "/tmp/${name}.sb-bak" || rm -f "/tmp/${name}.sb-bak"
${writeFileCmd(`/tmp/${name}.sb-site`, text)} && mv "/tmp/${name}.sb-site" "$F"
[ -n "$L" ] && ln -sf "$F" "$L"
if nginx -t >/dev/null 2>&1; then
  running() { pgrep -x nginx >/dev/null 2>&1 || { [ -s /run/nginx.pid ] && kill -0 "$(cat /run/nginx.pid)" 2>/dev/null; }; }
  if running; then systemctl reload nginx 2>/dev/null || service nginx reload >/dev/null 2>&1 || nginx -s reload
  else systemctl enable --now nginx >/dev/null 2>&1 || service nginx start >/dev/null 2>&1 || true; running || nginx; fi
  running && echo "OK $F" || echo "BAD nginx does not run"
else
  if [ -f "/tmp/${name}.sb-bak" ]; then mv "/tmp/${name}.sb-bak" "$F"; else rm -f "$F" \${L:+"$L"}; fi
  echo "BAD $(nginx -t 2>&1 | tail -3 | tr '\\n' ' ')"
fi`,
  );
  const ok = lines(out).find((l) => l.startsWith('OK '));
  if (ok) ctx.log(`nginx site written: ${ok.slice(3)}${n ? ` (${n} port value(s) changed)` : ''}`);
  else ctx.warn(`nginx site for ${plan.nginxBlocks.flatMap((b) => b.names).join(', ')} is not active on ${dst.name}: ${lines(out).find((l) => l.startsWith('BAD '))?.slice(4) || '?'}`);
}

/** Switchboard's web proxy sites and helper settings for the project, on the new port. */
async function copySwitchboardBits(ctx, { dst, dstConn, plan, project, newDep }) {
  const need = plan.edgeSites.length || plan.sbConf || plan.sbPort;
  if (!need) return;
  ctx.step(`Switchboard web proxy and settings on ${dst.name}`);
  await installHelper(ctx, dstConn, dst);
  if (plan.sbPort) {
    const to = plan.map[String(plan.sbPort)] || String(plan.sbPort);
    await root(ctx, dstConn, dst, `mkdir -p /etc/switchboard/ports && echo ${shq(to)} > ${shq(`/etc/switchboard/ports/${project.slug}`)}`);
    ctx.log(`App port of ${project.slug}: ${to}`);
  }
  if (plan.sbConf) await pushProjectConf(ctx, dstConn, dst, project, newDep);
  for (const e of plan.edgeSites) {
    if (!e.port || !e.hosts.length || !SAFE_SITE.test(e.name)) continue;
    const to = plan.map[String(e.port)] || String(e.port);
    try {
      await helper(ctx, dstConn, dst, ['edge-site', e.name, to, ...e.hosts], { timeout: 10 * 60000 });
    } catch (err) {
      ctx.warn(`Web proxy site ${e.hosts.join(' ')} not created on ${dst.name}: ${err.message}`);
    }
  }
}

async function verifyPm2Ports(ctx, conn, server, plan) {
  const want = plan.ports.filter((p) => ['pm2', 'service', 'docker', 'nginx'].includes(p.kind));
  if (!want.length) return 0;
  await sleep(3000);
  const out = await root(ctx, conn, server, `ss -ltnH 2>/dev/null || ss -ltn | tail -n +2`).catch(() => '');
  const listening = new Set(lines(out).map((l) => Number((l.split(/\s+/).find((x) => /:\d+$/.test(x)) || '').match(/:(\d+)$/)?.[1])));
  let bad = 0;
  for (const p of want) {
    // Stopped apps/containers don't listen; only check what runs on the source.
    const running =
      (p.kind === 'docker' && plan.stacks.some((st) => st.containers.some((c) => c.running && p.what.some((w) => w.startsWith(`${c.name} `))))) ||
      (p.kind === 'pm2' && plan.pm2.some((u) => u.list.some((a) => a.pm2_env?.status === 'online' && p.what.some((w) => w.startsWith(`PM2 ${a.name} `))))) ||
      p.kind === 'service' ||
      p.kind === 'nginx';
    if (!running) continue;
    const ok = listening.has(p.to);
    if (!ok) bad++;
    (ok ? ctx.log : ctx.warn)(`  port ${p.to} (${p.what.join(', ')}): ${ok ? 'listening' : 'NOT listening'}`);
  }
  return bad;
}

/** The new deployment record (same containers/database settings, the new port). */
function addDeployment(ctx, { project, dep, src, dst, plan }) {
  const max = get('SELECT MAX(priority) AS m FROM deployments WHERE project_id = ?', project.id)?.m ?? dep.priority;
  const appPort = dep.app_port ? Number(plan.map[String(dep.app_port)] || dep.app_port) : plan.sbPort ? Number(plan.map[String(plan.sbPort)] || plan.sbPort) : null;
  const id = insert('deployments', {
    project_id: project.id,
    server_id: dst.id,
    priority: max + 1,
    app_dir: dep.app_dir,
    app_container: dep.app_container,
    db_type: dep.db_type,
    db_container: dep.db_container,
    db_name: dep.db_name,
    db_user: dep.db_user,
    db_password: dep.db_password,
    app_port: appPort,
    skip_backup: dep.skip_backup || 0,
    health: 'unknown',
    maintenance: 0,
    data_at: now(),
    data_note: `Copied from ${src.name}`,
    created_at: now(),
  });
  ctx.log(`${dst.name} added to ${project.name} as a standby${appPort ? ` (app port ${appPort})` : ''}`);
  return getDeployment(id);
}

/* ------------------------------------------------------------------ job */

export async function runCopyProject(ctx, p) {
  const project = getProject(Number(p.project));
  const dep = getDeployment(Number(p.deployment));
  const dst = getServer(Number(p.target));
  if (!project || !dep || dep.project_id !== project.id) throw new Error('Project or deployment not found (was it removed?)');
  if (!dst) throw new Error('Target server not found (was it removed?)');
  const src = getServer(dep.server_id);
  if (src.id === dst.id) throw new Error('Source and target are the same server');
  const opts = copyOptions(p);
  ctx.log(`Copy ${project.name}: ${src.name} (${src.ip}) → ${dst.name} (${dst.ip})`);

  const srcConn = await connectTo(ctx, src);
  let dstConn = null;
  try {
    dstConn = await connectTo(ctx, dst);
    ctx.step('Scan both servers');
    const [srcScan, dstScan] = await Promise.all([scanServer(ctx, srcConn, src), scanServer(ctx, dstConn, dst)]);
    const plan = await makeCopyPlan(ctx, { project, dep, src, dst, srcConn, dstConn, srcScan, dstScan, opts });
    for (const w of plan.warnings) ctx.warn(w);
    if (plan.problems.length) throw new Error(plan.problems.join(' · '));
    const changed = plan.ports.filter((x) => x.to !== x.port);
    ctx.log(
      `Plan: ${plan.stacks.length} Docker stack(s), ${plan.pm2.reduce((n, u) => n + u.list.length, 0)} PM2 app(s), ${plan.services.length} service(s), ${plan.nginxBlocks.length} nginx site(s), about ${fmtBytes(plan.bytes.total)}`,
    );
    ctx.log(`Ports: ${plan.ports.map((x) => (x.to !== x.port ? `${x.port} → ${x.to}` : `${x.port}`)).join(', ') || 'none'}${changed.length ? '' : ' (unchanged)'}`);
    ctx.throwIfCancelled();

    // 1. What the apps need on the target.
    let conn = dstConn;
    if (plan.stacks.length) conn = dstConn = await ensureDocker(ctx, dstConn, dst, dstScan);
    if (plan.packages.length) await installPackages(ctx, conn, dst, plan.packages);
    if (plan.users.length) {
      const groups = srcScan.groups.filter((g) => plan.users.some((u) => u.gid === g.gid) && !dstScan.groups.some((d) => d.name === g.name));
      await copyUsers(ctx, conn, dst, { users: plan.users, groups, members: {} }, dstScan);
    }
    if (plan.nodePaths.length || plan.npmGlobals.length) await copyNodeRuntime(ctx, { src, dst, srcConn, dstConn: conn, plan });
    ctx.throwIfCancelled();

    // 2. Docker: images, folders + volumes, ports, start.
    let bad = 0;
    if (plan.stacks.length) {
      await copyImages(ctx, { src, dst, srcConn, dstConn: conn, plan });
      for (const st of plan.stacks) {
        await copyStack(ctx, { src, dst, srcConn, dstConn: conn, st, freeze: opts.freeze, replace: opts.replace, dstHas: plan.clash.includes(st.project) });
        ctx.throwIfCancelled();
      }
      for (const st of plan.stacks) {
        await rewriteStackPorts(ctx, conn, dst, st, plan.map);
        await startStack(ctx, conn, dst, st);
      }
      ctx.step(`Check containers on ${dst.name}`);
      bad += await verifyStacks(ctx, conn, dst, plan.stacks);
    }

    // 3. Outside Docker: folders, PM2, systemd, nginx.
    if (plan.appDirs.length) {
      await copyHostFiles(ctx, { src, dst, srcConn, dstConn: conn, paths: plan.appDirs, title: `Copy app folder(s): ${plan.appDirs.join(', ')}` });
      await rewriteFolderPorts(ctx, conn, dst, plan.appDirs, plan.map);
    }
    if (plan.pm2.length) await startPm2(ctx, conn, dst, plan, opts.replace);
    await copyServices(ctx, { src, dst, srcConn, dstConn: conn, plan });
    await copyNginxSites(ctx, { src, dst, srcConn, dstConn: conn, plan, project });
    ctx.throwIfCancelled();

    // 4. Switchboard: deployment record, helper settings, web proxy.
    const newDep = addDeployment(ctx, { project, dep, src, dst, plan });
    await copySwitchboardBits(ctx, { dst, dstConn: conn, plan, project, newDep });

    ctx.step(`Check ports on ${dst.name}`);
    bad += await verifyPm2Ports(ctx, conn, dst, plan);
    if (bad) ctx.warn(`${bad} container(s)/port(s) are not like on ${src.name} — check their logs on the ${dst.name} page`);
    ctx.log(`Done. ${project.name} runs on ${dst.name} too (standby). Traffic was NOT moved — use Switch when you're ready.`);
    if (plan.stacks.length) ctx.log('Tip: if an app config (.env) contains the old server IP, update it on the new server.');
    return { deployment: newDep.id, bad, bytes: plan.bytes.total, ports: plan.ports.map((x) => ({ from: x.port, to: x.to })) };
  } finally {
    srcConn?.end();
    dstConn?.end();
  }
}

defineJob('project-copy', async (ctx, p) => {
  const project = getProject(Number(p.project));
  const dst = getServer(Number(p.target));
  const srcName = getServer(Number(p.source))?.name || '?';
  try {
    const r = await runCopyProject(ctx, p);
    bus.emit('state', { projectId: project.id });
    await refreshDnsState(project.id).catch(() => {});
    await checkProjectNow(project.id).catch(() => {});
    alert(r.bad ? 'warn' : 'success', `${project.name} copied from ${srcName} to ${dst.name}${r.bad ? ` — ${r.bad} thing(s) need a look` : ''}`, {
      projectId: project.id,
      serverId: dst.id,
      jobId: ctx.id,
      user: ctx.user,
      link: `#/projects/${project.id}`,
    });
    logEvent('info', `${project.name}: copied ${srcName} → ${dst.name} (ports ${r.ports.map((x) => (x.from === x.to ? x.from : `${x.from}→${x.to}`)).join(', ') || 'none'})`, { projectId: project.id, serverId: dst.id, jobId: ctx.id, user: ctx.user });
  } catch (e) {
    alert('error', `Copy of ${project?.name || '?'} to ${dst?.name || '?'} FAILED — ${e.message}`, { projectId: project?.id, serverId: dst?.id, jobId: ctx.id, user: ctx.user, link: project ? `#/projects/${project.id}` : undefined });
    throw e;
  } finally {
    bus.emit('state', { serverId: dst?.id });
  }
});

export { rootDocker };

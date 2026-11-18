/**
 * CLEAN UP — free disk space and memory on a server, without touching data.
 *
 *  previewCleanup(): reads over SSH what could be freed and how much (changes nothing).
 *  'server-cleanup' job: does the parts the admin ticked, and logs disk/memory before and after.
 *
 * Never touched: Docker volumes (database data), running containers (except a restart the admin
 * picked), containers of Switchboard projects, and the container this dashboard runs in.
 * Log files are emptied (truncated), never deleted, so programs writing to them keep working.
 */
import { defineJob, enqueue } from '../jobs.js';
import { all, get, run } from '../db.js';
import { getServer, deploymentsOnServer, getProject } from '../models.js';
import { fmtBytes } from '../util.js';
import { logEvent } from '../events.js';
import { connectTo, runRemote, asRoot, dockerExec, shellScript, shq } from './remote.js';
import { rootDocker } from './clone.js';
import { inspectAll, switchboardContainers, ownContainerId } from './wipe.js';

/** Log files at least this big are listed and emptied. */
export const BIG_LOG_MB = 20;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** The options a cleanup can have. Everything off unless asked (the dialog pre-ticks the safe ones). */
export function cleanupOptions(p = {}) {
  const b = (v) => v === true || v === 1 || v === '1' || v === 'true';
  return {
    buildCache: b(p.buildCache),
    images: b(p.images), // dangling images (no name, left over from builds/pulls)
    allImages: b(p.allImages), // every image no container uses — extra, warned
    containers: b(p.containers), // stopped containers that are not part of a Switchboard project
    networks: b(p.networks),
    journal: b(p.journal),
    apt: b(p.apt),
    logs: b(p.logs),
    laravel: b(p.laravel),
    dropCaches: b(p.dropCaches),
    swap: b(p.swap),
    restart: (Array.isArray(p.restart) ? p.restart : []).map((x) => String(x).trim()).filter((x) => NAME_RE.test(x)).slice(0, 50),
  };
}

export const cleanupLabel = (o) =>
  [
    o.buildCache && 'build cache',
    (o.images || o.allImages) && (o.allImages ? 'all unused images' : 'dangling images'),
    o.containers && 'stopped containers',
    o.networks && 'networks',
    o.journal && 'journal',
    o.apt && 'apt cache',
    o.logs && 'big logs',
    o.laravel && 'Laravel caches',
    o.dropCaches && 'page cache',
    o.swap && 'swap',
    o.restart.length && `restart ${o.restart.join(', ')}`,
  ]
    .filter(Boolean)
    .join(', ');

/* ------------------------------------------------------------------ parsing */

const UNIT = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
/** "1.2GB", "58.7MiB", "0B", "12.5kB (40%)" → bytes. */
export function parseSize(s) {
  const m = String(s || '').match(/([\d.]+)\s*([kKmMgGtT]?i?B)/);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (UNIT[m[2].toLowerCase()] || 1));
}

function sections(out) {
  const sec = {};
  let cur = null;
  for (const line of String(out || '').split('\n')) {
    const m = line.match(/^@@(\w+)$/);
    if (m) sec[(cur = m[1])] = [];
    else if (cur && line.trim()) sec[cur].push(line);
  }
  return sec;
}

export function parseDisk(lines = []) {
  const d = (lines[0] || '').trim().split(/\s+/);
  if (d.length < 5) return null;
  return { total: Number(d[1]) * 1024, used: Number(d[2]) * 1024, avail: Number(d[3]) * 1024, pct: parseInt(d[4], 10) };
}

export function parseMem(lines = []) {
  const m = {};
  for (const l of lines) {
    const x = l.match(/^(\w+):\s+(\d+)/);
    if (x) m[x[1]] = Number(x[2]) * 1024;
  }
  if (!m.MemTotal) return null;
  return {
    total: m.MemTotal,
    free: m.MemFree ?? null,
    available: m.MemAvailable ?? null,
    cached: (m.Cached || 0) + (m.Buffers || 0),
    swap_total: m.SwapTotal || 0,
    swap_used: (m.SwapTotal || 0) - (m.SwapFree || 0),
  };
}

const DISK = 'df -kP / | tail -1';
const MEM = 'grep -E "^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):" /proc/meminfo';

/**
 * Big log files (≥ BIG_LOG_MB on disk): /var/log (not the binary journal, not the sparse lastlog),
 * Docker's own container logs, and storage/logs of the Laravel apps on this server.
 * Prints "<KB>|<path>" lines. The same script finds them for the preview and for the job.
 */
function bigLogsScript(server, appDirs) {
  const blocks = BIG_LOG_MB * 2048; // find -size counts 512-byte blocks (portable, also busybox)
  const dirs = ['/var/log', ...appDirs.map((d) => `${d.replace(/\/+$/, '')}/storage/logs`)];
  return `sb_big() { for d in "$@"; do [ -d "$d" ] || continue; find "$d" -xdev -type f -size +${blocks} ! -name lastlog ! -path '*/journal/*' 2>/dev/null; done | head -300 | while IFS= read -r f; do
  kb=$(du -k "$f" 2>/dev/null | cut -f1); [ "\${kb:-0}" -ge ${BIG_LOG_MB * 1024} ] && echo "$kb|$f"; done; }
DR=$(${rootDocker(server)} info -f '{{.DockerRootDir}}' 2>/dev/null)
sb_big ${dirs.map(shq).join(' ')} \${DR:+"$DR/containers"}`;
}

const parseBig = (lines = []) =>
  lines
    .map((l) => l.match(/^(\d+)\|(\/.+)$/))
    .filter(Boolean)
    .map((m) => ({ path: m[2], size: Number(m[1]) * 1024, kind: m[2].includes('/containers/') && m[2].endsWith('-json.log') ? 'docker' : m[2].startsWith('/var/log/') ? 'system' : 'app' }))
    .sort((a, b) => b.size - a.size);

/** Projects on this server: their containers are never removed, their Laravel caches can be cleared. */
function serverApps(server) {
  return deploymentsOnServer(server.id).map((d) => ({ dep: d, project: getProject(d.project_id)?.name || '?' }));
}

const appDirsOf = (apps) => [...new Set(apps.map((a) => a.dep.app_dir).filter((x) => x && x.startsWith('/') && !x.includes('..')))];

async function root(ctx, conn, server, script, opts = {}) {
  return (await runRemote(ctx, conn, asRoot(server, script), { timeout: 10 * 60000, ...opts })).stdout;
}

const quietCtx = () => ({ log() {}, warn() {}, step() {}, output() {}, signal: new AbortController().signal, throwIfCancelled() {} });

/** Laravel app of a deployment: "php artisan" in its container, or in its folder on the host. */
function artisanCmd(server, dep, args) {
  if (dep.app_container) return dockerExec(server, dep.app_container, `[ -f artisan ] || exit 3; php artisan ${args}`);
  return `cd ${shq(dep.app_dir)} && [ -f artisan ] || exit 3; php artisan ${args}`;
}

async function laravelApps(ctx, conn, server, apps) {
  const out = [];
  for (const a of apps) {
    const d = a.dep;
    if (!d.app_container && !d.app_dir) continue;
    // Is it Laravel (artisan + php)? Were its config/routes cached ("php artisan optimize")?
    const probe = d.app_container
      ? dockerExec(server, d.app_container, '[ -f artisan ] && command -v php >/dev/null && { [ -f bootstrap/cache/config.php ] && echo cached || echo plain; }')
      : `cd ${shq(d.app_dir)} 2>/dev/null && [ -f artisan ] && command -v php >/dev/null && { [ -f bootstrap/cache/config.php ] && echo cached || echo plain; }`;
    const r = await runRemote(ctx, conn, probe, { quiet: true, timeout: 30000, okCodes: [0, 1, 2, 125, 126, 127, 128, 137] }).catch(() => null);
    const st = String(r?.stdout || '').trim();
    if (st === 'cached' || st === 'plain') out.push({ dep: d, project: a.project, where: d.app_container || d.app_dir, cached: st === 'cached' });
  }
  return out;
}

/** Running containers by memory (docker stats), with this dashboard's own container marked. */
async function topContainers(ctx, conn, server) {
  const D = rootDocker(server);
  const out = await root(ctx, conn, server, `${D} stats --no-stream --format '{{json .}}' 2>/dev/null | head -200; true`, { quiet: true, timeout: 60000 });
  const me = ownContainerId();
  const rows = [];
  for (const l of String(out).split('\n')) {
    if (!l.startsWith('{')) continue;
    try {
      const j = JSON.parse(l);
      const id = String(j.ID || j.Container || '');
      rows.push({
        name: String(j.Name || '').replace(/^\//, ''),
        mem: parseSize(String(j.MemUsage || '').split('/')[0]),
        mem_pct: parseFloat(j.MemPerc) || 0,
        cpu_pct: parseFloat(j.CPUPerc) || 0,
        self: !!me && !!id && (me.startsWith(id) || id.startsWith(me.slice(0, 12))),
      });
    } catch {}
  }
  return rows.sort((a, b) => b.mem - a.mem);
}

/** Stopped containers, split into removable ones and ones that belong to a Switchboard project. */
function stoppedContainers(containers, apps) {
  const protectedNames = new Set(apps.flatMap((a) => [a.dep.app_container, a.dep.db_container]).filter(Boolean));
  const dirs = appDirsOf(apps).map((d) => d.replace(/\/+$/, ''));
  const projectsOfApps = new Set();
  for (const c of containers) {
    const l = c.Config?.Labels || {};
    const wd = String(l['com.docker.compose.project.working_dir'] || '').replace(/\/+$/, '');
    const name = String(c.Name || '').replace(/^\//, '');
    if (l['com.docker.compose.project'] && (protectedNames.has(name) || (wd && dirs.includes(wd)))) projectsOfApps.add(l['com.docker.compose.project']);
  }
  const sb = switchboardContainers(containers);
  const keep = new Set([...sb.self, ...sb.others]);
  return containers
    .filter((c) => !c.State?.Running && !c.State?.Restarting && !c.State?.Paused)
    .map((c) => {
      const name = String(c.Name || '').replace(/^\//, '');
      const proj = c.Config?.Labels?.['com.docker.compose.project'] || null;
      const kept = protectedNames.has(name) || (proj && projectsOfApps.has(proj)) || keep.has(name);
      return { id: c.Id, name, image: c.Config?.Image || '', status: c.State?.Status || '', finished: c.State?.FinishedAt || null, project: proj, kept: !!kept };
    });
}

/* ------------------------------------------------------------------ preview */

async function scan(ctx, conn, server) {
  const D = rootDocker(server);
  const apps = serverApps(server);
  const out = await root(
    ctx,
    conn,
    server,
    `set +e
echo @@disk; ${DISK}
echo @@mem; ${MEM}
echo @@docker; command -v ${D.split(' ')[0]} >/dev/null 2>&1 && ${D} version -f '{{.Server.Version}}' 2>/dev/null
echo @@df; ${D} system df --format '{{json .}}' 2>/dev/null
echo @@dangling; ${D} images -f dangling=true -q 2>/dev/null | sort -u | wc -l
echo @@networks; ${D} network ls -q -f dangling=true 2>/dev/null | wc -l
echo @@journal; command -v journalctl >/dev/null 2>&1 && { du -sk /var/log/journal /run/log/journal 2>/dev/null | awk '{s+=$1} END {print s+0}'; }
echo @@apt; command -v apt-get >/dev/null 2>&1 && { du -sk /var/cache/apt 2>/dev/null | cut -f1; }
echo @@dropcaches; [ -w /proc/sys/vm/drop_caches ] && echo yes
echo @@logs; ${bigLogsScript(server, appDirsOf(apps))}
true`,
    { quiet: true, timeout: 3 * 60000 },
  );
  const sec = sections(out);
  const docker = (sec.docker?.[0] || '').trim() || null;
  const df = (sec.df || [])
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        const j = JSON.parse(l);
        return { type: j.Type, total: Number(j.TotalCount) || 0, active: Number(j.Active) || 0, size: parseSize(j.Size), reclaimable: parseSize(j.Reclaimable) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const dfOf = (t) => df.find((x) => x.type === t) || { total: 0, active: 0, size: 0, reclaimable: 0 };
  const containers = docker ? await inspectAll(ctx, conn, server) : [];
  // Size of the dangling images: what "docker image prune" (without -a) would free.
  let danglingBytes = 0;
  if (docker && Number(sec.dangling?.[0]) > 0) {
    const sz = await root(ctx, conn, server, `${D} image ls -f dangling=true --format '{{.ID}} {{.Size}}' 2>/dev/null | sort -u`, { quiet: true, timeout: 60000 }).catch(() => '');
    for (const l of String(sz).split('\n')) danglingBytes += parseSize(l.split(' ').slice(1).join(' '));
  }
  return {
    docker,
    disk: parseDisk(sec.disk),
    mem: parseMem(sec.mem),
    df,
    buildCache: dfOf('Build Cache').reclaimable,
    images: { total: dfOf('Images').total, active: dfOf('Images').active, unused: dfOf('Images').reclaimable, dangling: Number(sec.dangling?.[0]) || 0, danglingBytes },
    networks: Number(sec.networks?.[0]) || 0,
    journal: sec.journal?.length ? Number(sec.journal[0]) * 1024 : null,
    apt: sec.apt?.length ? Number(sec.apt[0]) * 1024 : null,
    canDropCaches: (sec.dropcaches?.[0] || '').trim() === 'yes',
    logs: parseBig(sec.logs),
    stopped: stoppedContainers(containers, apps),
    apps,
  };
}

export async function previewCleanup(server) {
  const ctx = quietCtx();
  const conn = await connectTo(null, server);
  try {
    const s = await scan(ctx, conn, server);
    const laravel = await laravelApps(ctx, conn, server, s.apps);
    const top = s.docker ? (await topContainers(ctx, conn, server)).slice(0, 15) : [];
    return {
      server: { id: server.id, name: server.name },
      docker: s.docker,
      disk: s.disk,
      mem: s.mem,
      dockerDisk: s.df,
      buildCache: s.buildCache,
      images: s.images,
      networks: s.networks,
      journal: s.journal,
      apt: s.apt,
      canDropCaches: s.canDropCaches,
      logs: s.logs.slice(0, 50),
      logsTotal: s.logs.reduce((a, l) => a + l.size, 0),
      bigLogMb: BIG_LOG_MB,
      stopped: s.stopped.map(({ id, ...c }) => c),
      laravel: laravel.map((l) => ({ project: l.project, where: l.where, cached: l.cached })),
      top,
      schedule: getSchedule(server.id),
    };
  } finally {
    conn.end();
  }
}

/* ------------------------------------------------------------------ the job */

async function measure(ctx, conn, server) {
  const sec = sections(await root(ctx, conn, server, `echo @@disk; ${DISK}; echo @@mem; ${MEM}`, { quiet: true, timeout: 30000 }));
  return { disk: parseDisk(sec.disk), mem: parseMem(sec.mem) };
}

const diffText = (before, after) => {
  const d = (after?.disk?.avail ?? 0) - (before?.disk?.avail ?? 0);
  // Under 1 MB is just other programs writing a little meanwhile.
  return d >= 1048576 ? `${fmtBytes(d)} freed` : d <= -1048576 ? `disk free went down by ${fmtBytes(-d)} (other programs are writing)` : 'nothing freed';
};

defineJob('server-cleanup', async (ctx, p) => {
  const server = getServer(Number(p.server));
  if (!server) throw new Error('Server not found');
  const o = cleanupOptions(p);
  if (p.scheduled) ctx.log('Weekly cleanup (scheduled)');
  const conn = await connectTo(ctx, server);
  const D = rootDocker(server);
  try {
    ctx.step(`Look at ${server.name}`);
    const s = await scan(ctx, conn, server);
    const before = { disk: s.disk, mem: s.mem };
    const mem = (m) => (m ? `${fmtBytes(m.available)} of ${fmtBytes(m.total)} memory available${m.swap_total ? `, swap used ${fmtBytes(m.swap_used)}` : ''}` : 'memory ?');
    ctx.log(`Before: disk ${before.disk?.pct ?? '?'}% full (${fmtBytes(before.disk?.avail)} free) · ${mem(before.mem)}`);

    let last = before;
    const part = async (title, fn) => {
      ctx.throwIfCancelled();
      ctx.step(title);
      try {
        await fn();
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        ctx.warn(`${title}: ${e.message}`);
        return;
      }
      const now = await measure(ctx, conn, server).catch(() => null);
      if (now?.disk && last?.disk) ctx.log(`  → ${diffText(last, now)}`);
      if (now) last = now;
    };

    // 1. Docker. Volumes are never touched; running containers neither.
    if (s.docker) {
      if (o.containers) {
        const rm = s.stopped.filter((c) => !c.kept);
        const kept = s.stopped.filter((c) => c.kept);
        if (kept.length) ctx.log(`Kept (stopped, but part of a Switchboard project or a dashboard): ${kept.map((c) => c.name).join(', ')}`);
        if (rm.length) await part(`Remove ${rm.length} stopped container(s): ${rm.map((c) => c.name).join(', ')}`, () => root(ctx, conn, server, `${D} rm ${rm.map((c) => shq(c.id)).join(' ')}`));
        else ctx.log('No stopped containers to remove');
      }
      if (o.networks) await part('Remove unused Docker networks', () => root(ctx, conn, server, `${D} network prune -f`));
      if (o.buildCache) await part('Remove the Docker build cache (the next build may take a little longer)', () => root(ctx, conn, server, `${D} builder prune -af 2>&1 | tail -1`));
      if (o.allImages) await part('Remove every image no container uses', () => root(ctx, conn, server, `${D} image prune -af 2>&1 | tail -1`));
      else if (o.images) await part('Remove dangling images (no name, left over from builds)', () => root(ctx, conn, server, `${D} image prune -f 2>&1 | tail -1`));
    } else if (o.containers || o.networks || o.buildCache || o.images || o.allImages) ctx.log('Docker is not installed — Docker parts skipped');

    // 2. System.
    if (o.journal) {
      if (s.journal === null) ctx.log('journalctl not found — skipped');
      else await part('Keep only the last 7 days of system journal logs', () => root(ctx, conn, server, 'journalctl --vacuum-time=7d 2>&1 | tail -2'));
    }
    if (o.apt) {
      if (s.apt === null) ctx.log('apt-get not found — skipped');
      else await part('Remove downloaded package files (apt-get clean)', () => root(ctx, conn, server, 'apt-get clean'));
    }
    if (o.logs) {
      if (!s.logs.length) ctx.log(`No log files of ${BIG_LOG_MB} MB or more`);
      else
        await part(`Empty ${s.logs.length} big log file(s) (they stay, only their content goes)`, () =>
          root(ctx, conn, server, s.logs.map((l) => // Same real path as scanned (no symlink anywhere in it), so an app can't redirect this to a system file.
            `[ -f ${shq(l.path)} ] && [ "$(readlink -f ${shq(l.path)})" = ${shq(l.path)} ] && : > ${shq(l.path)} && printf '  %s  %s\\n' ${shq(fmtBytes(l.size))} ${shq(l.path)}`).join('\n') + '\ntrue'),
        );
    }

    // 3. Laravel caches of the projects on this server.
    if (o.laravel) {
      const apps = await laravelApps(ctx, conn, server, s.apps);
      if (!apps.length) ctx.log('No Laravel apps of Switchboard projects found on this server — skipped');
      for (const a of apps) {
        await part(`${a.project}: php artisan optimize:clear${a.cached ? ' + optimize' : ''} (${a.where})`, async () => {
          await runRemote(ctx, conn, artisanCmd(server, a.dep, 'optimize:clear'), { timeout: 5 * 60000 });
          // It was optimized before: build the config/route/view caches again, so the app stays fast.
          if (a.cached) await runRemote(ctx, conn, artisanCmd(server, a.dep, 'optimize'), { timeout: 5 * 60000 });
        });
      }
    }

    // 4. Memory.
    if (o.restart.length) {
      const containers = await inspectAll(ctx, conn, server);
      const sb = switchboardContainers(containers);
      for (const name of o.restart) {
        const c = containers.find((x) => String(x.Name || '').replace(/^\//, '') === name);
        if (!c) ctx.warn(`${name}: no such container — skipped`);
        else if (sb.self.includes(name)) ctx.warn(`${name} is this Switchboard dashboard — not restarted`);
        else if (!c.State?.Running) ctx.warn(`${name} is not running — skipped`);
        else await part(`Restart container ${name}`, () => root(ctx, conn, server, `${D} restart ${shq(name)}`));
      }
    }
    if (o.swap) {
      await part('Move swap back into memory (swapoff + swapon)', async () => {
        const m = (await measure(ctx, conn, server)).mem;
        if (!m?.swap_used) return ctx.log('  Swap is not in use — nothing to do');
        if ((m.available ?? 0) < m.swap_used + 256 * 1024 * 1024) {
          return ctx.warn(`  Not enough free memory (${fmtBytes(m.available)}) to take back ${fmtBytes(m.swap_used)} of swap — skipped`);
        }
        await root(ctx, conn, server, 'swapoff -a && swapon -a', { timeout: 15 * 60000 });
      });
    }
    if (o.dropCaches) {
      if (!s.canDropCaches) ctx.warn('Dropping the page cache is not possible here (/proc/sys/vm/drop_caches is read-only, e.g. inside a container) — skipped');
      else await part('Drop the page cache (Linux fills it again as files are read)', () => root(ctx, conn, server, 'sync; echo 3 > /proc/sys/vm/drop_caches'));
    }

    const after = await measure(ctx, conn, server);
    ctx.log(`After:  disk ${after.disk?.pct ?? '?'}% full (${fmtBytes(after.disk?.avail)} free) · ${mem(after.mem)}`);
    const freed = (after.disk?.avail ?? 0) - (before.disk?.avail ?? 0);
    const memFreed = (after.mem?.available ?? 0) - (before.mem?.available ?? 0);
    ctx.log(`Result: disk: ${diffText(before, after)}; memory available ${memFreed >= 0 ? '+' : '−'}${fmtBytes(Math.abs(memFreed))}`);
    logEvent('success', `Cleanup of ${server.name}: ${freed > 0 ? `${fmtBytes(freed)} disk freed` : 'done'}`, { serverId: server.id, jobId: ctx.id, user: ctx.user });
  } finally {
    conn.end();
  }
});

/* ------------------------------------------------------------------ weekly schedule */

/**
 * { "<serverId>": { cron, options } } — one row in the settings table, so no table change is needed.
 * Not a normal setting: the Settings page never sees or saves it.
 */
const SCHEDULE_KEY = 'cleanup_schedules';
export function getSchedules() {
  try {
    const v = JSON.parse(get('SELECT value FROM settings WHERE key = ?', SCHEDULE_KEY)?.value || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
export const getSchedule = (serverId) => getSchedules()[String(serverId)] || null;

export function setSchedule(serverId, value) {
  const all_ = { ...getSchedules() };
  if (value) all_[String(serverId)] = value;
  else delete all_[String(serverId)];
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', SCHEDULE_KEY, JSON.stringify(all_));
}

/** Called by the scheduler. Skips quietly when the server is gone or a cleanup is already queued. */
export function scheduledCleanup(serverId) {
  const server = getServer(Number(serverId));
  const sch = getSchedule(serverId);
  if (!server || !sch) return;
  const busy = all("SELECT params FROM jobs WHERE type = 'server-cleanup' AND status IN ('queued', 'running')").some((r) => {
    try {
      return JSON.parse(r.params).server === server.id;
    } catch {
      return false;
    }
  });
  if (busy) return;
  const o = cleanupOptions({ ...sch.options, restart: [] });
  enqueue({ type: 'server-cleanup', title: `Weekly cleanup: ${server.name}`, serverId: server.id, params: { server: server.id, ...o, scheduled: true }, user: 'scheduler' });
}

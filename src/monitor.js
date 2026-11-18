import fs from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import { config } from './config.js';
import { all, insert, run, update, now } from './db.js';
import { bus } from './bus.js';
import { getSetting } from './settings.js';
import { alert, logEvent } from './events.js';
import { enqueue, hasActiveJob } from './jobs.js';
import { connect, exec } from './ssh.js';
import { probe, certCheck } from './health.js';
import { deploymentsOf, deploymentsOnServer, getDeployment, getProject, parseJSON } from './models.js';
import { refreshDnsState, dnsTargetProblem } from './ops/dns.js';
import { dockerBin } from './ops/remote.js';
import { isLb, lbRuntime, rotationSig, saveRuntime } from './ops/lb.js';
import { inRotation } from './lb/nginx.js';
import { httpCheck } from './health.js';
import { getServer } from './models.js';
import { pollAllCi } from './ops/ci.js';
import { collectAllTraffic, pruneTraffic } from './ops/traffic.js';
import { cleanupLocal } from './ops/backupstore.js';
import { getSchedules, scheduledCleanup } from './ops/cleanup.js';
import { humanDuration, isoAgo } from './util.js';
import { checkBilling } from './billing.js';

/* ============================== HEALTH CHECKS ============================== */

async function checkAndRecord(project, dep) {
  const r = await probe(project, dep);
  const at = now();
  insert('checks', { deployment_id: dep.id, ok: r.ok ? 1 : 0, code: r.code, ms: r.ms, error: r.error, at });
  const threshold = Math.max(1, Number(project.failover_threshold) || 3);
  let fail = r.ok ? 0 : dep.fail_count + 1;
  let health;
  if (r.ok) health = 'up';
  else if (dep.maintenance && r.code === 503) {
    health = 'maintenance'; // expected: Switchboard put it in maintenance mode
    fail = 0;
  } else health = fail >= threshold ? 'down' : 'degraded';

  const patch = { health, fail_count: fail, checked_at: at, health_detail: JSON.stringify({ ...r, at }) };
  if (!r.ok && health !== 'maintenance' && !dep.down_since) patch.down_since = at;
  if (r.ok || health === 'maintenance') patch.down_since = null;
  update('deployments', dep.id, patch);

  const isActive = project.active_deployment_id === dep.id;
  const label = `${project.name} @ ${dep.server_name}${isActive ? ' (ACTIVE)' : ''}`;
  const ctx = { projectId: project.id, serverId: dep.server_id, link: `#/projects/${project.id}` };
  if (health === 'down' && dep.health !== 'down') alert(isActive ? 'error' : 'warn', `${label} is DOWN — ${r.error}`, ctx);
  if (health === 'up' && dep.health === 'down') {
    const since = dep.down_since ? ` after ${humanDuration(Date.now() - Date.parse(dep.down_since))}` : '';
    alert('success', `${label} is back UP${since}`, ctx);
  }
  return { ...r, health, deployment_id: dep.id };
}

const noStandbyAlerted = new Set();

/**
 * Load-balanced projects (own nginx): when a server goes down or comes back, rewrite the
 * nginx upstream so visitors only reach healthy servers. Cloudflare does this by itself.
 * Also checks the load balancer server itself (it's a single point of failure).
 */
async function evaluateLb(project) {
  if (project.lb_provider !== 'own') return;
  const deps = deploymentsOf(project.id);
  const rt = lbRuntime(project);
  const ctx = { projectId: project.id, link: `#/projects/${project.id}` };
  const sig = rotationSig(project, deps);
  if (rt.applied_sig && sig !== rt.applied_sig && !hasActiveJob(project.id)) {
    const on = new Set(inRotation(deps).map((d) => d.id));
    const out = deps.filter((d) => d.lb_state === 'active' && !on.has(d.id)).map((d) => d.server_name);
    const back = deps.filter((d) => on.has(d.id) && d.health === 'up').map((d) => d.server_name);
    alert(out.length ? 'warn' : 'info', `${project.name}: load balancer updated — ${out.length ? `taking out ${out.join(', ')} (down)` : 'all servers healthy'}; visitors go to ${back.join(', ') || 'the remaining servers'}`, ctx);
    enqueue({ type: 'lb-apply', title: `Update load balancer (${project.name})`, projectId: project.id, user: 'auto' });
  }
  const lb = getServer(project.lb_server_id);
  if (!lb) return;
  const r = await httpCheck({ ip: lb.ip, host: project.domain || lb.ip, scheme: 'http', port: 80, path: '/__switchboard_lb', expect: '200', timeoutMs: 8000 });
  const was = rt.lb_health;
  saveRuntime(project.id, { lb_health: r.ok ? 'up' : 'down', lb_checked_at: now(), lb_error: r.ok ? null : r.error });
  if (!r.ok && was !== 'down') alert('error', `${project.name}: the load balancer ${lb.name} (${lb.ip}) is DOWN — ${r.error}. Visitors can't reach the site!`, ctx);
  if (r.ok && was === 'down') alert('success', `${project.name}: the load balancer ${lb.name} is back up`, ctx);
}

/** Auto-failover: active server down + a healthy standby exists → switch (no DB copy). */
function evaluateFailover(projectId) {
  const project = getProject(projectId);
  if (isLb(project)) return evaluateLb(project); // the load balancer takes unhealthy servers out instead
  if (!project?.auto_failover || !project.active_deployment_id) return;
  const deps = deploymentsOf(projectId);
  const active = deps.find((d) => d.id === project.active_deployment_id);
  if (!active) return;
  if (active.health !== 'down') {
    noStandbyAlerted.delete(projectId);
    return;
  }
  if (hasActiveJob(projectId)) return; // a switch/sync is already running
  const cooldownMs = Math.max(0, Number(project.failover_cooldown) || 0) * 60000;
  if (project.last_failover_at && Date.now() - Date.parse(project.last_failover_at) < cooldownMs) return;
  // Healthy standbys first; standbys that Switchboard parked in maintenance mode also qualify
  // (the switch turns maintenance off and health-checks them before DNS is touched).
  const rank = (d) => (d.health === 'up' ? 0 : 1);
  const candidates = deps
    .filter((d) => d.id !== active.id && d.server_status !== 'down' && (d.health === 'up' || (d.health === 'maintenance' && d.maintenance)) && !dnsTargetProblem(project, d))
    .sort((a, b) => rank(a) - rank(b) || a.priority - b.priority || a.id - b.id);
  if (!candidates.length) {
    if (!noStandbyAlerted.has(projectId)) {
      noStandbyAlerted.add(projectId);
      alert('error', `${project.name}: active server ${active.server_name} is DOWN and there is no healthy standby to fail over to!`, {
        projectId,
        link: `#/projects/${projectId}`,
      });
    }
    return;
  }
  const target = candidates[0];
  update('projects', projectId, { last_failover_at: now() });
  alert('warn', `${project.name}: AUTO-FAILOVER starting — ${active.server_name} is down, switching traffic to ${target.server_name}`, {
    projectId,
    link: `#/projects/${projectId}`,
  });
  enqueue({
    type: 'switch',
    title: `Auto-failover ${project.name}: ${active.server_name} → ${target.server_name}`,
    projectId,
    params: { target: target.id, syncDb: false, syncFiles: false, maintenance: false, purgeCache: !!project.purge_cache, auto: true },
    user: 'auto-failover',
  });
}

let checking = false;
export async function runHealthChecks() {
  if (checking) return;
  checking = true;
  try {
    const projects = all('SELECT * FROM projects');
    await Promise.all(
      projects.map(async (p) => {
        const deps = deploymentsOf(p.id);
        await Promise.all(deps.map((d) => checkAndRecord(p, d).catch((e) => console.error('[health]', e))));
        await evaluateFailover(p.id);
      }),
    );
  } finally {
    checking = false;
    bus.emit('state', { health: true });
  }
}

/** Check one project now (button in the UI). */
export async function checkProjectNow(projectId) {
  const project = getProject(projectId);
  const results = await Promise.all(deploymentsOf(projectId).map((d) => checkAndRecord(project, d)));
  await evaluateFailover(projectId);
  bus.emit('state', { projectId });
  return results;
}

/* ============================== SERVER METRICS ============================== */

function metricsScript(server) {
  return [
    'echo "@@cpu"; head -1 /proc/stat; sleep 1; head -1 /proc/stat',
    'echo "@@load"; cat /proc/loadavg',
    'echo "@@nproc"; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo',
    'echo "@@mem"; grep -E "^(MemTotal|MemAvailable|SwapTotal|SwapFree):" /proc/meminfo',
    'echo "@@disk"; df -kP / | tail -1',
    'echo "@@uptime"; cat /proc/uptime',
    'echo "@@os"; ( . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" ) || uname -s',
    'echo "@@kernel"; uname -r',
    `echo "@@docker"; ${dockerBin(server)} ps -a --format '{{json .}}' 2>&1 | head -300`,
  ].join('\n');
}

function mapContainer(c) {
  const labels = {};
  for (const kv of String(c.Labels || '').split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) labels[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const status = String(c.Status || '');
  const health = /\(healthy\)/.test(status) ? 'healthy' : /\(unhealthy\)/.test(status) ? 'unhealthy' : /health: starting/.test(status) ? 'starting' : null;
  return {
    id: c.ID,
    name: c.Names,
    image: c.Image,
    state: c.State,
    status,
    health,
    ports: c.Ports || '',
    project: labels['com.docker.compose.project'] || null,
    service: labels['com.docker.compose.service'] || null,
    running_for: c.RunningFor || '',
  };
}

export function parseMetrics(out) {
  const sec = {};
  let cur = null;
  for (const line of out.split('\n')) {
    const m = line.match(/^@@(\w+)$/);
    if (m) {
      cur = m[1];
      sec[cur] = [];
    } else if (cur) sec[cur].push(line);
  }
  const res = {};
  const cpu = (sec.cpu || []).filter((l) => l.startsWith('cpu '));
  if (cpu.length === 2) {
    const nums = (l) => l.trim().split(/\s+/).slice(1).map(Number);
    const [a, b] = cpu.map(nums);
    const idle = (x) => x[3] + (x[4] || 0);
    const total = (x) => x.slice(0, 8).reduce((s, v) => s + (v || 0), 0);
    const dt = total(b) - total(a);
    res.cpu_pct = dt > 0 ? Math.round((1 - (idle(b) - idle(a)) / dt) * 1000) / 10 : null;
  }
  res.load = (sec.load?.[0] || '').split(' ').slice(0, 3).map(Number);
  res.cpus = parseInt(sec.nproc?.[0], 10) || null;
  const mem = {};
  for (const l of sec.mem || []) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) mem[m[1]] = Number(m[2]) * 1024;
  }
  res.mem_total = mem.MemTotal || null;
  res.mem_used = mem.MemTotal && mem.MemAvailable != null ? mem.MemTotal - mem.MemAvailable : null;
  res.mem_pct = res.mem_total ? Math.round((res.mem_used / res.mem_total) * 1000) / 10 : null;
  res.swap_total = mem.SwapTotal || 0;
  res.swap_used = (mem.SwapTotal || 0) - (mem.SwapFree || 0);
  const d = (sec.disk?.[0] || '').trim().split(/\s+/);
  if (d.length >= 5) {
    res.disk_total = Number(d[1]) * 1024;
    res.disk_used = Number(d[2]) * 1024;
    res.disk_avail = Number(d[3]) * 1024;
    res.disk_pct = parseInt(d[4], 10);
  }
  res.uptime_s = Math.round(parseFloat(sec.uptime?.[0]) || 0);
  res.os = (sec.os?.[0] || '').trim();
  res.kernel = (sec.kernel?.[0] || '').trim();
  res.containers = [];
  for (const l of (sec.docker || []).filter((x) => x.trim())) {
    if (!l.startsWith('{')) {
      res.docker_error = `${res.docker_error ? `${res.docker_error} ` : ''}${l.trim()}`.slice(0, 500);
      continue;
    }
    try {
      res.containers.push(mapContainer(JSON.parse(l)));
    } catch {}
  }
  res.containers.sort((x, y) => (x.project || '').localeCompare(y.project || '') || x.name.localeCompare(y.name));
  return res;
}

const sshFails = new Map();

export async function collectMetrics(server) {
  let conn;
  const prev = parseJSON(server.metrics);
  const ctx = { serverId: server.id, link: `#/servers/${server.id}` };
  try {
    conn = await connect(server, { timeout: 15000 });
    const r = await exec(conn, metricsScript(server), { timeout: 45000 });
    const m = parseMetrics(r.stdout);
    m.collected_at = now();
    update('servers', server.id, { status: 'up', status_error: null, metrics: JSON.stringify(m), checked_at: now() });
    sshFails.delete(server.id);
    if (server.status === 'down') alert('success', `Server ${server.name} is reachable over SSH again`, ctx);

    // Busy: CPU or memory high for a while → suggest adding a server to the load balancer.
    const cpuTh = Number(getSetting('busy_cpu_pct')) || 80;
    const memTh = Number(getSetting('busy_mem_pct')) || 90;
    const mins = Number(getSetting('busy_minutes')) || 0;
    const hot = (m.cpu_pct ?? 0) >= cpuTh || (m.mem_pct ?? 0) >= memTh;
    m.busy_since = hot ? prev?.busy_since || m.collected_at : null;
    m.busy = hot && Date.now() - Date.parse(m.busy_since) >= mins * 60000;
    update('servers', server.id, { metrics: JSON.stringify(m) });
    if (m.busy && !prev?.busy) {
      const lbProjects = deploymentsOnServer(server.id)
        .map((d) => getProject(d.project_id))
        .filter((p) => isLb(p));
      const why = [(m.cpu_pct ?? 0) >= cpuTh ? `CPU ${m.cpu_pct}%` : null, (m.mem_pct ?? 0) >= memTh ? `memory ${m.mem_pct}%` : null].filter(Boolean).join(', ');
      const hint = lbProjects.length
        ? ` Add a server to the load balancer of ${lbProjects.map((p) => p.name).join(', ')} (project → Traffic → Add server).`
        : ' Turn on load balancing for its projects to spread the load over more servers.';
      alert('warn', `Server ${server.name} is BUSY for ${mins} min: ${why}.${hint}`, { ...ctx, link: lbProjects.length ? `#/projects/${lbProjects[0].id}` : ctx.link });
    } else if (!m.busy && prev?.busy) {
      alert('success', `Server ${server.name} is calm again (CPU ${m.cpu_pct ?? '?'}%, memory ${m.mem_pct ?? '?'}%)`, ctx);
    }

    const limit = Number(getSetting('disk_alert_pct')) || 90;
    if (m.disk_pct >= limit && !(prev?.disk_pct >= limit)) alert('warn', `Server ${server.name}: disk is ${m.disk_pct}% full — free up space with More → Clean up`, { ...ctx, link: `#/servers/${server.id}?cleanup=1` });
    if (prev?.containers) {
      const before = new Map(prev.containers.map((c) => [c.name, c]));
      for (const c of m.containers) {
        const old = before.get(c.name);
        if (!old) continue;
        if (old.state === 'running' && c.state !== 'running') alert('warn', `Server ${server.name}: container ${c.name} is ${c.state} (${c.status})`, ctx);
        else if (c.health === 'unhealthy' && old.health !== 'unhealthy') alert('warn', `Server ${server.name}: container ${c.name} is unhealthy`, ctx);
      }
    }
    return m;
  } catch (e) {
    const n = (sshFails.get(server.id) || 0) + 1;
    sshFails.set(server.id, n);
    // A server that was up needs two failures in a row before it's called down (ignores one network blip).
    const wasUp = server.status === 'up';
    if (!wasUp || n >= 2) update('servers', server.id, { status: 'down', status_error: e.message, checked_at: now() });
    if (wasUp && n >= 2) alert('error', `Server ${server.name}: SSH unreachable — ${e.message}`, ctx);
    throw e;
  } finally {
    conn?.end();
    bus.emit('state', { serverId: server.id });
  }
}

async function collectLbMetrics() {
  if ((Number(getSetting('metrics_interval')) || 300) <= 60) return;
  const ids = all("SELECT DISTINCT d.server_id AS id FROM deployments d JOIN projects p ON p.id = d.project_id WHERE p.traffic_mode = 'lb' AND d.lb_state <> 'off'");
  await Promise.all(ids.map((r) => getServer(r.id)).filter(Boolean).map((s) => collectMetrics(s).catch(() => {})));
}

export async function collectAllMetrics() {
  const servers = all('SELECT * FROM servers');
  await Promise.all(servers.map((s) => collectMetrics(s).catch(() => {})));
}

/* ============================== DNS + SSL ============================== */

export async function checkAllDns() {
  if (!getSetting('cf_token')) return;
  for (const p of all("SELECT id FROM projects WHERE dns_records <> '[]'")) {
    await refreshDnsState(p.id).catch((e) => console.error('[dns]', e.message));
  }
}

async function checkSsl(project) {
  if (!project.domain || project.health_scheme === 'http') return;
  const deps = deploymentsOf(project.id);
  const state = { checked_at: now(), edge: await certCheck({ host: project.domain, servername: project.domain }), origins: {} };
  for (const d of deps) {
    state.origins[d.id] = { server: d.server_name, ...(await certCheck({ host: d.server_ip, servername: project.domain, port: project.health_port || 443 })) };
  }
  const limit = Number(getSetting('ssl_alert_days')) || 14;
  const warnings = [];
  if (state.edge.ok && state.edge.days_left <= limit) warnings.push(`public certificate expires in ${state.edge.days_left} days`);
  for (const o of Object.values(state.origins)) {
    if (o.ok && o.days_left <= limit) warnings.push(`certificate on ${o.server} expires in ${o.days_left} days`);
  }
  const prev = parseJSON(project.ssl_state) || {};
  const key = warnings.join('; ');
  state.alerted = key || null;
  if (key && key !== prev.alerted) alert('warn', `${project.name}: ${key}`, { projectId: project.id, link: `#/projects/${project.id}` });
  update('projects', project.id, { ssl_state: JSON.stringify(state) });
}

export async function checkAllSsl() {
  for (const p of all('SELECT * FROM projects')) await checkSsl(p).catch((e) => console.error('[ssl]', e.message));
}

/* ============================== SCHEDULES ============================== */

const crons = new Map();
const cleanupCrons = new Map(); // serverId -> Cron

function scheduledBackup(projectId) {
  const p = getProject(projectId);
  if (p?.db_server_id) {
    enqueue({ type: 'backup', title: `Scheduled backup: ${p.name} @ database server`, projectId, params: { shared: true, kind: 'scheduled' }, user: 'scheduler' });
    return;
  }
  if (!p?.active_deployment_id) return;
  const dep = getDeployment(p.active_deployment_id);
  if (!dep || dep.db_type === 'none') return;
  enqueue({
    type: 'backup',
    title: `Scheduled backup: ${p.name} @ ${dep.server_name}`,
    projectId,
    params: { deployment: dep.id, kind: 'scheduled' },
    user: 'scheduler',
  });
}

/** Warm standby: copy the active DB to every standby server on a schedule. */
function scheduledSync(projectId) {
  const p = getProject(projectId);
  if (!p?.active_deployment_id || p.db_server_id) return; // shared database: nothing to copy
  const deps = deploymentsOf(projectId);
  const src = deps.find((d) => d.id === p.active_deployment_id);
  if (!src || src.db_type === 'none' || src.health === 'down') return;
  for (const t of deps) {
    if (t.id === src.id || t.db_type === 'none') continue;
    enqueue({
      type: 'sync',
      title: `Scheduled copy: ${p.name} ${src.server_name} → ${t.server_name}`,
      projectId,
      params: { source: src.id, target: t.id, db: true, files: !!p.sync_files_scheduled, backupTarget: false, scheduled: true },
      user: 'scheduler',
    });
  }
}

export function reloadSchedules() {
  for (const set of crons.values()) Object.values(set).forEach((c) => c.stop());
  crons.clear();
  for (const p of all('SELECT id, name, backup_schedule, sync_schedule FROM projects')) {
    const set = {};
    for (const [kind, expr, fn] of [
      ['backup', p.backup_schedule, scheduledBackup],
      ['sync', p.sync_schedule, scheduledSync],
    ]) {
      if (!expr) continue;
      try {
        set[kind] = new Cron(expr, { protect: true }, () => fn(p.id));
      } catch (e) {
        console.warn(`[schedule] invalid ${kind} schedule for ${p.name}: ${e.message}`);
      }
    }
    crons.set(p.id, set);
  }
  // Weekly server cleanup (server page → More → Clean up / free memory).
  for (const c of cleanupCrons.values()) c.stop();
  cleanupCrons.clear();
  for (const [id, sch] of Object.entries(getSchedules())) {
    if (!sch?.cron) continue;
    try {
      cleanupCrons.set(Number(id), new Cron(sch.cron, { protect: true }, () => scheduledCleanup(Number(id))));
    } catch (e) {
      console.warn(`[schedule] invalid cleanup schedule for server ${id}: ${e.message}`);
    }
  }
}

export const nextCleanup = (serverId) => cleanupCrons.get(Number(serverId))?.nextRun()?.toISOString() || null;

export function nextRuns(projectId) {
  const set = crons.get(projectId) || {};
  return { backup: set.backup?.nextRun()?.toISOString() || null, sync: set.sync?.nextRun()?.toISOString() || null };
}

export function validateCron(expr) {
  if (!expr) return null;
  const c = new Cron(expr, { paused: true });
  const next = c.nextRun();
  c.stop();
  return next ? next.toISOString() : null;
}

/* ============================== HOUSEKEEPING ============================== */

function prune() {
  const days = Number(getSetting('history_days')) || 14;
  run('DELETE FROM checks WHERE at < ?', isoAgo(days * 864e5));
  run('DELETE FROM events WHERE at < ?', isoAgo(90 * 864e5));
  run("DELETE FROM jobs WHERE status NOT IN ('queued', 'running') AND created_at < ?", isoAgo(90 * 864e5));
  run('DELETE FROM sessions WHERE expires_at < ?', now());
  pruneTraffic();
  for (const dir of [config.tmpDir, ...fs.readdirSync(config.backupDir).map((d) => path.join(config.backupDir, d))]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (f.endsWith('.part') && Date.now() - fs.statSync(full).mtimeMs > 864e5) fs.rmSync(full, { force: true });
      }
    } catch {}
  }
}

/* ============================== LOOPS ============================== */

const timers = {};
function loop(name, intervalSec, fn, firstDelayMs) {
  const tick = async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`[${name}]`, e);
    } finally {
      timers[name] = setTimeout(tick, Math.max(10, Number(intervalSec()) || 60) * 1000);
    }
  };
  timers[name] = setTimeout(tick, firstDelayMs);
}

export function startMonitor() {
  loop('health', () => getSetting('check_interval'), runHealthChecks, 2000);
  loop('metrics', () => getSetting('metrics_interval'), collectAllMetrics, 4000);
  // Servers behind a load balancer: every minute, so "busy" is noticed quickly.
  loop('metrics-lb', () => 60, collectLbMetrics, 30000);
  loop('dns', () => getSetting('dns_interval'), checkAllDns, 6000);
  loop('ssl', () => 6 * 3600, checkAllSsl, 15000);
  loop('prune', () => 3600, prune, 60000);
  loop('ci', () => 60, pollAllCi, 20000); // GitHub Actions results + pull request previews
  loop('traffic', () => 60, collectAllTraffic, 25000);
  loop('billing', () => 3600, () => checkBilling(), 50000); // server payment reminders (each sent once per due date)
  loop('backup-store', () => 600, () => cleanupLocal(), 45000); // S3: retry failed uploads, remove local copies that are in S3 // nginx access logs → Traffic tab + unusual-activity alerts
  reloadSchedules();
  logEvent('info', 'Switchboard started');
}

export function stopMonitor() {
  for (const t of Object.values(timers)) clearTimeout(t);
  for (const set of crons.values()) Object.values(set).forEach((c) => c.stop());
  for (const c of cleanupCrons.values()) c.stop();
}

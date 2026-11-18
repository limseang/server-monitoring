import { all, get, run, update, insert } from '../db.js';
import { getSetting } from '../settings.js';
import { isoAgo } from '../util.js';

/**
 * Usage history: every time Switchboard reads a server's stats (Settings → "Server stats every",
 * every minute for servers behind a load balancer) it keeps one row of CPU / memory / GPU /
 * network here. When the server is "busy" (CPU or memory above the limits for a while) it also
 * writes a busy time — when it started, when it ended, how high it went and how many requests
 * came in — so you can look back and see WHEN a server had a lot of traffic, and whether more
 * servers (load balancer) or a restart is the right fix.
 */

const KEEP_STATS_DAYS = 35;
const KEEP_BUSY_DAYS = 400;

const pct = (v) => (Number.isFinite(v) ? v : null);

/** Called by collectMetrics() after each successful read. `m` already has busy / busy_since. */
export function recordUsage(server, m, prev, { cpuTh, memTh }) {
  const at = m.collected_at;
  run(
    'INSERT OR REPLACE INTO server_stats (server_id, at, cpu, mem, swap, load1, disk, gpu, gpu_mem, net_rx, net_tx) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    server.id,
    at,
    pct(m.cpu_pct),
    pct(m.mem_pct),
    m.swap_total ? Math.round((m.swap_used / m.swap_total) * 1000) / 10 : null,
    Array.isArray(m.load) && Number.isFinite(m.load[0]) ? m.load[0] : null,
    pct(m.disk_pct),
    pct(m.gpu_pct),
    pct(m.gpu_mem_pct),
    Number.isFinite(m.net_rx) ? m.net_rx : null,
    Number.isFinite(m.net_tx) ? m.net_tx : null,
  );

  let open = get('SELECT * FROM busy_periods WHERE server_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', server.id);
  if (m.busy && !open) {
    const id = insert('busy_periods', { server_id: server.id, started_at: m.busy_since || at });
    open = get('SELECT * FROM busy_periods WHERE id = ?', id);
  }
  if (!open) return;
  const patch = {
    peak_cpu: Math.max(open.peak_cpu ?? 0, m.cpu_pct ?? 0),
    peak_mem: Math.max(open.peak_mem ?? 0, m.mem_pct ?? 0),
    peak_gpu: m.gpu_pct != null || open.peak_gpu != null ? Math.max(open.peak_gpu ?? 0, m.gpu_pct ?? 0) : null,
  };
  if (!m.busy) patch.ended_at = at;
  Object.assign(patch, trafficDuring(server.id, open.started_at, patch.ended_at || at));
  patch.cause = causeOf({ ...open, ...patch }, { cpuTh, memTh });
  update('busy_periods', open.id, patch);
}

/** Requests (from the nginx logs, Traffic tab) during a busy time vs. the 24 hours before it. */
function trafficDuring(serverId, from, to) {
  const f = from.slice(0, 16);
  const t = to.slice(0, 16);
  const r = get('SELECT SUM(req) AS req, MAX(req) AS peak, COUNT(*) AS n FROM traffic WHERE server_id = ? AND minute >= ? AND minute <= ?', serverId, f, t);
  const before = get('SELECT SUM(req) AS req, COUNT(*) AS n FROM traffic WHERE server_id = ? AND minute >= ? AND minute < ?', serverId, new Date(Date.parse(from) - 864e5).toISOString().slice(0, 16), f);
  if (!r?.n && !before?.n) return { requests: null, peak_rpm: null, avg_rpm: null, baseline_rpm: null };
  const mins = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
  return {
    requests: r.req || 0,
    peak_rpm: r.peak || 0,
    avg_rpm: Math.round(((r.req || 0) / mins) * 10) / 10,
    baseline_rpm: Math.round(((before?.req || 0) / 1440) * 10) / 10,
  };
}

/**
 * Why was it busy?
 *  traffic → clearly more requests than usual: add a server to the load balancer (or a bigger one)
 *  memory  → memory full but traffic normal: an app holding memory — a restart / clean-up frees it
 *  cpu     → CPU high but traffic normal: a heavy job (queue, cron, backup) or a stuck process
 */
export function causeOf(p, { cpuTh, memTh }) {
  if (p.avg_rpm != null && p.avg_rpm >= 5 && p.avg_rpm >= Math.max(1, p.baseline_rpm || 0) * 1.5) return 'traffic';
  if ((p.peak_mem ?? 0) >= memTh && (p.peak_cpu ?? 0) < cpuTh) return 'memory';
  return 'cpu';
}

export function pruneUsage() {
  run('DELETE FROM server_stats WHERE at < ?', isoAgo(KEEP_STATS_DAYS * 864e5));
  run('DELETE FROM busy_periods WHERE started_at < ?', isoAgo(KEEP_BUSY_DAYS * 864e5));
}

/* ------------------------------------------------------------------ reading it back */
const avg = (a) => (a.length ? Math.round((a.reduce((s, v) => s + v, 0) / a.length) * 10) / 10 : null);
const max = (a) => (a.length ? Math.max(...a) : null);
const nums = (rows, k) => rows.map((r) => r[k]).filter((v) => v != null);

export function usageSummary(serverId, minutes) {
  const cpuTh = Number(getSetting('busy_cpu_pct')) || 80;
  const memTh = Number(getSetting('busy_mem_pct')) || 90;
  const fromIso = isoAgo(minutes * 60000);
  const rows = all('SELECT * FROM server_stats WHERE server_id = ? AND at >= ? ORDER BY at', serverId, fromIso);
  const traffic = all('SELECT minute, req FROM traffic WHERE server_id = ? AND minute >= ?', serverId, fromIso.slice(0, 16));

  const buckets = Math.min(minutes, 120);
  const size = minutes / buckets; // minutes per point
  const start = Date.parse(fromIso);
  const idx = (ms) => Math.min(buckets - 1, Math.max(0, Math.floor((ms - start) / (size * 60000))));
  const groups = Array.from({ length: buckets }, () => []);
  for (const r of rows) groups[idx(Date.parse(r.at))].push(r);
  const req = new Array(buckets).fill(0);
  let hasTraffic = false;
  for (const t of traffic) {
    req[idx(Date.parse(`${t.minute}:00Z`))] += t.req;
    hasTraffic = true;
  }
  const series = groups.map((g, i) => ({
    t: new Date(start + i * size * 60000).toISOString(),
    n: g.length,
    cpu: avg(nums(g, 'cpu')),
    cpu_max: max(nums(g, 'cpu')),
    mem: avg(nums(g, 'mem')),
    mem_max: max(nums(g, 'mem')),
    gpu: avg(nums(g, 'gpu')),
    net_rx: avg(nums(g, 'net_rx')),
    net_tx: avg(nums(g, 'net_tx')),
    rpm: hasTraffic ? Math.round((req[i] / size) * 10) / 10 : null,
  }));

  const periods = all('SELECT * FROM busy_periods WHERE server_id = ? ORDER BY started_at DESC LIMIT 100', serverId);
  const nowMs = Date.now();
  const inRange = periods.filter((p) => !p.ended_at || Date.parse(p.ended_at) >= start);
  const busyMs = inRange.reduce((s, p) => s + Math.max(0, (p.ended_at ? Date.parse(p.ended_at) : nowMs) - Math.max(start, Date.parse(p.started_at))), 0);

  const cpuAll = nums(rows, 'cpu');
  const memAll = nums(rows, 'mem');
  const summary = {
    samples: rows.length,
    cpu_avg: avg(cpuAll),
    cpu_peak: max(cpuAll),
    mem_avg: avg(memAll),
    mem_peak: max(memAll),
    gpu_peak: max(nums(rows, 'gpu')),
    net_peak: max(rows.map((r) => (r.net_rx ?? 0) + (r.net_tx ?? 0)).filter((v) => v > 0)),
    busy_count: inRange.length,
    busy_minutes: Math.round(busyMs / 60000),
    rpm_avg: hasTraffic ? Math.round((traffic.reduce((s, t) => s + t.req, 0) / minutes) * 10) / 10 : null,
    rpm_peak: hasTraffic ? Math.max(...traffic.map((t) => t.req)) : null,
  };
  return {
    minutes,
    per_point: size,
    thresholds: { cpu: cpuTh, mem: memTh, minutes: Number(getSetting('busy_minutes')) || 0 },
    interval: Number(getSetting('metrics_interval')) || 300,
    has_gpu: rows.some((r) => r.gpu != null),
    has_net: rows.some((r) => r.net_rx != null),
    series,
    summary,
    periods: periods.map((p) => ({ ...p, minutes: Math.round(((p.ended_at ? Date.parse(p.ended_at) : nowMs) - Date.parse(p.started_at)) / 60000) })),
    advice: adviceFor(summary, inRange, { cpuTh, memTh }),
  };
}

/** One plain sentence: what to do about it. */
function adviceFor(s, periods, { cpuTh, memTh }) {
  if (!s.samples) return { level: 'info', text: 'No history yet — it fills in from the next stats check.' };
  const causes = periods.reduce((o, p) => ((o[p.cause] = (o[p.cause] || 0) + 1), o), {});
  if (periods.some((p) => !p.ended_at)) {
    const p = periods.find((x) => !x.ended_at);
    return { level: 'bad', cause: p.cause, text: CAUSE_TEXT[p.cause] ? `Busy right now. ${CAUSE_TEXT[p.cause]}` : 'Busy right now.' };
  }
  if (causes.traffic >= 2) return { level: 'warn', cause: 'traffic', text: `Busy ${causes.traffic} times because of high traffic. ${CAUSE_TEXT.traffic}` };
  if (causes.memory >= 2) return { level: 'warn', cause: 'memory', text: `Memory filled up ${causes.memory} times while traffic was normal. ${CAUSE_TEXT.memory}` };
  if (periods.length) {
    const c = periods[0].cause;
    return { level: 'warn', cause: c, text: `Busy ${periods.length} time${periods.length > 1 ? 's' : ''} in this period. ${CAUSE_TEXT[c] || ''}` };
  }
  if ((s.cpu_peak ?? 0) >= cpuTh * 0.85 || (s.mem_peak ?? 0) >= memTh * 0.95) return { level: 'warn', text: 'Never busy for long, but it came close to the limit. Keep an eye on it — if traffic grows, add a server to the load balancer.' };
  return { level: 'good', text: `Plenty of room: CPU peaked at ${s.cpu_peak ?? '?'}%, memory at ${s.mem_peak ?? '?'}%. No need for more servers.` };
}

const CAUSE_TEXT = {
  traffic: 'More visitors than this server can handle → add a server to the load balancer (project → Traffic → Add server) or move to a bigger server.',
  memory: 'Traffic was normal, so an app is probably holding on to memory → restart the containers or use More → Clean up / free memory. If it keeps coming back, the app may have a memory leak.',
  cpu: 'Traffic was normal, so something on the server is working hard (queue worker, cron job, backup, a stuck process) → check the Containers tab; a restart usually helps.',
};

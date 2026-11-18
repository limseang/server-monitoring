import { connect, exec } from './ssh.js';
import { getServer } from './models.js';
import { getSetting } from './settings.js';
import { parseMetrics } from './monitor.js';
import { collectTraffic, logCommand } from './ops/traffic.js';
import { asRoot } from './ops/remote.js';

/**
 * Live views. While a browser has a server's page open, Switchboard watches that server more
 * closely and pushes what it sees over Server-Sent Events:
 *   - metrics: ONE long-running SSH command prints CPU / memory / GPU / network every 2 seconds
 *   - traffic: the nginx logs are read every 5 seconds instead of every minute
 *   - logs:    `tail -F` / `docker logs -f` streams new log lines as they are written
 * Nothing runs when nobody is looking. Several viewers of the same server share one watcher.
 * Live readings are not stored — the normal metrics loop keeps recording the history.
 */

export const METRICS_EVERY = 2; // seconds
export const TRAFFIC_EVERY = 5;
const HISTORY = 150; // live samples kept for a viewer who joins (5 minutes)
const GRACE_MS = 15000; // keep a watcher running briefly after the last viewer leaves (tab switches, reconnects)
const RETRY_MS = 10000;

/* ------------------------------------------------------------------ shared watchers */
const hubs = new Map(); // key → { subs, stop, timer, history, error }

function join(key, start, listener) {
  let h = hubs.get(key);
  if (!h) {
    h = { subs: new Set(), stop: null, timer: null, history: [], error: null };
    hubs.set(key, h);
  }
  clearTimeout(h.timer);
  h.subs.add(listener);
  if (!h.stop) {
    const emit = (event, data) => {
      for (const fn of h.subs) fn(event, data);
    };
    h.stop = start(h, emit);
  }
  return {
    hub: h,
    leave() {
      h.subs.delete(listener);
      if (h.subs.size) return;
      clearTimeout(h.timer);
      h.timer = setTimeout(() => {
        if (h.subs.size) return;
        h.stop?.();
        hubs.delete(key);
      }, GRACE_MS);
    },
  };
}

/** Number of running watchers (tests). */
export const activeWatchers = () => hubs.size;

/* ------------------------------------------------------------------ metrics */
const SAMPLE_SCRIPT = `i=0
while [ $i -lt 1800 ]; do
  i=$((i+1))
  echo @@uptime; cat /proc/uptime
  echo @@cpu; head -1 /proc/stat
  echo @@net; cat /proc/net/dev 2>/dev/null
  echo @@gpu; command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null
  echo @@load; cat /proc/loadavg
  echo @@nproc; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
  echo @@mem; grep -E "^(MemTotal|MemAvailable|SwapTotal|SwapFree):" /proc/meminfo
  echo @@disk; df -kP / | tail -1
  echo @@done
  sleep ${METRICS_EVERY}
done`;

function sections(block) {
  const sec = {};
  let cur = null;
  for (const line of block.split('\n')) {
    const m = line.match(/^@@(\w+)$/);
    if (m) sec[(cur = m[1])] = [];
    else if (cur) sec[cur].push(line);
  }
  return sec;
}

/** One live reading from two blocks of the sampler (CPU and network need the difference). */
export function liveSample(prev, cur) {
  const a = sections(prev);
  const b = sections(cur);
  const text = [
    '@@net1', ...(a.net || []),
    '@@cpu', ...(a.cpu || []), ...(b.cpu || []),
    '@@net2', ...(b.net || []),
    '@@gpu', ...(b.gpu || []),
    '@@load', ...(b.load || []),
    '@@nproc', ...(b.nproc || []),
    '@@mem', ...(b.mem || []),
    '@@disk', ...(b.disk || []),
    '@@uptime', ...(b.uptime || []),
  ].join('\n');
  const m = parseMetrics(text);
  const dt = parseFloat(b.uptime?.[0]) - parseFloat(a.uptime?.[0]);
  const perSec = (v) => (v == null || !(dt > 0) ? null : Math.round(v / dt));
  return {
    t: new Date().toISOString(),
    cpu: m.cpu_pct ?? null,
    mem: m.mem_pct ?? null,
    gpu: m.gpu_pct ?? null,
    net_rx: perSec(m.net_rx),
    net_tx: perSec(m.net_tx),
    load: m.load,
    cpus: m.cpus,
    mem_used: m.mem_used,
    mem_total: m.mem_total,
    swap_used: m.swap_used,
    swap_total: m.swap_total,
    disk_pct: m.disk_pct ?? null,
    disk_avail: m.disk_avail ?? null,
    disk_total: m.disk_total ?? null,
    uptime_s: m.uptime_s,
  };
}

function startMetrics(serverId, h, emit) {
  let stopped = false;
  let ctrl = null;
  let retry = null;
  async function run() {
    const server = getServer(serverId);
    if (!server || stopped) return;
    ctrl = new AbortController();
    let conn;
    let buf = '';
    let prev = null;
    try {
      conn = await connect(server, { timeout: 15000 });
      if (stopped) return;
      await exec(conn, SAMPLE_SCRIPT, {
        signal: ctrl.signal,
        maxBuffer: 0, // streamed, nothing kept
        onStdout(d) {
          buf += d.toString('utf8');
          let i;
          while ((i = buf.indexOf('@@done\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 7);
            if (prev) {
              const s = liveSample(prev, block);
              h.history.push(s);
              if (h.history.length > HISTORY) h.history.shift();
              if (h.error) emit('status', { ok: true });
              h.error = null;
              emit('sample', s);
            }
            prev = block;
          }
          if (buf.length > 1e6) buf = ''; // never happens with the script above; stay safe
        },
      });
    } catch (e) {
      if (!stopped) {
        h.error = e.message;
        emit('status', { ok: false, error: e.message });
      }
    } finally {
      conn?.end();
    }
    // The command ends by itself after an hour (or when the connection drops): start again.
    if (!stopped) retry = setTimeout(run, h.error ? RETRY_MS : 0);
  }
  run();
  return () => {
    stopped = true;
    clearTimeout(retry);
    ctrl?.abort();
  };
}

/* ------------------------------------------------------------------ traffic */
function startTraffic(serverId, h, emit) {
  let stopped = false;
  let timer = null;
  async function tick() {
    const server = getServer(serverId);
    if (stopped || !server) return;
    if (!Number(getSetting('traffic_enabled'))) {
      emit('status', { ok: false, error: 'Reading traffic is turned off (Settings → Monitoring)' });
    } else {
      try {
        const n = await collectTraffic(server);
        h.error = null;
        emit('traffic', { new_requests: n, at: new Date().toISOString() });
      } catch (e) {
        h.error = e.message;
        emit('status', { ok: false, error: e.message });
      }
    }
    if (!stopped) timer = setTimeout(tick, (h.error ? RETRY_MS / 1000 : TRAFFIC_EVERY) * 1000);
  }
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * Live server view: send(event, data) gets 'init', 'sample', 'traffic' and 'status' events.
 * Returns a function that stops listening.
 */
export function watchServer(server, { metrics, traffic }, send) {
  const leaves = [];
  if (metrics) {
    const { hub, leave } = join(`m:${server.id}`, (h, emit) => startMetrics(server.id, h, emit), (e, d) => send(e, { topic: 'metrics', ...d }));
    send('init', { topic: 'metrics', every: METRICS_EVERY, samples: hub.history, error: hub.error });
    leaves.push(leave);
  }
  if (traffic) {
    const { hub, leave } = join(`t:${server.id}`, (h, emit) => startTraffic(server.id, h, emit), (e, d) => send(e, { topic: 'traffic', ...d }));
    send('init', { topic: 'traffic', every: TRAFFIC_EVERY, error: hub.error });
    leaves.push(leave);
  }
  return () => leaves.forEach((l) => l());
}

/* ------------------------------------------------------------------ logs */
const MAX_BATCH = 1000; // lines per push; a log that writes faster than this is cut (the browser says so)

/**
 * Stream a log: first its last `lines` lines, then every new line. send(event, data) gets
 * 'lines' ({ lines, skipped }) and 'end' ({ error }). Returns a stop function.
 */
export function tailLog(server, { source, lines = 200, q = '' }, send) {
  const needle = String(q || '').toLowerCase();
  const n = needle ? Math.min(2000, lines * 5) : lines;
  const cmd = logCommand(server, source, n, true); // throws on a bad source → 400 before streaming starts
  const ctrl = new AbortController();
  let pending = [];
  let skipped = 0;
  let partial = '';
  let first = true;
  const flush = () => {
    if (!pending.length && !skipped) return;
    let out = pending;
    if (first && needle) out = out.slice(-lines); // the first batch is the "last N matches"
    if (out.length > MAX_BATCH) {
      skipped += out.length - MAX_BATCH;
      out = out.slice(-MAX_BATCH);
    }
    send('lines', { lines: out, skipped, first });
    first = false;
    pending = [];
    skipped = 0;
  };
  // the first lines go out quickly; after that a few times a second
  const timer = setInterval(flush, 300);
  const add = (line) => {
    if (needle && !line.toLowerCase().includes(needle)) return;
    pending.push(line);
    if (pending.length > MAX_BATCH * 2) {
      skipped += pending.length - MAX_BATCH;
      pending = pending.slice(-MAX_BATCH);
    }
  };
  (async () => {
    let conn;
    let error = null;
    try {
      conn = await connect(server, { timeout: 15000 });
      const r = await exec(conn, asRoot(server, cmd), {
        signal: ctrl.signal,
        maxBuffer: 0,
        onStdout(d) {
          const parts = (partial + d.toString('utf8')).split('\n');
          partial = parts.pop();
          parts.forEach(add);
        },
      });
      if (partial) add(partial);
      if (r.code) error = `The log command stopped (exit ${r.code})`;
    } catch (e) {
      if (!ctrl.signal.aborted) error = e.message;
    } finally {
      conn?.end();
      clearInterval(timer);
      if (!ctrl.signal.aborted) {
        flush();
        send('end', { error: error || 'The log stream ended' });
      }
    }
  })();
  return () => {
    clearInterval(timer);
    ctrl.abort();
  };
}

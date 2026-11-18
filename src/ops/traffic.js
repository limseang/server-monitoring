import { all, get, run, update } from '../db.js';
import { bus } from '../bus.js';
import { alert } from '../events.js';
import { getServer, parseJSON } from '../models.js';
import { getSetting } from '../settings.js';
import { connect, exec, shq } from '../ssh.js';
import { asRoot, dockerBin } from './remote.js';
import { isoAgo } from '../util.js';

/**
 * Traffic: every minute Switchboard reads what is NEW in each server's nginx access logs (it
 * remembers where it stopped), counts requests per minute by status, and keeps the top pages,
 * IPs and user agents. Then it looks for unusual activity and alerts.
 * Nothing is installed on the server: it's `tail -c +<offset>` over SSH.
 */

const READ_LIMIT = 8 * 1024 * 1024; // max new log bytes per file per minute (busier logs are sampled from the end)
const EDGE = 'switchboard-edge';
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const SELF_UA = /^Switchboard-HealthCheck/;

/* ------------------------------------------------------------------ parsing */
// combined log format (+ anything extra at the end, e.g. $request_time)
const LINE = /^(\S+) \S+ \S+ \[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):\d{2} ([+-]\d{4})\] "(?:(\S+) (\S+)[^"]*|[^"]*)" (\d{3}) (\d+|-)(?: "([^"]*)" "([^"]*)")?(.*)$/;

export function parseLine(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  const [, ip, dd, mon, yyyy, hh, mi, tz, method, path, status, bytes, , ua, rest] = m;
  const off = (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3)));
  const t = Date.UTC(Number(yyyy), MONTHS[mon] ?? 0, Number(dd), Number(hh), Number(mi)) - off * 60000;
  const rt = (rest || '').match(/(?:^|\s)(?:rt=|request_time=)?(\d+\.\d{3})(?:\s|$)/);
  return {
    ip,
    minute: new Date(t).toISOString().slice(0, 16),
    method: method || '',
    path: (path || '').split('?')[0].slice(0, 120) || '-',
    status: Number(status),
    bytes: bytes === '-' ? 0 : Number(bytes),
    ua: (ua || '').slice(0, 120),
    rt: rt ? Number(rt[1]) : null,
  };
}

const bump = (o, k, n = 1) => (o[k] = (o[k] || 0) + n);

/*
 * Unique visitors: a HyperLogLog sketch per minute (1024 one-byte registers, ~3% error), so
 * distinct IPs can be counted over any time range without storing every IP.
 */
const HLL_P = 10;
const HLL_M = 1 << HLL_P;
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
export function hllAdd(reg, value) {
  const h = hash32(value);
  const idx = h >>> (32 - HLL_P);
  const w = (h << HLL_P) >>> 0;
  const rho = w === 0 ? 32 - HLL_P + 1 : Math.clz32(w) + 1;
  if (rho > reg[idx]) reg[idx] = rho;
}
export const hllMerge = (a, b) => {
  for (let i = 0; i < HLL_M; i++) if (b[i] > a[i]) a[i] = b[i];
};
export function hllCount(reg) {
  let sum = 0;
  let zeros = 0;
  for (let i = 0; i < HLL_M; i++) {
    sum += 2 ** -reg[i];
    if (!reg[i]) zeros++;
  }
  const e = ((0.7213 / (1 + 1.079 / HLL_M)) * HLL_M * HLL_M) / sum;
  return Math.round(e <= 2.5 * HLL_M && zeros ? HLL_M * Math.log(HLL_M / zeros) : e);
}
const hllFrom = (b64) => (b64 ? new Uint8Array(Buffer.from(b64, 'base64')) : new Uint8Array(HLL_M));
const hllTo = (reg) => Buffer.from(reg).toString('base64');
const topN = (o, n = 25) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n));

/** Fold parsed lines into per-minute buckets. */
export function aggregate(lines) {
  const mins = new Map();
  for (const line of lines) {
    const r = parseLine(line);
    if (!r || SELF_UA.test(r.ua)) continue;
    let b = mins.get(r.minute);
    if (!b) mins.set(r.minute, (b = { req: 0, s2: 0, s3: 0, s4: 0, s5: 0, bytes: 0, rt_sum: 0, rt_n: 0, p: {}, i: {}, u: {}, c: {}, h: new Uint8Array(HLL_M) }));
    b.req++;
    hllAdd(b.h, r.ip);
    const cls = Math.floor(r.status / 100);
    if (cls >= 2 && cls <= 5) b[`s${cls}`]++;
    b.bytes += r.bytes;
    if (r.rt != null) {
      b.rt_sum += r.rt;
      b.rt_n++;
    }
    bump(b.p, `${r.method} ${r.path}`);
    bump(b.i, r.ip);
    if (r.ua) bump(b.u, r.ua);
    bump(b.c, String(r.status));
  }
  return mins;
}

function saveMinutes(serverId, mins, sshFails, nowMinute) {
  if (sshFails) {
    const b = mins.get(nowMinute) || { req: 0, s2: 0, s3: 0, s4: 0, s5: 0, bytes: 0, rt_sum: 0, rt_n: 0, p: {}, i: {}, u: {}, c: {} };
    b.ssh = sshFails;
    mins.set(nowMinute, b);
  }
  for (const [minute, b] of mins) {
    const ex = get('SELECT top FROM traffic WHERE server_id = ? AND minute = ?', serverId, minute);
    const top = parseJSON(ex?.top, {}) || {};
    for (const k of ['p', 'i', 'u', 'c']) {
      const merged = { ...(top[k] || {}) };
      for (const [x, n] of Object.entries(b[k] || {})) bump(merged, x, n);
      top[k] = topN(merged, k === 'c' ? 40 : 25);
    }
    if (b.h) {
      const reg = hllFrom(top.h);
      hllMerge(reg, b.h);
      top.h = hllTo(reg);
    }
    run(
      `INSERT INTO traffic (server_id, minute, req, s2, s3, s4, s5, bytes, rt_sum, rt_n, ssh_fail, top) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (server_id, minute) DO UPDATE SET req = req + excluded.req, s2 = s2 + excluded.s2, s3 = s3 + excluded.s3, s4 = s4 + excluded.s4,
         s5 = s5 + excluded.s5, bytes = bytes + excluded.bytes, rt_sum = rt_sum + excluded.rt_sum, rt_n = rt_n + excluded.rt_n,
         ssh_fail = ssh_fail + excluded.ssh_fail, top = excluded.top`,
      serverId, minute, b.req, b.s2, b.s3, b.s4, b.s5, b.bytes, b.rt_sum, b.rt_n, b.ssh || 0, JSON.stringify(top),
    );
  }
}

/* ------------------------------------------------------------------ reading the server */
const DISCOVER = `
{ command -v nginx >/dev/null 2>&1 && nginx -T 2>/dev/null | awk '$1=="access_log" {print $2}' | tr -d ';'; [ -f /var/log/nginx/access.log ] && echo /var/log/nginx/access.log; } | grep '^/' | sort -u | while read -r f; do [ -f "$f" ] && echo "file $f"; done
docker ps --format '{{.Names}}' 2>/dev/null | grep -qx ${EDGE} && echo "docker ${EDGE}"
[ -f /var/log/auth.log ] && echo "auth /var/log/auth.log"
command -v journalctl >/dev/null 2>&1 && echo "journal ssh"
true`;

function pollScript(state, server, sinceSec) {
  const D = dockerBin(server).replace(/^sudo(\s+-\S+)*\s+/, '') || 'docker';
  const parts = ['L=' + READ_LIMIT];
  for (const src of state.sources) {
    if (src.type === 'file' || src.type === 'auth') {
      const pos = state.pos[src.path] || {};
      parts.push(`f=${shq(src.path)}; want=${shq(pos.ino || '')}; off=${Number(pos.off) || 0}
if [ -f "$f" ]; then set -- $(stat -c '%i %s' "$f"); ino=$1; size=$2
  if [ -z "$want" ]; then off=$size; elif [ "$ino" != "$want" ] || [ "$size" -lt "$off" ]; then off=0; fi
  [ $((size - off)) -gt $L ] && off=$((size - L))
  echo "@@${src.type} $f $ino $size"; tail -c +$((off + 1)) "$f" | head -c $((size - off))
fi`);
    } else if (src.type === 'docker') {
      parts.push(`echo "@@docker ${src.path}"; ${D} logs --since ${sinceSec} ${shq(src.path)} 2>/dev/null | tail -c $L`);
    } else if (src.type === 'journal' && !state.sources.some((x) => x.type === 'auth')) {
      parts.push(`echo "@@journal ssh"; journalctl -u ssh -u sshd --since @${sinceSec} --no-pager -o cat 2>/dev/null | grep -cE 'Failed password|Invalid user|authentication failure' || true`);
    }
  }
  parts.push('echo @@end');
  return parts.join('\n');
}

/** Read new log lines of one server and store the counts. Returns the number of new requests. */
export async function collectTraffic(server) {
  const st = parseJSON(server.traffic_state, null) || { sources: [], pos: {}, discovered_at: null, last: null };
  const conn = await connect(server, { timeout: 15000 });
  const nowSec = Math.floor(Date.now() / 1000);
  let total = 0;
  try {
    if (!st.discovered_at || Date.now() - Date.parse(st.discovered_at) > 10 * 60000) {
      const r = await exec(conn, asRoot(server, DISCOVER), { timeout: 30000 });
      st.sources = r.stdout
        .split('\n')
        .map((l) => l.trim().match(/^(file|docker|auth|journal) (.+)$/))
        .filter(Boolean)
        .map((m) => ({ type: m[1], path: m[2] }));
      st.discovered_at = new Date().toISOString();
    }
    if (!st.sources.length) {
      update('servers', server.id, { traffic_state: JSON.stringify({ ...st, error: 'No nginx access log found on this server' }) });
      return 0;
    }
    const since = st.last ? Math.min(Number(st.last), nowSec - 1) : nowSec - 60;
    const r = await exec(conn, asRoot(server, pollScript(st, server, since)), { timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    const lines = [];
    let sshFails = 0;
    let cur = null;
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^@@(file|auth|docker|journal|end)(?: (\S+)(?: (\S+) (\d+))?)?$/);
      if (m) {
        cur = m[1];
        if ((m[1] === 'file' || m[1] === 'auth') && m[2]) st.pos[m[2]] = { ino: m[3], off: Number(m[4]) };
        continue;
      }
      if (cur === 'file' || cur === 'docker') lines.push(line);
      else if (cur === 'auth' && /sshd.*(Failed password|Invalid user|authentication failure)/.test(line)) sshFails++;
      else if (cur === 'journal' && /^\d+$/.test(line.trim())) sshFails += Number(line.trim());
    }
    const mins = aggregate(lines);
    for (const b of mins.values()) total += b.req;
    saveMinutes(server.id, mins, sshFails, new Date(nowSec * 1000).toISOString().slice(0, 16));
    st.last = nowSec;
    st.error = null;
    st.polled_at = new Date().toISOString();
  } catch (e) {
    st.error = e.message;
    throw e;
  } finally {
    conn.end();
    update('servers', server.id, { traffic_state: JSON.stringify(st) });
  }
  checkUnusual(getServer(server.id));
  return total;
}

/* ------------------------------------------------------------------ unusual activity */
const cooldown = new Map(); // `${serverId}:${kind}` → last alert time
const COOLDOWN_MS = 30 * 60000;

function liveFor(serverId) {
  return all('SELECT p.id, p.name FROM projects p JOIN deployments d ON d.id = p.active_deployment_id WHERE d.server_id = ?', serverId);
}

export function checkUnusual(server) {
  if (!server) return [];
  const rows = all('SELECT * FROM traffic WHERE server_id = ? AND minute >= ? ORDER BY minute', server.id, isoAgo(70 * 60000).slice(0, 16));
  const cutoff = isoAgo(5 * 60000).slice(0, 16);
  const recent = rows.filter((r) => r.minute >= cutoff);
  const before = rows.filter((r) => r.minute < cutoff);
  const sum = (list, k) => list.reduce((n, r) => n + r[k], 0);
  const findings = [];
  const req5 = sum(recent, 'req');
  const rpm = req5 / 5;
  const base = before.length >= 30 ? sum(before, 'req') / Math.max(1, before.length) : null;
  const spikeX = Number(getSetting('traffic_spike_x')) || 5;
  const minRpm = Number(getSetting('traffic_min_rpm')) || 60;
  if (base != null && rpm >= minRpm && rpm > spikeX * Math.max(base, 1)) {
    findings.push({ kind: 'spike', level: 'error', text: `traffic spike: ${Math.round(rpm)} requests/min, usually ~${Math.round(base)} (${Math.round(rpm / Math.max(base, 1))}×) — possible attack or bot` });
  }
  const live = liveFor(server.id);
  if (base != null && live.length && base >= 20 && rpm < base * 0.1) {
    findings.push({ kind: 'drop', level: 'error', text: `traffic dropped to ${Math.round(rpm)} requests/min (usually ~${Math.round(base)}) — visitors may not reach the site` });
  }
  const s5 = sum(recent, 's5');
  const pct5 = Number(getSetting('traffic_5xx_pct')) || 5;
  if (s5 >= 20 && req5 && (s5 / req5) * 100 >= pct5) {
    findings.push({ kind: '5xx', level: 'error', text: `${s5} server errors (5xx) in 5 minutes — ${Math.round((s5 / req5) * 100)}% of requests fail` });
  }
  const ips = {};
  for (const r of recent) for (const [ip, n] of Object.entries(parseJSON(r.top, {})?.i || {})) bump(ips, ip, n);
  const [topIp, topCount] = Object.entries(ips).sort((a, b) => b[1] - a[1])[0] || [];
  const ipPct = Number(getSetting('traffic_ip_pct')) || 40;
  if (topIp && topCount >= 300 && req5 && (topCount / req5) * 100 >= ipPct) {
    findings.push({ kind: `ip:${topIp}`, level: 'warn', text: `one IP (${topIp}) made ${topCount} requests in 5 minutes — ${Math.round((topCount / req5) * 100)}% of all traffic. Block it in Cloudflare (Security → WAF) if it's not you` });
  }
  const ssh = sum(recent, 'ssh_fail');
  const sshMax = Number(getSetting('traffic_ssh_fails')) || 50;
  const guard = parseJSON(server.ssh_guard, null);
  // Password login off: guessing can't get in, so no alert. fail2ban on: a quiet note at most once a day.
  if (ssh >= sshMax && !guard?.passwords_off) {
    if (guard?.fail2ban) findings.push({ kind: 'ssh', level: 'info', cooldown: 24 * 3600e3, text: `${ssh} failed SSH logins in 5 minutes — fail2ban is blocking the IPs that guess. Turn off password login (Protect SSH) to stop this for good` });
    else findings.push({ kind: 'ssh', level: 'warn', text: `${ssh} failed SSH logins in 5 minutes — someone is guessing passwords. Click to protect SSH (fail2ban, password login off)` });
  }

  for (const f of findings) {
    const key = `${server.id}:${f.kind}`;
    if (Date.now() - (cooldown.get(key) || 0) < (f.cooldown || COOLDOWN_MS)) continue;
    cooldown.set(key, Date.now());
    const tail = live.length && f.kind !== 'ssh' ? ` ${server.name} is LIVE for ${live.map((p) => p.name).join(', ')} — switch to a standby if it gets worse.` : '';
    const link = f.kind === 'ssh' ? `#/servers/${server.id}?protect-ssh=1` : live.length ? `#/projects/${live[0].id}` : `#/servers/${server.id}`;
    alert(f.level, `Unusual on ${server.name}: ${f.text}.${tail}`, { serverId: server.id, link });
  }
  if (findings.length) bus.emit('state', {});
  return findings;
}

/* ------------------------------------------------------------------ the loop */
let busy = false;
export async function collectAllTraffic() {
  if (busy || !Number(getSetting('traffic_enabled'))) return;
  busy = true;
  try {
    const servers = all("SELECT * FROM servers WHERE status <> 'down'");
    await Promise.all(servers.map((s) => collectTraffic(s).catch(() => {})));
    bus.emit('state', { traffic: true });
  } finally {
    busy = false;
  }
}

export function pruneTraffic() {
  run('DELETE FROM traffic WHERE minute < ?', isoAgo(8 * 864e5).slice(0, 16));
}

/* ------------------------------------------------------------------ reading it back */
export function trafficSummary(serverId, minutes) {
  const from = isoAgo(minutes * 60000).slice(0, 16);
  const rows = all('SELECT * FROM traffic WHERE server_id = ? AND minute >= ? ORDER BY minute', serverId, from);
  const buckets = Math.min(minutes, 120);
  const size = minutes / buckets; // minutes per bar
  const start = Date.parse(`${from}:00Z`);
  const series = Array.from({ length: buckets }, (_, i) => ({ t: new Date(start + i * size * 60000).toISOString(), req: 0, s2: 0, s3: 0, s4: 0, s5: 0 }));
  const tot = { req: 0, s2: 0, s3: 0, s4: 0, s5: 0, bytes: 0, rt_sum: 0, rt_n: 0, ssh_fail: 0 };
  const agg = { p: {}, i: {}, u: {}, c: {} };
  const visitors = new Uint8Array(HLL_M);
  for (const r of rows) {
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((Date.parse(`${r.minute}:00Z`) - start) / (size * 60000))));
    for (const k of ['req', 's2', 's3', 's4', 's5']) series[idx][k] += r[k];
    for (const k of Object.keys(tot)) tot[k] += r[k];
    const top = parseJSON(r.top, {}) || {};
    for (const k of Object.keys(agg)) for (const [x, n] of Object.entries(top[k] || {})) bump(agg[k], x, n);
    if (top.h) hllMerge(visitors, hllFrom(top.h));
  }
  const last5 = rows.filter((r) => r.minute >= isoAgo(5 * 60000).slice(0, 16));
  const st = parseJSON(getServer(serverId)?.traffic_state, {}) || {};
  return {
    minutes,
    per_bar: size,
    series,
    total: tot,
    rpm_now: Math.round((last5.reduce((n, r) => n + r.req, 0) / 5) * 10) / 10,
    err_now: (() => {
      const q = last5.reduce((n, r) => n + r.req, 0);
      return q ? Math.round((last5.reduce((n, r) => n + r.s5, 0) / q) * 1000) / 10 : 0;
    })(),
    avg_ms: tot.rt_n ? Math.round((tot.rt_sum / tot.rt_n) * 1000) : null,
    top_paths: Object.entries(topN(agg.p, 15)),
    top_ips: Object.entries(topN(agg.i, 15)),
    top_uas: Object.entries(topN(agg.u, 10)),
    statuses: Object.entries(agg.c).sort((a, b) => b[1] - a[1]),
    unique_ips: Math.max(hllCount(visitors), Math.min(Object.keys(agg.i).length, 25)),
    sources: st.sources || [],
    polled_at: st.polled_at || null,
    error: st.error || null,
  };
}

/** req/min and error % of the last 5 minutes per server (for the project cards). */
export function trafficNow(serverIds) {
  const out = {};
  if (!serverIds.length) return out;
  const from = isoAgo(5 * 60000).slice(0, 16);
  for (const id of serverIds) {
    const r = get('SELECT SUM(req) AS req, SUM(s5) AS s5, COUNT(*) AS n FROM traffic WHERE server_id = ? AND minute >= ?', id, from);
    if (r?.n) out[id] = { rpm: Math.round(((r.req || 0) / 5) * 10) / 10, err: r.req ? Math.round(((r.s5 || 0) / r.req) * 1000) / 10 : 0 };
  }
  return out;
}

/* ------------------------------------------------------------------ live logs */
export async function logSources(server) {
  const conn = await connect(server, { timeout: 15000 });
  try {
    const D = dockerBin(server).replace(/^sudo(\s+-\S+)*\s+/, '') || 'docker';
    const r = await exec(
      conn,
      asRoot(
        server,
        `${DISCOVER}
command -v nginx >/dev/null 2>&1 && nginx -T 2>/dev/null | awk '$1=="error_log" {print $2}' | tr -d ';' | grep '^/' | sort -u | while read -r f; do [ -f "$f" ] && echo "error $f"; done
[ -f /var/log/syslog ] && echo "syslog /var/log/syslog"
${D} ps --format '{{.Names}}' 2>/dev/null | while read -r c; do echo "container $c"; w=$(${D} inspect -f '{{.Config.WorkingDir}}' "$c" 2>/dev/null); [ -n "$w" ] && ${D} exec "$c" sh -c "ls $w/storage/logs/*.log >/dev/null 2>&1" 2>/dev/null && echo "laravel $c:$w/storage/logs"; done
true`,
      ),
      { timeout: 60000 },
    );
    const seen = new Set();
    const out = [];
    for (const l of r.stdout.split('\n')) {
      const m = l.trim().match(/^(file|docker|auth|journal|error|syslog|container|laravel) (.+)$/);
      if (!m) continue;
      const id = `${m[1]}:${m[2]}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const label = {
        file: `nginx access · ${m[2]}`,
        docker: `web proxy (${m[2]}) access + errors`,
        auth: 'SSH logins (auth.log)',
        journal: 'SSH logins (journal)',
        error: `nginx errors · ${m[2]}`,
        syslog: 'System log (syslog)',
        container: `container · ${m[2]}`,
        laravel: `Laravel log · ${m[2].split(':')[0]}`,
      }[m[1]];
      out.push({ id, type: m[1], label });
    }
    const order = ['file', 'error', 'laravel', 'docker', 'container', 'auth', 'journal', 'syslog'];
    return out.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  } finally {
    conn.end();
  }
}

const SAFE_PATH = /^\/[A-Za-z0-9._\/-]{1,300}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export async function readLog(server, source, lines = 200) {
  const n = Math.max(10, Math.min(2000, Number(lines) || 200));
  const [type, ...rest] = String(source || '').split(':');
  const arg = rest.join(':');
  const D = dockerBin(server).replace(/^sudo(\s+-\S+)*\s+/, '') || 'docker';
  let cmd;
  if (['file', 'error', 'auth', 'syslog'].includes(type)) {
    if (!SAFE_PATH.test(arg) || arg.includes('..') || !arg.startsWith('/var/log/')) throw new Error('That log file is not allowed');
    cmd = `tail -n ${n} ${shq(arg)}`;
  } else if (type === 'docker' || type === 'container') {
    if (!SAFE_NAME.test(arg)) throw new Error('Bad container name');
    cmd = `${D} logs --tail ${n} --timestamps ${shq(arg)} 2>&1`;
  } else if (type === 'laravel') {
    const [c, dir] = [arg.split(':')[0], arg.split(':').slice(1).join(':')];
    if (!SAFE_NAME.test(c) || !SAFE_PATH.test(dir) || dir.includes('..')) throw new Error('Bad Laravel log');
    cmd = `${D} exec ${shq(c)} sh -c ${shq(`f=$(ls -t ${dir}/*.log 2>/dev/null | head -n 1); [ -n "$f" ] && tail -n ${n} "$f" || echo 'No log file yet'`)}`;
  } else if (type === 'journal') {
    cmd = `journalctl -u ssh -u sshd -n ${n} --no-pager -o short-iso 2>&1`;
  } else throw new Error('Unknown log source');
  const conn = await connect(server, { timeout: 15000 });
  try {
    const r = await exec(conn, asRoot(server, cmd), { timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    const lines = r.stdout.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
  } finally {
    conn.end();
  }
}

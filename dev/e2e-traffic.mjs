#!/usr/bin/env node
// End-to-end test for Traffic + Logs + unusual-activity alerts.
// Needs the lab (./dev/setup.sh) and vps-ci (./dev/ci-setup.sh). Only touches vps-ci (its
// /var/log/nginx/access.log and /var/log/auth.log), its server entry, its traffic rows and the lab user "view-traffic".
//   node dev/e2e-traffic.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SB_URL || 'http://localhost:8090';
const CF = 'http://localhost:8787';
const KEY = fs.readFileSync(path.join(DIR, '.keys/id_ed25519'), 'utf8');
let failures = 0;

function client() {
  let cookie = '';
  return async function api(method, url, body, { raw = false } = {}) {
    const go = () => fetch(`${BASE}/api${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await go().catch((e) => (e.message === 'fetch failed' ? go() : Promise.reject(e)));
    for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) cookie = c.split(';')[0];
    const data = await res.json().catch(() => null);
    if (raw) return { status: res.status, data };
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
    return data;
  };
}
const api = client();
const sh = (cmd, input) => execSync(cmd, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
const onScript = (script) => sh('docker exec -i vps-ci sh -s', script);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(cond, msg) {
  if (cond) console.log('  ✔', msg);
  else {
    failures++;
    console.log('  ✖', msg);
  }
}
async function step(name, fn) {
  console.log(`\n▶ ${name}`);
  try {
    await fn();
  } catch (e) {
    failures++;
    console.log('  ✖ ERROR', e.message);
  }
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = (d = new Date()) => `${String(d.getUTCDate()).padStart(2, '0')}/${MON[d.getUTCMonth()]}/${d.getUTCFullYear()}:${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} +0000`;
const line = (ip, status, p = '/', ua = 'Mozilla/5.0 (Macintosh)') => `${ip} - - [${stamp()}] "GET ${p} HTTP/1.1" ${status} ${200 + (status % 7) * 100} "-" "${ua}" 0.0${status % 10}5`;
/** Append lines to a log file inside vps-ci (through stdin, in one go). */
const appendLog = (file, lines) => sh(`docker exec -i vps-ci sh -c ${JSON.stringify(`cat >> ${file}`)}`, `${lines.join('\n')}\n`);

let server;
const collect = async () => {
  const r = await api('POST', `/servers/${server.id}/traffic/collect`);
  if (!r.ok) throw new Error(r.error);
  return r.new_requests;
};

await step('Prepare vps-ci', async () => {
  await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
  for (const s of await api('GET', '/servers')) if (s.name === 'vps-ci') await api('DELETE', `/servers/${s.id}`);
  const { users } = await api('GET', '/users');
  for (const u of users) if (u.username === 'view-traffic') await api('DELETE', `/users/${u.id}`);
  await fetch(`${CF}/__reset`);
  onScript('mkdir -p /var/log/nginx && : > /var/log/nginx/access.log && : > /var/log/auth.log');
  server = await api('POST', '/servers', { name: 'vps-ci', ip: '172.30.0.25', ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY });
  await api('PUT', '/settings', { telegram_token: '123:lab', telegram_chat_id: '42', traffic_enabled: 1, traffic_spike_x: 5, traffic_min_rpm: 60, traffic_5xx_pct: 5, traffic_ip_pct: 40, traffic_ssh_fails: 50 });
  check((await collect()) === 0, 'first read finds the logs and starts at their end (old history is not counted)');
  const t = await api('GET', `/servers/${server.id}/traffic?minutes=60`);
  check(t.sources.some((s) => s.type === 'file' && s.path === '/var/log/nginx/access.log') && t.sources.some((s) => s.type === 'auth'), `log sources found: ${t.sources.map((s) => `${s.type} ${s.path}`).join(', ')}`);
});

await step('Normal traffic is counted per minute', async () => {
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(line(`198.51.100.${i % 60}`, 200, `/page/${i % 7}?x=${i}`));
  for (let i = 0; i < 20; i++) lines.push(line('198.51.100.7', 404, '/missing'));
  for (let i = 0; i < 5; i++) lines.push(line('198.51.100.8', 500, '/api/broken'));
  lines.push(line('172.30.0.5', 200, '/up', 'Switchboard-HealthCheck/1.0')); // our own health check: not counted
  appendLog('/var/log/nginx/access.log', lines);
  check((await collect()) === 325, 'read 325 new requests (health check left out)');
  check((await collect()) === 0, 'nothing is counted twice');
  const t = await api('GET', `/servers/${server.id}/traffic?minutes=60`);
  check(t.total.req === 325 && t.total.s2 === 300 && t.total.s4 === 20 && t.total.s5 === 5, `totals: ${t.total.req} req, 2xx ${t.total.s2}, 4xx ${t.total.s4}, 5xx ${t.total.s5}`);
  check(Math.abs(t.unique_ips - 60) <= 3, `unique visitors ≈ 60: ${t.unique_ips}`);
  check(t.top_paths.some(([p]) => p === 'GET /missing') && !t.top_paths.some(([p]) => p.includes('?')), 'top pages listed without query strings');
  check(t.avg_ms != null, `response time read from the log (${t.avg_ms} ms avg)`);
  check(t.series.length === 60 && t.series.reduce((n, b) => n + b.req, 0) === 325, 'chart has 60 one-minute bars');
  const ev = await api('GET', `/servers/${server.id}/traffic?minutes=60`);
  check(!ev.events.length, 'no alert for normal traffic');
});

await step('Attack-like spike: alerts for spike, 5xx and one IP', async () => {
  // 50 minutes of "usual" traffic (~5 req/min) as history, so there is a baseline.
  const now = Date.now();
  const rows = [];
  for (let m = 55; m >= 6; m--) rows.push(`(${server.id}, '${new Date(now - m * 60000).toISOString().slice(0, 16)}', 5, 5, 0, 0, 0, 1000, 0, 0, 0, '{}')`);
  // Written from inside the Switchboard container: SQLite's shared memory doesn't work across the Docker VM boundary.
  const sql = `INSERT OR REPLACE INTO traffic (server_id, minute, req, s2, s3, s4, s5, bytes, rt_sum, rt_n, ssh_fail, top) VALUES ${rows.join(',')}`;
  sh(`docker exec -i -w /app -e DATA_DIR=/data switchboard-dev-switchboard-1 node --input-type=module -e "const { run } = await import('/app/src/db.js'); run((await import('node:fs')).readFileSync(0, 'utf8'))"`, sql);
  const before = (await (await fetch(`${CF}/__state`)).json()).telegram.length;
  const lines = [];
  for (let i = 0; i < 1500; i++) lines.push(line('203.0.113.66', i % 5 < 2 ? 502 : 200, '/login', 'python-requests/2.32'));
  appendLog('/var/log/nginx/access.log', lines);
  await collect();
  const t = await api('GET', `/servers/${server.id}/traffic?minutes=60`);
  const msgs = t.events.map((e) => e.message);
  check(msgs.some((m) => /traffic spike/.test(m)), 'traffic spike alert');
  check(msgs.some((m) => /server errors \(5xx\)/.test(m)), '5xx alert');
  check(msgs.some((m) => /one IP \(203\.0\.113\.66\)/.test(m)), 'single-IP alert names the IP');
  check(t.top_ips[0]?.[0] === '203.0.113.66', 'top IP is the attacker');
  check(t.err_now >= 30, `error rate now: ${t.err_now}%`);
  await sleep(1500);
  const tg = (await (await fetch(`${CF}/__state`)).json()).telegram.slice(before);
  check(tg.some((m) => /Unusual on vps-ci/.test(m.text)), 'alert sent to Telegram');
  await collect();
  check((await api('GET', `/servers/${server.id}/traffic?minutes=60`)).events.length === t.events.length, 'no repeated alerts (30-minute cooldown)');
});

await step('Failed SSH logins', async () => {
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(`Nov 17 14:00:${String(i).padStart(2, '0')} vps-ci sshd[${1000 + i}]: Failed password for root from 45.0.0.${i % 9} port 5${i} ssh2`);
  appendLog('/var/log/auth.log', lines);
  await collect();
  const t = await api('GET', `/servers/${server.id}/traffic?minutes=60`);
  check(t.total.ssh_fail === 60, `failed SSH logins counted: ${t.total.ssh_fail}`);
  check(t.events.some((e) => /failed SSH logins/.test(e.message)), 'SSH brute-force alert');
});

await step('Live logs', async () => {
  const src = await api('GET', `/servers/${server.id}/log-sources`);
  check(src.some((s) => s.id === 'file:/var/log/nginx/access.log') && src.some((s) => s.type === 'container'), `log sources: ${src.length} (access log, containers, …)`);
  const r = await api('GET', `/servers/${server.id}/logs?source=${encodeURIComponent('file:/var/log/nginx/access.log')}&lines=50&q=502`);
  check(r.lines.length === 50 && r.lines.every((l) => l.includes(' 502 ')), 'filter "502" returns only matching lines');
  const bad = await api('GET', `/servers/${server.id}/logs?source=${encodeURIComponent('file:/etc/shadow')}`, undefined, { raw: true });
  check(bad.status >= 400, 'files outside /var/log are refused');
  const view = client();
  await api('POST', '/users', { username: 'view-traffic', password: 'view-password-123', role: 'viewer' });
  await view('POST', '/auth/login', { username: 'view-traffic', password: 'view-password-123' });
  check((await view('GET', `/servers/${server.id}/traffic?minutes=60`, undefined, { raw: true })).status === 200, 'a viewer can see the traffic numbers');
  check((await view('GET', `/servers/${server.id}/logs?source=file:/var/log/nginx/access.log`, undefined, { raw: true })).status === 403, 'a viewer cannot read the logs');
});

onScript(': > /var/log/nginx/access.log; : > /var/log/auth.log');
await api('PUT', '/settings', { clear_telegram_token: true, telegram_chat_id: '' }).catch(() => {});
console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);

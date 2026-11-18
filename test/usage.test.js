// Unit tests for usage history (CPU / memory / network / GPU readings + busy times):  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-usage-test-'));
const { insert, run, all } = await import('../src/db.js');
const { parseMetrics } = await import('../src/monitor.js');
const { recordUsage, usageSummary, causeOf } = await import('../src/ops/usage.js');

const NETDEV = (eth, docker) => `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999 1 0 0 0 0 0 0 9999 1 0 0 0 0 0 0
  eth0: ${eth[0]} 10 0 0 0 0 0 0 ${eth[1]} 10 0 0 0 0 0 0
docker0: ${docker} 1 0 0 0 0 0 0 ${docker} 1 0 0 0 0 0 0`;

test('parseMetrics reads network per second (real interfaces only) and NVIDIA GPUs', () => {
  const out = [
    '@@net1', NETDEV([1000, 500], 0),
    '@@cpu', 'cpu  100 0 100 800 0 0 0 0', 'cpu  150 0 150 900 0 0 0 0',
    '@@net2', NETDEV([5000, 2500], 99999),
    '@@gpu', '80, 1000, 4000', '40, 3000, 4000',
    '@@mem', 'MemTotal: 1000 kB', 'MemAvailable: 250 kB',
  ].join('\n');
  const m = parseMetrics(out);
  assert.equal(m.cpu_pct, 50);
  assert.equal(m.mem_pct, 75);
  assert.equal(m.net_rx, 4000);
  assert.equal(m.net_tx, 2000);
  assert.equal(m.gpus, 2);
  assert.equal(m.gpu_pct, 60);
  assert.equal(m.gpu_mem_pct, 50);
});

test('no nvidia-smi → no GPU fields', () => {
  const m = parseMetrics('@@gpu\n@@mem\nMemTotal: 1000 kB\nMemAvailable: 500 kB');
  assert.equal(m.gpu_pct, undefined);
  assert.equal(m.net_rx, undefined);
});

test('causeOf: traffic vs memory vs cpu', () => {
  const th = { cpuTh: 80, memTh: 90 };
  assert.equal(causeOf({ avg_rpm: 300, baseline_rpm: 100, peak_cpu: 95, peak_mem: 60 }, th), 'traffic');
  assert.equal(causeOf({ avg_rpm: 110, baseline_rpm: 100, peak_cpu: 40, peak_mem: 95 }, th), 'memory');
  assert.equal(causeOf({ avg_rpm: 110, baseline_rpm: 100, peak_cpu: 95, peak_mem: 50 }, th), 'cpu');
  assert.equal(causeOf({ avg_rpm: null, peak_cpu: 95, peak_mem: 50 }, th), 'cpu');
});

test('recordUsage keeps readings and one busy time from start to end, with traffic', () => {
  const sid = insert('servers', { name: 't1', ip: '192.0.2.10', ssh_user: 'root', created_at: new Date().toISOString() });
  const min = (ago) => new Date(Date.now() - ago * 60000);
  // normal traffic the day before (10 req/min), then 100 req/min during the busy time
  for (let i = 30; i < 1440; i += 1) run('INSERT INTO traffic (server_id, minute, req) VALUES (?, ?, 10)', sid, min(i).toISOString().slice(0, 16));
  for (let i = 0; i < 30; i++) run('INSERT INTO traffic (server_id, minute, req) VALUES (?, ?, 100)', sid, min(i).toISOString().slice(0, 16));

  const th = { cpuTh: 80, memTh: 90 };
  const reading = (ago, cpu, busy, since) => ({ collected_at: min(ago).toISOString(), cpu_pct: cpu, mem_pct: 50, load: [1, 1, 1], busy, busy_since: since });
  const since = min(25).toISOString();
  recordUsage({ id: sid }, reading(30, 20, false, null), null, th);
  recordUsage({ id: sid }, reading(15, 95, true, since), null, th);
  let p = all('SELECT * FROM busy_periods WHERE server_id = ?', sid);
  assert.equal(p.length, 1);
  assert.equal(p[0].ended_at, null);
  assert.equal(p[0].started_at, since);
  recordUsage({ id: sid }, reading(10, 98, true, since), null, th);
  recordUsage({ id: sid }, reading(5, 30, false, null), null, th);
  p = all('SELECT * FROM busy_periods WHERE server_id = ?', sid);
  assert.equal(p.length, 1);
  assert.ok(p[0].ended_at);
  assert.equal(p[0].peak_cpu, 98);
  assert.equal(p[0].cause, 'traffic');
  assert.equal(p[0].peak_rpm, 100);

  const u = usageSummary(sid, 60);
  assert.equal(u.summary.samples, 4);
  assert.equal(u.summary.cpu_peak, 98);
  assert.equal(u.summary.busy_count, 1);
  assert.equal(u.advice.cause, 'traffic');
  assert.equal(u.series.length, 60);
  assert.equal(u.periods[0].minutes, 20);
});

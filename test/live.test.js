// Unit tests for the live views (live CPU / network readings, live log commands):  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-live-test-'));
const { liveSample } = await import('../src/live.js');
const { logCommand } = await import('../src/ops/traffic.js');

const NETDEV = (rx, tx) => `Inter-|   Receive |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999 1 0 0 0 0 0 0 9999 1 0 0 0 0 0 0
  eth0: ${rx} 10 0 0 0 0 0 0 ${tx} 10 0 0 0 0 0 0`;

const block = ({ up, cpu, rx, tx, gpu = '' }) =>
  [
    '@@uptime', `${up} 100.00`,
    '@@cpu', cpu,
    '@@net', NETDEV(rx, tx),
    '@@gpu', ...(gpu ? [gpu] : []),
    '@@load', '0.50 0.40 0.30 1/100 123',
    '@@nproc', '4',
    '@@mem', 'MemTotal: 1000 kB', 'MemAvailable: 400 kB', 'SwapTotal: 0 kB', 'SwapFree: 0 kB',
    '@@disk', '/dev/sda1 1000 600 400 60% /',
  ].join('\n');

test('liveSample: CPU from two readings, network per second over the real time between them', () => {
  const a = block({ up: 100, cpu: 'cpu  100 0 100 800 0 0 0 0', rx: 1000, tx: 500 });
  const b = block({ up: 102, cpu: 'cpu  150 0 150 900 0 0 0 0', rx: 5000, tx: 2500, gpu: '70, 1000, 4000' });
  const s = liveSample(a, b);
  assert.equal(s.cpu, 50); // 100 busy of 200 ticks
  assert.equal(s.mem, 60);
  assert.equal(s.net_rx, 2000); // 4000 bytes in 2 s
  assert.equal(s.net_tx, 1000);
  assert.equal(s.gpu, 70);
  assert.equal(s.disk_pct, 60);
  assert.deepEqual(s.load, [0.5, 0.4, 0.3]);
  assert.ok(Date.parse(s.t));
});

test('logCommand: follow mode tails live, and still refuses paths outside /var/log', () => {
  const srv = { docker_cmd: 'docker' };
  assert.match(logCommand(srv, 'file:/var/log/nginx/access.log', 200, true), /^tail -n 200 -F '\/var\/log\/nginx\/access.log'/);
  assert.match(logCommand(srv, 'file:/var/log/nginx/access.log', 200), /^tail -n 200 '/);
  assert.match(logCommand(srv, 'container:web-1', 50, true), /docker logs -f --tail 50 --timestamps 'web-1'/);
  assert.match(logCommand(srv, 'journal:ssh', 100, true), /journalctl .* -f /);
  assert.match(logCommand(srv, 'laravel:app:/var/www/storage/logs', 100, true), /tail -n 100 -F/);
  assert.throws(() => logCommand(srv, 'file:/etc/shadow', 100, true), /not allowed/);
  assert.throws(() => logCommand(srv, 'file:/var/log/../../etc/shadow', 100, true), /not allowed/);
  assert.throws(() => logCommand(srv, 'container:bad;name', 100, true), /Bad container/);
  assert.throws(() => logCommand(srv, 'nope:x', 100, true), /Unknown/);
});

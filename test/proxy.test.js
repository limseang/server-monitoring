import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHosts, parseCheck, checkScript, proxySiteName } from '../src/ops/proxycheck.js';

test('parseHosts: cleans, dedupes and rejects bad names', () => {
  assert.deepEqual(parseHosts(' Shop.Example.com, www.shop.example.com  shop.example.com.'), ['shop.example.com', 'www.shop.example.com']);
  assert.throws(() => parseHosts(''), /Type the domain/);
  assert.throws(() => parseHosts('localhost'), /not a domain/);
  assert.throws(() => parseHosts('a.com; rm -rf /'), /not a domain/);
  assert.throws(() => parseHosts('*.a.com'), /not a domain/);
  assert.throws(() => parseHosts('a_b.com'), /not a domain/);
});

test('parseCheck: open port, same-port site kept, other site blocks', () => {
  const out = [
    '@port open',
    '@site /etc/switchboard/edge/conf.d/sb-dom-shop-example-com.conf',
    '  server_name shop.example.com;',
    '  proxy_pass http://127.0.0.1:8080;',
    '@site /etc/nginx/sites-enabled/old',
    '  server_name www.shop.example.com example.org;',
    '  root /var/www/html;',
    '@site /etc/nginx/conf.d/other.conf',
    '  server_name api.shop.example.com;',
    '  proxy_pass http://127.0.0.1:9000;',
  ].join('\n');
  const r = parseCheck(out, 8080, ['shop.example.com', 'www.shop.example.com']);
  assert.equal(r.open, true);
  assert.deepEqual(r.same, ['/etc/switchboard/edge/conf.d/sb-dom-shop-example-com.conf']);
  assert.deepEqual(r.other, [{ file: '/etc/nginx/sites-enabled/old', to: 'folder /var/www/html' }]); // api.* only matched the grep, not the name
  const none = parseCheck('@port closed\n', 8080, ['a.com']);
  assert.deepEqual(none, { open: false, same: [], other: [] });
  // a different port on the same host is "other"
  assert.equal(parseCheck('@port open\n@site /x\n server_name a.com;\n proxy_pass http://localhost:3000/;', 8080, ['a.com']).other.length, 1);
  assert.equal(parseCheck('@port open\n@site /x\n server_name a.com;\n proxy_pass http://localhost:8080/;', 8080, ['a.com']).same.length, 1);
});

test('checkScript skips our own site file and quotes the pattern', () => {
  const s = checkScript(7, 8080, ['a.example.com']);
  assert.match(s, /\*\/sb-proj-7\.conf\) continue/);
  assert.match(s, /'server_name\[\^;\]\*\[\[:space:\]\]\(a\\\.example\\\.com\)/);
  assert.equal(proxySiteName(7), 'proj-7');
});

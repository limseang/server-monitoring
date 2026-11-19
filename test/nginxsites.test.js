// Unit tests for the Nginx sites tab (sites-available) and its video stream proxy template:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListing, sitePath } from '../src/ops/nginxsites.js';
import { buildSite, parseUpstream, siteFileName, streamBlock } from '../public/app/nginxtemplate.js';

test('sitePath only allows plain names in the two nginx folders', () => {
  assert.equal(sitePath('sites', 'cinemagickh.com'), '/etc/nginx/sites-available/cinemagickh.com');
  assert.equal(sitePath('confd', 'a.conf'), '/etc/nginx/conf.d/a.conf');
  assert.equal(sitePath('confd', 'a'), '');
  assert.equal(sitePath('sites', '../nginx.conf'), '');
  assert.equal(sitePath('sites', 'a/b'), '');
  assert.equal(sitePath('sites', '.hidden'), '');
  assert.equal(sitePath('sites', 'a..b'), '');
  assert.equal(sitePath('etc', 'a'), '');
  assert.equal(sitePath('sites', "a'; rm -rf /"), '');
});

test('parseListing reads layout, files, domains, paths and Switchboard files', () => {
  const out = [
    '@nginx nginx version: nginx/1.24.0 (Ubuntu)',
    '@layout sites',
    '@cert',
    '@file sites 1 cinemagickh.com',
    '    listen 443 ssl;',
    '    server_name cinemagickh.com www.cinemagickh.com;',
    '    location /stream-proxy/ {',
    '    location / {',
    '@file sites 0 old',
    '  listen 80 default_server;',
    '@file confd 1 sb-dom-api.conf',
    '  server_name api.example.com;',
  ].join('\n');
  const r = parseListing(out);
  assert.equal(r.nginx, true);
  assert.equal(r.version, 'nginx/1.24.0 (Ubuntu)');
  assert.equal(r.layout, 'sites');
  assert.equal(r.cert, true);
  assert.equal(r.sites.length, 3);
  assert.deepEqual(r.sites[0].hosts, ['cinemagickh.com', 'www.cinemagickh.com']);
  assert.deepEqual(r.sites[0].locations, ['/stream-proxy/', '/']);
  assert.deepEqual(r.sites[0].ports, ['443']);
  assert.equal(r.sites[0].enabled, true);
  assert.equal(r.sites[1].enabled, false);
  assert.deepEqual(r.sites[1].ports, ['80']);
  assert.equal(r.sites[2].managed, true);
  assert.equal(parseListing('@layout none').nginx, false);
});

test('parseUpstream', () => {
  assert.deepEqual(parseUpstream('127.0.0.1:9000'), { url: 'http://127.0.0.1:9000', host: '127.0.0.1:9000', https: false });
  assert.deepEqual(parseUpstream('https://s3.example.com/'), { url: 'https://s3.example.com', host: 's3.example.com', https: true });
  assert.equal(parseUpstream(''), null);
  assert.equal(parseUpstream('http://a b'), null);
  assert.equal(parseUpstream('x;y'), null);
});

test('buildSite: app + video stream proxy before location /', () => {
  const t = buildSite({ hosts: 'cinemagickh.com www.cinemagickh.com', target: 'app', port: 8000, ssl: true, stream: { path: 'stream-proxy', upstream: '127.0.0.1:9000', signedHost: 'minio:9000' } });
  assert.match(t, /server_name cinemagickh\.com www\.cinemagickh\.com;/);
  assert.match(t, /listen 443 ssl;/);
  assert.match(t, /location \/stream-proxy\/ \{\n {8}proxy_pass http:\/\/127\.0\.0\.1:9000\/;\n {8}proxy_set_header Host minio:9000;/);
  assert.ok(t.indexOf('location /stream-proxy/') < t.indexOf('location / {'));
  assert.match(t, /proxy_pass http:\/\/127\.0\.0\.1:8000;/);
  assert.equal((t.match(/\{/g) || []).length, (t.match(/\}/g) || []).length);
  const plain = buildSite({ hosts: 'a.com', target: 'root', root: '/var/www/a' });
  assert.doesNotMatch(plain, /443|stream/);
  assert.match(plain, /root \/var\/www\/a;/);
});

test('streamBlock and siteFileName', () => {
  const b = streamBlock({ upstream: 'https://s3.example.com' });
  assert.match(b, /^# Video:/);
  assert.match(b, /^location \/stream-proxy\/ \{$/m);
  assert.match(b, /proxy_ssl_name s3\.example\.com;/);
  assert.match(b, /^\}\n$/m);
  assert.equal(siteFileName(' www.Cinema.com  x.com'), 'www.cinema.com');
});

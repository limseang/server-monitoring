// Unit tests for the SSL scan + set up (nginx config parsing and rewriting, certificate checks):  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseServerBlocks, nameMatches, planSiteEdit, certInfo, checkOwnCert, serverStatus, absPath } from '../src/ops/sslconf.js';
import { parseDump, sslHosts, acmeScript, finalizeScript } from '../src/ops/serverssl.js';

const CERT = '/etc/ssl/acme/shop.test.pem';
const KEY = '/etc/ssl/acme/shop.test.key';

const BROKEN = `# cinemagickh
server {
    listen 80;
    server_name cinemagickh.com www.cinemagickh.com;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl http2;
    server_name cinemagickh.com www.cinemagickh.com;
    ssl_certificate /etc/ssl/cloudflare/cinemagickh.pem;
    ssl_certificate_key /etc/ssl/cloudflare/cinemagickh.key;
    location / { proxy_pass http://127.0.0.1:8000; }
}
`;

test('parseServerBlocks finds server blocks and their own directives (not upstream servers or location ones)', () => {
  const text = `upstream app { server 127.0.0.1:9000; }
http {
  server {
    listen 80; listen [::]:80;
    server_name "a.test" b.test; # comment ; {
    location / { ssl_certificate /nope.pem; root /var/www; }
  }
}`;
  const b = parseServerBlocks(text);
  assert.equal(b.length, 1);
  assert.deepEqual(b[0].names, ['a.test', 'b.test']);
  assert.deepEqual(b[0].ports, [80, 80]);
  assert.equal(b[0].ssl, false);
  assert.equal(b[0].cert, '');
  const blocks = parseServerBlocks(BROKEN);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].redirectsToHttps, true);
  assert.equal(blocks[1].ssl, true);
  assert.equal(blocks[1].cert, '/etc/ssl/cloudflare/cinemagickh.pem');
  assert.equal(blocks[1].redirectsToHttps, false);
});

test('nameMatches: exact, *.zone (one level), .zone, regex', () => {
  assert.ok(nameMatches('shop.test', 'SHOP.test'));
  assert.ok(nameMatches('*.shop.test', 'www.shop.test'));
  assert.ok(!nameMatches('*.shop.test', 'a.b.shop.test'));
  assert.ok(!nameMatches('*.shop.test', 'shop.test'));
  assert.ok(nameMatches('.shop.test', 'shop.test'));
  assert.ok(nameMatches('.shop.test', 'a.b.shop.test'));
  assert.ok(nameMatches('~^(www\\.)?shop\\.test$', 'www.shop.test'));
  assert.ok(!nameMatches('_', 'shop.test'));
});

test('planSiteEdit points an HTTPS block with a missing certificate at the new files', () => {
  const r = planSiteEdit(BROKEN, ['cinemagickh.com'], CERT, KEY);
  assert.ok(r.changed);
  assert.match(r.text, new RegExp(`ssl_certificate ${CERT};`));
  assert.match(r.text, new RegExp(`ssl_certificate_key ${KEY};`));
  assert.doesNotMatch(r.text, /cloudflare\/cinemagickh/);
  assert.match(r.text, /return 301 https/, 'redirect block left alone');
  assert.equal((r.text.match(/listen 443/g) || []).length, 1, 'no extra listen 443');
  // Running it again changes nothing
  assert.equal(planSiteEdit(r.text, ['cinemagickh.com'], CERT, KEY).changed, false);
});

test('planSiteEdit adds port 443 to an http-only site (and IPv6 when it listens on IPv6)', () => {
  const text = `server {
\tlisten 80;
\tlisten [::]:80;
\tserver_name shop.test www.shop.test;
\troot /var/www/shop;
}
server {
\tlisten 80;
\tserver_name other.test;
}
`;
  const r = planSiteEdit(text, ['shop.test'], CERT, KEY);
  assert.ok(r.changed);
  assert.match(r.text, /\tlisten \[::\]:80;\n\tlisten 443 ssl;\n\tlisten \[::\]:443 ssl;\n\tssl_certificate \/etc\/ssl\/acme\/shop.test.pem;\n\tssl_certificate_key \/etc\/ssl\/acme\/shop.test.key;\n\tserver_name shop.test/);
  const blocks = parseServerBlocks(r.text);
  assert.equal(blocks[0].ssl, true);
  assert.equal(blocks[1].ssl, false, 'other site untouched');
  assert.equal(r.notes.length, 1);
});

test('planSiteEdit: bare "listen 443" gets ssl; missing cert lines are added; redirect-only is reported', () => {
  const a = planSiteEdit('server {\n  listen 443;\n  server_name shop.test;\n}\n', ['shop.test'], CERT, KEY);
  assert.match(a.text, /listen 443 ssl;\n  server_name shop.test;\n  ssl_certificate \/etc\/ssl\/acme\/shop.test.pem;\n  ssl_certificate_key/);
  const b = planSiteEdit('server {\n  listen 80;\n  server_name shop.test;\n  location /.well-known/acme-challenge/ { root /var/www/acme; }\n  location / { return 301 https://$host$request_uri; }\n}\n', ['shop.test'], CERT, KEY);
  assert.equal(b.changed, false);
  assert.match(b.notes[0], /only a redirect/);
  // another file already has the HTTPS block → http block left alone
  assert.equal(planSiteEdit('server { listen 80; server_name shop.test; root /x; }', ['shop.test'], CERT, KEY, { anySslElsewhere: true }).changed, false);
  // nothing for these hosts → no change
  assert.equal(planSiteEdit(BROKEN, ['shop.test'], CERT, KEY).changed, false);
});

test('absPath: relative paths are under /etc/nginx, variables are skipped', () => {
  assert.equal(absPath('ssl/a.pem'), '/etc/nginx/ssl/a.pem');
  assert.equal(absPath('/etc/a.pem'), '/etc/a.pem');
  assert.equal(absPath('/etc/$ssl_server_name.pem'), '');
});

function selfSigned(cn, days = 30, san = `DNS:${cn},DNS:www.${cn}`) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbssl-'));
  execFileSync('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', String(days), '-subj', `/CN=${cn}`, '-addext', `subjectAltName=${san}`, '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`], { stdio: 'ignore' });
  const out = { cert: fs.readFileSync(`${dir}/c.pem`, 'utf8'), key: fs.readFileSync(`${dir}/k.pem`, 'utf8') };
  fs.rmSync(dir, { recursive: true });
  return out;
}

test('certInfo + checkOwnCert read names, expiry, kind and check the key', () => {
  const a = selfSigned('shop.test');
  const i = certInfo(a.cert, ['shop.test', 'www.shop.test', 'api.shop.test']);
  assert.equal(i.ok, true);
  assert.equal(i.kind, 'self-signed');
  assert.deepEqual(i.names, ['shop.test', 'www.shop.test']);
  assert.deepEqual(i.missing_hosts, ['api.shop.test']);
  assert.ok(i.days_left >= 29 && i.days_left <= 30);
  assert.equal(certInfo('junk').ok, false);
  assert.equal(checkOwnCert(a.cert, a.key, ['shop.test']).info.names[0], 'shop.test');
  const b = selfSigned('other.test');
  assert.throws(() => checkOwnCert(a.cert, b.key, []), /does not belong/);
  assert.throws(() => checkOwnCert('', a.key, []), /BEGIN CERTIFICATE/);
  assert.throws(() => checkOwnCert(a.cert, 'nope', []), /private key/);
});

test('serverStatus explains each case in plain words', () => {
  const base = { nginx: '1.24', edge: '', hosts: ['shop.test'], broken: [] };
  assert.equal(serverStatus({ ...base, nginx: '', sites: [] }).status, 'no-nginx');
  assert.equal(serverStatus({ ...base, sites: [] }).status, 'no-site');
  assert.equal(serverStatus({ ...base, sites: [{ ssl: false }] }).status, 'no-ssl');
  const miss = serverStatus({ ...base, sites: [{ ssl: true, cert: '/etc/ssl/cloudflare/cinemagickh.pem', cert_missing: true, key: '/k', key_missing: false }] });
  assert.equal(miss.status, 'missing');
  assert.match(miss.message, /cinemagickh\.pem/);
  const info = { ok: true, days_left: 80, not_after: '2027-02-01T00:00:00Z', missing_hosts: [], kind: 'letsencrypt', issuer: 'x' };
  assert.equal(serverStatus({ ...base, sites: [{ ssl: true, cert_info: info, key_match: true }] }).status, 'ok');
  assert.equal(serverStatus({ ...base, sites: [{ ssl: true, cert_info: { ...info, days_left: -1 } }] }).status, 'expired');
  assert.equal(serverStatus({ ...base, sites: [{ ssl: true, cert_info: { ...info, kind: 'self-signed' } }] }).status, 'self-signed');
  assert.equal(serverStatus({ ...base, sites: [{ ssl: true, cert_info: info, key_match: false }] }).status, 'bad-key');
});

test('parseDump reads files (paths with spaces too) and skips duplicates', () => {
  const b = Buffer.from('server { listen 80; }').toString('base64');
  const d = parseDump(`@edge host\n@nginx nginx version: nginx/1.24.0\n@openssl\n@file host ${b} /etc/nginx/sites-available/my site\n@file host ${b} /etc/nginx/sites-available/my site\n`);
  assert.equal(d.edge, 'host');
  assert.equal(d.nginx, 'nginx/1.24.0');
  assert.equal(d.openssl, true);
  assert.equal(d.files.length, 1);
  assert.equal(d.files[0].path, '/etc/nginx/sites-available/my site');
  assert.equal(d.files[0].text, 'server { listen 80; }');
});

test('sslHosts: domain, extra hosts and linked records, no wildcards, no duplicates', () => {
  const p = { domain: 'Shop.test', template_opts: JSON.stringify({ extra_hosts: ['api.shop.test'] }), dns_records: JSON.stringify([{ name: 'shop.test' }, { name: 'www.shop.test' }, { name: '*.shop.test' }]) };
  assert.deepEqual(sslHosts(p), ['shop.test', 'api.shop.test', 'www.shop.test']);
});

test('acmeScript pins acme.sh, reads the token from stdin, accepts "already valid"', () => {
  const s = acmeScript({ hosts: ['shop.test', 'www.shop.test'], ca: 'letsencrypt', email: 'a@b.test', challenge: 'dns', D: "'/etc/ssl/acme'", B: "'shop.test'" });
  assert.match(s, /archive\/[0-9a-f]{40}\.tar\.gz/);
  assert.match(s, /read -r CF_Token; export CF_Token/);
  assert.match(s, /--dns dns_cf -d 'shop.test' -d 'www.shop.test'/);
  assert.match(s, /\[ "\$rc" = 2 \]/);
  assert.doesNotMatch(s, /CF_Token=/);
  const h = acmeScript({ hosts: ['shop.test'], ca: 'zerossl', email: 'a@b.test', challenge: 'http', D: 'x', B: 'y' });
  assert.match(h, /--nginx/);
  assert.match(h, /--register-account --server zerossl/);
  assert.doesNotMatch(h, /CF_Token/);
});

test('finalizeScript really puts everything back when nginx says no (run with sh)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbfin-'));
  const a = selfSigned('shop.test');
  fs.writeFileSync(`${dir}/c.pem.new`, a.cert);
  fs.writeFileSync(`${dir}/c.key.new`, a.key);
  fs.writeFileSync(`${dir}/c.pem`, 'OLD CERT');
  fs.writeFileSync(`${dir}/c.key`, 'OLD KEY');
  fs.writeFileSync(`${dir}/site`, 'old site');
  const q = (s) => `'${s}'`;
  const bad = finalizeScript({ D: q(dir), B: q('c'), edits: [{ path: `${dir}/site`, text: 'new site' }], reload: 'echo "nginx: [emerg] broken" >&2; false' });
  let err = '';
  try {
    execFileSync('sh', ['-c', bad], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    err = String(e.stderr);
  }
  assert.match(err, /everything is back as it was: nginx: \[emerg\] broken/);
  assert.equal(fs.readFileSync(`${dir}/c.pem`, 'utf8'), 'OLD CERT');
  assert.equal(fs.readFileSync(`${dir}/c.key`, 'utf8'), 'OLD KEY');
  assert.equal(fs.readFileSync(`${dir}/site`, 'utf8'), 'old site');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['c.key', 'c.pem', 'site']);
  // and when nginx says yes
  fs.writeFileSync(`${dir}/c.pem.new`, a.cert);
  fs.writeFileSync(`${dir}/c.key.new`, a.key);
  const good = finalizeScript({ D: q(dir), B: q('c'), edits: [{ path: `${dir}/site`, text: 'new site' }], reload: 'true' });
  assert.match(execFileSync('sh', ['-c', good], { encoding: 'utf8' }), /done/);
  assert.equal(fs.readFileSync(`${dir}/c.pem`, 'utf8'), a.cert);
  assert.equal(fs.readFileSync(`${dir}/site`, 'utf8'), 'new site');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['c.key', 'c.pem', 'site']);
  fs.rmSync(dir, { recursive: true });
});

#!/usr/bin/env node
// End-to-end: SSL scan + set up on a server's own nginx (project Settings → "SSL certificates on the servers").
// Needs the fake Cloudflare and vps-new with nginx installed:
//   docker compose -f dev/docker-compose.yml --profile clone up -d cf-mock vps-new switchboard
//   docker exec vps-new sh -c 'apt-get update -q && apt-get install -y -q nginx && nginx'
//   SB_URL=http://localhost:8090 CF_URL=http://localhost:8787 node dev/e2e-serverssl.mjs
// Only touches its own project "SSL setup test", nginx sites shop.test / other.test on vps-new and their certificate files.
// (Let's Encrypt / ZeroSSL is not run here: it needs a real certificate authority.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SB_URL || 'http://localhost:8090';
const CF = process.env.CF_URL || 'http://localhost:8787';
const KEY = fs.readFileSync(process.env.SB_KEY_FILE || path.join(DIR, '.keys/id_ed25519'), 'utf8');
const BOX = 'vps-new';
let failures = 0;
let cookie = '';

async function api(method, url, body) {
  const res = await fetch(`${BASE}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) cookie = c.split(';')[0];
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
  return data;
}
const sh = (cmd, input) => execSync(cmd, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }).trim();
const on = (cmd) => sh(`docker exec ${BOX} sh -c ${JSON.stringify(cmd)}`);
const put = (file, text) => sh(`docker exec -i ${BOX} sh -c ${JSON.stringify(`cat > ${file}`)}`, text);
const onOk = (cmd) => {
  try {
    on(cmd);
    return true;
  } catch {
    return false;
  }
};
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
async function waitJob(job) {
  for (let i = 0; i < 300; i++) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (process.env.VERBOSE) console.log(j.log.split('\n').slice(-40).map((l) => `      ${l}`).join('\n'));
      return j;
    }
    await sleep(700);
  }
  throw new Error('job did not finish in time');
}
const SITE = '/etc/nginx/sites-available/shop.test';
const issuerOn443 = () => on("echo | openssl s_client -connect 127.0.0.1:443 -servername shop.test 2>/dev/null | openssl x509 -noout -issuer");
function selfSigned() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'e2essl-'));
  execFileSync('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '60', '-subj', '/CN=shop.test', '-addext', 'subjectAltName=DNS:shop.test,DNS:www.shop.test', '-keyout', `${d}/k`, '-out', `${d}/c`], { stdio: 'ignore' });
  const out = { cert: fs.readFileSync(`${d}/c`, 'utf8'), key: fs.readFileSync(`${d}/k`, 'utf8') };
  fs.rmSync(d, { recursive: true });
  return out;
}

await fetch(`${CF}/__reset`);
await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
await api('PUT', '/settings', { cf_token: 'test-token' });

let project;
await step('Set up: project on vps-new whose nginx site points to a certificate file that is not there', async () => {
  for (const p of await api('GET', '/projects')) if (p.name === 'SSL setup test') await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  const servers = await api('GET', '/servers');
  const srv = servers.find((s) => s.ip === '172.30.0.22') || (await api('POST', '/servers', { ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY, name: 'vps-new', ip: '172.30.0.22' }));
  on('rm -rf /etc/ssl/cloudflare /etc/ssl/switchboard; rm -f /etc/nginx/sites-enabled/shop.test /etc/nginx/sites-enabled/other.test /etc/nginx/sites-available/other.test; nginx -s reload 2>/dev/null || nginx');
  put(SITE, `server {
    listen 80;
    server_name shop.test www.shop.test;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name shop.test www.shop.test;
    ssl_certificate /etc/ssl/cloudflare/cinemagickh.pem;
    ssl_certificate_key /etc/ssl/cloudflare/cinemagickh.key;
    location / { return 200 "shop ok"; }
}
`);
  on(`ln -sfn ${SITE} /etc/nginx/sites-enabled/shop.test`);
  check(/cannot load certificate "\/etc\/ssl\/cloudflare\/cinemagickh\.pem"/.test(sh(`docker exec ${BOX} sh -c "nginx -t 2>&1 || true"`)), 'nginx -t fails with the same error as on the real server');
  const zone = (await api('GET', '/cloudflare/zones')).find((z) => z.name === 'shop.test');
  const recs = (await api('GET', `/cloudflare/zones/${zone.id}/records`)).filter((r) => ['shop.test', 'www.shop.test'].includes(r.name));
  project = await api('POST', '/projects', { name: 'SSL setup test', domain: 'shop.test', health_scheme: 'http', dns_records: recs.map((r) => ({ zone_id: zone.id, zone_name: zone.name, id: r.id, name: r.name, type: r.type })) });
  await api('POST', `/projects/${project.id}/deployments`, { server_id: srv.id, db_type: 'none' });
  project = await api('GET', `/projects/${project.id}`);
});

await step('Scan finds the missing certificate file', async () => {
  const s = await api('GET', `/projects/${project.id}/ssl/scan`);
  const v = s.servers[0];
  check(JSON.stringify(s.hosts) === JSON.stringify(['shop.test', 'www.shop.test']), `hosts: ${s.hosts.join(', ')}`);
  check(v.status === 'missing' && /cinemagickh\.pem/.test(v.message), `status ${v.status}: ${v.message}`);
  check(v.sites.length === 2 && v.sites.some((x) => x.redirect) && v.sites.some((x) => x.cert_missing), 'both server blocks listed (redirect + HTTPS with missing file)');
  check(s.cloudflare === true, 'Cloudflare option available');
});

await step('Cloudflare (automatic): certificate made, site fixed, nginx reloads', async () => {
  const { job } = await api('POST', `/projects/${project.id}/ssl/setup`, { method: 'cloudflare', strict: false });
  const j = await waitJob(job);
  check(j.status === 'success', `job #${j.id} → ${j.status}${j.error ? ` (${j.error.slice(0, 300)})` : ''}`);
  const conf = on(`cat ${SITE}`);
  check(conf.includes('ssl_certificate /etc/ssl/cloudflare/shop.test.pem;') && conf.includes('ssl_certificate_key /etc/ssl/cloudflare/shop.test.key;') && !conf.includes('cinemagickh'), 'site points to /etc/ssl/cloudflare/shop.test.pem/.key');
  check(onOk('nginx -t'), 'nginx -t passes');
  check(/CloudFlare/i.test(issuerOn443()), `nginx serves it: ${issuerOn443()}`);
  check(on('stat -c %a /etc/ssl/cloudflare/shop.test.key') === '600', 'key is chmod 600');
  check(!onOk('ls /etc/ssl/cloudflare/*.new /etc/ssl/cloudflare/*.old /etc/nginx/sites-available/*.sb-bak'), 'no leftover temporary files');
  const s = await api('GET', `/projects/${project.id}/ssl/scan`);
  check(s.servers[0].status === 'ok' && /Cloudflare Origin/.test(s.servers[0].message), `scan after: ${s.servers[0].status} — ${s.servers[0].message}`);
  check(s.servers[0].sites.some((x) => x.key_match === true), 'scan: key matches the certificate');
});

const own = selfSigned();
await step('My own certificate on an http-only site: port 443 is added', async () => {
  put(SITE, 'server {\n    listen 80;\n    listen [::]:80;\n    server_name shop.test www.shop.test;\n    location / { return 200 "shop ok"; }\n}\n');
  on('nginx -s reload');
  const s0 = await api('GET', `/projects/${project.id}/ssl/scan`);
  check(s0.servers[0].status === 'no-ssl', `scan before: ${s0.servers[0].status} — ${s0.servers[0].message}`);
  let err = '';
  try {
    await api('POST', `/projects/${project.id}/ssl/setup`, { method: 'own', cert: own.cert, key: selfSigned().key });
  } catch (e) {
    err = e.message;
  }
  check(/does not belong/.test(err), `a key of another certificate is refused at once (${err})`);
  const { job } = await api('POST', `/projects/${project.id}/ssl/setup`, { method: 'own', cert: own.cert, key: own.key });
  const j = await waitJob(job);
  check(j.status === 'success', `job #${j.id} → ${j.status}${j.error ? ` (${j.error.slice(0, 300)})` : ''}`);
  check(!JSON.stringify(j).includes('PRIVATE KEY'), 'the private key is not in the job (params/log)');
  const conf = on(`cat ${SITE}`);
  check(/listen 443 ssl;\n\s*listen \[::\]:443 ssl;\n\s*ssl_certificate \/etc\/ssl\/switchboard\/shop\.test\.pem;/.test(conf), 'listen 443 ssl (+IPv6) and the certificate added to the site');
  check(on("echo | openssl s_client -connect 127.0.0.1:443 -servername shop.test 2>/dev/null | openssl x509 -noout -subject").includes('shop.test'), 'nginx serves the pasted certificate');
  const s = await api('GET', `/projects/${project.id}/ssl/scan`);
  check(s.servers[0].status === 'self-signed', `scan after: ${s.servers[0].status} — ${s.servers[0].message}`);
});

await step('Another broken site blocks nginx: everything is put back, scan names the culprit', async () => {
  put('/etc/nginx/sites-available/other.test', 'server {\n    listen 443 ssl;\n    server_name other.test;\n    ssl_certificate /etc/ssl/cloudflare/gone.pem;\n    ssl_certificate_key /etc/ssl/cloudflare/gone.key;\n}\n');
  on('ln -sfn /etc/nginx/sites-available/other.test /etc/nginx/sites-enabled/other.test');
  put(SITE, 'server {\n    listen 80;\n    server_name shop.test;\n    location / { return 200 "shop ok"; }\n}\n');
  const before = on(`cat ${SITE}`);
  const certBefore = on('sha256sum /etc/ssl/switchboard/shop.test.pem');
  const s0 = await api('GET', `/projects/${project.id}/ssl/scan`);
  check(s0.servers[0].broken.some((b) => b.path === '/etc/ssl/cloudflare/gone.pem' && b.file.endsWith('other.test')), 'scan lists other.test → gone.pem as the reason nginx cannot reload');
  const fresh = selfSigned();
  const { job } = await api('POST', `/projects/${project.id}/ssl/setup`, { method: 'own', cert: fresh.cert, key: fresh.key });
  const j = await waitJob(job);
  check(j.status === 'failed' && /nginx did not accept it.*gone\.pem/.test(j.error || ''), `job failed with nginx's reason: ${(j.error || '').slice(0, 200)}`);
  check(on(`cat ${SITE}`) === before, 'site file put back as it was');
  check(on('sha256sum /etc/ssl/switchboard/shop.test.pem') === certBefore, 'old certificate put back');
  check(!onOk('ls /etc/ssl/switchboard/*.new /etc/ssl/switchboard/*.old /etc/nginx/sites-available/*.sb-bak'), 'no leftover temporary files');
});

await step('Clean up', async () => {
  on('rm -f /etc/nginx/sites-enabled/shop.test /etc/nginx/sites-enabled/other.test /etc/nginx/sites-available/other.test ' + SITE + '; rm -rf /etc/ssl/cloudflare /etc/ssl/switchboard; nginx -s reload');
  await api('DELETE', `/projects/${project.id}`, { confirm: project.slug });
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);

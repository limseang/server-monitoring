#!/usr/bin/env node
// End-to-end: Cloudflare Origin Certificate from the project settings → installed on the servers →
// SSL "Full (strict)". Needs the fake Cloudflare (dev/cf-mock) and two lab boxes:
//   vps-ci  (172.30.0.25, own Docker + Switchboard's web proxy)   docker compose -f dev/docker-compose.yml --profile ci up -d vps-ci
//   vps-new (172.30.0.22, no web proxy → certificate files only)   docker compose -f dev/docker-compose.yml --profile clone up -d vps-new
//   SB_URL=http://localhost:8090 CF_URL=http://localhost:8787 node dev/e2e-origincert.mjs
// Only touches its own project "Origin cert test", its web proxy site on vps-ci and the certificate files.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SB_URL || 'http://localhost:8090';
const CF = process.env.CF_URL || 'http://localhost:8787';
const KEY = fs.readFileSync(process.env.SB_KEY_FILE || path.join(DIR, '.keys/id_ed25519'), 'utf8');
const SLUG = 'origin-cert-test';
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
const cfState = async () => (await fetch(`${CF}/__state`)).json();
const sh = (cmd, input) => execSync(cmd, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }).trim();
const on = (box, cmd) => sh(`docker exec ${box} sh -c ${JSON.stringify(cmd)}`);
const onOk = (box, cmd) => {
  try {
    on(box, cmd);
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
      if (j.status !== 'success' || process.env.VERBOSE) console.log(j.log.split('\n').slice(-40).map((l) => `      ${l}`).join('\n'));
      return j;
    }
    await sleep(700);
  }
  throw new Error('job did not finish in time');
}
const keyMatches = (box, crt, key) => onOk(box, `[ "$(openssl x509 -noout -pubkey -in ${crt} | openssl sha256)" = "$(openssl pkey -pubout -in ${key} | openssl sha256)" ]`);

await fetch(`${CF}/__reset`);
await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
await api('PUT', '/settings', { cf_token: 'test-token' });

let project, ci, fresh, zoneId;
await step('Set up: vps-ci with a web proxy site for the project, vps-new without one', async () => {
  for (const p of await api('GET', '/projects')) if (p.name === 'Origin cert test') await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  const servers = await api('GET', '/servers');
  const base = { ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY };
  ci = servers.find((s) => s.ip === '172.30.0.25') || (await api('POST', '/servers', { ...base, name: 'vps-ci', ip: '172.30.0.25' }));
  fresh = servers.find((s) => s.ip === '172.30.0.22') || (await api('POST', '/servers', { ...base, name: 'vps-new', ip: '172.30.0.22' }));
  // The web proxy site a template project would have (helper from this checkout).
  const helper = fs.readFileSync(path.join(DIR, '../src/remote/switchboard-helper.sh'), 'utf8').replaceAll('__VERSION__', '3').replaceAll('__EDGE_IMAGE__', 'nginx:1.27-alpine');
  sh('docker exec -i vps-ci sh -c "cat > /usr/local/bin/switchboard-helper && chmod 755 /usr/local/bin/switchboard-helper"', helper);
  on('vps-ci', `switchboard-helper edge-site ${SLUG} 18999 shop.test www.shop.test`);
  check(onOk('vps-ci', `grep -q 'ssl_certificate /etc/switchboard/edge/ssl/cert.pem' /etc/switchboard/edge/conf.d/sb-${SLUG}.conf`), 'web proxy site uses the self-signed certificate');
  const zone = (await api('GET', '/cloudflare/zones')).find((z) => z.name === 'shop.test');
  zoneId = zone.id;
  const recs = (await api('GET', `/cloudflare/zones/${zone.id}/records`)).filter((r) => ['shop.test', 'www.shop.test'].includes(r.name));
  project = await api('POST', '/projects', {
    name: 'Origin cert test',
    domain: 'shop.test',
    health_scheme: 'http',
    dns_records: recs.map((r) => ({ zone_id: zone.id, zone_name: zone.name, id: r.id, name: r.name, type: r.type })),
  });
  check(project.slug === SLUG, `project slug ${project.slug}`);
  await api('POST', `/projects/${project.id}/deployments`, { server_id: ci.id, db_type: 'none' });
  await api('POST', `/projects/${project.id}/deployments`, { server_id: fresh.id, db_type: 'none' });
  for (const r of recs) await api('POST', `/projects/${project.id}/dns/records/${r.id}`, { content: '172.30.0.25' });
  const st = await api('GET', `/projects/${project.id}/ssl`);
  check(JSON.stringify(st.cert_hostnames) === JSON.stringify(['shop.test', '*.shop.test']), `certificate will cover ${st.cert_hostnames.join(', ')}`);
  const c = st.checks.find((x) => x.ip === '172.30.0.25' && x.name === 'shop.test');
  check(c?.https && !c.strict_ok, `before: vps-ci serves HTTPS with a self-signed certificate (strict_ok=${c?.strict_ok})`);
});

await step('Install the Origin Certificate on both servers, then switch to Full (strict)', async () => {
  const { job } = await api('POST', `/projects/${project.id}/ssl/origin-cert`, { strict: true });
  const j = await waitJob(job);
  check(j.status === 'success', `job #${j.id} → ${j.status}${j.error ? ` (${j.error.slice(0, 200)})` : ''}`);
  const cs = await cfState();
  check(cs.origin_certs.length === 2 && cs.origin_certs.every((c) => c.hostnames.join() === 'shop.test,*.shop.test' && c.request_type === 'origin-rsa'), `Cloudflare signed ${cs.origin_certs.length} certificates (one per server)`);
  // vps-ci: web proxy site switched to the new certificate
  const conf = on('vps-ci', `cat /etc/switchboard/edge/conf.d/sb-${SLUG}.conf`);
  check(conf.includes(`ssl_certificate /etc/switchboard/edge/ssl/site-${SLUG}.pem;`) && conf.includes(`ssl_certificate_key /etc/switchboard/edge/ssl/site-${SLUG}.key;`), 'vps-ci: web proxy site uses site-<slug>.pem/.key');
  check(keyMatches('vps-ci', `/etc/switchboard/edge/ssl/site-${SLUG}.pem`, `/etc/switchboard/edge/ssl/site-${SLUG}.key`), 'vps-ci: certificate matches the key made on the server');
  check(on('vps-ci', `stat -c %a /etc/switchboard/edge/ssl/site-${SLUG}.key`) === '600', 'vps-ci: key is chmod 600');
  check(on('vps-ci', 'switchboard-helper version') .includes('4'), 'vps-ci: switchboard-helper updated to v4');
  // vps-new: files only
  check(keyMatches('vps-new', '/etc/ssl/cloudflare/shop.test.pem', '/etc/ssl/cloudflare/shop.test.key'), 'vps-new: /etc/ssl/cloudflare/shop.test.pem + .key saved and matching');
  check(/ssl_certificate +\/etc\/ssl\/cloudflare\/shop\.test\.pem;/.test(j.log), 'job log shows the nginx lines for vps-new');
  check(!onOk('vps-new', 'ls /etc/ssl/cloudflare/*.new'), 'no leftover temporary files');
  // HTTPS check + strict
  const st = await api('GET', `/projects/${project.id}/ssl`);
  const c = st.checks.find((x) => x.ip === '172.30.0.25' && x.name === 'shop.test');
  check(c?.https && c.strict_ok && /CloudFlare/.test(c.issuer), `after: vps-ci presents the Origin Certificate (${c?.issuer}, strict_ok=${c?.strict_ok})`);
  check(cs.settings[zoneId]?.ssl === 'strict' && cs.settings[zoneId]?.always_use_https === 'on', `Cloudflare SSL: ${cs.settings[zoneId]?.ssl}, Always Use HTTPS ${cs.settings[zoneId]?.always_use_https}`);
  const ev = await api('GET', `/events?project=${project.id}`).then((e) => e.events || e);
  check(ev.some((e) => /Origin Certificate installed on vps-ci, vps-new \(files only/.test(e.message)), 'activity log: certificate installed');
  check(ev.some((e) => /Cloudflare SSL of shop\.test: flexible → strict/.test(e.message)), 'activity log: SSL → strict');
});

await step('The certificate stays when the web proxy site is set up again', async () => {
  on('vps-ci', `switchboard-helper edge-site ${SLUG} 18999 shop.test www.shop.test`);
  check(onOk('vps-ci', `grep -q 'ssl_certificate /etc/switchboard/edge/ssl/site-${SLUG}.pem' /etc/switchboard/edge/conf.d/sb-${SLUG}.conf`), 'site still uses the Origin Certificate');
});

await step('Running it again replaces the certificate (new key)', async () => {
  const before = on('vps-ci', `openssl x509 -noout -serial -in /etc/switchboard/edge/ssl/site-${SLUG}.pem`);
  const { job } = await api('POST', `/projects/${project.id}/ssl/origin-cert`, {});
  const j = await waitJob(job);
  check(j.status === 'success', `job → ${j.status}`);
  const after = on('vps-ci', `openssl x509 -noout -serial -in /etc/switchboard/edge/ssl/site-${SLUG}.pem`);
  check(before !== after && keyMatches('vps-ci', `/etc/switchboard/edge/ssl/site-${SLUG}.pem`, `/etc/switchboard/edge/ssl/site-${SLUG}.key`), 'new certificate, still matching its key');
});

await step('Clean up', async () => {
  await api('DELETE', `/projects/${project.id}`, { confirm: project.slug });
  for (const s of [ci, fresh]) if (!(await api('GET', '/projects')).some((p) => p.deployments?.some((d) => d.server_id === s.id))) await api('DELETE', `/servers/${s.id}`);
  on('vps-ci', `switchboard-helper edge-rm ${SLUG}; rm -f /etc/switchboard/edge/ssl/site-${SLUG}.*`);
  on('vps-new', 'rm -rf /etc/ssl/cloudflare');
  await fetch(`${CF}/__reset`);
  check(true, 'test project, servers, web proxy site and certificate files removed');
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);

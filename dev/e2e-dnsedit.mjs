#!/usr/bin/env node
// End-to-end: change a linked Cloudflare record by hand (point to another IP, proxy on/off) and set the
// zone's SSL mode from the project settings card. Needs srv-a / srv-b and a fake Cloudflare (dev/cf-mock).
//   SB_URL=http://localhost:8090 CF_URL=http://localhost:8787 node dev/e2e-dnsedit.mjs
// Starts a small nginx with a self-signed certificate (container sb-e2e-tls, 172.30.0.77) as an
// "HTTPS origin", and removes it at the end.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SB_URL || 'http://localhost:8090';
const CF = process.env.CF_URL || 'http://localhost:8787';
const NET = process.env.LAB_NET || 'switchboard-dev_lab';
const TLS_IP = '172.30.0.77';
const KEY = fs.readFileSync(process.env.SB_KEY_FILE || path.join(DIR, '.keys/id_ed25519'), 'utf8');
let failures = 0;

function session() {
  let cookie = '';
  return async function api(method, url, body, { status } = {}) {
    const res = await fetch(`${BASE}/api${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) cookie = c.split(';')[0];
    const data = await res.json().catch(() => null);
    if (status) return { status: res.status, data };
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
    return data;
  };
}
const api = session();
const cfState = async () => (await fetch(`${CF}/__state`)).json();
const cfRec = async (name) => (await cfState()).records.find((r) => r.name === name);
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

function startTlsOrigin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-tls-'));
  sh(`openssl req -x509 -nodes -newkey rsa:2048 -days 30 -subj /CN=sb-e2e -keyout ${dir}/key.pem -out ${dir}/cert.pem 2>/dev/null`);
  fs.chmodSync(path.join(dir, 'key.pem'), 0o644);
  fs.writeFileSync(
    path.join(dir, 'default.conf'),
    `server { listen 80; return 301 https://$host$request_uri; }
server { listen 443 ssl; ssl_certificate /tls/cert.pem; ssl_certificate_key /tls/key.pem; location / { return 200 "ok\\n"; } }
`,
  );
  sh('docker rm -f sb-e2e-tls >/dev/null 2>&1 || true');
  sh(`docker run -d --name sb-e2e-tls --network ${NET} --ip ${TLS_IP} -v ${dir}/cert.pem:/tls/cert.pem:ro -v ${dir}/key.pem:/tls/key.pem:ro -v ${dir}/default.conf:/etc/nginx/conf.d/default.conf:ro nginx:1.27-alpine`);
  return dir;
}

await fetch(`${CF}/__reset`);
await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
await api('PUT', '/settings', { cf_token: 'test-token' });

let project, depA, depB, A, B, www, shop, mail, zoneId;
await step('Set up servers A/B and a project linked to shop.test + www', async () => {
  for (const p of await api('GET', '/projects')) if (p.name === 'DNS edit test') await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  const servers = await api('GET', '/servers');
  const base = { ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY };
  A = servers.find((s) => s.ip === '172.30.0.11') || (await api('POST', '/servers', { ...base, name: 'Server A', ip: '172.30.0.11' }));
  B = servers.find((s) => s.ip === '172.30.0.12') || (await api('POST', '/servers', { ...base, name: 'Server B', ip: '172.30.0.12' }));
  const zone = (await api('GET', '/cloudflare/zones')).find((z) => z.name === 'shop.test');
  zoneId = zone.id;
  const recs = await api('GET', `/cloudflare/zones/${zone.id}/records`);
  [shop, www, mail] = ['shop.test', 'www.shop.test', 'mail.shop.test'].map((n) => recs.find((r) => r.name === n));
  project = await api('POST', '/projects', {
    name: 'DNS edit test',
    domain: 'shop.test',
    health_scheme: 'http',
    dns_records: [shop, www].map((r) => ({ zone_id: zone.id, zone_name: zone.name, id: r.id, name: r.name, type: r.type })),
  });
  depA = await api('POST', `/projects/${project.id}/deployments`, { server_id: A.id, db_type: 'none' });
  depB = await api('POST', `/projects/${project.id}/deployments`, { server_id: B.id, db_type: 'none' });
  const st = await api('POST', `/projects/${project.id}/dns/refresh`);
  check(st.records.length === 2 && st.records.every((r) => r.owner_name === 'Server A'), 'both records point to Server A');
});

await step('Point www.shop.test to Server B, then to an unknown old server, then back', async () => {
  let r = await api('POST', `/projects/${project.id}/dns/records/${www.id}`, { content: '172.30.0.12' });
  check(r.changed && (await cfRec('www.shop.test')).content === '172.30.0.12', 'Cloudflare: www → 172.30.0.12');
  check(r.dns_state.records.find((x) => x.id === www.id).owner_name === 'Server B', 'dashboard sees www on Server B');
  check((await cfRec('shop.test')).content === '172.30.0.11', 'shop.test untouched');
  r = await api('POST', `/projects/${project.id}/dns/records/${www.id}`, { content: '198.51.100.20' });
  check(r.dns_state.records.find((x) => x.id === www.id).owner_name === null, 'IP of a server Switchboard does not know is accepted');
  r = await api('POST', `/projects/${project.id}/dns/records/${www.id}`, { content: '172.30.0.11' });
  check((await cfRec('www.shop.test')).content === '172.30.0.11', 'back on Server A');
  r = await api('POST', `/projects/${project.id}/dns/records/${www.id}`, { content: '172.30.0.11' });
  check(r.changed === false, 'same IP again → nothing changed');
  const ev = await api('GET', `/events?project=${project.id}`);
  const list = ev.events || ev;
  check(list.some((e) => /www\.shop\.test changed by hand: 172\.30\.0\.11 → 172\.30\.0\.12 \(Server B\)/.test(e.message) && e.user === 'admin'), 'audit log has the change (with who did it)');
});

await step('Bad input is refused', async () => {
  let r = await api('POST', `/projects/${project.id}/dns/records/${www.id}`, { content: 'not-an-ip' }, { status: true });
  check(r.status === 400, `not an IP → 400 (${r.data?.error})`);
  r = await api('POST', `/projects/${project.id}/dns/records/${www.id}`, { content: '2001:db8::1' }, { status: true });
  check(r.status === 400, 'IPv6 on an A record → 400');
  r = await api('POST', `/projects/${project.id}/dns/records/${mail.id}`, { content: '172.30.0.12' }, { status: true });
  check(r.status === 400 && (await cfRec('mail.shop.test')).content === '172.30.0.99', `record not linked to the project → 400 (${r.data?.error})`);
});

await step('Proxy (orange cloud) off and on', async () => {
  let r = await api('POST', `/projects/${project.id}/dns/records/${www.id}`, { proxied: false });
  check(r.changed && (await cfRec('www.shop.test')).proxied === false, 'www proxy off in Cloudflare');
  check(r.dns_state.records.find((x) => x.id === www.id).proxied === false, 'dashboard shows DNS only');
  r = await api('POST', `/projects/${project.id}/dns/records/${www.id}`, { proxied: true });
  check((await cfRec('www.shop.test')).proxied === true, 'www proxy back on');
  const list = await api('GET', `/events?project=${project.id}`).then((e) => e.events || e);
  check(list.some((e) => /proxy OFF/.test(e.message)) && list.some((e) => /proxy ON/.test(e.message)), 'audit log has proxy changes');
});

await step('Only admins may change DNS or SSL', async () => {
  const userList = async () => [].concat((await api('GET', '/users')).users || (await api('GET', '/users')));
  const users = await userList();
  for (const u of users.filter((x) => x.username === 'dns-dev')) await api('DELETE', `/users/${u.id}`);
  await api('POST', '/users', { username: 'dns-dev', password: 'dev-password-123', role: 'developer' });
  const dev = session();
  await dev('POST', '/auth/login', { username: 'dns-dev', password: 'dev-password-123' });
  const r1 = await dev('POST', `/projects/${project.id}/dns/records/${www.id}`, { content: '172.30.0.12' }, { status: true });
  const r2 = await dev('POST', `/projects/${project.id}/ssl`, { mode: 'off' }, { status: true });
  check(r1.status === 403 && r2.status === 403, `developer → 403 / 403 (${r1.status} / ${r2.status})`);
  check((await cfRec('www.shop.test')).content === '172.30.0.11', 'DNS unchanged');
  for (const u of (await userList()).filter((x) => x.username === 'dns-dev')) await api('DELETE', `/users/${u.id}`);
});

const tlsDir = startTlsOrigin();
await sleep(1500);

await step('SSL: status and safety checks', async () => {
  const st = await api('GET', `/projects/${project.id}/ssl`);
  check(st.zones[0].ssl === 'flexible' && st.zones[0].always_use_https === 'off', `zone now: ssl=${st.zones[0].ssl}, always https=${st.zones[0].always_use_https}`);
  check(st.default_mode === 'full', 'safe default is "full"');
  check(st.checks.some((c) => c.name === 'shop.test' && c.ip === '172.30.0.11' && !c.https), 'Server A does not answer HTTPS (seen)');
  const r = await api('POST', `/projects/${project.id}/ssl`, { mode: 'full', always_https: true }, { status: true });
  check(r.status === 409 && r.data.problems.length >= 2, `Full refused while proxied hosts have no HTTPS (${r.data?.problems?.length} problems)`);
  check((await cfState()).settings[zoneId]?.ssl !== 'full', 'zone not changed');
});

await step('SSL: point both records to an HTTPS origin, then turn on Full + Always Use HTTPS', async () => {
  for (const rec of [shop, www]) await api('POST', `/projects/${project.id}/dns/records/${rec.id}`, { content: TLS_IP });
  const st = await api('GET', `/projects/${project.id}/ssl`);
  const c = st.checks.find((x) => x.ip === TLS_IP && x.name === 'shop.test');
  check(c?.https && !c.strict_ok && c.redirects_to_https, `origin ${TLS_IP}: https=${c?.https}, strict_ok=${c?.strict_ok}, redirects=${c?.redirects_to_https}`);
  const r = await api('POST', `/projects/${project.id}/ssl`, { mode: 'full', always_https: true });
  const zs = (await cfState()).settings[zoneId];
  check(zs.ssl === 'full' && zs.always_use_https === 'on', `Cloudflare: ssl=${zs.ssl}, always_use_https=${zs.always_use_https}`);
  check(r.status.zones[0].ssl === 'full', 'status after apply shows full');
});

await step('SSL: strict and flexible are refused when they would break the site', async () => {
  let r = await api('POST', `/projects/${project.id}/ssl`, { mode: 'strict' }, { status: true });
  check(r.status === 409 && r.data.problems.some((p) => /strict/.test(p)), 'strict refused: self-signed certificate');
  r = await api('POST', `/projects/${project.id}/ssl`, { mode: 'flexible' }, { status: true });
  check(r.status === 409 && r.data.problems.some((p) => /redirect loop/.test(p)), 'flexible refused: origin redirects http → https (loop)');
  check((await cfState()).settings[zoneId].ssl === 'full', 'zone still on full');
  r = await api('POST', `/projects/${project.id}/ssl`, { mode: 'strict', force: true });
  check((await cfState()).settings[zoneId].ssl === 'strict', 'force → strict');
  await api('POST', `/projects/${project.id}/ssl`, { mode: 'full' });
  const list = await api('GET', `/events?project=${project.id}`).then((e) => e.events || e);
  check(list.some((e) => /Cloudflare SSL of shop\.test: flexible → full, Always Use HTTPS on/.test(e.message)), 'audit log has the SSL change');
  check(list.some((e) => /→ strict \(forced despite/.test(e.message) && e.level === 'warn'), 'forced change logged as a warning');
});

await step('Clean up', async () => {
  await api('DELETE', `/projects/${project.id}`, { confirm: project.slug });
  sh('docker rm -f sb-e2e-tls >/dev/null 2>&1 || true');
  fs.rmSync(tlsDir, { recursive: true, force: true });
  await fetch(`${CF}/__reset`);
  check(true, 'test project, TLS origin and fake Cloudflare state removed');
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);

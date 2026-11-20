#!/usr/bin/env node
// End-to-end test for the project "Web proxy (nginx)": domain → nginx → the app's port, on a project's servers.
// Needs vps-src from the clone pair (./dev/clone-setup.sh): its shop app answers on port 8080 and a second app
// on 127.0.0.1:18000. Only touches vps-src's web proxy (sb-proj-*.conf), and removes what it adds.
//   node dev/e2e-proxy.mjs
//   SB_URL=http://localhost:8096 SB_USER=… SB_PASSWORD=…   test another Switchboard instance (default: the lab on 8090)
//   SB_LAB_DIR=/path/to/dev                                where .keys is (default: this folder)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LAB = process.env.SB_LAB_DIR || DIR;
const BASE = process.env.SB_URL || 'http://localhost:8090';
const KEY = fs.readFileSync(path.join(LAB, '.keys/id_ed25519'), 'utf8');
let cookie = '';
let failures = 0;

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
const refused = (p) => p.then(() => '').catch((e) => e.message);
const on = (vps, cmd) => execSync(`docker exec ${vps} sh -c ${JSON.stringify(cmd)}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const curl = (host) => on('vps-src', `curl -s -m 5 -H 'Host: ${host}' http://127.0.0.1/ || true`);

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
async function waitJob(job, expect = 'success') {
  for (let i = 0; i < 600; i++) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-30).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error})` : ''}`);
      return j;
    }
    await sleep(1000);
  }
  throw new Error('job did not finish in time');
}

const NAME = 'Proxy vps-src';
let srv, shop, other, dep, dep2;

await step('Set up: vps-src with its shop app, two projects', async () => {
  check(/shop-app-1/.test(on('vps-src', 'docker ps --format {{.Names}}')), 'vps-src runs the shop app (port 8080)');
  await api('POST', '/auth/login', { username: process.env.SB_USER || 'admin', password: process.env.SB_PASSWORD || 'admin-password-123' });
  for (const p of await api('GET', '/projects')) if (['proxy-shop', 'proxy-other'].includes(p.slug)) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  for (const s of await api('GET', '/servers')) if (s.name === NAME) await api('DELETE', `/servers/${s.id}`);
  srv = await api('POST', '/servers', { ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY, name: NAME, ip: '172.30.0.21' });
  shop = await api('POST', '/projects', { name: 'Proxy Shop', domain: 'shop.proxy.test' });
  dep = await api('POST', `/projects/${shop.id}/deployments`, { server_id: srv.id, app_container: 'shop-app-1', app_dir: '/srv/shop', db_type: 'none' });
  other = await api('POST', '/projects', { name: 'Proxy Other', domain: 'other.proxy.test' });
  dep2 = await api('POST', `/projects/${other.id}/deployments`, { server_id: srv.id, db_type: 'none' });
});

await step('Bad input is refused before anything runs', async () => {
  check(/not a domain/.test(await refused(api('POST', `/projects/${shop.id}/proxy`, { hosts: 'shop;rm -rf /', servers: [{ deployment: dep.id, port: 8080 }] }))), 'a bad domain');
  check(/not the app/.test(await refused(api('POST', `/projects/${shop.id}/proxy`, { hosts: 'shop.proxy.test', servers: [{ deployment: dep.id, port: 22 }] }))), 'port 22');
  check(/Unknown server/.test(await refused(api('POST', `/projects/${shop.id}/proxy`, { hosts: 'shop.proxy.test', servers: [{ deployment: dep2.id, port: 8080 }] }))), "another project's server");
  check(/No web proxy/.test(await refused(api('DELETE', `/projects/${shop.id}/proxy`))), 'remove when nothing is set up');
});

await step('Set up shop.proxy.test + www → port 8080 (no nginx on the server: the helper brings one)', async () => {
  const { job } = await api('POST', `/projects/${shop.id}/proxy`, { hosts: 'shop.proxy.test www.shop.proxy.test', servers: [{ deployment: dep.id, port: 8080 }] });
  const j = await waitJob(job);
  const prog = typeof j.progress === 'string' ? JSON.parse(j.progress) : j.progress;
  check(prog?.kind === 'proxy' && prog.servers[0].state === 'success' && prog.servers[0].code === 200, `live progress: ${JSON.stringify(prog?.servers?.[0])}`);
  check(/^ok /.test(curl('shop.proxy.test')), `shop.proxy.test → the shop app ("${curl('shop.proxy.test')}")`);
  check(/^ok /.test(curl('www.shop.proxy.test')), 'www.shop.proxy.test too');
  const p = await api('GET', `/projects/${shop.id}`);
  const d = p.deployments.find((x) => x.id === dep.id);
  check(d.proxy_state?.ok && d.proxy_state.port === 8080 && d.app_port === 8080, `saved: ${JSON.stringify(d.proxy_state)}, app_port ${d.app_port}`);
  check(JSON.stringify(p.proxy?.hosts) === '["shop.proxy.test","www.shop.proxy.test"]', 'project remembers its domains');
});

await step('Another project cannot take the same domain', async () => {
  const { job } = await api('POST', `/projects/${other.id}/proxy`, { hosts: 'shop.proxy.test', servers: [{ deployment: dep2.id, port: 18000 }] });
  const j = await waitJob(job, 'failed');
  check(/already used by the web proxy of project "Proxy Shop"/.test(j.log), 'the job names the project that has it');
  check(/^ok /.test(curl('shop.proxy.test')), 'shop.proxy.test still goes to the shop app');
});

await step('Change the port: our own site is replaced, not counted as a conflict', async () => {
  const { job } = await api('POST', `/projects/${shop.id}/proxy`, { hosts: 'shop.proxy.test', servers: [{ deployment: dep.id, port: 18000 }] });
  await waitJob(job);
  const body = curl('shop.proxy.test');
  check(body && !/^ok /.test(body), `shop.proxy.test now goes to port 18000 ("${body.slice(0, 40)}")`);
  check(!/www\.shop\.proxy\.test/.test(on('vps-src', 'cat /etc/switchboard/edge/conf.d/sb-proj-*.conf /etc/nginx/conf.d/sb-proj-*.conf 2>/dev/null || true')), 'www was dropped from the site');
});

await step('Remove: nginx no longer sends the domain to the app', async () => {
  const { job } = await api('POST', `/projects/${shop.id}/proxy`, { hosts: 'shop.proxy.test', servers: [{ deployment: dep.id, port: 8080 }] });
  await waitJob(job);
  const r = await api('DELETE', `/projects/${shop.id}/proxy`);
  await waitJob(r.job);
  check(!/^ok /.test(curl('shop.proxy.test')), 'shop.proxy.test no longer reaches the app');
  const p = await api('GET', `/projects/${shop.id}`);
  check(!p.proxy && !p.deployments[0].proxy_state, 'project and server records cleared');
  check(on('vps-src', 'ls /etc/switchboard/edge/conf.d /etc/nginx/conf.d 2>/dev/null | grep -c sb-proj- || true') === '0', 'no sb-proj-*.conf left');
});

await step('Clean up the test projects and server', async () => {
  for (const p of [shop, other]) if (p) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  if (srv) await api('DELETE', `/servers/${srv.id}`);
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all web proxy checks passed');
process.exit(failures ? 1 : 0);

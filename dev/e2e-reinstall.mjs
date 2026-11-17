#!/usr/bin/env node
// End-to-end test for "Reinstall OS (erase whole disk)".
// The lab's servers are containers, and a real OS can't be reinstalled inside a container, so the
// Switchboard instance under test must run with:
//   REINSTALL_SCRIPT_URL=file:///root/fake-reinstall.sh  (a fake installer this test puts on vps-new)
//   REINSTALL_ALLOW_CONTAINER=true
// Everything else is real: checks, download, cancel safety, reboot step, waiting for the new system,
// host key re-pinning, Docker install. The "fresh install" is simulated with ./clone-setup.sh reset-new.
//   SB_URL=http://localhost:8091 SB_LAB_DIR=/path/to/dev node dev/e2e-reinstall.mjs
// Only touches vps-new (and reads vps-src / Server A).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LAB = process.env.SB_LAB_DIR || DIR;
const BASE = process.env.SB_URL || 'http://localhost:8090';
const KEY = fs.readFileSync(path.join(LAB, '.keys/id_ed25519'), 'utf8');
const PUB = fs.readFileSync(path.join(LAB, '.keys/id_ed25519.pub'), 'utf8').split(' ').slice(0, 2).join(' ');
let cookie = '';
let failures = 0;

async function api(method, url, body) {
  const go = () =>
    fetch(`${BASE}/api${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const res = await go().catch((e) => (e.message === 'fetch failed' ? go() : Promise.reject(e)));
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) cookie = c.split(';')[0];
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
  return data;
}
const refused = (p) => p.then(() => '').catch((e) => e.message);
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const on = (vps, cmd) => sh(`docker exec ${vps} sh -c ${JSON.stringify(cmd)}`);
const onOk = (vps, cmd) => {
  try {
    on(vps, cmd);
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
async function waitJob(job, expect = 'success', minutes = 25) {
  for (let i = 0; i < minutes * 60; i++) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-40).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error})` : ''}`);
      return j;
    }
    await sleep(1000);
  }
  throw new Error('job did not finish in time');
}
async function until(fn, seconds, what) {
  for (let i = 0; i < seconds; i++) {
    if (fn()) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const FAKE = `#!/bin/sh
# Fake reinstall.sh for the lab: records what it was asked to do.
if [ "$1" = reset ]; then touch /root/reset-called; echo 'fake: reset'; exit 0; fi
echo "$@" > /root/args.txt
[ -f /root/slow ] && sleep 60
echo 'fake: installer prepared, reboot to start'`;
const putFake = () => on('vps-new', `echo ${Buffer.from(FAKE).toString('base64')} | base64 -d > /root/fake-reinstall.sh && chmod +x /root/fake-reinstall.sh && rm -f /root/args.txt /root/reset-called /root/slow`);

let src, dst, srvA, proj;
const NAMES = ['vps-src', 'vps-new', 'Reinstall Server A'];

await step('Blank vps-new, log in, add servers and a project', async () => {
  sh(`${path.join(LAB, 'clone-setup.sh')} reset-new`);
  await until(() => onOk('vps-new', 'pgrep sshd'), 30, 'sshd on vps-new');
  await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
  for (const p of await api('GET', '/projects')) if (p.slug === 'reinstall-shop' || p.deployments?.some((d) => NAMES.includes(d.server_name))) await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  for (const s of await api('GET', '/servers')) if (NAMES.includes(s.name)) await api('DELETE', `/servers/${s.id}`);
  const base = { ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY };
  src = await api('POST', '/servers', { ...base, name: 'vps-src', ip: '172.30.0.21' });
  dst = await api('POST', '/servers', { ...base, name: 'vps-new', ip: '172.30.0.22' });
  srvA = await api('POST', '/servers', { ...base, name: 'Reinstall Server A', ip: '172.30.0.11' });
  proj = await api('POST', '/projects', { name: 'Reinstall Shop', domain: 'reinstall-shop.test' });
  const live = await api('POST', `/projects/${proj.id}/deployments`, { server_id: src.id, app_dir: '/srv/shop', db_type: 'none' });
  await api('POST', `/projects/${proj.id}/adopt`, { deployment: live.id });
  await api('POST', `/projects/${proj.id}/deployments`, { server_id: dst.id, app_dir: '/srv/shop', db_type: 'none' });
  putFake();
});

await step('Checks refuse the dangerous cases', async () => {
  const a = await api('POST', `/servers/${srvA.id}/reinstall/preview`, { os: 'debian-12' });
  check(a.ok && a.plan.problems.some((x) => /This Switchboard dashboard runs on this server/.test(x)), `Server A (runs Switchboard) refused: ${a.plan?.problems[0] || a.error}`);
  const s = await api('POST', `/servers/${src.id}/reinstall/preview`, { os: 'debian-12' });
  check(s.ok && s.plan.problems.some((x) => /live server of Reinstall Shop/.test(x)), 'vps-src (live server) refused');
  check(/live server/.test(await refused(api('POST', `/servers/${src.id}/reinstall`, { confirm: 'vps-src' }))), 'start on vps-src refused');
  check(/confirm/.test(await refused(api('POST', `/servers/${dst.id}/reinstall`, { confirm: 'nope' }))), 'start without the typed name refused');
  const n = await api('POST', `/servers/${dst.id}/reinstall/preview`, { os: 'debian-12' });
  check(n.ok && !n.plan.problems.length, `vps-new can be reinstalled${n.plan?.problems.length ? `: ${n.plan.problems.join(' | ')}` : ''}${n.error || ''}`);
  check(n.plan?.facts.target === 'Debian 12 (bookworm)' && /root with the same SSH key/.test(n.plan?.facts.login), `preview shows target + login (${n.plan?.facts.login})`);
  check(n.plan?.facts.deployments.includes('Reinstall Shop'), 'preview says it leaves "Reinstall Shop"');
  check(!onOk('vps-new', 'test -e /root/args.txt'), 'preview changed nothing');
  // Another Switchboard (not this dashboard) on the server: a warning, not a block.
  on('vps-new', "command -v docker >/dev/null || exit 0; docker rm -f switchboard >/dev/null 2>&1; true");
  const other = await api('POST', `/servers/${srvA.id}/reinstall/preview`, { os: 'debian-12' });
  check(other.plan?.warnings.some((x) => /Another Switchboard runs here \(container [^)]*\bswitchboard\b/.test(x)), `Server A: your own "switchboard" container is only a warning (${other.plan?.warnings.find((x) => /Another/.test(x)) || 'none'})`);
  check(!other.plan?.problems.some((x) => /container[^)]*\bswitchboard[,)]/.test(x)), 'and it is not listed as THIS dashboard');
});

await step('Cancel while the installer runs → the installer is disarmed, nothing else changes', async () => {
  on('vps-new', 'touch /root/slow');
  const { job } = await api('POST', `/servers/${dst.id}/reinstall`, { os: 'debian-12', confirm: 'vps-new' });
  await until(() => onOk('vps-new', 'test -f /root/args.txt'), 60, 'fake installer started');
  await api('POST', `/jobs/${job.id}/cancel`);
  await waitJob(job, 'cancelled');
  await until(() => onOk('vps-new', 'test -f /root/reset-called'), 30, 'reset called');
  check(onOk('vps-new', 'test -f /root/reset-called'), '"reinstall.sh reset" was run to disarm it');
  check(!onOk('vps-new', 'test -e /root/.switchboard-before-reinstall'), 'no marker left');
  const p = await api('GET', `/projects/${proj.id}`);
  check(p.deployments.some((d) => d.server_id === dst.id), 'vps-new still in its project (nothing was erased)');
  putFake();
});

await step('Reinstall vps-new with Debian 12 (+ Docker)', async () => {
  const { job } = await api('POST', `/servers/${dst.id}/reinstall`, { os: 'debian-12', installDocker: true, confirm: 'vps-new' });
  await until(() => onOk('vps-new', 'test -f /root/.switchboard-before-reinstall'), 120, 'installer prepared');
  const args = on('vps-new', 'cat /root/args.txt');
  check(args.startsWith('debian 12 --username root --ssh-key ') && args.includes(PUB), `installer called with: debian 12, root, the same SSH key`);
  check(!/--ssh-port/.test(args), 'no --ssh-port for port 22');
  // Simulate the reboot into a freshly installed disk.
  await sleep(5000);
  sh(`${path.join(LAB, 'clone-setup.sh')} reset-new`);
  const j = await waitJob(job, 'success', 30);
  check(/new system is up/.test(j.log) && /New SSH host key pinned/.test(j.log), 'waited for the new system and pinned its host key');
  check(onOk('vps-new', 'docker info >/dev/null'), 'Docker installed on the fresh system');
  check(!onOk('vps-new', 'test -e /root/.switchboard-before-reinstall'), 'fresh disk (marker gone)');
  const s = (await api('GET', '/servers')).find((x) => x.id === dst.id);
  check(s.ssh_user === 'root' && !!s.host_key, 'server record: root login, host key pinned');
  const p = await api('GET', `/projects/${proj.id}`);
  check(!p.deployments.some((d) => d.server_id === dst.id), 'vps-new removed from "Reinstall Shop"');
  check((await api('POST', `/servers/${dst.id}/refresh`)).ok, 'Switchboard can log in to the new system');
  check(onOk('vps-src', 'docker ps --format {{.Names}} | grep -q shop-app-1'), 'vps-src untouched');
});

await step('Clean up', async () => {
  await api('DELETE', `/projects/${proj.id}`, { confirm: 'reinstall-shop' }).catch(() => {});
  for (const s of [src, dst, srvA]) await api('DELETE', `/servers/${s.id}`).catch(() => {});
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);

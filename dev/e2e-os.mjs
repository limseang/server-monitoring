#!/usr/bin/env node
// End-to-end test for "Upgrade OS". Needs the lab (./dev/setup.sh) and the VPS set (./dev/clone-setup.sh).
//   node dev/e2e-os.mjs
// Upgrades the blank vps-lb (Debian 12) to Debian 13 through the real API (reboots are skipped in containers),
// and checks the safety rules: downgrade refused, live server refused, snapshot + name confirmation required.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SB_URL || 'http://localhost:8090';
const KEY = fs.readFileSync(path.join(DIR, '.keys/id_ed25519'), 'utf8');
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
  if (!res.ok) throw Object.assign(new Error(`${method} ${url} → ${res.status} ${data?.error}`), { data });
  return data;
}
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const on = (vps, cmd) => sh(`docker exec ${vps} sh -c ${JSON.stringify(cmd)}`);
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
async function waitJob(job, expect = 'success', minutes = 40) {
  for (let i = 0; i < minutes * 60; i++) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-40).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error.slice(0, 200)})` : ''}`);
      return j;
    }
    await sleep(1500);
  }
  throw new Error('job did not finish in time');
}
const refused = async (fn, re) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return re.test(e.message);
  }
};

let lb;
let src;

await step('Reset vps-lb (blank Debian 12) and add servers', async () => {
  sh(`${path.join(DIR, 'clone-setup.sh')} reset-lb`);
  for (let i = 0; i < 30; i++) {
    try {
      on('vps-lb', 'pgrep sshd');
      break;
    } catch {
      await sleep(500);
    }
  }
  const v0 = on('vps-lb', 'grep ^VERSION_ID= /etc/os-release | cut -d= -f2 | tr -d \'"\'');
  check(v0 === '12', `vps-lb runs Debian 12 (${v0})`);
  await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
  for (const p of await api('GET', '/projects')) if (p.slug === 'os-test') await api('DELETE', `/projects/${p.id}`, { confirm: p.slug });
  const base = { ssh_user: 'root', ssh_port: 22, auth_type: 'key', ssh_key: KEY };
  const existing = await api('GET', '/servers');
  // vps-lb was just reinstalled → its SSH host key changed; re-add it. vps-src may be live in other lab projects → reuse.
  for (const s of existing) if (s.name === 'vps-lb') await api('DELETE', `/servers/${s.id}`).catch(() => {});
  lb = await api('POST', '/servers', { ...base, name: 'vps-lb', ip: '172.30.0.24' });
  src = existing.find((s) => s.name === 'vps-src') || (await api('POST', '/servers', { ...base, name: 'vps-src', ip: '172.30.0.21' }));
  const p = await api('POST', '/projects', { name: 'OS test', domain: 'shop.test', health_scheme: 'http', health_port: 8080, health_path: '/up' });
  const d = await api('POST', `/projects/${p.id}/deployments`, { server_id: src.id, db_type: 'none' });
  await api('POST', `/projects/${p.id}/adopt`, { deployment: d.id });
});

await step('Preview and safety rules', async () => {
  const r = await api('POST', `/servers/${lb.id}/os-upgrade/preview`, {});
  check(r.ok && r.plan.os.id === 'debian' && r.plan.os.version === '12', `reads the OS: ${r.plan?.os.pretty}`);
  check(JSON.stringify(r.plan.path) === '["13"]', `can go to: ${r.plan.path.join(', ')}`);
  const down = await api('POST', `/servers/${lb.id}/os-upgrade/preview`, { target: '11' });
  check(down.plan.problems.some((x) => /Downgrading .*not possible.*Reinstall.*Clone/.test(x)), 'downgrade refused, explains reinstall + clone');
  const live = await api('POST', `/servers/${src.id}/os-upgrade/preview`, { target: '13' });
  check(live.plan.problems.some((x) => /LIVE server of "OS test"/.test(x)), 'the live server of a project is refused');
  check(await refused(() => api('POST', `/servers/${lb.id}/os-upgrade`, { target: '13', confirm: 'vps-lb' }), /snapshot/), 'refused without the snapshot checkbox');
  check(await refused(() => api('POST', `/servers/${lb.id}/os-upgrade`, { target: '13', snapshot: true, confirm: 'nope' }), /Type the server name/), 'refused without typing the server name');
});

await step('Upgrade vps-lb: Debian 12 → 13', async () => {
  const { job } = await api('POST', `/servers/${lb.id}/os-upgrade`, { target: '13', snapshot: true, confirm: 'vps-lb' });
  const j = await waitJob(job);
  check(on('vps-lb', 'grep ^VERSION_ID= /etc/os-release | cut -d= -f2 | tr -d \'"\'') === '13', 'vps-lb now runs Debian 13');
  check(/now runs Debian GNU\/Linux 13/.test(j.log), 'job log confirms the new version');
  check(/Reboot skipped \(container/.test(j.log), 'reboot skipped in the container lab');
  check(on('vps-lb', 'grep -h -o trixie /etc/apt/sources.list.d/*.sources /etc/apt/sources.list 2>/dev/null | head -1') === 'trixie', 'apt sources point at trixie');
  check(on('vps-lb', 'test -f /etc/apt/apt.conf.d/99switchboard-upgrade && echo yes || echo no') === 'no', 'temporary apt settings removed');
  const s = (await api('GET', '/servers')).find((x) => x.id === lb.id);
  check(/13/.test(s.metrics?.os || ''), `dashboard shows the new OS (${s.metrics?.os})`);
  // The lab skips reboots; a real reboot also restarts the old sshd that is still running → do that here.
  sh('docker restart vps-lb >/dev/null');
  await sleep(3000);
  const again = await api('POST', `/servers/${lb.id}/os-upgrade/preview`, {});
  check(again.ok, `SSH works after the "reboot"${again.error ? `: ${again.error}` : ''}`);
  check(again.plan?.path.length === 0, 'nothing newer to upgrade to');
});

// Clean up the test project so vps-src is free for the other tests.
for (const p of await api('GET', '/projects').catch(() => [])) if (p.slug === 'os-test') await api('DELETE', `/projects/${p.id}`, { confirm: p.slug }).catch(() => {});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ All OS upgrade checks passed');
process.exit(failures ? 1 : 0);

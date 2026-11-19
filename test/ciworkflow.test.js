// Own workflow + "the live server waits": Switchboard tells the workflow where to deploy (repository variable),
// holds the live server after an approved run, and "Deploy now" starts the workflow for that server:  npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SHA = 'c'.repeat(40);
const calls = [];
const vars = {};
let runs = [];
const jobs = {};
const gh = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const data = body ? JSON.parse(body) : null;
    calls.push({ m: req.method, p: u.pathname, data });
    const json = (x, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(x));
    };
    let m;
    if ((m = u.pathname.match(/^\/repos\/acme\/api\/actions\/variables\/(\w+)$/)) && req.method === 'PATCH') {
      if (!(m[1] in vars)) return json({ message: 'Not Found' }, 404);
      vars[m[1]] = data.value;
      return json({}, 204);
    }
    if (u.pathname === '/repos/acme/api/actions/variables' && req.method === 'POST') {
      vars[data.name] = data.value;
      return json({}, 201);
    }
    if (u.pathname === '/repos/acme/api/actions/workflows/deploy-both-servers.yml/runs') return json({ workflow_runs: runs });
    if (u.pathname === '/repos/acme/api/actions/workflows/deploy-both-servers.yml/dispatches') return json({}, 204);
    if ((m = u.pathname.match(/^\/repos\/acme\/api\/actions\/runs\/(\d+)\/jobs$/))) return json({ jobs: jobs[m[1]] || [] });
    json({ message: 'Not Found' }, 404);
  });
});
await new Promise((r) => gh.listen(0, '127.0.0.1', r));
after(() => gh.close());

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ciworkflow-test-'));
process.env.GITHUB_API_BASE = `http://127.0.0.1:${gh.address().port}`;
const { insert, get, update, now } = await import('../src/db.js');
const { setSetting } = await import('../src/settings.js');
const { pollProject, serversPlan } = await import('../src/ops/ci.js');
const { heldOf, releaseHeld } = await import('../src/ops/deployplan.js');

setSetting('github_token', 'test-token');
const live = insert('servers', { name: 'cinemagickh', ip: '10.0.0.1', created_at: now() });
const backup = insert('servers', { name: 'Backup', ip: '10.0.0.2', created_at: now() });
const pid = insert('projects', { name: 'API', slug: 'api', git_repo: 'acme/api', git_branch: 'main', ci_enabled: 1, ci_mode: 'runner', ci_workflow_path: '.github/workflows/deploy-both-servers.yml', ci_live_policy: 'hold', created_at: now() });
const dLive = insert('deployments', { project_id: pid, server_id: live, app_dir: '/var/www/api_v2/docker', created_at: now() });
insert('deployments', { project_id: pid, server_id: backup, app_dir: '/var/www/api_v2/docker', created_at: now() });
update('projects', pid, { active_deployment_id: dLive });
const project = () => get('SELECT * FROM projects WHERE id = ?', pid);
const run = (id, extra = {}) => ({ id, run_number: id, name: 'Deploy', event: 'push', head_branch: 'main', head_sha: SHA, status: 'completed', conclusion: 'success', html_url: `https://gh/${id}`, created_at: now(), updated_at: now(), ...extra });

test('plan: standby now, the live server waits (and with one server, it is deployed)', () => {
  const plan = serversPlan(project());
  assert.deepEqual(plan.now.map((s) => [s.name, s.label]), [['Backup', 'backup']]);
  assert.deepEqual([plan.live.name, plan.live.label], ['cinemagickh', 'cinemagickh']);
  update('projects', pid, { ci_live_policy: 'now' });
  assert.deepEqual(serversPlan(project()).now.map((s) => s.name), ['Backup', 'cinemagickh']); // live last
  assert.equal(serversPlan(project()).live, null);
  update('projects', pid, { ci_live_policy: 'hold' });
});

test('poll: saves SWITCHBOARD_SERVERS (creates it once, then only when it changes)', async () => {
  runs = [run(1)];
  await pollProject(pid);
  assert.equal(JSON.parse(vars.SWITCHBOARD_SERVERS).live.name, 'cinemagickh');
  const n = calls.filter((c) => c.p.includes('/variables')).length;
  await pollProject(pid);
  assert.equal(calls.filter((c) => c.p.includes('/variables')).length, n, 'unchanged → not saved again');
});

test('a run whose "Live server waits…" job passed holds the live server; a skipped run does not', async () => {
  runs = [run(3), run(2), run(1)];
  jobs[2] = [{ name: 'Approve deploy (Telegram)', conclusion: 'success' }]; // skipped in Telegram: no hold job
  jobs[3] = [{ name: 'Deploy to Backup (backup)', conclusion: 'success' }, { name: 'Live server waits for Switchboard (cinemagickh)', conclusion: 'success' }];
  await pollProject(pid);
  const held = heldOf(pid);
  assert.equal(held.length, 1);
  assert.equal(held[0].server_name, 'cinemagickh');
  assert.equal(held[0].commit_sha, SHA);
  assert.equal(held[0].via, 'workflow');
  await pollProject(pid); // seen already: still one
  assert.equal(heldOf(pid).length, 1);
});

test('Deploy now: starts the workflow for the live server and that commit, no Switchboard job', async () => {
  const job = await releaseHeld(heldOf(pid)[0], { user: 'tester' });
  assert.equal(job, null);
  const d = calls.filter((c) => c.p.endsWith('/dispatches')).at(-1);
  assert.deepEqual(d.data, { ref: 'main', inputs: { deploy_sha: SHA, deploy_to: 'cinemagickh' } });
  assert.equal(heldOf(pid).length, 0);
});

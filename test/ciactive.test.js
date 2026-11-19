// CI/CD "Running now": active runs of any workflow, matched to the project's servers, and cancel:  npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// A fake GitHub API: one run in progress (deploy on the server "cinemagickh"), one queued.
const calls = [];
const RUNS = {
  in_progress: [{ id: 11, run_number: 7, name: 'Deploy', display_title: 'fx', event: 'push', head_branch: 'master', head_sha: 'a'.repeat(40), status: 'in_progress', html_url: 'https://gh/r/11', run_started_at: '2026-11-20T10:00:00Z' }],
  queued: [{ id: 12, run_number: 3, name: 'Switchboard', display_title: 'fx', event: 'push', head_branch: 'master', head_sha: 'a'.repeat(40), status: 'queued', html_url: 'https://gh/r/12' }],
  waiting: [],
};
const JOBS = {
  11: [
    { id: 1, name: 'Build Docker Images', status: 'completed', conclusion: 'success', labels: ['ubuntu-latest'], steps: [] },
    { id: 2, name: 'Deploy', status: 'in_progress', labels: ['self-hosted', 'cinemagickh'], runner_name: 'cinemagickh', steps: [{ number: 1, name: 'docker compose up', status: 'in_progress' }] },
  ],
  12: [],
};
const gh = http.createServer((req, res) => {
  calls.push(`${req.method} ${req.url}`);
  const u = new URL(req.url, 'http://x');
  let m;
  const json = (x, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(x));
  };
  if ((m = u.pathname.match(/^\/repos\/acme\/api\/actions\/runs$/))) return json({ workflow_runs: RUNS[u.searchParams.get('status')] || [] });
  if ((m = u.pathname.match(/^\/repos\/acme\/api\/actions\/runs\/(\d+)\/jobs$/))) return json({ jobs: JOBS[m[1]] || [] });
  if ((m = u.pathname.match(/^\/repos\/acme\/api\/actions\/runs\/(\d+)\/(cancel|force-cancel)$/))) return m[1] === '99' ? json({ message: 'Cannot cancel a workflow run that is completed.' }, 409) : json({}, 202);
  if ((m = u.pathname.match(/^\/repos\/acme\/api\/actions\/runs\/(\d+)$/))) return json([...RUNS.in_progress, ...RUNS.queued].find((r) => r.id === Number(m[1])) || {});
  json({ message: 'Not Found' }, 404);
});
await new Promise((r) => gh.listen(0, '127.0.0.1', r));
after(() => gh.close());

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ciactive-test-'));
process.env.GITHUB_API_BASE = `http://127.0.0.1:${gh.address().port}`;
const { insert, get, now } = await import('../src/db.js');
const { setSetting } = await import('../src/settings.js');
const { activeRuns } = await import('../src/ops/ci.js');
const ghc = await import('../src/github.js');

setSetting('github_token', 'test-token');
const sid = insert('servers', { name: 'cinemagickh', ip: '10.0.0.1', created_at: now() });
const pid = insert('projects', { name: 'API', slug: 'api', git_repo: 'acme/api', git_branch: 'master', ci_enabled: 1, created_at: now() });
insert('deployments', { project_id: pid, server_id: sid, app_dir: '/var/www/api_v2/docker', created_at: now() });

test('activeRuns: every unfinished run of the repo, with the project server its job runs on', async () => {
  const runs = await activeRuns(get('SELECT * FROM projects WHERE id = ?', pid));
  assert.deepEqual(runs.map((r) => [r.run_id, r.workflow, r.status]), [[12, 'Switchboard', 'queued'], [11, 'Deploy', 'in_progress']]);
  const deploy = runs.find((r) => r.run_id === 11);
  assert.deepEqual(deploy.servers.map((s) => [s.name, s.status]), [['cinemagickh', 'in_progress']]);
  assert.equal(deploy.step, 'Deploy: docker compose up');
  assert.deepEqual(deploy.jobs, { total: 2, done: 1 });
});

test('cancelRun: cancel and force-cancel go to GitHub; a finished run gives 409', async () => {
  await ghc.cancelRun('acme/api', 11);
  await ghc.cancelRun('acme/api', 11, true);
  assert.ok(calls.includes('POST /repos/acme/api/actions/runs/11/cancel'));
  assert.ok(calls.includes('POST /repos/acme/api/actions/runs/11/force-cancel'));
  await assert.rejects(ghc.cancelRun('acme/api', 99), (e) => e.status === 409);
});

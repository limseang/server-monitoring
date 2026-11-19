// The visual flow editor's YAML ⇄ flow conversion (src/ops/flow.js):  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlow, applyFlow, remapServers, flowToYaml, runsOnOf } from '../src/ops/flow.js';

const SRC = `# Deploy the app
name: Deploy

on:
  push:
    branches: [main]   # only main
  workflow_dispatch:

jobs:
  # 1. tests on GitHub
  tests:
    name: Run tests
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      # the real work
      - name: Test
        run: |
          npm ci
          npm test

  deploy:
    name: Deploy on backup
    needs: tests
    runs-on: [self-hosted, backup] # the standby
    steps:
      - run: git pull
`;
const flow = () => structuredClone(parseFlow(SRC).flow);
const changedLines = (a, b) => {
  const A = a.split('\n');
  const B = b.split('\n');
  return { removed: A.filter((l) => !B.includes(l)), added: B.filter((l) => !A.includes(l)) };
};

test('parse: triggers, jobs, where each runs, steps, keys kept as they are', () => {
  const f = flow();
  assert.equal(f.name, 'Deploy');
  assert.deepEqual(f.triggers.push, { on: true, branches: ['main'] });
  assert.equal(f.triggers.manual, true);
  assert.deepEqual(f.jobs.map((j) => [j.id, j.runs_on.kind]), [['tests', 'github'], ['deploy', 'server']]);
  assert.equal(f.jobs[1].runs_on.label, 'backup');
  assert.deepEqual(f.jobs[1].needs, ['tests']);
  assert.deepEqual(f.jobs[0].extra, ['timeout-minutes']);
  assert.equal(f.jobs[0].steps[1].run, 'npm ci\nnpm test\n');
  assert.equal(runsOnOf('${{ matrix.x }}').kind, 'custom');
});

test('unchanged flow → the very same text', () => {
  assert.equal(applyFlow(SRC, flow()), SRC);
});

test('rename a job: only that line changes, comments stay', () => {
  const f = flow();
  f.jobs[1].name = 'Deploy on Backup server';
  const out = applyFlow(SRC, f);
  assert.deepEqual(changedLines(SRC, out), { removed: ['    name: Deploy on backup'], added: ['    name: Deploy on Backup server'] });
});

test('add a step: appended, other steps and comments untouched', () => {
  const f = flow();
  f.jobs[0].steps.push({ name: 'Lint', uses: '', run: 'npm run lint', with: {}, if: '' });
  const out = applyFlow(SRC, f);
  assert.ok(out.includes('      # the real work\n      - name: Test'));
  assert.ok(out.includes('      - name: Lint\n        run: npm run lint\n'));
  assert.equal(parseFlow(out).flow.jobs[0].steps.length, 3);
});

test('add, remove and move jobs; set triggers', () => {
  const f = flow();
  f.jobs.push({ id: 'notify', name: 'Tell the team', runs_on: { kind: 'github', image: 'ubuntu-latest' }, needs: ['deploy'], if: 'always()', steps: [{ name: 'Say', uses: '', run: 'echo done', with: {}, if: '' }] });
  f.triggers.schedule = ['0 3 * * *'];
  let out = applyFlow(SRC, f);
  let p = parseFlow(out).flow;
  assert.deepEqual(p.jobs.map((j) => j.id), ['tests', 'deploy', 'notify']);
  assert.equal(p.jobs[2].if, 'always()');
  assert.deepEqual(p.triggers.schedule, ['0 3 * * *']);
  assert.ok(out.includes('branches: [main]   # only main'), 'the comment on the trigger line stays');
  p.jobs = p.jobs.filter((j) => j.id !== 'deploy');
  p.jobs[1].needs = ['tests'];
  out = applyFlow(out, p);
  assert.deepEqual(parseFlow(out).flow.jobs.map((j) => j.id), ['tests', 'notify']);
  assert.ok(out.includes('# 1. tests on GitHub'));
});

test('a job that waits for a job that is gone is refused', () => {
  const f = flow();
  f.jobs = f.jobs.filter((j) => j.id !== 'tests');
  assert.throws(() => applyFlow(SRC, f), /not a job any more/);
});

test('copy to another project: server labels swapped (or to GitHub)', () => {
  const out = remapServers(SRC, { backup: 'shop-vps' });
  const d = parseFlow(out).flow.jobs[1];
  assert.equal(d.runs_on.label, 'shop-vps');
  assert.equal(d.name, 'Deploy on shop-vps');
  assert.equal(parseFlow(remapServers(SRC, { backup: 'github' })).flow.jobs[1].runs_on.kind, 'github');
});

test('a new file from a flow is a valid workflow', () => {
  const y = flowToYaml({ name: 'X', triggers: { push: { on: true, branches: ['main'] }, pull_request: { on: false, branches: [] }, manual: true, schedule: [], other: [] }, jobs: [{ id: 'a', name: 'A', runs_on: { kind: 'server', label: 'web' }, needs: [], if: '', steps: [{ name: 'Up', uses: '', run: 'docker compose up -d', with: {}, if: '' }] }] });
  const p = parseFlow(y);
  assert.deepEqual(p.errors, []);
  assert.ok(/^on:\n  push:/m.test(y));
  assert.ok(y.includes('  workflow_dispatch:\n'));
  assert.equal(p.flow.jobs[0].runs_on.label, 'web');
});

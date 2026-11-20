// Server tools: which tools a project needs, which of its servers lack them, and the install order:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tools-test-'));
const { insert, update, now } = await import('../src/db.js');
const { getProject } = await import('../src/models.js');
const { projectNeeds, missingFor, installPlan, toolCatalog } = await import('../src/ops/tools.js');
const { FRONTEND_SCRIPT, PM2_SCRIPT } = await import('../public/app/deploypresets.js');

test('a project needs what its deploy script uses', () => {
  assert.deepEqual(projectNeeds({ deploy_script: FRONTEND_SCRIPT }).sort(), ['git', 'node']);
  assert.deepEqual(projectNeeds({ deploy_script: PM2_SCRIPT }).sort(), ['git', 'node', 'pm2']);
  assert.deepEqual(projectNeeds({ deploy_script: 'git pull\ndocker compose up -d --build' }).sort(), ['docker', 'git']);
  assert.deepEqual(projectNeeds({ deploy_script: '' }), []);
  assert.deepEqual(projectNeeds({ deploy_script: '', template: 'frontend', git_repo: 'a/b' }).sort(), ['git', 'nginx|docker', 'node']);
});

test('install order: what a tool needs comes first, installed ones are not added again', () => {
  assert.deepEqual(installPlan(['pm2']), ['node', 'pm2']);
  assert.deepEqual(installPlan(['pm2'], { node: 'v22' }), ['pm2']);
  assert.deepEqual(installPlan(['node', 'pm2', 'pnpm']), ['node', 'pm2', 'pnpm']);
  assert.throws(() => installPlan(['rm -rf /']), /Unknown tool/);
});

test('the catalog has no install scripts in it (sent to the browser)', () => {
  for (const t of toolCatalog()) assert.equal(t.install, undefined);
});

test('missingFor: a checked server without Node.js is reported, an unchecked one is not guessed', () => {
  const s1 = insert('servers', { name: 'Backup', ip: '10.0.0.1', created_at: now() });
  const s2 = insert('servers', { name: 'Backup 2', ip: '10.0.0.2', created_at: now() });
  const s3 = insert('servers', { name: 'New', ip: '10.0.0.3', created_at: now() });
  update('servers', s1, { tools: JSON.stringify({ at: now(), list: { node: 'v22.1.0 · /usr/bin/node', git: '2.43' } }) });
  update('servers', s2, { tools: JSON.stringify({ at: now(), list: { node: null, git: '2.43' } }) });
  const pid = insert('projects', { name: 'Dashbord', slug: 'dashbord', deploy_script: FRONTEND_SCRIPT, created_at: now() });
  for (const sid of [s1, s2, s3]) insert('deployments', { project_id: pid, server_id: sid, app_dir: '/var/www/dashboard', created_at: now() });
  const m = Object.fromEntries(missingFor(getProject(pid)).map((x) => [x.server_name, x]));
  assert.deepEqual(m.Backup.missing, []);
  assert.deepEqual(m['Backup 2'].missing, ['node']);
  assert.deepEqual(m.New.missing, []);
  assert.equal(m.New.checked_at, null);
});

test('template needs: Docker apps need Docker; apps without Docker need Node.js and a web server (nginx OR Docker)', async () => {
  const { templateNeeds, lacking, needName } = await import('../src/ops/tools.js');
  assert.deepEqual(templateNeeds('laravel'), ['docker', 'git']);
  assert.deepEqual(templateNeeds('frontend'), ['node', 'nginx|docker', 'git']);
  assert.deepEqual(lacking(templateNeeds('frontend'), { node: 'v22', docker: '27', git: '2' }), []);
  assert.deepEqual(lacking(templateNeeds('frontend'), { git: '2' }), ['node', 'nginx|docker']);
  assert.equal(needName('nginx|docker'), 'Nginx (or Docker)');
  assert.deepEqual(installPlan(['nginx|docker']), ['nginx']);
  // A project made from the Laravel template deploys through the helper (no "docker" in its script) — still needs Docker.
  assert.deepEqual(projectNeeds({ template: 'laravel', deploy_script: 'switchboard-helper deploy x' }).sort(), ['docker', 'git']);
});

test('starter apps are real projects with folders (Vue/Vite front-end, Node app) and a README', async () => {
  const { scaffoldFiles } = await import('../src/ops/stack.js');
  const fe = scaffoldFiles('frontend', 'Cinema Admin');
  for (const f of ['package.json', 'vite.config.js', 'index.html', 'src/main.js', 'src/App.vue', 'src/components/HelloCard.vue', 'public/favicon.svg', 'README.md', '.gitignore']) assert.ok(fe[f], f);
  const pkg = JSON.parse(fe['package.json']);
  assert.equal(pkg.name, 'cinema-admin');
  assert.equal(pkg.scripts.build, 'vite build');
  const node = scaffoldFiles('pm2', 'Cinema Admin');
  assert.equal(JSON.parse(node['package.json']).scripts.start, 'node src/server.js');
  assert.ok(node['src/routes.js'].includes("'/up'"));
  assert.ok(scaffoldFiles('static', 'X')['index.html']);
  assert.ok(fe['.gitignore'].includes('node_modules/') && fe['.gitignore'].includes('.env'));
});

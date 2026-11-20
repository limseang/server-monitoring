import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Apps without Docker: which kind a repo's package.json is, and the defaults a new project of that kind gets.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-apptypes-test-'));
const { classifyPackage } = await import('../src/github.js');
const { templateProjectRow } = await import('../src/ops/provision.js');
const { TEMPLATES, scaffoldFiles } = await import('../src/ops/stack.js');
const { FRONTEND_SCRIPT, PM2_SCRIPT } = await import('../public/app/deploypresets.js');

const pkg = (deps, scripts = {}) => JSON.stringify({ dependencies: deps, scripts });

test('classifyPackage: front-ends vs servers', () => {
  assert.deepEqual(classifyPackage(pkg({ vue: '3' }, { build: 'vite build' })), { kind: 'frontend', framework: 'Vue' });
  assert.deepEqual(classifyPackage(JSON.stringify({ devDependencies: { vite: '5', react: '18' }, scripts: { build: 'vite build' } })), { kind: 'frontend', framework: 'React' });
  assert.deepEqual(classifyPackage(pkg({ '@angular/core': '18' }, { build: 'ng build' })), { kind: 'frontend', framework: 'Angular' });
  assert.deepEqual(classifyPackage(pkg({ nuxt: '3', vue: '3' }, { build: 'nuxt build' })), { kind: 'server', framework: 'Nuxt' });
  assert.deepEqual(classifyPackage(pkg({ nuxt: '3' }, { build: 'nuxt generate' })), { kind: 'frontend', framework: 'Nuxt' });
  assert.deepEqual(classifyPackage(pkg({ next: '14', react: '18' }, { build: 'next build' })), { kind: 'server', framework: 'Next.js' });
  assert.deepEqual(classifyPackage(pkg({ express: '4' }, { start: 'node index.js' })), { kind: 'server', framework: 'Express' });
  assert.deepEqual(classifyPackage(pkg({}, { start: 'node server.js' })), { kind: 'server', framework: 'Node.js' });
  assert.deepEqual(classifyPackage('not json'), { kind: null, framework: null });
});

test('front-end / PM2 templates: no container, ready deploy scripts, checked through the web proxy', () => {
  for (const [id, script] of [['frontend', FRONTEND_SCRIPT], ['pm2', PM2_SCRIPT]]) {
    assert.equal(TEMPLATES[id].host, true);
    const row = templateProjectRow({ name: 'Shop', template: id, db: 'none', domain: 'shop.example.com', repo: 'acme/shop', branch: 'main' });
    assert.equal(row.deploy_script, script);
    assert.equal(row.health_scheme, 'http');
    assert.equal(row.health_port, null);
    assert.equal(row.maintenance_on_cmd, 'true');
  }
  assert.ok(scaffoldFiles('frontend', 'Shop')['index.html'].includes('Shop'));
  assert.ok(scaffoldFiles('pm2', 'Shop')['src/server.js'].includes('process.env.PORT'));
  assert.match(PM2_SCRIPT, /\.switchboard\/pm2\.config\.cjs/);
  assert.doesNotMatch(FRONTEND_SCRIPT, /corepack enable/);
});

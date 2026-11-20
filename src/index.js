import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { config } from './config.js';
import './db.js';
import { initAuth } from './auth.js';
import { recoverJobs } from './jobs.js';
import './ops/jobs.js'; // registers job types
import './ops/provision.js';
import './ops/ci.js';
import './ops/serverctl.js';
import './ops/backupstore.js';
import './ops/dbaccess.js';
import './ops/sshguard.js';
import './ops/tools.js';
import { api } from './api.js';
import { startMonitor, stopMonitor } from './monitor.js';

const require = createRequire(import.meta.url);
const vueFile = path.join(path.dirname(require.resolve('vue/package.json')), 'dist', 'vue.esm-browser.prod.js');

recoverJobs();
await initAuth();

const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    // Vue compiles templates in the browser, which needs 'unsafe-eval'. Everything is served from this origin.
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

app.use('/api', api);
app.get('/vendor/vue.js', (req, res) => res.type('application/javascript').sendFile(vueFile, { maxAge: '7d', dotfiles: 'allow' }));
// no-cache: the browser always checks for a newer file, so an update never mixes old and new code.
app.use(express.static(config.publicDir, { index: 'index.html', setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

const server = app.listen(config.port, config.host, () => {
  console.log(`Switchboard is running on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
});

startMonitor();

function shutdown(signal) {
  console.log(`${signal} received, shutting down…`);
  stopMonitor();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

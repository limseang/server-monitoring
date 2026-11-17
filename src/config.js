import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const env = process.env;

// Only trust X-Forwarded-For when you run behind a reverse proxy / tunnel (set TRUST_PROXY=true).
// With plain Docker port mapping every client looks like a private IP, so trusting it by default
// would let anyone fake their IP.
function parseTrustProxy(v) {
  if (v === undefined || v === '' || v === 'false') return false;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export const config = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  port: Number(env.PORT) || 8080,
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
  cfApiBase: (env.CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, ''),
  // GitHub (CI/CD). Overridable so the test lab can point at a fake GitHub.
  githubApiBase: (env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, ''),
  githubWebBase: (env.GITHUB_WEB_BASE || 'https://github.com').replace(/\/+$/, ''),
  githubGitUrl: env.GITHUB_GIT_URL || 'git@github.com:{repo}.git', // how servers clone; {repo} = owner/name
  telegramApiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  cookieSecure: env.COOKIE_SECURE || 'auto', // 'true' | 'false' | 'auto'
  sessionDays: Number(env.SESSION_DAYS) || 7,
  adminUser: env.ADMIN_USER || '',
  adminPassword: env.ADMIN_PASSWORD || '',
  appKey: env.APP_KEY || '',
  // Test lab only: its fake servers have private IPs. Never set this for real use.
  allowPrivateDns: env.ALLOW_PRIVATE_DNS === 'true',
  // "Reinstall OS": the open-source reinstall tool (github.com/bin456789/reinstall), pinned to one commit.
  reinstallRef: env.REINSTALL_REF || '54fae2067557b3c0ca49e7c9ce03bca63c793f8c',
  // Test lab only: a fake reinstall script, and allowing it on the lab's container "servers".
  reinstallScriptUrl: env.REINSTALL_SCRIPT_URL || '',
  reinstallAllowContainer: env.REINSTALL_ALLOW_CONTAINER === 'true',
};

config.backupDir = path.join(config.dataDir, 'backups');
config.tmpDir = path.join(config.dataDir, 'tmp');
for (const dir of [config.dataDir, config.backupDir, config.tmpDir]) fs.mkdirSync(dir, { recursive: true });

// Key used to encrypt secrets (SSH keys, DB passwords, API tokens) at rest.
// Prefer setting APP_KEY in the environment; otherwise one is generated into data/app.key.
if (!config.appKey) {
  const keyFile = path.join(config.dataDir, 'app.key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
  config.appKey = fs.readFileSync(keyFile, 'utf8').trim();
}

import crypto from 'node:crypto';
import { config } from './config.js';
import { get, insert, run, now } from './db.js';
import { decrypt, hashPassword, randomToken, sha256, verifyPassword, verifyTotp } from './crypto.js';
import { logEvent } from './events.js';
import { ROLES } from './roles.js';

const COOKIE = 'sb_session';
const SESSION_MS = () => config.sessionDays * 864e5;
let setupCode = null;

export const usersCount = () => get('SELECT COUNT(*) AS n FROM users').n;

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw Object.assign(new Error('Password must be at least 10 characters'), { status: 400 });
  if (pw.length > 200) throw Object.assign(new Error('Password is too long'), { status: 400 });
}

export function validateUsername(u) {
  if (!/^[A-Za-z0-9._@-]{3,50}$/.test(String(u || ''))) {
    throw Object.assign(new Error('Username: 3-50 characters, letters/numbers/._@-'), { status: 400 });
  }
}

export async function createUser(username, password, role = 'admin') {
  validateUsername(username);
  validatePassword(password);
  if (!ROLES.includes(role)) throw Object.assign(new Error('Unknown role'), { status: 400 });
  if (get('SELECT id FROM users WHERE username = ?', username)) throw Object.assign(new Error('That username already exists'), { status: 400 });
  return insert('users', { username, password_hash: await hashPassword(password), role, created_at: now() });
}

/** First start: create the admin from env vars, or print a one-time setup code to the logs. */
export async function initAuth() {
  if (usersCount() > 0) return;
  if (config.adminUser && config.adminPassword) {
    await createUser(config.adminUser, config.adminPassword);
    console.log(`[auth] Created admin user "${config.adminUser}" from ADMIN_USER / ADMIN_PASSWORD`);
    return;
  }
  setupCode = crypto.randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})/, '$1-');
  console.log('');
  console.log('  ==========================================================');
  console.log(`   Switchboard first-time setup code:  ${setupCode}`);
  console.log('   Open the dashboard in your browser and enter this code.');
  console.log('  ==========================================================');
  console.log('');
}

export const needsSetup = () => usersCount() === 0;

export function checkSetupCode(code) {
  if (!setupCode) return false;
  const a = Buffer.from(String(code || '').trim().toUpperCase());
  const b = Buffer.from(setupCode);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function finishSetup() {
  setupCode = null;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieOptions(req) {
  const secure = config.cookieSecure === 'true' ? true : config.cookieSecure === 'false' ? false : req.secure;
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_MS() };
}

export function issueSession(req, res, user) {
  const token = randomToken(32);
  insert('sessions', {
    id: sha256(token),
    user_id: user.id,
    ip: req.ip,
    user_agent: String(req.get('user-agent') || '').slice(0, 300),
    created_at: now(),
    seen_at: now(),
    expires_at: new Date(Date.now() + SESSION_MS()).toISOString(),
  });
  run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), user.id);
  res.cookie(COOKIE, token, cookieOptions(req));
}

export function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}

export function authenticate(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const s = get(
    'SELECT s.id, s.user_id, s.expires_at, s.seen_at, u.username, u.role, u.totp_secret FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?',
    sha256(token),
  );
  if (!s || s.expires_at < now()) return null;
  // Sliding expiry, refreshed at most once an hour.
  if (res && (!s.seen_at || Date.now() - Date.parse(s.seen_at) > 3600e3)) {
    run('UPDATE sessions SET seen_at = ?, expires_at = ? WHERE id = ?', now(), new Date(Date.now() + SESSION_MS()).toISOString(), s.id);
    res.cookie(COOKIE, token, cookieOptions(req));
  }
  return { id: s.user_id, username: s.username, role: s.role || 'admin', totp: !!s.totp_secret, sessionId: s.id };
}

export function requireAuth(req, res, next) {
  const user = authenticate(req, res);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

// ---- brute-force protection (per IP and per username, 15-minute window) ----
const attempts = new Map();
const WINDOW = 15 * 60000;
const LIMITS = { ip: 30, user: 10 };

function over(key, limit) {
  const a = attempts.get(key);
  if (!a || Date.now() > a.reset) return false;
  return a.count >= limit;
}

function bump(key) {
  const a = attempts.get(key);
  if (!a || Date.now() > a.reset) attempts.set(key, { count: 1, reset: Date.now() + WINDOW });
  else a.count++;
}

export function loginAllowed(ip, username = '') {
  return !over(`ip:${ip}`, LIMITS.ip) && !(username && over(`user:${String(username).toLowerCase()}`, LIMITS.user));
}

export function noteFailedAttempt(ip, username = '') {
  bump(`ip:${ip}`);
  if (username) bump(`user:${String(username).toLowerCase()}`);
}

export async function login(req, { username, password, totp }) {
  const ip = req.ip;
  if (!loginAllowed(ip, username)) throw Object.assign(new Error('Too many failed attempts. Try again in 15 minutes.'), { status: 429 });
  const user = get('SELECT * FROM users WHERE username = ?', String(username || ''));
  // Always run a hash comparison so timing doesn't reveal whether the user exists.
  const ok = user ? await verifyPassword(password, user.password_hash) : (await hashPassword('x'), false);
  if (!ok) {
    noteFailedAttempt(ip, username);
    logEvent('warn', `Failed login for "${String(username || '').slice(0, 50)}" from ${ip}`);
    throw Object.assign(new Error('Wrong username or password'), { status: 401 });
  }
  if (user.totp_secret) {
    if (!totp) return { needTotp: true };
    if (!verifyTotp(decrypt(user.totp_secret), totp)) {
      noteFailedAttempt(ip, username);
      throw Object.assign(new Error('Wrong 2FA code'), { status: 401 });
    }
  }
  attempts.delete(`user:${String(username).toLowerCase()}`);
  logEvent('info', `${user.username} logged in from ${ip}`, { user: user.username });
  return { user };
}

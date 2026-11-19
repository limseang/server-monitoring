import { get } from './db.js';

/**
 * Who may do what.
 *   admin     — everything (servers, settings, users, switching, deleting…)
 *   developer — look at everything, deploy, maintenance mode, backups, artisan commands in the app
 *               container, run CI, refresh staging data, remove PR previews. Can't change servers,
 *               settings, DNS, users, or delete anything.
 *   viewer    — read-only (no backup downloads, no user list).
 */
export const ROLES = ['admin', 'developer', 'viewer'];

export const ROLE_INFO = {
  admin: 'Everything',
  developer: 'Deploy, logs, maintenance, backups, CI, staging data, previews — no server/settings/user changes',
  viewer: 'Read-only',
};

const ownJob = (req, m) => get('SELECT user FROM jobs WHERE id = ?', Number(m[1]))?.user === req.user.username;

// Things every logged-in user may do (their own account).
const EVERYONE = [
  ['POST', /^\/auth\/logout$/],
  ['POST', /^\/account\//],
  // The flow editor turns YAML into a picture and back: no side effects.
  ['POST', /^\/projects\/\d+\/ci\/flow\/(parse|apply)$/],
];

const DEVELOPER = [
  ['POST', /^\/projects\/\d+\/deploy$/],
  ['POST', /^\/projects\/\d+\/deploy-plan$/],
  ['POST', /^\/held-deploys\/\d+\/deploy$/],
  ['DELETE', /^\/held-deploys\/\d+$/],
  ['POST', /^\/deployments\/\d+\/(deploy|maintenance|backup)$/],
  ['POST', /^\/deployments\/\d+\/command$/, (req) => req.body?.where === 'app'],
  ['POST', /^\/projects\/\d+\/(check|dns\/refresh)$/],
  ['POST', /^\/servers\/\d+\/traffic\/collect$/],
  ['POST', /^\/jobs\/(\d+)\/cancel$/, ownJob],
  ['POST', /^\/projects\/\d+\/ci\/(refresh|run|git-check)$/],
  ['POST', /^\/projects\/\d+\/ci\/runs\/\d+\/(cancel|deploy)$/],
  ['POST', /^\/projects\/\d+\/staging\/\d+\/data$/],
  ['POST', /^\/projects\/\d+\/previews\/sync$/],
  ['DELETE', /^\/projects\/\d+\/previews\/\d+$/],
];

// GETs that only admins may make (secrets, data dumps, server internals).
const ADMIN_ONLY_GET = [/^\/github\//, /^\/servers\/\d+\/users$/, /^\/backups\/\d+\/download$/, /^\/users$/, /^\/servers\/\d+\/discover/, /^\/cloudflare\//, /^\/servers\/\d+\/clone/, /^\/servers\/\d+\/folders/, /^\/servers\/\d+\/nginx/];

function match(list, req) {
  for (const [method, re, extra] of list) {
    if (method !== req.method) continue;
    const m = req.path.match(re);
    if (m && (!extra || extra(req, m))) return true;
  }
  return false;
}

// Logs can hold personal data (IPs, emails): developers and admins only.
const NO_VIEWER_GET = [/^\/servers\/\d+\/(logs|log-sources|logs\/live)$/, /^\/servers\/\d+\/containers\/[^/]+\/logs$/, /^\/servers\/\d+\/apps\/logs$/];

export function allowed(req) {
  const role = req.user?.role || 'viewer';
  if (role === 'admin') return true;
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (role === 'viewer' && NO_VIEWER_GET.some((re) => re.test(req.path))) return false;
    return !ADMIN_ONLY_GET.some((re) => re.test(req.path));
  }
  if (match(EVERYONE, req)) return true;
  return role === 'developer' && match(DEVELOPER, req);
}

/** Express middleware, mounted after login is checked. */
export function requireRole(req, res, next) {
  if (allowed(req)) return next();
  res.status(403).json({ error: `Your role (${req.user?.role || 'viewer'}) can't do this — ask an admin.` });
}

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import express from 'express';
import QRCode from 'qrcode';
import { config } from './config.js';
import { all, get, run, insert, update, now, tx } from './db.js';
import { encrypt, newTotpSecret, verifyTotp, verifyPassword, hashPassword } from './crypto.js';
import { getSetting, setSetting, publicSettings, DEFAULTS, SECRET_SETTINGS } from './settings.js';
import * as auth from './auth.js';
import { ROLES, ROLE_INFO, requireRole } from './roles.js';
import { bus } from './bus.js';
import { enqueue, getJob, cancelJob, summary, hasActiveJob } from './jobs.js';
import { logEvent } from './events.js';
import {
  getServer,
  getProject,
  getDeployment,
  deploymentsOf,
  deploymentsOnServer,
  serverPublic,
  deploymentPublic,
  projectPublic,
  parseJSON,
} from './models.js';
import * as cf from './cloudflare.js';
import { connect, exec, withSSH } from './ssh.js';
import { sendNotification, telegramChats } from './notify.js';
import { refreshDnsState, dnsTargetProblem, setRecord } from './ops/dns.js';
import { sslStatus, sslProblems, applySsl, SSL_MODES } from './ops/cfssl.js';
import { certHostnames } from './ops/origincert.js';
import { scanProject, setupOptions, sslHosts, ACME_CAS } from './ops/serverssl.js';
import { checkOwnCert } from './ops/sslconf.js';
import { countTables, backupAbsPath } from './ops/database.js';
import { ensureLocal, backupAvailable, removeBackupFiles } from './ops/backupstore.js';
import { s3Config, testS3 } from './s3.js';
import { dockerBin, shq, asRoot } from './ops/remote.js';
import { previewClone } from './ops/clone.js';
import { previewCopy, portMap } from './ops/copyproject.js';
import { previewReset, resetOptions, removalProblem, deleteProjectRecord, safeDir } from './ops/wipe.js';
import { previewReinstall, reinstallOptions, REINSTALL_OS } from './ops/reinstall.js';
import { isLb, lbConfig } from './ops/lb.js';
import { METHODS as LB_METHODS, nginxConfig } from './lb/nginx.js';
import { cloudflareHealth } from './lb/cloudflare.js';
import { ENGINE_NAMES, dbServerPublic, getDbServer } from './ops/dbserver.js';
import { planUpgrade } from './ops/osupgrade.js';
import { detectHostApps, publicHostApps, hostAppScript, hostAppLogsScript } from './ops/hostapps.js';
import { PROVIDERS, CURRENCIES, isDate, localDate, parseRemindDays, money } from './billingcalc.js';
import { getBilling, billingPublic, allBilling, monthlyTotals, billingByServer, remindDays, paymentsOf, recentPayments, recordPayment, deletePayment, checkBilling } from './billing.js';
import { dbAccessOf, dbAccessProblem, dbAccessIssues, dbDeps, zoneOf, DEFAULT_PORTS, PROXY_IMAGE } from './ops/dbaccess.js';
import { reloadSchedules, collectMetrics, checkProjectNow, nextRuns, validateCron, nextCleanup } from './monitor.js';
import { previewGuard, guardOptions, unbanIp } from './ops/sshguard.js';
import { toolCatalog, toolsOf, checkTools, installPlan, projectNeeds, missingFor, toolName, templateNeeds, lacking } from './ops/tools.js';
import { previewCleanup, cleanupOptions, cleanupLabel, getSchedule, setSchedule } from './ops/cleanup.js';
import { slugify, lastLines, stripAnsi, isPrivateAddress } from './util.js';
import * as gh from './github.js';
import { TEMPLATES, DB_NAMES } from './ops/stack.js';
import { templateProjectRow } from './ops/provision.js';
import * as nginxSites from './ops/nginxsites.js';
import './ops/proxy.js';
import { parseHosts, cleanSiteFolder, findFoldersScript, parseFolders } from './ops/proxycheck.js';
import { POWER, serverRoles, listUsers, changePassword, USER_RE, scanPorts, listFolders, makeFolder, cleanFolder } from './ops/serverctl.js';
import { trafficSummary, trafficNow, logSources, readLog, collectTraffic } from './ops/traffic.js';
import { usageSummary } from './ops/usage.js';
import { watchServer, tailLog } from './live.js';
import { parseFlow, applyFlow, remapServers } from './ops/flow.js';
import { POLICIES, parseQuiet, nextQuietTime, heldOf, releaseHeld, cancelHeld, runPlan } from './ops/deployplan.js';
import { workflowYaml, workflowHash, commitWorkflow, ciProjects, ciServers, rootOf, runnerStatus, pollProject, removePreview, runnerLabel, runnerLabels, runnerUser, liveRun, activeRuns, forgetActive, serversPlan, SERVERS_VAR, deployCommitTo, depsOn, gitStates, checkAllGit, ownWorkflow, workflowPathOf, workflowFileOf, exampleWorkflow, DOCKER_DEPLOY_SCRIPT } from './ops/ci.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;

export const api = express.Router();
api.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------------ helpers */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);
const notFound = (m = 'Not found') => new HttpError(404, m);

const str = (v, max = 255) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const int = (v, def, min, max) => {
  if (v === '' || v === null || v === undefined) return def;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const bool = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const toId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad('Invalid id');
  return n;
};

const RE = {
  container: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,
  dbName: /^[A-Za-z0-9_-]{1,64}$/,
  dbUser: /^[A-Za-z0-9_.@-]{1,80}$/,
  sshUser: /^[A-Za-z0-9._-]{1,64}$/,
  host: /^[A-Za-z0-9.-]{1,253}$/,
  domain: /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i,
  absPath: /^\/[^\0\n\r]{0,500}$/,
  dockerCmd: /^[A-Za-z0-9 _./-]{1,100}$/,
  cfId: /^[A-Za-z0-9]{8,64}$/,
  expect: /^\d{3}(-\d{3})?(,\s*\d{3}(-\d{3})?)*$/,
};
function check(re, v, label) {
  if (v && !re.test(v)) throw bad(`Invalid ${label}`);
  return v || null;
}
const dropUndefined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function mustServer(id) {
  const s = getServer(toId(id));
  if (!s) throw notFound('Server not found');
  return s;
}
function mustProject(id) {
  const p = getProject(toId(id));
  if (!p) throw notFound('Project not found');
  return p;
}
function mustDep(project, id) {
  const d = getDeployment(toId(id));
  if (!d || (project && d.project_id !== project.id)) throw notFound('Server not found in this project');
  return d;
}
function mustBackup(id) {
  const b = get('SELECT * FROM backups WHERE id = ?', toId(id));
  if (!b) throw notFound('Backup not found');
  return b;
}
const who = (req) => req.user?.username || 'system';
const audit = (req, level, message, ctx = {}) => logEvent(level, message, { ...ctx, user: who(req) });

/** Uptime bars: `buckets` slices over the last `hours`, per deployment. */
function uptimeData(depIds, hours = 24, buckets = 48) {
  const out = {};
  for (const id of depIds) out[id] = { bars: Array.from({ length: buckets }, () => null), ok: 0, n: 0, msSum: 0, msN: 0 };
  if (!depIds.length) return out;
  const since = Date.now() - hours * 3600e3;
  const size = (hours * 3600) / buckets;
  const rows = all(
    `SELECT deployment_id AS d, CAST((strftime('%s', at) - ?) / ? AS INTEGER) AS b, SUM(ok) AS okc, COUNT(*) AS n, AVG(CASE WHEN ok = 1 THEN ms END) AS ms
     FROM checks WHERE at >= ? GROUP BY d, b`,
    Math.floor(since / 1000),
    size,
    new Date(since).toISOString(),
  );
  for (const r of rows) {
    const o = out[r.d];
    if (!o || r.b < 0 || r.b >= buckets) continue;
    o.bars[r.b] = { r: r.okc / r.n, n: r.n, ms: r.ms == null ? null : Math.round(r.ms) };
    o.ok += r.okc;
    o.n += r.n;
    if (r.ms != null) {
      o.msSum += r.ms * r.okc;
      o.msN += r.okc;
    }
  }
  for (const o of Object.values(out)) {
    o.uptime = o.n ? Math.round((o.ok / o.n) * 10000) / 100 : null;
    o.ms_avg = o.msN ? Math.round(o.msSum / o.msN) : null;
    delete o.msSum;
    delete o.msN;
  }
  return out;
}

function projectWithDeployments(p, { hours = 24, buckets = 48 } = {}) {
  const deps = deploymentsOf(p.id);
  const up = uptimeData(deps.map((d) => d.id), hours, buckets);
  return {
    ...projectPublic(p),
    deployments: deps.map((d) => ({ ...deploymentPublic(d, p), ...up[d.id] })),
  };
}

/* ------------------------------------------------------------------ public routes */
api.get('/health', (req, res) => res.json({ ok: true, version: VERSION }));

// CSRF: every state-changing request must carry a custom header (forms on other sites can't set it).
api.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-requested-with') !== 'switchboard') {
    return res.status(403).json({ error: 'Missing X-Requested-With header' });
  }
  next();
});

api.get('/auth/state', (req, res) => {
  const user = auth.authenticate(req, res);
  res.json({ setupRequired: auth.needsSetup(), user: user ? { username: user.username, role: user.role, totp: user.totp } : null, version: VERSION });
});

api.post('/auth/setup', async (req, res) => {
  if (!auth.needsSetup()) throw bad('Setup was already completed');
  if (!auth.loginAllowed(req.ip)) throw new HttpError(429, 'Too many attempts, wait 15 minutes');
  if (!auth.checkSetupCode(req.body.code)) {
    auth.noteFailedAttempt(req.ip);
    throw bad('Wrong setup code — find it in the dashboard logs (docker logs switchboard)');
  }
  const userId = await auth.createUser(str(req.body.username, 50), String(req.body.password || ''));
  auth.finishSetup();
  const user = get('SELECT * FROM users WHERE id = ?', userId);
  auth.issueSession(req, res, user);
  logEvent('success', `Admin account "${user.username}" created`, { user: user.username });
  res.json({ ok: true });
});

api.post('/auth/login', async (req, res) => {
  const r = await auth.login(req, { username: str(req.body.username, 50), password: String(req.body.password || ''), totp: str(req.body.totp, 10) });
  if (r.needTotp) return res.json({ needTotp: true });
  auth.issueSession(req, res, r.user);
  res.json({ ok: true });
});

api.post('/auth/logout', (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ everything below needs login */
api.use(auth.requireAuth);
api.use(requireRole);

/* ---------- live updates (Server-Sent Events) ---------- */
function sse(req, res, onClose) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': connected\n\n');
  let open = true;
  const ping = setInterval(() => open && res.write(': ping\n\n'), 25000);
  const cleanup = () => {
    if (!open) return;
    open = false;
    clearInterval(ping);
    onClose?.();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  return {
    send: (event, data) => open && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    end: () => {
      cleanup();
      res.end();
    },
  };
}

api.get('/stream', (req, res) => {
  const onJob = (d) => s.send('job', d);
  const onState = (d) => s.send('state', d);
  const onEvent = (d) => s.send('event', d);
  const s = sse(req, res, () => {
    bus.off('job', onJob);
    bus.off('state', onState);
    bus.off('event', onEvent);
  });
  bus.on('job', onJob);
  bus.on('state', onState);
  bus.on('event', onEvent);
});

api.get('/jobs/:id/stream', (req, res) => {
  const job = getJob(toId(req.params.id));
  if (!job) throw notFound('Job not found');
  const key = `job:${job.id}`;
  const onMsg = (m) => {
    if (m.type === 'log') s.send('log', { line: m.line });
    else if (m.type === 'progress') s.send('progress', m.progress);
    else if (m.type === 'end') {
      s.send('end', { status: m.status, error: m.error });
      s.end();
    }
  };
  const s = sse(req, res, () => bus.off(key, onMsg));
  s.send('init', { log: job.log, status: job.status, error: job.error, type: job.type, progress: parseJSON(job.progress, null) });
  if (!['queued', 'running'].includes(job.status)) {
    s.send('end', { status: job.status, error: job.error });
    return s.end();
  }
  bus.on(key, onMsg); // same tick as the snapshot above, so no log line is missed
});

/* ---------- live server views (only watched while a page is open) ---------- */
// One channel per view. A heartbeat every 15 s lets the browser notice a dead connection.
function liveChannel(req, res, onClose) {
  let hb = null;
  const s = sse(req, res, () => {
    clearInterval(hb);
    onClose();
  });
  hb = setInterval(() => s.send('hb', { at: Date.now() }), 15000);
  return s;
}

api.get('/servers/:id/live', (req, res) => {
  const server = mustServer(req.params.id);
  const topics = { metrics: bool(req.query.metrics), traffic: bool(req.query.traffic) };
  if (!topics.metrics && !topics.traffic) throw bad('Ask for metrics=1 and/or traffic=1');
  let stop = () => {};
  const s = liveChannel(req, res, () => stop());
  stop = watchServer(server, topics, s.send);
});

api.get('/servers/:id/logs/live', (req, res) => {
  const server = mustServer(req.params.id);
  const opts = { source: str(req.query.source, 500), lines: int(req.query.lines, 200, 10, 2000), q: str(req.query.q, 200) };
  let stop = () => {};
  const s = liveChannel(req, res, () => stop());
  try {
    stop = tailLog(server, opts, (event, data) => {
      s.send(event, data);
      if (event === 'end') s.end();
    });
  } catch (e) {
    s.send('end', { error: e.message, fatal: true });
    s.end();
  }
});

/* ---------- overview ---------- */
function computeAlerts(projects, servers, bills = billingByServer()) {
  const alerts = [];
  const add = (level, message, link) => alerts.push({ level, message, link });
  if (!getSetting('cf_token')) add('info', 'Add your Cloudflare API token so Switchboard can switch DNS for you.', '#/settings');
  if (!getSetting('telegram_token') && !getSetting('webhook_url')) add('info', 'Set up Telegram (or a webhook) to get a message when a server goes down.', '#/settings');
  const diskLimit = Number(getSetting('disk_alert_pct')) || 90;
  const staleHours = Number(getSetting('stale_alert_hours')) || 24;
  const sslDays = Number(getSetting('ssl_alert_days')) || 14;
  const billWindow = Math.max(7, ...remindDays());
  for (const s of servers) {
    const link = `#/servers/${s.id}`;
    if (s.status === 'down') add('error', `Server ${s.name} is unreachable over SSH — ${s.status_error || ''}`, link);
    const m = s.metrics;
    if (m?.disk_pct >= diskLimit) add('warn', `Server ${s.name}: disk ${m.disk_pct}% full — click to clean up`, `${link}?cleanup=1`);
    const sick = (m?.containers || []).filter((c) => c.health === 'unhealthy' || c.state === 'restarting');
    if (sick.length) add('warn', `Server ${s.name}: ${sick.map((c) => c.name).join(', ')} unhealthy or restarting`, link);
    const bill = bills.get(s.id);
    if (bill?.days_left != null) {
      const d = bill.days_left;
      const what = `${bill.provider ? ` (${bill.provider})` : ''}${bill.price ? ` — ${money(bill.price, bill.currency)}` : ''}`;
      if (d < 0 && !bill.auto_renew) add('error', `Server ${s.name}: payment OVERDUE by ${-d} day${d === -1 ? '' : 's'}${what}`, link);
      else if (d >= 0 && d <= billWindow) {
        const when = d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
        if (bill.auto_renew) add('info', `Server ${s.name}: renews automatically ${when}${what}`, link);
        else add(d <= 3 ? 'warn' : 'info', `Server ${s.name}: payment due ${when}${what}`, link);
      }
    }
  }
  for (const p of projects) {
    const link = `#/projects/${p.id}`;
    const active = p.deployments.find((d) => d.is_active);
    if (!p.deployments.length) add('info', `${p.name}: add the servers this project runs on.`, link);
    else if (!active) add('warn', `${p.name}: no active server yet — link the Cloudflare DNS records (Settings tab) so Switchboard knows which server is live.`, link);
    for (const d of p.deployments) {
      if (d.health === 'down') add(d.is_active ? 'error' : 'warn', `${p.name} on ${d.server_name}${d.is_active ? ' (ACTIVE)' : ''} is down — ${d.health_detail?.error || ''}`, link);
      if (d.is_active && d.maintenance) add('warn', `${p.name}: the active server ${d.server_name} is in maintenance mode`, link);
      if (!d.is_active && active && d.db_type !== 'none') {
        const age = d.data_at ? (Date.now() - Date.parse(d.data_at)) / 3600e3 : null;
        if (age === null) add('info', `${p.name}: database on standby ${d.server_name} was never copied from the active server`, link);
        else if (age > staleHours) add('warn', `${p.name}: database on standby ${d.server_name} is ${Math.round(age)}h old — copy it before switching`, link);
      }
    }
    for (const i of dbAccessIssues(p, p.deployments)) add(i.level, `${p.name}: ${i.message}`, link);
    if (p.dns_state?.drift) add('error', `${p.name}: DNS drift — Cloudflare does not point to the active server`, link);
    if (p.dns_state?.error) add('warn', `${p.name}: DNS check failed — ${p.dns_state.error}`, link);
    const ssl = p.ssl_state;
    if (ssl?.edge?.ok && ssl.edge.days_left <= sslDays) add('warn', `${p.name}: public SSL certificate expires in ${ssl.edge.days_left} days`, link);
    for (const o of Object.values(ssl?.origins || {})) {
      if (o.ok && o.days_left <= sslDays) add('warn', `${p.name}: SSL certificate on ${o.server} expires in ${o.days_left} days`, link);
    }
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Servers for lists: with a short billing summary (due date, days left) when one is set. */
function serversWithBilling(bills = billingByServer()) {
  return all('SELECT * FROM servers ORDER BY name').map((s) => ({ ...serverPublic(s), billing: bills.get(s.id) || null }));
}

api.get('/overview', (req, res) => {
  const projects = all('SELECT * FROM projects ORDER BY name').map((p) => projectWithDeployments(p));
  const bills = billingByServer();
  const servers = serversWithBilling(bills);
  const jobs = all('SELECT * FROM jobs ORDER BY id DESC LIMIT 8').map(summary);
  const running = get("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')").n;
  const items = allBilling();
  const billing = { totals: monthlyTotals(items), upcoming: items.filter((b) => b.days_left != null).slice(0, 6), count: items.length };
  res.json({ projects, servers, jobs, running, billing, alerts: computeAlerts(projects, servers, bills) });
});

/* ---------- servers ---------- */
function serverInput(b, existing) {
  const name = str(b.name, 80);
  if (!name) throw bad('Server name is required');
  const ip = str(b.ip, 64);
  if (!net.isIPv4(ip)) throw bad('Public IP must be an IPv4 address (it is what the DNS A record points to)');
  const ipv6 = str(b.ipv6, 64);
  if (ipv6 && !net.isIPv6(ipv6)) throw bad('IPv6 address is not valid');
  const sshHost = str(b.ssh_host, 253);
  if (sshHost && !net.isIP(sshHost) && !RE.host.test(sshHost)) throw bad('Invalid SSH host');
  const sshUser = str(b.ssh_user, 64) || 'root';
  if (!RE.sshUser.test(sshUser)) throw bad('Invalid SSH user');
  const authType = ['key', 'keyfile', 'password', 'agent'].includes(b.auth_type) ? b.auth_type : 'key';
  const dockerCmd = str(b.docker_cmd, 100) || 'docker';
  if (!RE.dockerCmd.test(dockerCmd)) throw bad('Invalid docker command');
  const privateIp = str(b.private_ip, 64);
  if (privateIp && !net.isIPv4(privateIp)) throw bad('Private IP must be an IPv4 address (e.g. 10.0.0.5)');
  const keyPath = str(b.ssh_key_path, 500);
  if (authType === 'keyfile' && !keyPath) throw bad('Enter the path of the private key file');
  const row = {
    name,
    ip,
    ipv6: ipv6 || null,
    ssh_host: sshHost || null,
    ssh_port: int(b.ssh_port, 22, 1, 65535),
    ssh_user: sshUser,
    auth_type: authType,
    ssh_key_path: keyPath || null,
    docker_cmd: dockerCmd,
    private_ip: privateIp || null,
    notes: str(b.notes, 2000) || null,
  };
  const key = typeof b.ssh_key === 'string' ? b.ssh_key.trim() : '';
  if (key) {
    if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(key)) throw bad('That is not a private key — it should start with -----BEGIN … PRIVATE KEY-----');
    row.ssh_key = encrypt(`${key.replace(/\r\n/g, '\n')}\n`);
  }
  if (typeof b.ssh_passphrase === 'string' && b.ssh_passphrase) row.ssh_passphrase = encrypt(b.ssh_passphrase);
  if (bool(b.clear_passphrase)) row.ssh_passphrase = null;
  if (typeof b.ssh_password === 'string' && b.ssh_password) row.ssh_password = encrypt(b.ssh_password);
  if (authType === 'key' && !row.ssh_key && !existing?.ssh_key) throw bad('Paste the private SSH key for this server');
  if (authType === 'password' && !row.ssh_password && !existing?.ssh_password) throw bad('Enter the SSH password');
  if (existing) {
    const hostChanged = (existing.ssh_host || existing.ip) !== (row.ssh_host || row.ip) || Number(existing.ssh_port) !== row.ssh_port;
    if (hostChanged) row.host_key = null; // new address: trust the new host key on next connect
  }
  return row;
}

api.get('/servers', (req, res) => {
  res.json(serversWithBilling());
});

function uniqueServerName(name, exceptId = 0) {
  if (get('SELECT id FROM servers WHERE name = ? COLLATE NOCASE AND id <> ?', name, exceptId)) throw bad(`A server named "${name}" already exists`);
}

api.post('/servers', (req, res) => {
  const row = serverInput(req.body);
  uniqueServerName(row.name);
  const id = insert('servers', { ...row, created_at: now() });
  audit(req, 'info', `Server ${row.name} (${row.ip}) added`, { serverId: id });
  const server = getServer(id);
  collectMetrics(server).catch(() => {});
  res.json(serverPublic(server));
});

api.post('/servers/test', async (req, res) => {
  const existing = req.body.id ? mustServer(req.body.id) : null;
  let server;
  try {
    server = { ...(existing || {}), ...serverInput(req.body, existing), id: undefined };
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
  try {
    const r = await withSSH(
      server,
      (conn) =>
        exec(
          conn,
          `uname -srm; echo @@; ${dockerBin(server)} version --format '{{.Server.Version}}' 2>&1 | head -3; echo @@; ${dockerBin(server)} ps -q 2>/dev/null | wc -l`,
          { timeout: 20000 },
        ).then((x) => ({ ...x, hostKey: conn.hostKey })),
      { timeout: 15000 },
    );
    const [uname, docker, count] = r.stdout.split('@@').map((x) => x.trim());
    res.json({ ok: true, host_key: r.hostKey, uname, docker, docker_ok: /^\d+\./.test(docker), containers: Number(count) || 0 });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

api.get('/servers/:id', (req, res) => {
  const s = mustServer(req.params.id);
  const tools = toolsOf(s);
  const deployments = deploymentsOnServer(s.id).map((d) => {
    const p = getProject(d.project_id);
    // Tools this project needs that this server lacks (only once the server was checked).
    const missing_tools = tools ? lacking(projectNeeds(p), tools.list) : [];
    return { ...deploymentPublic(d, p), project_name: p.name, project_domain: p.domain, project_template: p.template, missing_tools };
  });
  res.json({ ...serverPublic(s), deployments, roles: serverRoles(s.id), private_ip_warning: !config.allowPrivateDns && isPrivateAddress(s.ip) });
});

api.put('/servers/:id', (req, res) => {
  const existing = mustServer(req.params.id);
  const row = serverInput(req.body, existing);
  uniqueServerName(row.name, existing.id);
  update('servers', existing.id, row);
  audit(req, 'info', `Server ${row.name} updated`, { serverId: existing.id });
  bus.emit('state', { serverId: existing.id });
  res.json(serverPublic(getServer(existing.id)));
});

api.delete('/servers/:id', (req, res) => {
  const s = mustServer(req.params.id);
  const activeIn = all('SELECT p.name FROM projects p JOIN deployments d ON d.id = p.active_deployment_id WHERE d.server_id = ?', s.id);
  if (activeIn.length) throw bad(`${s.name} is the ACTIVE server of: ${activeIn.map((p) => p.name).join(', ')}. Switch those projects to another server first.`);
  run('DELETE FROM servers WHERE id = ?', s.id);
  if (getSchedule(s.id)) {
    setSchedule(s.id, null);
    reloadSchedules();
  }
  audit(req, 'warn', `Server ${s.name} (${s.ip}) removed`);
  bus.emit('state', {});
  res.json({ ok: true });
});

api.post('/servers/:id/refresh', async (req, res) => {
  const s = mustServer(req.params.id);
  try {
    await collectMetrics(s);
  } catch (e) {
    return res.json({ ok: false, error: e.message, server: serverPublic(getServer(s.id)) });
  }
  res.json({ ok: true, server: serverPublic(getServer(s.id)) });
});

api.post('/servers/:id/reset-host-key', (req, res) => {
  const s = mustServer(req.params.id);
  update('servers', s.id, { host_key: null });
  audit(req, 'warn', `Pinned SSH host key of ${s.name} was reset (will trust the next key it sees)`, { serverId: s.id });
  res.json({ ok: true });
});

/* ---------- server billing: when to pay, payment reminders, payment history ---------- */
const money2 = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 1e9) throw bad('Price must be a number like 12.50');
  return Math.round(n * 100) / 100;
};
const currencyInput = (v) => {
  const c = str(v, 8).toUpperCase() || 'USD';
  if (!/^[A-Z]{3}$/.test(c)) throw bad('Currency: 3 letters, e.g. USD or EUR');
  return c;
};
const dateInput = (v, label, required = false) => {
  const d = str(v, 10);
  if (!d) {
    if (required) throw bad(`${label} is required`);
    return null;
  }
  if (!isDate(d)) throw bad(`${label}: use a date like 2026-12-31`);
  return d;
};
const urlInput = (v) => {
  const u = str(v, 500);
  if (u && !/^https?:\/\/[^\s]+$/i.test(u)) throw bad('Provider link must start with https://');
  return u || null;
};

function billingInput(b) {
  const cycle = int(b.cycle_months, 1, 1, 60);
  const due = dateInput(b.due_date, 'Next payment date');
  return {
    provider: str(b.provider, 80) || null,
    provider_url: urlInput(b.provider_url),
    price: money2(b.price),
    currency: currencyInput(b.currency),
    cycle_months: cycle,
    due_date: due,
    anchor_day: due ? Number(due.slice(8, 10)) : null,
    auto_renew: bool(b.auto_renew) ? 1 : 0,
    notes: str(b.notes, 2000) || null,
  };
}

api.get('/billing', (req, res) => {
  const items = allBilling();
  const have = new Set(items.map((b) => b.server_id));
  res.json({
    today: localDate(),
    providers: PROVIDERS,
    currencies: CURRENCIES,
    remind_days: remindDays(),
    items,
    totals: monthlyTotals(items),
    without: all('SELECT id, name, ip FROM servers ORDER BY name').filter((s) => !have.has(s.id)),
    payments: recentPayments(200),
  });
});

api.post('/billing/check', (req, res) => {
  res.json({ ok: true, ...checkBilling({ force: true }) });
});

api.get('/servers/:id/billing', (req, res) => {
  const s = mustServer(req.params.id);
  res.json({ billing: billingPublic(getBilling(s.id)), payments: paymentsOf(s.id, 100), providers: PROVIDERS, currencies: CURRENCIES, today: localDate() });
});

api.put('/servers/:id/billing', (req, res) => {
  const s = mustServer(req.params.id);
  const row = billingInput(req.body || {});
  const before = getBilling(s.id);
  const keys = Object.keys(row);
  run(
    `INSERT INTO billing (server_id, ${keys.join(', ')}, updated_at) VALUES (?, ${keys.map(() => '?').join(', ')}, ?)
     ON CONFLICT(server_id) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = excluded.updated_at`,
    s.id,
    ...keys.map((k) => row[k]),
    now(),
  );
  // a new due date starts a fresh set of reminders
  if (before && before.due_date !== row.due_date) run('UPDATE billing SET reminded = NULL WHERE server_id = ?', s.id);
  audit(req, 'info', `Billing of ${s.name} ${before ? 'updated' : 'added'}${row.due_date ? ` — next payment ${row.due_date}` : ''}`, { serverId: s.id });
  bus.emit('state', { serverId: s.id });
  res.json(billingPublic(getBilling(s.id)));
});

api.delete('/servers/:id/billing', (req, res) => {
  const s = mustServer(req.params.id);
  run('DELETE FROM billing WHERE server_id = ?', s.id);
  audit(req, 'warn', `Billing info of ${s.name} removed (payment history kept)`, { serverId: s.id });
  bus.emit('state', { serverId: s.id });
  res.json({ ok: true });
});

api.post('/servers/:id/billing/paid', (req, res) => {
  const s = mustServer(req.params.id);
  const b = req.body || {};
  if (!getBilling(s.id)) throw bad('Add billing info for this server first');
  const r = recordPayment(s.id, {
    paid_on: dateInput(b.paid_on, 'Paid on') || localDate(),
    amount: b.amount === undefined ? undefined : money2(b.amount),
    currency: b.currency ? currencyInput(b.currency) : undefined,
    months: b.months ? int(b.months, 1, 1, 60) : undefined,
    due_date: dateInput(b.due_date, 'Next payment date'),
    note: str(b.note, 500) || null,
    user: who(req),
  });
  audit(req, 'success', `Payment for ${s.name} recorded — next payment ${r.to}`, { serverId: s.id });
  res.json({ ok: true, ...r, billing: billingPublic(getBilling(s.id)) });
});

api.delete('/payments/:id', (req, res) => {
  const p = deletePayment(toId(req.params.id));
  if (!p) throw notFound('Payment not found');
  const s = getServer(p.server_id);
  audit(req, 'warn', `Payment of ${p.paid_on} for ${s?.name || 'a server'} deleted${p.reverted_to ? ` — next payment back to ${p.reverted_to}` : ''}`, { serverId: p.server_id });
  res.json({ ok: true, reverted_to: p.reverted_to });
});

function describeContainer(c) {
  const name = String(c.Name || '').replace(/^\//, '');
  const image = c.Config?.Image || '';
  const env = {};
  for (const e of c.Config?.Env || []) {
    const i = e.indexOf('=');
    if (i > 0) env[e.slice(0, i)] = e.slice(i + 1);
  }
  const labels = c.Config?.Labels || {};
  const img = image.toLowerCase();
  let kind = 'other';
  let db = null;
  if (/mysql|mariadb|percona/.test(img) || env.MYSQL_DATABASE || env.MARIADB_DATABASE) {
    kind = 'db';
    const hasRoot = !!(env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD || env.MYSQL_ROOT_PASSWORD_FILE || env.MARIADB_ROOT_PASSWORD_FILE || env.MYSQL_ALLOW_EMPTY_PASSWORD || env.MARIADB_ALLOW_EMPTY_ROOT_PASSWORD);
    db = { type: 'mysql', name: env.MYSQL_DATABASE || env.MARIADB_DATABASE || '', user: hasRoot ? '' : env.MYSQL_USER || env.MARIADB_USER || '' };
  } else if (/postgres|postgis|timescale/.test(img) || env.POSTGRES_PASSWORD) {
    kind = 'db';
    db = { type: 'postgres', name: env.POSTGRES_DB || env.POSTGRES_USER || 'postgres', user: '' };
  } else if (/redis|valkey|memcached|keydb/.test(img)) kind = 'cache';
  else if (/nginx|caddy|traefik|httpd|apache/.test(img) && !/php/.test(img)) kind = 'web';
  else if (/php|laravel|fpm|octane|frankenphp|sail/.test(img) || env.APP_KEY || env.DB_CONNECTION || env.DB_HOST) kind = 'app';
  return {
    name,
    image,
    state: c.State?.Status || '',
    kind,
    db, // database name/user only — passwords never leave the server
    compose_project: labels['com.docker.compose.project'] || null,
    compose_service: labels['com.docker.compose.service'] || null,
    working_dir: labels['com.docker.compose.project.working_dir'] || null,
  };
}

function suggestDeployment(all, hint) {
  // Switchboard's own containers (shared database server…) never belong to a project's server card.
  const containers = all.filter((c) => !/^switchboard-/.test(c.name) && !/^\/opt\/switchboard-/.test(c.working_dir || ''));
  const h = String(hint || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const score = (c) => {
    const hay = `${c.compose_project || ''}${c.name}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    return h && hay.includes(h) ? 1 : 0;
  };
  const byScore = (list) => [...list].sort((a, b) => score(b) - score(a));
  const db = byScore(containers.filter((c) => c.kind === 'db'))[0];
  const sameProject = (c) => !db?.compose_project || c.compose_project === db.compose_project;
  const apps = byScore(containers.filter((c) => c.kind === 'app'));
  const app = apps.find((c) => sameProject(c) && /app|php|laravel|fpm/.test(c.compose_service || c.name)) || apps.find(sameProject) || apps[0];
  return {
    app_container: app?.name || '',
    app_dir: app?.working_dir || db?.working_dir || '',
    db_type: db ? db.db.type : 'none',
    db_container: db?.name || '',
    db_name: db?.db.name || '',
    db_user: db?.db.user || '',
  };
}

api.get('/servers/:id/discover', async (req, res) => {
  const s = mustServer(req.params.id);
  const d = dockerBin(s);
  const r = await withSSH(s, (conn) => exec(conn, `ids=$(${d} ps -q); if [ -n "$ids" ]; then ${d} inspect $ids; else echo '[]'; fi`, { timeout: 30000 }), { timeout: 15000 });
  if (r.code !== 0) throw bad(`docker inspect failed: ${lastLines(r.stderr) || r.code}`);
  let list;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    throw bad('Unexpected output from docker inspect');
  }
  const containers = list.map(describeContainer);
  res.json({ containers, suggestion: suggestDeployment(containers, req.query.hint) });
});

api.get('/servers/:id/containers/:name/logs', async (req, res) => {
  const s = mustServer(req.params.id);
  const name = str(req.params.name, 128);
  if (!RE.container.test(name)) throw bad('Invalid container name');
  const tail = int(req.query.tail, 200, 10, 5000);
  const r = await withSSH(s, (conn) => exec(conn, `${dockerBin(s)} logs --tail ${tail} --timestamps ${shq(name)} 2>&1`, { timeout: 30000 }), { timeout: 15000 });
  res.json({ log: stripAnsi(r.stdout), code: r.code });
});

api.post('/servers/:id/containers/:name/:action', (req, res) => {
  const s = mustServer(req.params.id);
  const name = str(req.params.name, 128);
  if (!RE.container.test(name)) throw bad('Invalid container name');
  if (!['restart', 'stop', 'start', 'rm'].includes(req.params.action)) throw bad('Unknown action');
  if (req.params.action === 'rm') {
    if (str(req.body?.confirm, 128) !== name) throw bad(`Type the container name "${name}" to confirm`);
    const live = get(
      'SELECT p.name FROM deployments d JOIN projects p ON p.id = d.project_id WHERE d.server_id = ? AND p.active_deployment_id = d.id AND (d.app_container = ? OR d.db_container = ?)',
      s.id,
      name,
      name,
    );
    if (live) throw bad(`${name} is the live app or database container of ${live.name} on ${s.name}. Switch ${live.name} to another server first.`);
  }
  const job = enqueue({ type: 'container', title: `docker ${req.params.action === 'rm' ? 'rm (delete)' : req.params.action} ${name} @ ${s.name}`, serverId: s.id, params: { server: s.id, container: name, action: req.params.action }, user: who(req) });
  res.json({ job });
});

api.post('/servers/:id/command', (req, res) => {
  const s = mustServer(req.params.id);
  const command = str(req.body.command, 20000);
  if (!command) throw bad('Enter a command');
  const cwd = str(req.body.cwd, 500);
  if (cwd && !RE.absPath.test(cwd)) throw bad('Working directory must be an absolute path');
  const job = enqueue({ type: 'command', title: `$ ${command.split('\n')[0].slice(0, 60)} @ ${s.name}`, serverId: s.id, params: { server: s.id, command, cwd }, user: who(req) });
  audit(req, 'info', `Command on ${s.name}: ${command.slice(0, 200)}`, { serverId: s.id, jobId: job.id });
  res.json({ job });
});

/* ---------- apps outside Docker (PM2, systemd, nginx sites) ---------- */
function hostAppInput(b) {
  const type = str(b.type, 20);
  const p = { type, user: str(b.user, 32), name: str(b.name, 120), action: str(b.action, 20) };
  try {
    hostAppScript(p); // validates type / user / name / action
  } catch (e) {
    throw bad(e.message);
  }
  return p;
}

api.get('/servers/:id/apps', async (req, res) => {
  const s = mustServer(req.params.id);
  try {
    const d = await withSSH(s, (conn) => detectHostApps(null, conn, s), { timeout: 15000 });
    res.json({ ok: true, ...publicHostApps(d) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

api.get('/servers/:id/apps/logs', async (req, res) => {
  const s = mustServer(req.params.id);
  let script;
  try {
    script = hostAppLogsScript({ type: str(req.query.type, 20), user: str(req.query.user, 32), name: str(req.query.name, 120), tail: int(req.query.tail, 200, 10, 5000) });
  } catch (e) {
    throw bad(e.message);
  }
  const r = await withSSH(s, (conn) => exec(conn, asRoot(s, script), { timeout: 30000 }), { timeout: 15000 });
  res.json({ log: stripAnsi(r.stdout + r.stderr), code: r.code });
});

api.post('/servers/:id/apps/action', (req, res) => {
  const s = mustServer(req.params.id);
  const p = hostAppInput(req.body);
  const label = p.type === 'pm2' ? `pm2 ${p.action} ${p.name}${p.user !== 'root' ? ` (${p.user})` : ''}` : `systemctl ${p.action} ${p.name}`;
  const job = enqueue({ type: 'hostapp', title: `${label} @ ${s.name}`, serverId: s.id, params: { server: s.id, ...p }, user: who(req) });
  res.json({ job });
});

/* ---------- load balancing & shared database ---------- */
function lbProject(req, { needLb = true } = {}) {
  const p = mustProject(req.params.id);
  if (needLb && !isLb(p)) throw bad('Turn on load balancing for this project first');
  return p;
}
const lbEnqueue = (req, p, type, title, params) => {
  const job = enqueue({ type, title, projectId: p.id, params, user: who(req) });
  audit(req, 'warn', `${title} started`, { projectId: p.id, jobId: job.id });
  return job;
};

api.get('/projects/:id/lb', async (req, res) => {
  const p = mustProject(req.params.id);
  const deps = deploymentsOf(p.id);
  const cfg = lbConfig(p);
  const out = { mode: p.traffic_mode, provider: p.lb_provider, config: cfg, runtime: parseJSON(p.lb_state, {}), lb_server: serverPublic(getServer(p.lb_server_id)), cloudflare_health: null, nginx_preview: null };
  if (isLb(p) && p.lb_provider === 'cloudflare') out.cloudflare_health = await cloudflareHealth(cfg).catch((e) => ({ error: e.message }));
  const lbs = getServer(p.lb_server_id);
  if (lbs) out.nginx_preview = nginxConfig(p, deps, lbs, cfg);
  out.db_server = dbServerPublic(p.db_server_id ? getDbServer(p.db_server_id) : null);
  res.json(out);
});

api.post('/projects/:id/lb/enable', (req, res) => {
  const p = lbProject(req, { needLb: false });
  if (isLb(p)) throw bad('Already load balanced');
  const provider = req.body.provider === 'cloudflare' ? 'cloudflare' : 'own';
  if (provider === 'cloudflare' && !getSetting('cf_token')) throw bad('Add your Cloudflare API token first (Settings)');
  if (!parseJSON(p.dns_records, []).length) throw bad('Link the Cloudflare DNS records to this project first (project Settings tab)');
  const params = {
    provider,
    lb_server: provider === 'own' ? mustServer(req.body.lb_server).id : null,
    method: Object.hasOwn(LB_METHODS, req.body.method) ? req.body.method : 'least_conn',
    tls_cert: str(req.body.tls_cert, 300),
    tls_key: str(req.body.tls_key, 300),
    use_private: req.body.use_private === undefined ? true : bool(req.body.use_private),
    sticky: bool(req.body.sticky),
    members: (Array.isArray(req.body.members) ? req.body.members : []).map((x) => mustDep(p, x).id),
    force: bool(req.body.force),
  };
  for (const k of ['tls_cert', 'tls_key']) if (params[k] && !/^\/[A-Za-z0-9._\/-]+$/.test(params[k])) throw bad('Certificate paths must be absolute paths on the load balancer server');
  if (!!params.tls_cert !== !!params.tls_key) throw bad('Give both the certificate and the key path (or neither)');
  res.json({ job: lbEnqueue(req, p, 'lb-enable', `Turn on load balancing (${p.name})`, params) });
});

api.post('/projects/:id/lb/disable', (req, res) => {
  const p = lbProject(req);
  const t = mustDep(p, req.body.target);
  res.json({ job: lbEnqueue(req, p, 'lb-disable', `Turn off load balancing → ${t.server_name} (${p.name})`, { target: t.id, force: bool(req.body.force) }) });
});

api.post('/projects/:id/lb/member', (req, res) => {
  const p = lbProject(req);
  const d = mustDep(p, req.body.deployment);
  const action = ['add', 'drain', 'weight'].includes(req.body.action) ? req.body.action : null;
  if (!action) throw bad('Unknown action');
  const verb = { add: 'Add', drain: 'Drain', weight: 'Change weight of' }[action];
  res.json({ job: lbEnqueue(req, p, 'lb-member', `${verb} ${d.server_name} (${p.name})`, { deployment: d.id, action, weight: int(req.body.weight, 1, 1, 100), force: bool(req.body.force) }) });
});

api.post('/projects/:id/lb/scale-out', (req, res) => {
  const p = lbProject(req);
  const s = mustServer(req.body.server);
  const source = req.body.source ? mustDep(p, req.body.source) : getDeployment(p.active_deployment_id);
  if (!source) throw bad('No live server to copy the app from');
  if (source.server_id === s.id) throw bad('Pick a different server than the one the app is copied from');
  if (cloneBusy(source.server_id, s.id)) throw bad('A clone involving one of these servers is already running');
  const params = { server: s.id, source: source.id, clone: req.body.clone === undefined ? true : bool(req.body.clone), replace: bool(req.body.replace), force: bool(req.body.force) };
  res.json({ job: lbEnqueue(req, p, 'scale-out', `Add ${s.name} to the load balancer (${p.name})`, params) });
});

api.get('/db-servers', (req, res) => {
  res.json({ engines: ENGINE_NAMES, servers: all('SELECT * FROM db_servers ORDER BY id').map(dbServerPublic) });
});

api.post('/db-servers', (req, res) => {
  const s = mustServer(req.body.server);
  if (!ENGINE_NAMES.includes(req.body.engine)) throw bad('Pick MySQL, MariaDB or PostgreSQL');
  if (get('SELECT id FROM db_servers WHERE server_id = ?', s.id)) throw bad(`${s.name} is already a database server`);
  const allow = (Array.isArray(req.body.allow) ? req.body.allow : []).map((x) => mustServer(x).id);
  const job = enqueue({ type: 'dbserver-setup', title: `Set up database server on ${s.name}`, serverId: s.id, params: { server: s.id, engine: req.body.engine, redis: req.body.redis === undefined ? true : bool(req.body.redis), allow }, user: who(req) });
  audit(req, 'warn', `Database server setup on ${s.name} started`, { serverId: s.id, jobId: job.id });
  res.json({ job });
});

api.post('/projects/:id/db/move', (req, res) => {
  const p = lbProject(req, { needLb: false });
  if (p.db_server_id) throw bad('This project already uses a database server');
  const dbs = getDbServer(toId(req.body.db_server));
  if (!dbs) throw bad('Database server not found');
  if (dbs.status !== 'ready') throw bad('That database server is not ready yet');
  res.json({ job: lbEnqueue(req, p, 'db-move', `Move database to ${getServer(dbs.server_id)?.name} (${p.name})`, { db_server: dbs.id, maintenance: req.body.maintenance === undefined ? true : bool(req.body.maintenance), redis: req.body.redis === undefined ? true : bool(req.body.redis) }) });
});

api.post('/projects/:id/backup-shared', (req, res) => {
  const p = mustProject(req.params.id);
  if (!p.db_server_id) throw bad('This project has no shared database');
  const job = enqueue({ type: 'backup', title: `Backup ${p.name} @ database server`, projectId: p.id, params: { shared: true, kind: 'manual' }, user: who(req) });
  res.json({ job });
});

/* ---------- OS upgrade ---------- */
function serverBusy(id) {
  return all("SELECT params, type, server_id FROM jobs WHERE type IN ('clone', 'os-upgrade', 'project-copy') AND status IN ('queued', 'running')").some((r) => {
    const p = parseJSON(r.params, {});
    return r.server_id === id || p.source === id || p.target === id || p.server === id;
  });
}

api.post('/servers/:id/os-upgrade/preview', async (req, res) => {
  const s = mustServer(req.params.id);
  const target = str(req.body.target, 10) || null;
  try {
    const plan = await withSSH(s, (conn) => planUpgrade(null, conn, s, target), { timeout: 15000 });
    delete plan._drain;
    res.json({ ok: true, plan });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

api.post('/servers/:id/os-upgrade', (req, res) => {
  const s = mustServer(req.params.id);
  const target = str(req.body.target, 10);
  if (!/^\d{1,2}(\.\d{2})?$/.test(target)) throw bad('Pick the version to upgrade to');
  if (!bool(req.body.snapshot)) throw bad('Make a snapshot/backup of the server at your provider first and tick the box');
  if (str(req.body.confirm, 80) !== s.name) throw bad(`Type the server name "${s.name}" to confirm`);
  if (serverBusy(s.id)) throw bad('A clone or OS upgrade involving this server is already running');
  const job = enqueue({ type: 'os-upgrade', title: `Upgrade OS of ${s.name} → ${target}`, serverId: s.id, params: { server: s.id, target }, user: who(req) });
  audit(req, 'warn', `OS upgrade of ${s.name} to ${target} started`, { serverId: s.id, jobId: job.id });
  res.json({ job });
});

/* ---------- clone a server ---------- */
function cloneInput(req) {
  const src = mustServer(req.params.id);
  const dst = mustServer(req.body.target);
  if (src.id === dst.id) throw bad('Pick a different server to clone to');
  const lines = (Array.isArray(req.body.extraPaths) ? req.body.extraPaths : String(req.body.extraPaths || '').split('\n')).map((x) => str(x, 500)).filter(Boolean);
  if (lines.length > 50) throw bad('At most 50 extra paths');
  for (const l of lines) if (!RE.absPath.test(l) || l === '/' || l.includes('..')) throw bad(`Extra path "${l}" must be an absolute path (not /)`);
  const params = {
    source: src.id,
    target: dst.id,
    installDocker: req.body.installDocker === undefined ? true : bool(req.body.installDocker),
    host: req.body.host === undefined ? true : bool(req.body.host),
    freeze: req.body.freeze === undefined ? true : bool(req.body.freeze),
    replace: bool(req.body.replace),
    addToProjects: req.body.addToProjects === undefined ? true : bool(req.body.addToProjects),
    extraPaths: lines,
  };
  // Optional picks (left out = copy everything): compose project names and app folders.
  if (Array.isArray(req.body.stacks)) {
    params.stacks = req.body.stacks.map((x) => str(x, 128)).filter((x) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(x)).slice(0, 300);
  }
  if (Array.isArray(req.body.folders)) {
    params.folders = req.body.folders.map((x) => str(x, 500)).filter((x) => RE.absPath.test(x) && x !== '/' && !x.includes('..')).slice(0, 300);
  }
  return { src, dst, params };
}

function cloneBusy(...ids) {
  const rows = all("SELECT params FROM jobs WHERE type = 'clone' AND status IN ('queued', 'running')");
  return rows.some((r) => {
    const p = parseJSON(r.params, {});
    return ids.includes(p.source) || ids.includes(p.target);
  });
}

function resetBusy(id) {
  return all("SELECT params FROM jobs WHERE type IN ('server-reset', 'server-reinstall') AND status IN ('queued', 'running')").some((r) => parseJSON(r.params, {}).server === id);
}

api.get('/reinstall/os', (req, res) => res.json(Object.entries(REINSTALL_OS).map(([id, o]) => ({ id, label: o.label }))));

api.post('/servers/:id/reinstall/preview', async (req, res) => {
  const s = mustServer(req.params.id);
  try {
    res.json({ ok: true, plan: await previewReinstall(s, req.body) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

api.post('/servers/:id/reinstall', (req, res) => {
  const s = mustServer(req.params.id);
  if (str(req.body?.confirm) !== s.name) throw bad(`Type "${s.name}" to confirm`);
  const roles = serverRoles(s.id);
  if (roles.length) throw bad(`${s.name} is the ${roles.join(', ')}. Move that to another server first.`);
  if (serverBusy(s.id) || cloneBusy(s.id) || resetBusy(s.id)) throw bad('A clone, OS upgrade, reset or reinstall involving this server is already running');
  const opts = reinstallOptions(req.body);
  const job = enqueue({ type: 'server-reinstall', title: `Reinstall ${s.name} with ${REINSTALL_OS[opts.os].label} (erase disk)`, serverId: s.id, params: { server: s.id, ...opts }, user: who(req) });
  audit(req, 'warn', `Reinstall of ${s.name} (${s.ip}) with ${REINSTALL_OS[opts.os].label} started — the whole disk will be erased`, { serverId: s.id, jobId: job.id });
  res.json({ job });
});

api.post('/servers/:id/reset/preview', async (req, res) => {
  const s = mustServer(req.params.id);
  try {
    res.json({ ok: true, plan: await previewReset(s, req.body) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

api.post('/servers/:id/reset', (req, res) => {
  const s = mustServer(req.params.id);
  if (str(req.body?.confirm) !== s.name) throw bad(`Type "${s.name}" to confirm`);
  const roles = serverRoles(s.id);
  if (roles.length) throw bad(`${s.name} is the ${roles.join(', ')}. Move that to another server first.`);
  if (serverBusy(s.id) || cloneBusy(s.id) || resetBusy(s.id)) throw bad('A clone, OS upgrade or reset involving this server is already running');
  const job = enqueue({ type: 'server-reset', title: `Reset ${s.name} (delete everything)`, serverId: s.id, params: { server: s.id, ...resetOptions(req.body) }, user: who(req) });
  audit(req, 'warn', `Reset of ${s.name} (${s.ip}) started — all containers, volumes and apps will be deleted`, { serverId: s.id, jobId: job.id });
  res.json({ job });
});

/* Clean up / free memory: preview (changes nothing), run now, weekly schedule. Admin only (POST). */
function cleanupBusy(id) {
  return all("SELECT params FROM jobs WHERE type = 'server-cleanup' AND status IN ('queued', 'running')").some((r) => parseJSON(r.params, {}).server === id);
}

/* ---------- protect SSH (fail2ban, password login off) ---------- */
api.post('/servers/:id/ssh-guard/preview', async (req, res) => {
  const s = mustServer(req.params.id);
  try {
    res.json({ ok: true, plan: await previewGuard(s) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/* ---------- server tools (Node.js, PM2, Docker…): what is installed, and one-click install ---------- */
api.get('/servers/:id/tools', async (req, res) => {
  const s = mustServer(req.params.id);
  let state = toolsOf(s);
  let error = null;
  if (req.query.refresh === '1' || !state) {
    try {
      state = await withSSH(s, (conn) => checkTools(conn, s), { timeout: 15000 });
    } catch (e) {
      error = e.message;
    }
  }
  const running = all("SELECT id, params FROM jobs WHERE type = 'tools-install' AND status IN ('queued', 'running')").find((r) => parseJSON(r.params, {}).server === s.id);
  res.json({ server: { id: s.id, name: s.name, ip: s.ip }, catalog: toolCatalog(), state, error, running_job: running?.id || null });
});

api.post('/servers/:id/tools/install', (req, res) => {
  const s = mustServer(req.params.id);
  const keys = Array.isArray(req.body?.tools) ? req.body.tools.map((k) => str(k, 20)).filter(Boolean) : [];
  if (!keys.length) throw bad('Choose at least one tool');
  let plan;
  try {
    plan = installPlan(keys, toolsOf(s)?.list || {});
  } catch (e) {
    throw bad(e.message);
  }
  if (all("SELECT params FROM jobs WHERE type = 'tools-install' AND status IN ('queued', 'running')").some((r) => parseJSON(r.params, {}).server === s.id)) throw bad('Tools are already being installed on this server — wait for that job');
  const names = plan.map(toolName).join(', ');
  const job = enqueue({ type: 'tools-install', title: `Install ${names} on ${s.name}`, serverId: s.id, params: { server: s.id, tools: plan }, user: who(req) });
  audit(req, 'info', `${s.name}: install ${names}`, { serverId: s.id, jobId: job.id });
  res.json({ job });
});

api.post('/servers/:id/ssh-guard', (req, res) => {
  const s = mustServer(req.params.id);
  let o;
  try {
    o = guardOptions(req.body || {});
  } catch (e) {
    throw bad(e.message);
  }
  if (!o.remove && !o.fail2ban && !o.passwords_off) throw bad('Tick at least one protection');
  if (o.passwords_off && s.auth_type === 'password') throw bad('Switchboard logs in to this server with a password — switch it to an SSH key first (Edit server), or it would lock itself out');
  if (o.passwords_off && !bool(req.body?.confirm_keys)) throw bad('Confirm that you can log in to this server with an SSH key');
  if (all("SELECT params FROM jobs WHERE type = 'ssh-guard' AND status IN ('queued', 'running')").some((r) => parseJSON(r.params, {}).server === s.id)) throw bad('SSH protection of this server is already running');
  const what = o.remove ? 'remove SSH protection' : [o.fail2ban && 'fail2ban', o.passwords_off && 'password login off'].filter(Boolean).join(' + ');
  const job = enqueue({ type: 'ssh-guard', title: `Protect SSH on ${s.name}: ${what}`, serverId: s.id, params: { server: s.id, ...o }, user: who(req) });
  audit(req, 'warn', `${s.name}: ${what}`, { serverId: s.id, jobId: job.id });
  res.json({ job });
});

api.post('/servers/:id/ssh-guard/unban', async (req, res) => {
  const s = mustServer(req.params.id);
  const ip = str(req.body?.ip, 64);
  try {
    await unbanIp(s, ip);
  } catch (e) {
    throw bad(e.message);
  }
  audit(req, 'info', `${s.name}: ${ip} unblocked (fail2ban)`, { serverId: s.id });
  res.json({ ok: true });
});

api.post('/servers/:id/cleanup/preview', async (req, res) => {
  const s = mustServer(req.params.id);
  try {
    res.json({ ok: true, plan: { ...(await previewCleanup(s)), next_run: nextCleanup(s.id) } });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

api.post('/servers/:id/cleanup', (req, res) => {
  const s = mustServer(req.params.id);
  const opts = cleanupOptions(req.body);
  const what = cleanupLabel(opts);
  if (!what) throw bad('Tick at least one thing to clean up');
  if (cleanupBusy(s.id)) throw bad('A cleanup of this server is already running');
  if (serverBusy(s.id) || cloneBusy(s.id) || resetBusy(s.id)) throw bad('A clone, copy, OS upgrade, reset or reinstall involving this server is running — try again when it is done');
  const job = enqueue({ type: 'server-cleanup', title: `Clean up ${s.name}`, serverId: s.id, params: { server: s.id, ...opts }, user: who(req) });
  audit(req, 'info', `Cleanup of ${s.name} started: ${what}`, { serverId: s.id, jobId: job.id });
  res.json({ job });
});

api.get('/servers/:id/cleanup/schedule', (req, res) => {
  const s = mustServer(req.params.id);
  res.json({ schedule: getSchedule(s.id), next_run: nextCleanup(s.id) });
});

api.put('/servers/:id/cleanup/schedule', (req, res) => {
  const s = mustServer(req.params.id);
  const cron = cronInput(req.body?.cron, 'Cleanup schedule');
  if (!cron) {
    setSchedule(s.id, null);
    audit(req, 'info', `Weekly cleanup of ${s.name} turned off`, { serverId: s.id });
  } else {
    // A schedule never restarts containers: that is only done by hand.
    const options = { ...cleanupOptions(req.body?.options), restart: [] };
    if (!cleanupLabel(options)) throw bad('Tick at least one thing for the scheduled cleanup');
    setSchedule(s.id, { cron, options });
    audit(req, 'info', `Cleanup schedule of ${s.name}: ${cron} (${cleanupLabel(options)})`, { serverId: s.id });
  }
  reloadSchedules();
  res.json({ schedule: getSchedule(s.id), next_run: nextCleanup(s.id) });
});

api.post('/servers/:id/clone/preview', async (req, res) => {
  const { src, dst, params } = cloneInput(req);
  try {
    res.json({ ok: true, plan: await previewClone(src, dst, params) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

api.post('/servers/:id/clone', (req, res) => {
  const { src, dst, params } = cloneInput(req);
  if (cloneBusy(src.id, dst.id) || serverBusy(src.id) || serverBusy(dst.id)) throw bad('A clone or OS upgrade involving one of these servers is already running');
  const job = enqueue({ type: 'clone', title: `Clone ${src.name} → ${dst.name}`, serverId: src.id, params, user: who(req) });
  audit(req, 'warn', `Clone of ${src.name} to ${dst.name} started`, { serverId: dst.id, jobId: job.id });
  res.json({ job });
});

/* ---------- copy one project to another server ---------- */
function copyInput(req) {
  const project = mustProject(req.params.id);
  const dep = getDeployment(toId(req.body.deployment));
  if (!dep || dep.project_id !== project.id) throw bad('Pick the server to copy from (a server of this project)');
  const dst = mustServer(req.body.target);
  if (dst.id === dep.server_id) throw bad('Pick a different server to copy to');
  let ports;
  try {
    ports = portMap(req.body.ports);
  } catch (e) {
    throw bad(e.message);
  }
  const params = {
    project: project.id,
    deployment: dep.id,
    source: dep.server_id,
    target: dst.id,
    ports,
    installDocker: req.body.installDocker === undefined ? true : bool(req.body.installDocker),
    freeze: req.body.freeze === undefined ? true : bool(req.body.freeze),
    replace: bool(req.body.replace),
  };
  return { project, dep, dst, params };
}

api.post('/projects/:id/copy/preview', async (req, res) => {
  const { project, dep, dst, params } = copyInput(req);
  try {
    res.json({ ok: true, plan: await previewCopy(project, dep, dst, params) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

api.post('/projects/:id/copy', (req, res) => {
  const { project, dep, dst, params } = copyInput(req);
  const src = getServer(dep.server_id);
  if (serverBusy(src.id) || serverBusy(dst.id) || cloneBusy(src.id, dst.id) || resetBusy(src.id) || resetBusy(dst.id)) {
    throw bad('A clone, copy, OS upgrade, reset or reinstall involving one of these servers is already running');
  }
  if (params.replace && str(req.body.confirm, 80) !== dst.name) throw bad(`Type the server name "${dst.name}" to confirm replacing what exists there`);
  const job = enqueue({ type: 'project-copy', title: `Copy ${project.name}: ${src.name} → ${dst.name}`, projectId: project.id, serverId: src.id, params, user: who(req) });
  audit(req, 'warn', `Copy of ${project.name} from ${src.name} to ${dst.name} started`, { projectId: project.id, serverId: dst.id, jobId: job.id });
  res.json({ job });
});

/* ---------- projects ---------- */
function cronInput(v, label) {
  const s = str(v, 100);
  if (!s) return null;
  try {
    validateCron(s);
  } catch (e) {
    throw bad(`${label}: ${e.message}`);
  }
  return s;
}

function recordsInput(list) {
  if (!Array.isArray(list)) throw bad('dns_records must be a list');
  if (list.length > 20) throw bad('Too many DNS records');
  return list.map((r) => {
    const rec = { zone_id: str(r.zone_id, 64), zone_name: str(r.zone_name, 253), id: str(r.id, 64), name: str(r.name, 253), type: r.type === 'AAAA' ? 'AAAA' : 'A' };
    if (!RE.cfId.test(rec.zone_id) || !RE.cfId.test(rec.id)) throw bad('Invalid Cloudflare record id');
    return rec;
  });
}

function projectInput(b) {
  const has = (k) => b[k] !== undefined;
  const out = {};
  const name = str(b.name, 80);
  if (!name) throw bad('Project name is required');
  out.name = name;
  if (has('domain')) {
    const domain = str(b.domain, 253).toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
    if (domain && !RE.domain.test(domain)) throw bad('Domain is not valid (example: shop.example.com)');
    out.domain = domain || null;
  }
  if (has('health_path')) {
    const hp = str(b.health_path, 500) || '/';
    if (!hp.startsWith('/') || /\s/.test(hp)) throw bad('Health check path must start with / (Laravel 11+ apps have /up)');
    out.health_path = hp;
  }
  if (has('health_scheme')) out.health_scheme = b.health_scheme === 'http' ? 'http' : 'https';
  if (has('health_port')) out.health_port = b.health_port ? int(b.health_port, null, 1, 65535) : null;
  if (has('health_expect')) {
    const ex = str(b.health_expect, 100) || '200-399';
    if (!RE.expect.test(ex)) throw bad('Expected status: e.g. 200-399 or 200,204');
    out.health_expect = ex;
  }
  if (has('health_keyword')) out.health_keyword = str(b.health_keyword, 200) || null;
  if (has('auto_failover')) out.auto_failover = bool(b.auto_failover) ? 1 : 0;
  if (has('failover_threshold')) out.failover_threshold = int(b.failover_threshold, 3, 1, 50);
  if (has('failover_cooldown')) out.failover_cooldown = int(b.failover_cooldown, 30, 0, 1440);
  if (has('maintenance_on_cmd')) out.maintenance_on_cmd = str(b.maintenance_on_cmd, 500);
  if (has('maintenance_off_cmd')) out.maintenance_off_cmd = str(b.maintenance_off_cmd, 500);
  if (has('deploy_script')) out.deploy_script = str(b.deploy_script, 20000) || null;
  if (has('sync_paths')) out.sync_paths = str(b.sync_paths, 5000) || null;
  if (has('sync_schedule')) out.sync_schedule = cronInput(b.sync_schedule, 'Copy schedule');
  if (has('sync_files_scheduled')) out.sync_files_scheduled = bool(b.sync_files_scheduled) ? 1 : 0;
  if (has('backup_schedule')) out.backup_schedule = cronInput(b.backup_schedule, 'Backup schedule');
  if (has('backup_keep')) out.backup_keep = int(b.backup_keep, 7, 1, 1000);
  if (has('purge_cache')) out.purge_cache = bool(b.purge_cache) ? 1 : 0;
  if (has('drain_seconds')) out.drain_seconds = int(b.drain_seconds, 30, 0, 600);
  if (has('notes')) out.notes = str(b.notes, 5000) || null;
  if (has('group_name')) out.group_name = str(b.group_name, 80) || null;
  if (has('dns_records')) out.dns_records = JSON.stringify(recordsInput(b.dns_records));
  return dropUndefined(out);
}

api.get('/projects', (req, res) => {
  res.json(all('SELECT * FROM projects ORDER BY name').map((p) => projectWithDeployments(p)));
});

api.post('/projects', (req, res) => {
  const row = projectInput(req.body);
  let slug = slugify(row.name);
  for (let i = 2; get('SELECT id FROM projects WHERE slug = ?', slug); i++) slug = `${slugify(row.name)}-${i}`;
  const id = insert('projects', { ...row, slug, created_at: now() });
  audit(req, 'info', `Project ${row.name} created`, { projectId: id });
  reloadSchedules();
  refreshDnsState(id).catch(() => {});
  res.json(projectPublic(getProject(id)));
});

api.get('/projects/:id', (req, res) => {
  const p = mustProject(req.params.id);
  const data = projectWithDeployments(p, { hours: 24, buckets: 96 });
  const used = new Set(data.deployments.map((d) => d.server_id));
  res.json({
    ...data,
    next_runs: nextRuns(p.id),
    backups_count: get('SELECT COUNT(*) AS n FROM backups WHERE project_id = ?', p.id).n,
    parent_name: p.parent_id ? getProject(p.parent_id)?.name : null,
    // How to clone it on a PC (the project page's "Use on my PC")
    git_urls: p.git_repo ? { ssh: gh.gitUrl(p.git_repo), https: `${gh.webUrl(p.git_repo)}.git`, web: gh.webUrl(p.git_repo) } : null,
    // For the "How to use" guide: the app has Switchboard's Makefile, and which optional parts it runs
    has_makefile: !!(parseJSON(p.template_opts, {}) || {}).makefile,
    ssh_users: Object.fromEntries(data.deployments.map((d) => [d.server_id, getServer(d.server_id)?.ssh_user || 'root'])),
    services: (parseJSON(p.template_opts, {}) || {}).services || null,
    group_parts: p.group_name ? all('SELECT id, name FROM projects WHERE group_name = ? AND id != ? ORDER BY name', p.group_name, p.id) : [],
    traffic: trafficNow(data.deployments.map((d) => d.server_id)),
    tool_check: { needs: projectNeeds(p), servers: missingFor(p) },
    available_servers: all('SELECT id, name, ip FROM servers ORDER BY name').filter((s) => !used.has(s.id)),
  });
});

api.put('/projects/:id', (req, res) => {
  const p = mustProject(req.params.id);
  const row = projectInput(req.body);
  update('projects', p.id, row);
  audit(req, 'info', `Project ${row.name} settings saved`, { projectId: p.id });
  // Servers keep a copy of the deploy script / health settings for CI deploys: refresh it.
  const keys = ['deploy_script', 'domain', 'health_path', 'health_scheme', 'health_port'];
  if ((p.template || rootOf(p).ci_enabled) && keys.some((k) => row[k] !== undefined && String(row[k] ?? '') !== String(p[k] ?? ''))) {
    enqueue({ type: 'ci-servers', title: `Update deploy settings on the servers (${p.name})`, projectId: p.id, user: who(req) });
  }
  reloadSchedules();
  if (row.dns_records !== undefined && row.dns_records !== p.dns_records) refreshDnsState(p.id).catch(() => {});
  bus.emit('state', { projectId: p.id });
  res.json(projectPublic(getProject(p.id)));
});

// Check every server of the project for the tools its deploy script needs (Node.js, Docker…), now.
api.post('/projects/:id/tool-check', async (req, res) => {
  const p = mustProject(req.params.id);
  const errors = [];
  await Promise.all(
    deploymentsOf(p.id).map(async (d) => {
      const s = getServer(d.server_id);
      try {
        await withSSH(s, (conn) => checkTools(conn, s), { timeout: 15000 });
      } catch (e) {
        errors.push(`${s.name}: ${e.message}`);
      }
    }),
  );
  res.json({ needs: projectNeeds(p), servers: missingFor(getProject(p.id)), errors });
});

/* ---------- outside database access (another service uses this project's database) ---------- */
function dbAccessView(p) {
  const cfg = dbAccessOf(p);
  const deps = deploymentsOf(p.id);
  const active = deps.find((d) => d.id === p.active_deployment_id) || null;
  const dbDep = active && active.db_type !== 'none' ? active : dbDeps(p)[0] || null;
  const root = (p.domain || '').split('.').slice(-2).join('.');
  return {
    config: cfg,
    problem: dbAccessProblem(p),
    issues: dbAccessIssues(p, deps).map((i) => ({ level: i.level, message: i.message, deployment_id: i.dep.id })),
    suggested_host: root ? `db.${root}` : '',
    default_port: DEFAULT_PORTS[dbDep?.db_type] || 3306,
    db_type: dbDep?.db_type || null,
    env: dbDep ? { database: dbDep.db_name || '', username: dbDep.db_user || '' } : null,
    proxy_image: PROXY_IMAGE,
    servers: deps.map((d) => ({
      id: d.id,
      server_name: d.server_name,
      server_ip: d.server_ip,
      is_active: d.id === p.active_deployment_id,
      has_db: d.db_type !== 'none' && !!d.db_container,
      db_container: d.db_container,
      ...(cfg?.servers?.[d.id] || {}),
    })),
  };
}

api.get('/projects/:id/db-access', (req, res) => {
  res.json(dbAccessView(mustProject(req.params.id)));
});

function dbAccessIps(list) {
  if (!Array.isArray(list)) throw bad('Allowed IPs must be a list');
  const out = [];
  for (const x of list.slice(0, 50)) {
    const ip = str(typeof x === 'string' ? x : x?.ip, 64);
    if (!ip) continue;
    const [addr, bits] = ip.split('/');
    if (!net.isIPv4(addr) || (bits !== undefined && !(/^\d+$/.test(bits) && Number(bits) >= 8 && Number(bits) <= 32))) throw bad(`"${ip}" is not an IPv4 address (like 203.0.113.5, or 203.0.113.0/24 for a range)`);
    if (addr === '0.0.0.0') throw bad('0.0.0.0 would open the database to the whole internet — enter the IP of your other server');
    if (out.some((o) => o.ip === ip)) continue;
    out.push({ ip, label: str(x?.label, 60) || null });
  }
  return out;
}

api.put('/projects/:id/db-access', async (req, res) => {
  const p = mustProject(req.params.id);
  const problem = dbAccessProblem(p);
  if (problem) throw bad(problem);
  const b = req.body || {};
  const host = str(b.host, 253).toLowerCase().replace(/\.$/, '');
  if (!RE.domain.test(host)) throw bad('Host name: a name like db.example.com (without https://)');
  if (p.domain && host === p.domain.toLowerCase()) throw bad(`${host} is your website — use a separate name, e.g. db.${p.domain}`);
  const port = int(b.port, 0, 0, 65535);
  if (!port || port < 1024 && ![3306, 5432].includes(port)) throw bad('Port: 3306 for MySQL, 5432 for PostgreSQL, or any number from 1024 to 65535');
  const ips = dbAccessIps(b.ips || []);
  const old = dbAccessOf(p) || {};
  let zone = old.host === host && old.zone_id ? { zone_id: old.zone_id, zone_name: old.zone_name } : null;
  if (!zone) {
    if (!getSetting('cf_token')) throw bad('Add your Cloudflare API token first (Settings)');
    try {
      zone = await zoneOf(host);
    } catch (e) {
      throw bad(`Cloudflare: ${e.message}`);
    }
    if (!zone) throw bad(`${host} is not in any of your Cloudflare zones`);
  }
  // A new name: unlink the old record from the project (it is kept in Cloudflare)
  if (old.record_id && old.host !== host) {
    update('projects', p.id, { dns_records: JSON.stringify(parseJSON(p.dns_records, []).filter((x) => x.id !== old.record_id)) });
  }
  const cfg = { ...old, enabled: true, host, port, ips, ...zone, ...(old.host !== host ? { record_id: null, record_created: false } : {}), servers: old.servers || {} };
  update('projects', p.id, { db_access: JSON.stringify(cfg) });
  audit(req, 'warn', `${p.name}: outside database access set to ${host}:${port} for ${ips.map((x) => x.ip).join(', ') || 'nobody'}`, { projectId: p.id });
  const job = enqueue({ type: 'db-access', title: `Outside database access: ${p.name} (${host}:${port})`, projectId: p.id, params: { action: 'apply' }, user: who(req) });
  bus.emit('state', { projectId: p.id });
  res.json({ job, ...dbAccessView(getProject(p.id)) });
});

api.post('/projects/:id/db-access/apply', (req, res) => {
  const p = mustProject(req.params.id);
  if (!dbAccessOf(p)?.enabled) throw bad('Outside database access is off for this project');
  const job = enqueue({ type: 'db-access', title: `Outside database access: ${p.name} (apply)`, projectId: p.id, params: { action: 'apply' }, user: who(req) });
  res.json({ job });
});

api.delete('/projects/:id/db-access', (req, res) => {
  const p = mustProject(req.params.id);
  if (!dbAccessOf(p)?.enabled) throw bad('Outside database access is already off');
  const job = enqueue({ type: 'db-access', title: `Outside database access: ${p.name} (turn off)`, projectId: p.id, params: { action: 'remove', deleteDns: req.body?.delete_dns !== false }, user: who(req) });
  audit(req, 'warn', `${p.name}: outside database access turned off`, { projectId: p.id });
  res.json({ job });
});

api.delete('/projects/:id', (req, res) => {
  const p = mustProject(req.params.id);
  if (str(req.body?.confirm) !== p.slug) throw bad(`Type "${p.slug}" to confirm`);
  if (bool(req.body?.remove_files)) {
    // Also remove it from every server: runs as a job (backup → containers, volumes, folders → record).
    if (p.parent_id) throw bad('Delete staging copies from their main project, or remove their server first');
    if (isLb(p)) throw bad('Turn off load balancing first, then delete the project');
    if (hasActiveJob(p.id)) throw bad('Another job of this project is running — wait for it to finish');
    const job = enqueue({ type: 'project-delete', title: `Delete ${p.name} from Switchboard and its servers`, projectId: p.id, params: { backup: req.body?.backup !== false }, user: who(req) });
    audit(req, 'warn', `Project ${p.name}: delete from all servers started`, { projectId: p.id, jobId: job.id });
    return res.json({ job });
  }
  const r = deleteProjectRecord(p);
  audit(req, 'warn', `Project ${p.name} deleted (with ${r.backups} backups)`);
  bus.emit('state', {});
  res.json({ ok: true });
});

api.post('/projects/:id/check', async (req, res) => {
  const p = mustProject(req.params.id);
  res.json(await checkProjectNow(p.id));
});

api.post('/projects/:id/dns/refresh', async (req, res) => {
  const p = mustProject(req.params.id);
  res.json(await refreshDnsState(p.id));
});

api.post('/projects/:id/dns/fix', (req, res) => {
  const p = mustProject(req.params.id);
  if (!p.active_deployment_id) throw bad('No active server set');
  const job = enqueue({ type: 'dns', title: `Point DNS to active server (${p.name})`, projectId: p.id, user: who(req) });
  res.json({ job });
});

/** Change one linked record by hand: point it at another IP and/or turn the proxy (orange cloud) on/off. Admin only. */
api.post('/projects/:id/dns/records/:record', async (req, res) => {
  const p = mustProject(req.params.id);
  const recordId = str(req.params.record, 64);
  if (!RE.cfId.test(recordId)) throw bad('Invalid record id');
  const b = req.body || {};
  const opts = {};
  if (b.content !== undefined) {
    const ip = str(b.content, 64);
    const rec = parseJSON(p.dns_records, []).find((r) => r.id === recordId);
    if (rec?.type === 'AAAA' ? !net.isIPv6(ip) : !net.isIPv4(ip)) throw bad(`${ip || 'That'} is not an ${rec?.type === 'AAAA' ? 'IPv6' : 'IPv4'} address`);
    opts.content = ip;
  }
  if (b.proxied !== undefined) opts.proxied = bool(b.proxied);
  let r;
  try {
    r = await setRecord(p, recordId, opts);
  } catch (e) {
    throw bad(e.message);
  }
  if (r.changed) {
    const what = [];
    if (r.before.content !== r.after.content) {
      const dep = deploymentsOf(p.id).find((d) => d.server_ip === r.after.content || d.server_ipv6 === r.after.content);
      what.push(`${r.before.content} → ${r.after.content}${dep ? ` (${dep.server_name})` : ''}`);
    }
    if (!!r.before.proxied !== !!r.after.proxied) what.push(r.after.proxied ? 'proxy ON (orange cloud)' : 'proxy OFF (DNS only)');
    audit(req, 'warn', `${p.name}: DNS ${r.after.type} ${r.after.name} changed by hand: ${what.join(', ')}`, { projectId: p.id });
  }
  res.json({ changed: r.changed, record: r.after, dns_state: await refreshDnsState(p.id) });
});

/** Cloudflare SSL mode of the project's zone(s) + an HTTPS check of every hostname a change would touch. */
api.get('/projects/:id/ssl', async (req, res) => {
  const p = mustProject(req.params.id);
  res.json({ ...(await sslStatus(p)), cert_hostnames: certHostnames(p) });
});

api.post('/projects/:id/ssl', async (req, res) => {
  const p = mustProject(req.params.id);
  const mode = str(req.body?.mode, 20);
  if (!SSL_MODES.includes(mode)) throw bad(`SSL mode must be one of ${SSL_MODES.join(', ')}`);
  const alwaysHttps = req.body?.always_https === undefined ? undefined : bool(req.body.always_https) && mode !== 'off';
  const status = await sslStatus(p);
  const zoneErr = status.zones.find((z) => z.error);
  if (zoneErr) throw bad(`${zoneErr.zone_name}: ${zoneErr.error}`);
  const problems = sslProblems(status, mode);
  if (problems.length && !bool(req.body?.force)) {
    return res.status(409).json({ error: `Setting SSL to "${mode}" would break ${problems.length} hostname${problems.length === 1 ? '' : 's'}`, problems });
  }
  let out;
  try {
    out = await applySsl(p, { mode, alwaysHttps });
  } catch (e) {
    throw bad(`${e.message}${/permission|auth|9109|10000/i.test(e.message) ? ' — your Cloudflare token needs "Zone Settings: Edit"' : ''}`);
  }
  for (const z of out) {
    const zn = status.zones.find((x) => x.zone_id === z.zone_id)?.zone_name || z.zone_id;
    audit(req, problems.length || mode === 'flexible' || mode === 'off' ? 'warn' : 'info', `${p.name}: Cloudflare SSL of ${zn}: ${z.before} → ${z.ssl}${z.always_use_https ? `, Always Use HTTPS ${z.always_use_https}` : ''}${problems.length ? ` (forced despite: ${problems.join('; ')})` : ''}`, { projectId: p.id });
  }
  res.json({ zones: out, status: await sslStatus(p) });
});

/** Make a Cloudflare Origin Certificate for each server of the project and install it (job). Admin only. */
api.post('/projects/:id/ssl/origin-cert', (req, res) => {
  const p = mustProject(req.params.id);
  if (!parseJSON(p.dns_records, []).length) throw bad('Link the Cloudflare DNS records to this project first');
  if (!deploymentsOf(p.id).length) throw bad('Add a server to this project first');
  const strict = bool(req.body?.strict);
  const job = enqueue({ type: 'origin-cert', title: `Cloudflare Origin Certificate (${p.name})${strict ? ' + Full (strict)' : ''}`, projectId: p.id, params: { strict }, user: who(req) });
  audit(req, 'warn', `${p.name}: Cloudflare Origin Certificate for all servers started${strict ? ', then SSL → Full (strict)' : ''}`, { projectId: p.id, jobId: job.id });
  res.json({ job });
});

/** What SSL each server of the project has: nginx sites for its hosts, certificate files, issuer, expiry. Admin only. */
api.get('/projects/:id/ssl/scan', async (req, res) => {
  const p = mustProject(req.params.id);
  const deps = deploymentsOf(p.id);
  res.json({ hosts: sslHosts(p), cert_hostnames: certHostnames(p), cloudflare: !!parseJSON(p.dns_records, []).length && !!getSetting('cf_token'), cas: ACME_CAS, servers: await scanProject(p, deps, getServer) });
});

/** Set up SSL on some/all servers of the project: Cloudflare Origin, own certificate, or acme (job). Admin only. */
api.post('/projects/:id/ssl/setup', (req, res) => {
  const p = mustProject(req.params.id);
  const all = deploymentsOf(p.id);
  if (!all.length) throw bad('Add a server to this project first');
  const ids = (Array.isArray(req.body?.deployments) ? req.body.deployments : []).map(Number).filter((id) => all.some((d) => d.id === id));
  if (Array.isArray(req.body?.deployments) && !ids.length) throw bad('Pick at least one server');
  let params;
  try {
    params = setupOptions(req.body, p, checkOwnCert);
  } catch (e) {
    throw bad(e.message);
  }
  params.deployments = ids;
  const names = (ids.length ? all.filter((d) => ids.includes(d.id)) : all).map((d) => d.server_name).join(', ');
  const label = params.method === 'cloudflare' ? 'Cloudflare Origin Certificate' : params.method === 'own' ? 'own certificate' : `${ACME_CAS[params.ca]} (${params.challenge === 'dns' ? 'DNS' : 'http'} check)`;
  const job = enqueue({ type: 'ssl-setup', title: `SSL: ${label} on ${names} (${p.name})${params.strict ? ' + Full (strict)' : ''}`, projectId: p.id, params, user: who(req) });
  audit(req, 'warn', `${p.name}: SSL set up with ${label} on ${names}${params.strict ? ', then SSL → Full (strict)' : ''}`, { projectId: p.id, jobId: job.id });
  res.json({ job });
});

/** Mark a server as active WITHOUT touching DNS (e.g. DNS was changed by hand in Cloudflare). */
api.post('/projects/:id/adopt', (req, res) => {
  const p = mustProject(req.params.id);
  const dep = mustDep(p, req.body.deployment);
  const prev = p.active_deployment_id;
  tx(() => {
    update('projects', p.id, { active_deployment_id: dep.id });
    if (prev && prev !== dep.id) update('deployments', prev, { data_at: now(), data_note: 'Was active (changed by hand)' });
    update('deployments', dep.id, { data_at: null, data_note: null });
  });
  audit(req, 'warn', `${dep.server_name} marked as the active server of ${p.name} (DNS not changed)`, { projectId: p.id });
  refreshDnsState(p.id).catch(() => {});
  res.json({ ok: true });
});

api.post('/projects/:id/switch', (req, res) => {
  const p = mustProject(req.params.id);
  const target = mustDep(p, req.body.target);
  if (target.id === p.active_deployment_id) throw bad(`${target.server_name} is already the active server`);
  if (!isLb(p)) {
    const problem = dnsTargetProblem(p, target);
    if (problem) throw bad(problem);
  }
  if (!parseJSON(p.dns_records, []).length) throw bad('Link the Cloudflare DNS records to this project first (project Settings tab)');
  if (!getSetting('cf_token')) throw bad('Add your Cloudflare API token first (Settings)');
  const job = enqueue({
    type: 'switch',
    title: `Switch ${p.name} → ${target.server_name}`,
    projectId: p.id,
    params: {
      target: target.id,
      syncDb: bool(req.body.syncDb),
      syncFiles: bool(req.body.syncFiles),
      maintenance: bool(req.body.maintenance),
      backupTarget: req.body.backupTarget === undefined ? true : bool(req.body.backupTarget),
      keepOldDown: req.body.keepOldDown === undefined ? true : bool(req.body.keepOldDown),
      purgeCache: bool(req.body.purgeCache),
      force: bool(req.body.force),
    },
    user: who(req),
  });
  audit(req, 'info', `Switch of ${p.name} to ${target.server_name} started`, { projectId: p.id, jobId: job.id });
  res.json({ job });
});

api.post('/projects/:id/sync', (req, res) => {
  const p = mustProject(req.params.id);
  const source = mustDep(p, req.body.source);
  const target = mustDep(p, req.body.target);
  if (source.id === target.id) throw bad('Pick two different servers');
  const targetActive = target.id === p.active_deployment_id;
  if (targetActive && str(req.body.confirm) !== p.slug) throw bad(`${target.server_name} is the ACTIVE server. Type "${p.slug}" to confirm you want to overwrite live data.`);
  const job = enqueue({
    type: 'sync',
    title: `Copy ${source.server_name} → ${target.server_name} (${p.name})`,
    projectId: p.id,
    params: {
      source: source.id,
      target: target.id,
      db: req.body.db === undefined ? true : bool(req.body.db),
      files: bool(req.body.files),
      backupTarget: req.body.backupTarget === undefined ? true : bool(req.body.backupTarget),
      maintenance: bool(req.body.maintenance),
      allowActiveTarget: targetActive,
    },
    user: who(req),
  });
  audit(req, targetActive ? 'warn' : 'info', `Copy ${source.server_name} → ${target.server_name} started for ${p.name}`, { projectId: p.id, jobId: job.id });
  res.json({ job });
});

api.post('/projects/:id/deploy', (req, res) => {
  const p = mustProject(req.params.id);
  if (!str(p.deploy_script)) throw bad('Set a deploy script first (project Settings tab)');
  const job = enqueue({ type: 'deploy', title: `Deploy ${p.name} on all servers`, projectId: p.id, params: { all: true }, user: who(req) });
  res.json({ job });
});

api.get('/projects/:id/backups', (req, res) => {
  const p = mustProject(req.params.id);
  const rows = all('SELECT * FROM backups WHERE project_id = ? ORDER BY id DESC', p.id).map((b) => ({ ...b, local: fs.existsSync(backupAbsPath(b)), exists: backupAvailable(b) }));
  res.json(rows);
});

/* ---------- deployments (a project on a server) ---------- */
function deploymentInput(b) {
  const row = {
    priority: int(b.priority, 10, 0, 1000),
    app_dir: check(RE.absPath, str(b.app_dir, 500).replace(/\/+$/, ''), 'app directory (must be an absolute path like /home/deploy/shop)'),
    app_container: check(RE.container, str(b.app_container, 128), 'app container name'),
    db_type: ['mysql', 'postgres', 'none'].includes(b.db_type) ? b.db_type : 'mysql',
    db_container: check(RE.container, str(b.db_container, 128), 'database container name'),
    db_name: check(RE.dbName, str(b.db_name, 64), 'database name (letters, numbers, _ and -)'),
    db_user: check(RE.dbUser, str(b.db_user, 80), 'database user'),
    skip_backup: bool(b.skip_backup) ? 1 : 0,
  };
  if (row.db_type !== 'none' && !row.db_container) throw bad('Database container is required (or choose "No database")');
  if (typeof b.db_password === 'string' && b.db_password) row.db_password = encrypt(b.db_password);
  if (bool(b.clear_db_password)) row.db_password = null;
  return row;
}

api.post('/projects/:id/deployments', (req, res) => {
  const p = mustProject(req.params.id);
  const server = mustServer(req.body.server_id);
  if (get('SELECT id FROM deployments WHERE project_id = ? AND server_id = ?', p.id, server.id)) throw bad(`${server.name} is already part of this project`);
  const id = insert('deployments', { ...deploymentInput(req.body), project_id: p.id, server_id: server.id, created_at: now() });
  audit(req, 'info', `${server.name} added to project ${p.name}`, { projectId: p.id, serverId: server.id });
  refreshDnsState(p.id).catch(() => {});
  checkProjectNow(p.id).catch(() => {});
  res.json(deploymentPublic(getDeployment(id), getProject(p.id)));
});

api.put('/deployments/:id', (req, res) => {
  const d = mustDep(null, req.params.id);
  update('deployments', d.id, deploymentInput(req.body));
  const p = getProject(d.project_id);
  audit(req, 'info', `${d.server_name} settings updated in project ${p.name}`, { projectId: p.id });
  bus.emit('state', { projectId: p.id });
  res.json(deploymentPublic(getDeployment(d.id), p));
});

api.delete('/deployments/:id', (req, res) => {
  const d = mustDep(null, req.params.id);
  const p = getProject(d.project_id);
  if (p.active_deployment_id === d.id) throw bad(`${d.server_name} is the ACTIVE server of ${p.name}. Switch to another server first.`);
  if (bool(req.body?.remove_files)) {
    const problem = removalProblem(p, d);
    if (problem) throw bad(problem);
    const job = enqueue({ type: 'remove-deployment', title: `Remove ${p.name} from ${d.server_name}`, projectId: p.id, params: { deployment: d.id, backup: req.body?.backup !== false }, user: who(req) });
    audit(req, 'warn', `Removing ${p.name} from ${d.server_name} (containers, volumes and files)`, { projectId: p.id, serverId: d.server_id, jobId: job.id });
    return res.json({ job });
  }
  run('DELETE FROM deployments WHERE id = ?', d.id);
  audit(req, 'warn', `${d.server_name} removed from project ${p.name}`, { projectId: p.id });
  bus.emit('state', { projectId: p.id });
  res.json({ ok: true });
});

/** Test DB settings before saving them (uses the saved password when none is typed). */
api.post('/servers/:id/test-db', async (req, res) => {
  const s = mustServer(req.params.id);
  const saved = req.body.deployment_id ? mustDep(null, req.body.deployment_id) : null;
  let dep;
  try {
    dep = { ...deploymentInput(req.body), server_name: s.name };
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
  if (!dep.db_password && saved?.db_password && !bool(req.body.clear_db_password)) dep.db_password = saved.db_password;
  if (dep.db_type === 'none') return res.json({ ok: false, error: 'No database selected' });
  try {
    const n = await withSSH(s, (conn) => countTables(conn, s, dep), { timeout: 15000 });
    res.json({ ok: true, tables: n });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

api.post('/deployments/:id/maintenance', (req, res) => {
  const d = mustDep(null, req.params.id);
  const p = getProject(d.project_id);
  const on = bool(req.body.on);
  const job = enqueue({ type: 'maintenance', title: `Maintenance ${on ? 'ON' : 'OFF'} ${p.name} @ ${d.server_name}`, projectId: p.id, params: { deployment: d.id, on }, user: who(req) });
  res.json({ job });
});

api.post('/deployments/:id/backup', (req, res) => {
  const d = mustDep(null, req.params.id);
  const p = getProject(d.project_id);
  if (d.db_type === 'none') throw bad('No database configured for this server');
  const job = enqueue({ type: 'backup', title: `Backup ${p.name} @ ${d.server_name}`, projectId: p.id, params: { deployment: d.id, kind: 'manual', note: str(req.body.note, 200) }, user: who(req) });
  res.json({ job });
});

api.post('/deployments/:id/deploy', (req, res) => {
  const d = mustDep(null, req.params.id);
  const p = getProject(d.project_id);
  if (!str(p.deploy_script)) throw bad('Set a deploy script first (project Settings tab)');
  const job = enqueue({ type: 'deploy', title: `Deploy ${p.name} @ ${d.server_name}`, projectId: p.id, params: { deployment: d.id }, user: who(req) });
  res.json({ job });
});

api.post('/deployments/:id/command', (req, res) => {
  const d = mustDep(null, req.params.id);
  const p = getProject(d.project_id);
  const command = str(req.body.command, 20000);
  if (!command) throw bad('Enter a command');
  const where = req.body.where === 'app' ? 'app' : 'host';
  const job = enqueue({
    type: 'command',
    title: `$ ${command.split('\n')[0].slice(0, 60)} @ ${d.server_name}`,
    projectId: p.id,
    params: { deployment: d.id, command, where },
    user: who(req),
  });
  audit(req, 'info', `Command on ${d.server_name} (${p.name}, ${where}): ${command.slice(0, 200)}`, { projectId: p.id, jobId: job.id });
  res.json({ job });
});

/* ---------- backups ---------- */
api.get('/backups/:id/download', async (req, res) => {
  const b = mustBackup(req.params.id);
  const file = path.resolve(await ensureLocal(b).catch((e) => Promise.reject(notFound(e.message))));
  if (!file.startsWith(path.resolve(config.backupDir) + path.sep) || !fs.existsSync(file)) throw notFound('Backup file is missing');
  audit(req, 'info', `Backup #${b.id} downloaded`, { projectId: b.project_id });
  res.download(file, path.basename(file));
});

api.post('/backups/:id/restore', (req, res) => {
  const b = mustBackup(req.params.id);
  const p = getProject(b.project_id);
  const shared = req.body.target === 'shared';
  if (shared && !p.db_server_id) throw bad('This project has no shared database');
  const target = shared ? { id: 'shared', server_name: 'the shared database' } : mustDep(p, req.body.target);
  const targetActive = shared || target.id === p.active_deployment_id;
  if (targetActive && str(req.body.confirm) !== p.slug) throw bad(`${target.server_name} is the ACTIVE server. Type "${p.slug}" to confirm you want to overwrite live data.`);
  const job = enqueue({
    type: 'restore',
    title: `Restore backup #${b.id} → ${target.server_name} (${p.name})`,
    projectId: p.id,
    params: {
      backup: b.id,
      target: target.id,
      backupFirst: req.body.backupFirst === undefined ? true : bool(req.body.backupFirst),
      maintenance: bool(req.body.maintenance),
      allowActiveTarget: targetActive,
    },
    user: who(req),
  });
  audit(req, 'warn', `Restore of backup #${b.id} into ${target.server_name} started`, { projectId: p.id, jobId: job.id });
  res.json({ job });
});

api.patch('/backups/:id', (req, res) => {
  const b = mustBackup(req.params.id);
  const patch = {};
  if (req.body.note !== undefined) patch.note = str(req.body.note, 200) || null;
  if (req.body.keep) patch.kind = 'manual'; // "keep forever" = exclude from automatic cleanup
  update('backups', b.id, patch);
  res.json({ ok: true });
});

api.delete('/backups/:id', (req, res) => {
  const b = mustBackup(req.params.id);
  removeBackupFiles(b); // here and in S3
  run('DELETE FROM backups WHERE id = ?', b.id);
  audit(req, 'warn', `Backup #${b.id} deleted`, { projectId: b.project_id });
  res.json({ ok: true });
});

/* ---------- jobs & events ---------- */
api.get('/jobs', (req, res) => {
  const where = [];
  const args = [];
  if (req.query.project) {
    where.push('project_id = ?');
    args.push(toId(req.query.project));
  }
  if (req.query.server) {
    where.push("(server_id = ? OR project_id IN (SELECT project_id FROM deployments WHERE server_id = ?) OR (type IN ('clone', 'project-copy') AND json_extract(params, '$.target') = ?))");
    args.push(toId(req.query.server), toId(req.query.server), toId(req.query.server));
  }
  if (req.query.status) {
    where.push('status = ?');
    args.push(str(req.query.status, 20));
  }
  const limit = int(req.query.limit, 50, 1, 500);
  const rows = all(`SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`, ...args);
  res.json(rows.map(summary));
});

api.get('/jobs/:id', (req, res) => {
  const j = getJob(toId(req.params.id));
  if (!j) throw notFound('Job not found');
  res.json({ ...summary(j), log: j.log, params: parseJSON(j.params, {}), progress: parseJSON(j.progress, null) });
});

api.post('/jobs/:id/cancel', (req, res) => {
  const ok = cancelJob(toId(req.params.id));
  if (ok) audit(req, 'warn', `Job #${req.params.id} cancelled`, { jobId: Number(req.params.id) });
  res.json({ ok });
});

api.get('/events', (req, res) => {
  const where = [];
  const args = [];
  if (req.query.project) {
    where.push('project_id = ?');
    args.push(toId(req.query.project));
  }
  if (req.query.server) {
    where.push('server_id = ?');
    args.push(toId(req.query.server));
  }
  if (req.query.level) {
    where.push('level = ?');
    args.push(str(req.query.level, 10));
  }
  if (req.query.before) {
    where.push('id < ?');
    args.push(toId(req.query.before));
  }
  const limit = int(req.query.limit, 100, 1, 500);
  res.json(all(`SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`, ...args));
});

/* ---------- settings & Cloudflare ---------- */
const NUMERIC = {
  s3_enabled: [0, 1],
  s3_path_style: [0, 1],
  s3_keep_local: [0, 1],
  traffic_enabled: [0, 1],
  notify_jobs_failed_only: [0, 1],
  billing_reminders: [0, 1],
  billing_overdue_daily: [0, 1],
  billing_remind_hour: [0, 23],
  traffic_spike_x: [2, 100],
  traffic_min_rpm: [5, 100000],
  traffic_5xx_pct: [1, 100],
  traffic_ip_pct: [10, 100],
  traffic_ssh_fails: [5, 100000],
  check_interval: [15, 3600],
  check_timeout: [2, 60],
  metrics_interval: [60, 86400],
  dns_interval: [60, 86400],
  disk_alert_pct: [50, 99],
  ssl_alert_days: [1, 90],
  stale_alert_hours: [1, 8760],
  history_days: [1, 365],
  busy_cpu_pct: [1, 100],
  busy_mem_pct: [1, 100],
  busy_minutes: [0, 1440],
};

api.get('/settings', (req, res) => {
  res.json({ ...publicSettings(), info: { version: VERSION, data_dir: config.dataDir, cf_api: config.cfApiBase, allow_private_dns: config.allowPrivateDns } });
});

api.put('/settings', (req, res) => {
  const b = req.body || {};
  const changed = [];
  for (const key of Object.keys(DEFAULTS)) {
    if (SECRET_SETTINGS.includes(key)) {
      if (bool(b[`clear_${key}`]) || (key === 's3_access_key' && bool(b.clear_s3_secret_key))) {
        setSetting(key, '');
        changed.push(key);
      } else if (typeof b[key] === 'string' && b[key].trim()) {
        if (key === 'webhook_url' && !/^https?:\/\//.test(b[key].trim())) throw bad('Webhook URL must start with http(s)://');
        setSetting(key, b[key].trim());
        changed.push(key);
      }
      continue;
    }
    if (b[key] === undefined) continue;
    if (NUMERIC[key]) {
      const [min, max] = NUMERIC[key];
      setSetting(key, int(b[key], DEFAULTS[key], min, max));
    } else if (key === 'telegram_chat_id') {
      const v = str(b[key], 64);
      if (v && !/^(-?\d+|@[A-Za-z0-9_]{4,})$/.test(v)) throw bad('Telegram chat id is a number like 123456789 or -1001234567890 (or @channelname)');
      setSetting(key, v);
    } else if (key === 's3_endpoint') {
      const v = str(b[key], 300).replace(/\/+$/, '');
      if (v && !/^https?:\/\/[^\s/]+(:\d+)?$/.test(v)) throw bad('S3 endpoint: the address only, e.g. https://storage.example.com');
      setSetting(key, v);
    } else if (key === 's3_bucket') {
      const v = str(b[key], 63);
      if (v && !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(v)) throw bad('S3 bucket: lowercase letters, numbers, dots and dashes');
      setSetting(key, v);
    } else if (key === 's3_region') {
      const v = str(b[key], 40) || 'us-east-1';
      if (!/^[A-Za-z0-9-]{2,40}$/.test(v)) throw bad('S3 region: e.g. us-east-1');
      setSetting(key, v);
    } else if (key === 's3_prefix') {
      const v = str(b[key], 200).replace(/^\/+|\/+$/g, '');
      if (v && !/^[A-Za-z0-9._\/-]+$/.test(v)) throw bad('S3 folder: letters, numbers, . _ - and /');
      setSetting(key, v);
    } else if (key === 'notify_jobs') {
      const list = (Array.isArray(b[key]) ? b[key] : []).map((x) => str(x, 40)).filter((x) => /^[a-z0-9-]{1,40}$/.test(x));
      setSetting(key, [...new Set(list)].slice(0, 60));
    } else if (key === 'billing_remind_days') {
      const days = parseRemindDays(b[key]);
      if (!days.length && str(b[key])) throw bad('Payment reminders: days before the due date, e.g. 7,3,1,0');
      setSetting(key, days.join(','));
    } else if (key === 'dashboard_url') {
      const v = str(b[key], 300).replace(/\/+$/, '');
      if (v && !/^https?:\/\/\S+$/.test(v)) throw bad('Dashboard URL must start with http(s)://');
      setSetting(key, v);
    }
    changed.push(key);
  }
  audit(req, 'info', `Settings saved (${changed.filter((k) => !SECRET_SETTINGS.includes(k)).length} values${changed.some((k) => SECRET_SETTINGS.includes(k)) ? ', secrets updated' : ''})`);
  res.json(publicSettings());
});

api.post('/settings/cloudflare/test', async (req, res) => {
  try {
    const r = await cf.verifyToken(str(req.body.token, 200) || undefined);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

api.post('/settings/telegram/chats', async (req, res) => {
  const token = str(req.body?.telegram_token, 200) || getSetting('telegram_token');
  if (!token) return res.json({ ok: false, error: 'Paste the bot token first (from @BotFather)' });
  try {
    res.json({ ok: true, ...(await telegramChats(token)) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

api.post('/settings/notify/test', async (req, res) => {
  const o = {};
  for (const k of ['telegram_token', 'telegram_chat_id', 'webhook_url']) if (str(req.body[k], 500)) o[k] = str(req.body[k], 500);
  const r = await sendNotification('info', `Test message from Switchboard (sent by ${who(req)}) — notifications work!`, o, { retry: [2000] });
  if (!r.sent.length && !r.errors.length) return res.json({ ok: false, error: 'Nothing configured yet — fill in Telegram or a webhook URL' });
  res.json({ ok: r.errors.length === 0, ...r });
});

api.get('/cloudflare/zones', async (req, res) => {
  res.json(await cf.listZones());
});

api.get('/cloudflare/zones/:zone/records', async (req, res) => {
  const zone = str(req.params.zone, 64);
  if (!RE.cfId.test(zone)) throw bad('Invalid zone id');
  res.json(await cf.listRecords(zone));
});

/* ---------- templates, CI/CD (GitHub + self-hosted runners), staging, PR previews ---------- */
function zoneInput(b, domain) {
  if (!b || !b.zone_id) return null;
  const z = { zone_id: str(b.zone_id, 64), zone_name: str(b.zone_name, 253).toLowerCase() };
  if (!RE.cfId.test(z.zone_id) || !RE.domain.test(z.zone_name)) throw bad('Invalid Cloudflare zone');
  if (domain && domain !== z.zone_name && !domain.endsWith(`.${z.zone_name}`)) throw bad(`${domain} is not in the zone ${z.zone_name}`);
  return z;
}
const domainInput = (v) => {
  const d = str(v, 253).toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  if (d && !RE.domain.test(d)) throw bad('Domain is not valid (example: shop.example.com)');
  return d || null;
};
const branchInput = (v, def = 'main') => {
  const b = str(v, 100) || def;
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(b) || b.includes('..') || b.startsWith('/') || b.endsWith('/')) throw bad('Invalid branch name');
  return b;
};
const repoInput = (v) => {
  const r = str(v, 201).replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (r && !gh.REPO_RE.test(r)) throw bad('GitHub repository: owner/name (for example acme/shop)');
  return r || null;
};
function uniqueSlug(name) {
  let slug = slugify(name);
  for (let i = 2; get('SELECT id FROM projects WHERE slug = ?', slug); i++) slug = `${slugify(name)}-${i}`;
  return slug;
}

api.get('/templates', (req, res) => {
  res.json({
    templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label, hint: t.hint, dbs: t.dbs, host: !!t.host, services: t.services || [], needs: templateNeeds(id) })),
    dbs: DB_NAMES,
    github: gh.hasToken(),
  });
});

api.get('/github/me', async (req, res) => {
  if (!gh.hasToken()) return res.json({ connected: false });
  try {
    res.json({ connected: true, ...(await gh.whoami()) });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// A starter project (no repository yet) → a new GitHub repository with the server's code, see the 'link-github' job.
api.post('/projects/:id/link-github', (req, res) => {
  const p = mustProject(req.params.id);
  if (!gh.hasToken()) throw bad('Add a GitHub token first (Settings → GitHub)');
  if (p.git_repo) throw bad(`Already linked to ${p.git_repo}`);
  const repo = str(req.body?.repo, 201);
  if (!gh.REPO_RE.test(repo)) throw bad('Repository must look like owner/name');
  if (!deploymentsOf(p.id).length) throw bad('Add a server to the project first');
  if (all("SELECT id FROM jobs WHERE type = 'link-github' AND project_id = ? AND status IN ('queued', 'running')", p.id).length) throw bad('Already linking — wait for that job');
  const job = enqueue({ type: 'link-github', title: `Link ${p.name} with GitHub (${repo})`, projectId: p.id, params: { repo, privateRepo: req.body?.private !== false, ci: bool(req.body?.ci) }, user: who(req) });
  audit(req, 'info', `${p.name}: link with GitHub ${repo}`, { projectId: p.id, jobId: job.id });
  res.json({ job });
});

api.get('/github/repos', async (req, res) => {
  if (!gh.hasToken()) throw bad('Add a GitHub token first (Settings → GitHub)');
  res.json(await gh.listMyRepos());
});

api.get('/github/repo-info', async (req, res) => {
  const repo = repoInput(req.query.repo);
  if (!repo) throw bad('Choose a repository');
  const branch = req.query.branch ? branchInput(req.query.branch) : null;
  const [info, branches] = await Promise.all([gh.detectRepo(repo, branch), gh.listBranches(repo).catch(() => [])]);
  res.json({ ...info, branches });
});

/** A folder an app may live in: absolute, at least two levels deep, not a system or home folder itself. */
function appFolderInput(v) {
  const dir = cleanFolder(str(v, 500));
  if (!dir) throw bad('Folder must be an absolute path like /srv/shop or /home/deploy/shop');
  if (!safeDir(dir)) throw bad(`${dir} can't hold an app — use a folder of its own, like /srv/shop, /opt/shop or /home/deploy/shop (not /, /home, /var/www, /etc…)`);
  return dir;
}

api.post('/projects/from-template', (req, res) => {
  const b = req.body || {};
  const template = str(b.template, 20);
  const t = TEMPLATES[template];
  if (!t) throw bad('Choose a template');
  const db = t.dbs.includes(b.db) ? b.db : t.dbs[0];
  const name = str(b.name, 80);
  if (!name) throw bad('Project name is required');
  const domain = domainInput(b.domain);
  const zone = zoneInput(b.zone, domain);
  const servers = (Array.isArray(b.servers) ? b.servers : []).map((id) => mustServer(id).id);
  if (!servers.length) throw bad('Choose at least one server');
  const code = ['new', 'repo', 'none'].includes(b.code) ? b.code : 'none';
  const repo = code === 'none' ? null : repoInput(b.repo);
  if (code !== 'none' && !repo) throw bad('Enter the GitHub repository (owner/name)');
  if (repo && !gh.hasToken()) throw bad('Add a GitHub token first (Settings → GitHub)');
  const branch = branchInput(b.branch);
  const extraHosts = domain && bool(b.www) && !domain.startsWith('www.') ? [`www.${domain}`] : [];
  if (template === 'compose' && code !== 'repo') throw bad('A Docker Compose project uses your existing GitHub repository');
  const appPort = template === 'compose' ? int(b.app_port, 0, 1, 65535) || null : null;
  if (template === 'compose' && !appPort) throw bad('Enter the port the app listens on (from its docker-compose.yml, e.g. 8080)');
  let healthPath = str(b.health_path, 200) || '/';
  if (!healthPath.startsWith('/')) healthPath = `/${healthPath}`;
  const appDir = b.folder ? appFolderInput(b.folder) : null;
  const allServices = (t.services || []).map((s) => s.key);
  const services = Array.isArray(b.services) ? b.services.filter((k) => allServices.includes(k)) : allServices;
  const row = templateProjectRow({ name, template, db, domain, repo, branch, extraHosts, appPort, healthPath, services: allServices.length ? services : null });
  const id = insert('projects', { ...row, slug: uniqueSlug(name), created_at: now() });
  const job = enqueue({
    type: 'provision',
    title: `Set up ${name} (${t.label})`,
    projectId: id,
    params: { servers, appDir, createRepo: code === 'new', privateRepo: b.privateRepo !== false, zone, takeoverDns: bool(b.takeoverDns), ci: repo && ['pull', 'runner'].includes(b.ci) ? b.ci : null },
    user: who(req),
  });
  audit(req, 'info', `Project ${name} created from the ${t.label} template`, { projectId: id, jobId: job.id });
  reloadSchedules();
  bus.emit('state', {});
  res.json({ project: projectPublic(getProject(id)), job });
});

/** Run the template setup again (e.g. after fixing a problem), or on more servers. */
api.post('/projects/:id/provision', (req, res) => {
  const p = mustProject(req.params.id);
  if (!p.template) throw bad('This project was not made from a template');
  const ids = Array.isArray(req.body.servers) && req.body.servers.length ? req.body.servers.map((id) => mustServer(id).id) : deploymentsOf(p.id).map((d) => d.server_id);
  if (!ids.length) throw bad('Choose a server');
  const zone = p.dns_records === '[]' ? zoneInput(req.body.zone, p.domain) : null;
  const job = enqueue({ type: 'provision', title: `Set up ${p.name} on ${ids.length} server(s)`, projectId: p.id, params: { servers: ids, zone }, user: who(req) });
  res.json({ job });
});

api.get('/projects/:id/ci', async (req, res) => {
  const p = mustProject(req.params.id);
  const root = rootOf(p);
  const st = parseJSON(root.ci_state, {}) || {};
  const yaml = root.git_repo ? workflowYaml(root) : '';
  const live = req.query.live === '1' && root.git_repo && gh.hasToken() ? await runnerStatus(root.git_repo) : null;
  const runners = root.git_repo
    ? all('SELECT r.*, s.name AS server_name FROM runners r JOIN servers s ON s.id = r.server_id WHERE r.repo = ? ORDER BY s.name', root.git_repo).map((r) => ({ ...r, live: live ? live[r.name] || { status: 'missing' } : null }))
    : [];
  const zone = parseJSON(root.preview_zone);
  res.json({
    root: { id: root.id, name: root.name, slug: root.slug, template: root.template },
    is_root: root.id === p.id,
    token: gh.hasToken(),
    repo: root.git_repo,
    repo_url: root.git_repo ? gh.webUrl(root.git_repo) : null,
    branch: root.git_branch,
    enabled: !!root.ci_enabled,
    mode: root.ci_mode || 'runner',
    repo_private: st.repo_private ?? null,
    deployed: st.deployed || {},
    test_on: root.ci_test_on,
    test_cmd: root.ci_test_cmd || '',
    default_tests: root.template ? TEMPLATES[root.template].tests : '',
    workflow: yaml,
    workflow_path: workflowPathOf(root),
    own_workflow: ownWorkflow(root),
    runner_access: root.ci_runner_access === 'full' ? 'full' : 'restricted',
    docker_deploy_script: DOCKER_DEPLOY_SCRIPT,
    live_policy: POLICIES.includes(root.ci_live_policy) ? root.ci_live_policy : 'now',
    quiet_time: parseQuiet(root.ci_quiet_time)?.time || '',
    next_quiet: root.ci_quiet_time ? nextQuietTime(root.ci_quiet_time) : null,
    held: heldOf(root.id),
    // Own workflow: what Switchboard tells it (repository variable) — where to deploy after you approve.
    servers_var: ownWorkflow(root) ? { name: SERVERS_VAR, plan: serversPlan(root), saved_at: st.servers_var_at || null, error: st.servers_var_error || null } : null,
    up_to_date: ownWorkflow(root) || (!!yaml && st.committed_hash === workflowHash(yaml)),
    committed_at: st.committed_at || null,
    polled_at: st.polled_at || null,
    error: st.error || null,
    runs: all('SELECT * FROM ci_runs WHERE project_id = ? ORDER BY run_id DESC LIMIT 30', root.id),
    runners,
    servers: ciServers(root).map((s) => ({
      id: s.id,
      name: s.name,
      ip: s.ip,
      label: runnerLabel(s),
      labels: runnerLabels(s),
      runner_user: runnerUser(root, s),
      installed: runners.some((r) => r.server_id === s.id),
      deps: depsOn(root, s).map(({ project, dep }) => ({ id: dep.id, project: project.name, project_id: project.id, branch: project.git_branch || root.git_branch || 'main', dir: dep.app_dir || '', active: project.active_deployment_id === dep.id, deploy_script: !!String(project.deploy_script || '').trim() })),
    })),
    git: gitStates(root),
    preview: { server_id: root.preview_server_id, zone, example: zone ? `pr-12-${root.slug}.${zone.zone_name}` : null },
    previews: all('SELECT * FROM previews WHERE project_id = ? ORDER BY pr DESC', root.id),
    projects: ciProjects(root).map((x) => ({ id: x.id, name: x.name, env: x.env, branch: x.git_branch, domain: x.domain, servers: deploymentsOf(x.id).map((d) => d.server_name) })),
    staging: all('SELECT id, name, domain, git_branch, env FROM projects WHERE parent_id = ? ORDER BY id', root.id).map((x) => ({
      ...x,
      deployments: deploymentsOf(x.id).map((d) => ({ id: d.id, server_name: d.server_name, health: d.health, data_at: d.data_at, data_note: d.data_note, skip_backup: !!d.skip_backup })),
    })),
    all_servers: all('SELECT id, name, ip FROM servers ORDER BY name'),
  });
});

api.put('/projects/:id/ci', (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  const b = req.body || {};
  const row = {};
  if (b.git_repo !== undefined) row.git_repo = repoInput(b.git_repo);
  if (b.git_branch !== undefined) row.git_branch = branchInput(b.git_branch);
  if (b.ci_test_on !== undefined) row.ci_test_on = b.ci_test_on === 'none' ? 'none' : 'github';
  if (b.ci_mode !== undefined) row.ci_mode = b.ci_mode === 'pull' ? 'pull' : 'runner';
  if (b.ci_test_cmd !== undefined) row.ci_test_cmd = str(b.ci_test_cmd, 5000) || null;
  if (b.ci_runner_access !== undefined) row.ci_runner_access = b.ci_runner_access === 'full' ? 'full' : 'restricted';
  if (b.ci_live_policy !== undefined) {
    row.ci_live_policy = POLICIES.includes(b.ci_live_policy) ? b.ci_live_policy : 'now';
    if (row.ci_live_policy !== p.ci_live_policy) {
      // Runs from before this moment never hold the live server.
      const st = parseJSON(p.ci_state, {}) || {};
      row.ci_state = JSON.stringify({ ...st, policy_at: now() });
    }
  }
  if (b.ci_quiet_time !== undefined) {
    const t = str(b.ci_quiet_time, 5);
    const off = Number.isInteger(b.tz_offset) && Math.abs(b.tz_offset) <= 14 * 60 ? b.tz_offset : 0;
    if (t && !parseQuiet(t)) throw bad('Quiet time: like 02:00');
    row.ci_quiet_time = t ? `${t}|${off}` : null;
  }
  if ((row.ci_live_policy ?? p.ci_live_policy) === 'quiet' && !(row.ci_quiet_time ?? p.ci_quiet_time)) throw bad('Choose the quiet time (like 02:00)');
  if (b.ci_workflow_path !== undefined) row.ci_workflow_path = b.ci_workflow_path ? workflowPathInput(b.ci_workflow_path) : null;
  // Another workflow file: the runs list starts again with that file's runs.
  if (row.ci_workflow_path !== undefined && (row.ci_workflow_path || null) !== (p.ci_workflow_path || null)) run('DELETE FROM ci_runs WHERE project_id = ?', p.id);
  if (b.preview_server_id !== undefined) {
    row.preview_server_id = b.preview_server_id ? mustServer(b.preview_server_id).id : null;
    if (row.preview_server_id && !p.template) throw bad('Pull request previews need a project made from a template (Switchboard must know how to build it)');
  }
  if (b.preview_zone !== undefined) row.preview_zone = b.preview_zone?.zone_id ? JSON.stringify(zoneInput(b.preview_zone)) : null;
  update('projects', p.id, row);
  audit(req, 'info', `CI/CD settings of ${p.name} saved`, { projectId: p.id });
  bus.emit('state', { projectId: p.id });
  res.json({ ok: true });
});

api.post('/projects/:id/ci/setup', (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  if (!p.git_repo) throw bad('Set the GitHub repository first');
  if (!gh.hasToken()) throw bad('Add a GitHub token first (Settings → GitHub)');
  if (!ciServers(p).length) throw bad('Add a server to the project first');
  const job = enqueue({ type: 'ci-setup', title: `Set up CI/CD for ${p.name}`, projectId: p.id, params: { commit: req.body.commit !== false }, user: who(req) });
  res.json({ job });
});

api.post('/projects/:id/ci/servers', (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  const job = enqueue({ type: 'ci-servers', title: `Update deploy settings on the servers (${p.name})`, projectId: p.id, user: who(req) });
  res.json({ job });
});

/** Connect a server (e.g. a backup server) to the repo + CI/CD. Not in the project yet → added as a standby with the live server's settings. */
api.post('/projects/:id/ci/connect', (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  if (!p.git_repo) throw bad('Set the GitHub repository first (CI/CD → Repository → Save)');
  const server = mustServer(req.body.server_id);
  if (!depsOn(p, server).length) {
    const deps = deploymentsOf(p.id);
    const src = deps.find((d) => d.id === p.active_deployment_id) || deps[0];
    const dir = str(req.body.app_dir, 500) || src?.app_dir || '';
    if (!/^\/[^\0]+$/.test(dir) || /(^|\/)\.\.?(\/|$)/.test(dir)) throw bad('Give the app folder on the server as a full path, like /srv/shop');
    const row = { project_id: p.id, server_id: server.id, priority: Math.max(10, ...deps.map((d) => d.priority)) + 1, app_dir: dir, health: 'unknown', created_at: now() };
    if (src) Object.assign(row, { app_container: src.app_container, db_type: src.db_type, db_container: src.db_container, db_name: src.db_name, db_user: src.db_user, db_password: src.db_password });
    else row.db_type = 'none';
    insert('deployments', row);
    audit(req, 'info', `${server.name} added to project ${p.name} (standby${src ? `, same settings as ${src.server_name}` : ''}) to connect it to Git`, { projectId: p.id, serverId: server.id });
    refreshDnsState(p.id).catch(() => {});
    checkProjectNow(p.id).catch(() => {});
  } else if (req.body.app_dir) {
    // Folder given for a server already in the project: set it when none was set.
    for (const { dep } of depsOn(p, server)) if (!dep.app_dir && dep.project_id === p.id) update('deployments', dep.id, { app_dir: str(req.body.app_dir, 500) });
  }
  const runner = req.body.runner === true;
  if (runner && !gh.hasToken()) throw bad('A self-hosted runner needs a GitHub token first (Settings → GitHub)');
  if (req.body.runner_access !== undefined) update('projects', p.id, { ci_runner_access: req.body.runner_access === 'full' ? 'full' : 'restricted' });
  const job = enqueue({ type: 'ci-connect', title: `Connect ${server.name} to ${p.git_repo}${runner ? ' + self-hosted runner' : ''} (${p.name})`, projectId: p.id, serverId: server.id, params: { server: server.id, deploy: req.body.deploy === true, runner }, user: who(req) });
  bus.emit('state', { projectId: p.id });
  res.json({ job });
});

/** One run live from GitHub: its jobs and steps, each self-hosted job matched to a server. */
api.get('/projects/:id/ci/runs/:runId/live', async (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  if (!p.git_repo || !gh.hasToken()) throw bad('Needs a repository and a GitHub token');
  // Any run of this project's repository (also other workflow files): GitHub only finds it in that repo.
  const runId = Number(req.params.runId);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw notFound('Run not found');
  res.json(await liveRun(p, runId));
});

/** Runs of the repository that are still going (any workflow), with the project's servers they run on. */
api.get('/projects/:id/ci/active', async (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  if (!p.git_repo || !gh.hasToken()) return res.json({ runs: [] });
  res.json({ runs: await activeRuns(p) });
});

/** Send a finished run's commit to one server of the project (e.g. the live server). Body: { deployment }. */
api.post('/projects/:id/ci/runs/:runId/deploy', async (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  if (!p.git_repo || !gh.hasToken()) throw bad('Needs a repository and a GitHub token');
  const runId = Number(req.params.runId);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw notFound('Run not found');
  const dep = deploymentsOf(p.id).find((d) => d.id === Number(req.body?.deployment));
  if (!dep) throw bad('That server is not in this project');
  const r = await gh.getRun(p.git_repo, runId);
  if (r.status !== 'completed' || r.conclusion !== 'success') throw bad('Only a run that finished without errors can be deployed (its images must be built)');
  if (r.event === 'pull_request') throw bad('A pull request run is not deployed to the servers');
  const job = await deployCommitTo(p, dep, r.head_sha, { user: who(req), why: `from run #${r.run_number}` });
  audit(req, 'info', `${p.name}: commit ${r.head_sha.slice(0, 7)} (run #${r.run_number}) sent to ${dep.server_name}${dep.id === p.active_deployment_id ? ' (live)' : ''}`, { projectId: p.id });
  res.json({ job, sha: r.head_sha, message: job ? null : `GitHub deploys ${r.head_sha.slice(0, 7)} on ${dep.server_name} now — watch it under "Running now"` });
});

/** Stop a run on GitHub. Body: { force } — force also skips its "always run" steps. */
api.post('/projects/:id/ci/runs/:runId/cancel', async (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  if (!p.git_repo || !gh.hasToken()) throw bad('Needs a repository and a GitHub token');
  const runId = Number(req.params.runId);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw notFound('Run not found');
  const force = req.body?.force === true;
  try {
    await gh.cancelRun(p.git_repo, runId, force);
  } catch (e) {
    if (e.status === 409) throw bad('GitHub says this run can no longer be cancelled (it already finished or is stopping)');
    throw e;
  }
  forgetActive(p, runId);
  audit(req, 'warn', `CI/CD run ${runId} ${force ? 'force-' : ''}cancelled on GitHub (${p.name})`, { projectId: p.id });
  setTimeout(() => pollProject(p.id).catch(() => {}), 4000);
  res.json({ ok: true });
});

/**
 * Deploy plan: some servers now, others later (when you click, or at a time) — the same commit for all.
 * Body: { now: [deploymentId], later: [{ deployment, at? }], commit? ('latest' = newest on the branch) }
 */
api.post('/projects/:id/deploy-plan', async (req, res) => {
  const p = mustProject(req.params.id);
  if (!str(p.deploy_script)) throw bad('Set a deploy script first (project Settings tab, or CI/CD → "pull from Git + rebuild")');
  const ids = new Set(deploymentsOf(p.id).map((d) => d.id));
  const nowIds = (Array.isArray(req.body.now) ? req.body.now : []).map(Number).filter((id) => ids.has(id));
  const later = (Array.isArray(req.body.later) ? req.body.later : [])
    .map((l) => ({ deployment: Number(l?.deployment), at: l?.at ? new Date(l.at) : null }))
    .filter((l) => ids.has(l.deployment) && !nowIds.includes(l.deployment));
  for (const l of later) if (l.at && (Number.isNaN(l.at.getTime()) || l.at.getTime() < Date.now() - 60000)) throw bad('A "later" time is in the past');
  if (!nowIds.length && !later.length) throw bad('Choose at least one server');
  // Pin the commit, so the servers that wait later get exactly what the others get now.
  const root = rootOf(p);
  let commit = /^[0-9a-f]{7,40}$/.test(String(req.body.commit || '')) ? req.body.commit : null;
  if (!commit && later.length && root.git_repo && gh.hasToken()) commit = await gh.branchSha(root.git_repo, p.git_branch || root.git_branch || 'main').catch(() => null);
  const job = runPlan({ project: p, nowIds, later: later.map((l) => ({ deployment: l.deployment, at: l.at ? l.at.toISOString() : null })), commit, liveFirst: req.body.live_first === true, rollback: req.body.rollback === true, user: who(req) });
  audit(req, 'info', `${p.name}: deploy plan — now ${nowIds.length}, later ${later.length}${commit ? ` (commit ${commit.slice(0, 7)})` : ''}`, { projectId: p.id });
  res.json({ job, commit, held: heldOf(root.id) });
});

/** The newest commits of the project's branch: CI result of each, and which servers are on which commit. */
api.get('/projects/:id/commits', async (req, res) => {
  const p = mustProject(req.params.id);
  const root = rootOf(p);
  if (!root.git_repo || !gh.hasToken()) throw bad('Needs the GitHub repository and a token (CI/CD tab, Settings → GitHub)');
  const branch = p.git_branch || root.git_branch || 'main';
  const commits = await gh.listCommits(root.git_repo, branch, 25);
  const runs = all('SELECT sha, status, conclusion, html_url, run_number, run_id FROM ci_runs WHERE project_id = ? AND event != ? ORDER BY run_id DESC', root.id, 'pull_request');
  const git = gitStates(root);
  const servers = deploymentsOf(p.id).map((d) => ({ deployment: d.id, server_name: d.server_name, live: d.id === p.active_deployment_id, commit: git[d.id]?.commit || null }));
  const held = heldOf(root.id);
  res.json({
    branch,
    commits: commits.map((c, i) => ({ ...c, newest: i === 0, run: runs.find((r) => r.sha === c.sha) || null, on: servers.filter((s) => s.commit === c.sha).map((s) => s.server_name) })),
    servers,
    held,
  });
});

const mustHeld = (id) => {
  const row = get('SELECT h.*, s.name AS server_name, p.name AS project_name FROM held_deploys h JOIN deployments d ON d.id = h.deployment_id JOIN servers s ON s.id = d.server_id JOIN projects p ON p.id = h.project_id WHERE h.id = ?', toId(id));
  if (!row) throw notFound('This waiting deploy is gone (already deployed or cancelled)');
  return row;
};
api.post('/held-deploys/:id/deploy', async (req, res) => {
  const row = mustHeld(req.params.id);
  const job = await releaseHeld(row, { user: who(req), why: 'started by hand' });
  audit(req, 'info', `${row.project_name}: waiting deploy on ${row.server_name} started now`, { projectId: row.project_id });
  res.json({ job, message: job ? null : `GitHub deploys ${row.server_name} now — watch it under "Running now"` });
});
api.delete('/held-deploys/:id', (req, res) => {
  cancelHeld(mustHeld(req.params.id), who(req));
  res.json({ ok: true });
});

/** Look at the Git folder on every server of the project (read-only). */
api.post('/projects/:id/ci/git-check', async (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  if (!p.git_repo) throw bad('Set the GitHub repository first');
  res.json({ git: await checkAllGit(p) });
});

const workflowPathInput = (v) => {
  let path = str(v, 200).replace(/^\/+/, '');
  if (!path.includes('/')) path = `.github/workflows/${path}`;
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(path)) throw bad('Workflow file: a .yml file in .github/workflows, like .github/workflows/deploy.yml');
  if (path === gh.WORKFLOW_PATH) throw bad(`${gh.WORKFLOW_PATH} is Switchboard's own file — choose "Made by Switchboard", or give your file another name`);
  return path;
};

/** Your own workflow: the files in .github/workflows, one file's content, the example to start from. */
api.get('/projects/:id/ci/workflows', async (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  if (!p.git_repo) throw bad('Set the GitHub repository first');
  const branch = p.git_branch || 'main';
  const files = gh.hasToken() ? await gh.listWorkflowFiles(p.git_repo, branch) : [];
  let content = null;
  if (req.query.path) {
    const path = workflowPathInput(req.query.path);
    content = (await gh.getFile(p.git_repo, path, branch))?.content ?? null;
  }
  res.json({ branch, files: files.filter((f) => f !== gh.WORKFLOW_PATH), content, example: exampleWorkflow(p) });
});

/** Save your own workflow file to GitHub (a commit on the live branch). */
api.put('/projects/:id/ci/workflow', async (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  if (!p.git_repo) throw bad('Set the GitHub repository first');
  if (!gh.hasToken()) throw bad('Add a GitHub token first (Settings → GitHub)');
  const path = workflowPathInput(req.body.path || p.ci_workflow_path);
  const content = String(req.body.content ?? '');
  if (!content.trim()) throw bad('The workflow file is empty');
  if (content.length > 200000) throw bad('The workflow file is too big');
  if (!/^\s*jobs\s*:/m.test(content) || !/^\s*on\s*:/m.test(content)) throw bad('This does not look like a GitHub workflow (it needs "on:" and "jobs:")');
  const branch = p.git_branch || 'main';
  const changed = await gh.putFile(p.git_repo, path, content.endsWith('\n') ? content : `${content}\n`, { branch, message: str(req.body.message, 200) || `Update ${path.split('/').pop()} (from Switchboard)` });
  if (p.ci_workflow_path !== path) {
    update('projects', p.id, { ci_workflow_path: path });
    run('DELETE FROM ci_runs WHERE project_id = ?', p.id);
  }
  audit(req, 'info', `${p.name}: workflow ${path} ${changed ? 'committed' : 'unchanged'} on ${branch}`, { projectId: p.id });
  bus.emit('state', { projectId: p.id });
  res.json({ ok: true, changed, path });
});

/* ------------------------------------------------------------------ visual flow editor (src/ops/flow.js) */
/** The servers of a project as the flow editor shows them: name, runner label, app folder, live. */
api.get('/projects/:id/ci/flow/servers', (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  res.json({ project: { id: p.id, name: p.name, repo: p.git_repo || '', branch: p.git_branch || 'main', workflow_path: p.ci_workflow_path || '' }, servers: serversPlan(p).servers });
});

/** Workflow text → flow (jobs, steps, triggers) for the picture. */
api.post('/projects/:id/ci/flow/parse', (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  const content = String(req.body.content ?? '');
  if (content.length > 200000) throw bad('The workflow file is too big');
  res.json({ ...parseFlow(content), servers: serversPlan(p).servers });
});

/** The edited flow → workflow text (only what changed is rewritten; comments stay). */
api.post('/projects/:id/ci/flow/apply', (req, res) => {
  mustProject(req.params.id);
  const content = String(req.body.content ?? '');
  if (content.length > 200000) throw bad('The workflow file is too big');
  if (!req.body.flow || typeof req.body.flow !== 'object') throw bad('No flow');
  try {
    res.json({ content: applyFlow(content, req.body.flow) });
  } catch (e) {
    throw bad(e.message);
  }
});

/**
 * Copy a workflow to another project: its servers are swapped by `map` ({ old runner label: new label | 'github' }),
 * then the file is committed to that project's repository. Body: { to, content, path, map, follow }.
 */
api.post('/projects/:id/ci/flow/copy', async (req, res) => {
  const from = rootOf(mustProject(req.params.id));
  const to = rootOf(mustProject(req.body.to));
  if (!to.git_repo) throw bad(`${to.name} has no GitHub repository yet (its CI/CD tab)`);
  if (!gh.hasToken()) throw bad('Add a GitHub token first (Settings → GitHub)');
  const path = workflowPathInput(req.body.path || '.github/workflows/deploy.yml');
  const map = req.body.map && typeof req.body.map === 'object' ? Object.fromEntries(Object.entries(req.body.map).map(([k, v]) => [String(k), String(v || '')])) : {};
  let content;
  try {
    content = remapServers(String(req.body.content ?? ''), map);
  } catch (e) {
    throw bad(e.message);
  }
  const branch = to.git_branch || 'main';
  const changed = await gh.putFile(to.git_repo, path, content.endsWith('\n') ? content : `${content}\n`, { branch, message: `Add ${path.split('/').pop()} (copied from ${from.name} in Switchboard)` });
  if (req.body.follow === true && to.ci_workflow_path !== path) {
    update('projects', to.id, { ci_workflow_path: path });
    run('DELETE FROM ci_runs WHERE project_id = ?', to.id);
  }
  audit(req, 'info', `Workflow copied from ${from.name} to ${to.name} (${to.git_repo}: ${path})`, { projectId: to.id });
  bus.emit('state', { projectId: to.id });
  res.json({ ok: true, changed, path, repo: to.git_repo, project: to.id });
});

/** Saved flows: start a project's workflow from one of them. */
api.get('/flow-templates', (req, res) => res.json(all('SELECT id, name, description, content, created_by, created_at FROM flow_templates ORDER BY name')));
api.post('/flow-templates', (req, res) => {
  const name = str(req.body.name, 80);
  const content = String(req.body.content ?? '');
  if (!name) throw bad('Give the template a name');
  if (!content.trim() || content.length > 200000) throw bad('The workflow is empty or too big');
  const { flow, errors } = parseFlow(content);
  if (!flow) throw bad(errors[0] || 'Not a workflow');
  const id = insert('flow_templates', { name, description: str(req.body.description, 300), content, created_by: who(req), created_at: now() });
  audit(req, 'info', `Workflow template "${name}" saved`);
  res.json({ id });
});
api.delete('/flow-templates/:id', (req, res) => {
  const row = get('SELECT * FROM flow_templates WHERE id = ?', toId(req.params.id));
  if (!row) throw notFound('Template not found');
  run('DELETE FROM flow_templates WHERE id = ?', row.id);
  audit(req, 'warn', `Workflow template "${row.name}" deleted`);
  res.json({ ok: true });
});

/** Use the Docker Compose "pull and rebuild" deploy script for this project. */
api.post('/projects/:id/docker-deploy-script', (req, res) => {
  const p = mustProject(req.params.id);
  update('projects', p.id, { deploy_script: DOCKER_DEPLOY_SCRIPT });
  audit(req, 'info', `${p.name}: deploy script set to "pull from Git and rebuild with Docker"`, { projectId: p.id });
  bus.emit('state', { projectId: p.id });
  res.json({ ok: true });
});

api.post('/projects/:id/ci/commit', async (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  if (!p.git_repo) throw bad('Set the GitHub repository first');
  await commitWorkflow(null, p);
  audit(req, 'info', `CI/CD workflow of ${p.name} committed to ${p.git_repo}`, { projectId: p.id });
  res.json({ ok: true });
});

api.post('/projects/:id/ci/refresh', async (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  await pollProject(p.id);
  res.json({ ok: true });
});

api.post('/projects/:id/ci/run', async (req, res) => {
  const p = mustProject(req.params.id);
  const root = rootOf(p);
  if (!root.git_repo) throw bad('No GitHub repository set');
  const branch = branchInput(req.body.branch, p.git_branch || root.git_branch);
  await gh.dispatchWorkflow(root.git_repo, branch, workflowFileOf(root));
  audit(req, 'info', `CI/CD run started on ${branch} (${root.name})`, { projectId: root.id });
  setTimeout(() => pollProject(root.id).catch(() => {}), 4000);
  res.json({ ok: true });
});

api.post('/projects/:id/ci/disable', (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  update('projects', p.id, { ci_enabled: 0 });
  audit(req, 'warn', `CI/CD tracking turned off for ${p.name} (runners and workflow file were left as they are)`, { projectId: p.id });
  res.json({ ok: true });
});

api.delete('/projects/:id/ci/runners/:rid', (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  const r = get('SELECT r.*, s.name AS server_name FROM runners r JOIN servers s ON s.id = r.server_id WHERE r.id = ? AND r.repo = ?', toId(req.params.rid), p.git_repo);
  if (!r) throw notFound('Runner not found');
  const job = enqueue({ type: 'runner-remove', title: `Remove GitHub runner from ${r.server_name}`, projectId: p.id, params: { runner: r.id }, user: who(req) });
  res.json({ job });
});

api.post('/projects/:id/previews/sync', async (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  await pollProject(p.id);
  res.json({ ok: true });
});

api.delete('/projects/:id/previews/:pid', async (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  const row = get('SELECT * FROM previews WHERE id = ? AND project_id = ?', toId(req.params.pid), p.id);
  if (!row) throw notFound('Preview not found');
  await removePreview(p, row, 'removed by hand', who(req));
  res.json({ ok: true });
});

api.post('/projects/:id/staging', (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  if (!p.template) throw bad('A staging copy can be made for projects created from a template. For other projects, add a project by hand.');
  const server = mustServer(req.body.server_id);
  const domain = domainInput(req.body.domain);
  const zone = zoneInput(req.body.zone, domain);
  const branch = branchInput(req.body.branch, 'staging');
  const label = str(req.body.label, 30) || 'staging';
  const opts = parseJSON(p.template_opts, {}) || {};
  const row = templateProjectRow({ name: `${p.name} (${label})`, template: p.template, db: opts.db || 'none', domain, repo: p.git_repo, branch, env: 'staging', parentId: p.id, services: opts.services || null });
  row.ci_test_cmd = null;
  const id = insert('projects', { ...row, slug: uniqueSlug(`${p.slug}-${label}`), created_at: now() });
  const job = enqueue({
    type: 'provision',
    title: `Set up ${row.name}`,
    projectId: id,
    params: { servers: [server.id], zone, branchFrom: p.git_repo ? p.git_branch : null },
    user: who(req),
  });
  audit(req, 'info', `Staging copy ${row.name} created`, { projectId: p.id, jobId: job.id });
  bus.emit('state', {});
  res.json({ project: projectPublic(getProject(id)), job });
});

api.post('/projects/:id/staging/:sid/data', (req, res) => {
  const p = rootOf(mustProject(req.params.id));
  const s = mustProject(req.params.sid);
  if (s.parent_id !== p.id) throw bad('That is not a staging copy of this project');
  const job = enqueue({ type: 'staging-data', title: `Copy live data → ${s.name}`, projectId: s.id, user: who(req) });
  audit(req, 'info', `Live data of ${p.name} copied to ${s.name}`, { projectId: s.id, jobId: job.id });
  res.json({ job });
});

api.post('/settings/s3/test', async (req, res) => {
  const over = {};
  for (const k of ['s3_endpoint', 's3_region', 's3_bucket', 's3_access_key', 's3_secret_key', 's3_prefix']) if (str(req.body[k], 300)) over[k] = str(req.body[k], 300);
  if (req.body.s3_path_style !== undefined) over.s3_path_style = bool(req.body.s3_path_style) ? 1 : 0;
  try {
    res.json(await testS3(s3Config(over)));
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

api.post('/settings/s3/upload-all', (req, res) => {
  const job = enqueue({ type: 's3-upload-all', title: 'Upload existing backups to S3', user: who(req) });
  res.json({ job });
});

api.get('/settings/s3/status', (req, res) => {
  res.json(get("SELECT COUNT(*) AS total, SUM(s3_key IS NOT NULL) AS in_s3, SUM(s3_error IS NOT NULL AND s3_key IS NULL) AS failed, COALESCE(SUM(CASE WHEN s3_key IS NOT NULL THEN size END), 0) AS bytes FROM backups"));
});

api.post('/settings/github/test', async (req, res) => {
  try {
    const u = await gh.whoami(str(req.body.token, 300) || undefined);
    res.json({ ok: true, ...u });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/* ---------- server control: power, passwords, ports, domains ---------- */
api.get('/servers/:id/traffic', (req, res) => {
  const s = mustServer(req.params.id);
  const minutes = [60, 360, 1440, 10080].includes(Number(req.query.minutes)) ? Number(req.query.minutes) : 60;
  res.json({
    ...trafficSummary(s.id, minutes),
    live_for: all('SELECT p.id, p.name FROM projects p JOIN deployments d ON d.id = p.active_deployment_id WHERE d.server_id = ?', s.id),
    events: all("SELECT * FROM events WHERE server_id = ? AND message LIKE 'Unusual on %' ORDER BY id DESC LIMIT 20", s.id),
  });
});

// Usage history: CPU / memory / GPU / network over time + every busy time (server → Usage history)
api.get('/servers/:id/usage', (req, res) => {
  const s = mustServer(req.params.id);
  const minutes = [60, 360, 1440, 10080, 43200].includes(Number(req.query.minutes)) ? Number(req.query.minutes) : 1440;
  res.json(usageSummary(s.id, minutes));
});

api.post('/servers/:id/traffic/collect', async (req, res) => {
  const s = mustServer(req.params.id);
  try {
    res.json({ ok: true, new_requests: await collectTraffic(s) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

api.get('/servers/:id/log-sources', async (req, res) => {
  const s = mustServer(req.params.id);
  res.json(await logSources(s));
});

api.get('/servers/:id/logs', async (req, res) => {
  const s = mustServer(req.params.id);
  const q = str(req.query.q, 200).toLowerCase();
  const lines = int(req.query.lines, 200, 10, 2000);
  let out = await readLog(s, str(req.query.source, 500), q ? Math.min(2000, lines * 5) : lines);
  if (q) out = out.filter((l) => l.toLowerCase().includes(q)).slice(-lines);
  res.json({ lines: out, at: now() });
});

api.post('/servers/:id/power', (req, res) => {
  const s = mustServer(req.params.id);
  const act = POWER[req.body.action];
  if (!act) throw bad('Unknown action');
  if (str(req.body.confirm) !== s.name) throw bad(`Type the server name "${s.name}" to confirm`);
  const roles = serverRoles(s.id);
  if (roles.length && !bool(req.body.force)) throw bad(`${s.name} is the ${roles.join(', ')} — visitors will be affected. Tick "I understand" to do it anyway.`);
  const job = enqueue({ type: 'power', title: `${act.label} ${s.name}`, serverId: s.id, params: { server: s.id, action: req.body.action }, user: who(req) });
  audit(req, 'warn', `${act.label} of ${s.name} requested`, { serverId: s.id, jobId: job.id });
  res.json({ job });
});

api.get('/servers/:id/users', async (req, res) => {
  const s = mustServer(req.params.id);
  res.json(await listUsers(s));
});

/** Folder picker for a new app: the sub-folders of ?path= on the server. */
api.get('/servers/:id/folders', async (req, res) => {
  const s = mustServer(req.params.id);
  res.json(await listFolders(s, str(req.query.path, 500)));
});

/** "New folder" in the folder picker. */
api.post('/servers/:id/folders', async (req, res) => {
  const s = mustServer(req.params.id);
  const dir = appFolderInput(req.body.path);
  await makeFolder(s, dir);
  audit(req, 'info', `Folder ${dir} created on ${s.name}`, { serverId: s.id });
  res.json({ path: dir });
});

api.post('/servers/:id/password', async (req, res) => {
  const s = mustServer(req.params.id);
  const user = str(req.body.user, 32);
  const password = String(req.body.password || '');
  if (!USER_RE.test(user)) throw bad('Choose a user');
  if (password.length < 12) throw bad('Use at least 12 characters');
  if (password.length > 200 || /[\r\n\0]/.test(password)) throw bad('That password has characters that are not allowed');
  await changePassword(s, user, password);
  audit(req, 'warn', `Password of ${user} on ${s.name} changed`, { serverId: s.id });
  res.json({ ok: true, synced: s.auth_type === 'password' && (s.ssh_user || 'root') === user });
});

api.get('/servers/:id/ports', async (req, res) => {
  const s = mustServer(req.params.id);
  try {
    res.json({ ok: true, ...(await scanPorts(s)), domains: all('SELECT d.*, p.name AS project_name FROM domains d LEFT JOIN projects p ON p.id = d.project_id WHERE d.server_id = ? ORDER BY d.host', s.id) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

api.post('/servers/:id/ports/change', async (req, res) => {
  const s = mustServer(req.params.id);
  const from = int(req.body.from, 0, 1, 65535);
  const to = int(req.body.to, 0, 1, 65535);
  if (!from || !to || from === to) throw bad('Enter the new port (1-65535)');
  if (to < 1024 && ![80, 443].includes(to)) throw bad('Use a port above 1024');
  const scan = await scanPorts(s);
  const row = scan.ports.find((p) => p.port === from && p.proto === 'tcp' && p.container === str(req.body.container, 128));
  if (!row) throw bad(`No container ${str(req.body.container, 128)} on port ${from} — refresh the list`);
  if (!row.can_change) throw bad('Only ports of Docker Compose containers can be changed here');
  if (scan.ports.some((p) => p.port === to)) throw bad(`Port ${to} is already used on ${s.name}`);
  const job = enqueue({
    type: 'port-change',
    title: `${row.container}: port ${from} → ${to} @ ${s.name}`,
    serverId: s.id,
    params: { server: s.id, container: row.container, from, to, project: row.compose.project, service: row.compose.service, dir: row.compose.dir },
    user: who(req),
  });
  audit(req, 'warn', `Port of ${row.container} on ${s.name}: ${from} → ${to}`, { serverId: s.id, jobId: job.id });
  res.json({ job });
});

api.post('/servers/:id/domains', (req, res) => {
  const s = mustServer(req.params.id);
  const zone = zoneInput(req.body.zone);
  if (!zone) throw bad('Choose the Cloudflare zone (domain)');
  const sub = str(req.body.sub, 200).toLowerCase().replace(/\.+$/, '');
  if (sub && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(sub)) throw bad('Subdomain: letters, numbers and - (for example api or shop.api)');
  const host = sub ? `${sub}.${zone.zone_name}` : zone.zone_name;
  const port = int(req.body.port, 0, 1, 65535);
  if (!port) throw bad('Choose the port the app listens on');
  const project = req.body.project ? mustProject(req.body.project).id : null;
  const used = get('SELECT d.*, s.name AS server_name FROM domains d JOIN servers s ON s.id = d.server_id WHERE d.host = ?', host);
  if (used && used.server_id !== s.id) throw bad(`${host} is already connected to ${used.server_name}`);
  const job = enqueue({
    type: 'domain-connect',
    title: `Connect ${host} → ${s.name}:${port}`,
    serverId: s.id,
    params: { server: s.id, host, port, zone, project, proxied: req.body.proxied !== false, takeover: bool(req.body.takeover) },
    user: who(req),
  });
  audit(req, 'info', `Connect ${host} to ${s.name} port ${port}`, { serverId: s.id, jobId: job.id });
  res.json({ job, host });
});

/* ---------- web proxy (nginx) for a project: its domains → the app's port, on each of its servers ---------- */
api.post('/projects/:id/proxy', (req, res) => {
  const p = mustProject(req.params.id);
  let hosts;
  try {
    hosts = parseHosts(req.body.hosts);
  } catch (e) {
    throw bad(e.message);
  }
  const deps = deploymentsOf(p.id);
  const servers = (Array.isArray(req.body.servers) ? req.body.servers : []).map((s) => {
    const d = deps.find((x) => x.id === Number(s?.deployment));
    if (!d) throw bad('Unknown server for this project');
    if (s.folder) {
      // a front-end that does not run in Docker: nginx serves its built files
      try {
        return { deployment: d.id, folder: cleanSiteFolder(s.folder), spa: s.spa !== false };
      } catch (e) {
        throw bad(`${d.server_name}: ${e.message}`);
      }
    }
    const port = int(s.port, 0, 1, 65535);
    if (!port) throw bad(`Choose the port of the app on ${d.server_name}`);
    if ([22, 80, 443].includes(port)) throw bad(`Port ${port} is not the app (it is SSH or the web proxy itself) — choose the app's own port on ${d.server_name}`);
    return { deployment: d.id, port };
  });
  if (!servers.length) throw bad('Choose at least one server');
  const job = enqueue({
    type: 'proxy-setup',
    title: `Web proxy ${hosts[0]}${hosts.length > 1 ? ` +${hosts.length - 1}` : ''} for ${p.name} on ${servers.length} server${servers.length > 1 ? 's' : ''}`,
    projectId: p.id,
    params: { project: p.id, hosts, servers },
    user: who(req),
  });
  audit(req, 'info', `Web proxy for ${p.name}: ${hosts.join(', ')}`, { projectId: p.id, jobId: job.id });
  res.json({ job });
});

// Built website folders on each server of the project (Vue/React "dist" and friends), for the setup dialog.
api.get('/projects/:id/proxy/folders', async (req, res) => {
  const p = mustProject(req.params.id);
  const out = {};
  await Promise.all(deploymentsOf(p.id).map(async (d) => {
    try {
      const s = getServer(d.server_id);
      const r = await withSSH(s, (conn) => exec(conn, asRoot(s, findFoldersScript([d.app_dir].filter(Boolean)))), { timeout: 20000 });
      out[d.id] = { ok: true, folders: parseFolders(r.stdout) };
    } catch (e) {
      out[d.id] = { ok: false, folders: [], error: e.message };
    }
  }));
  res.json(out);
});

api.delete('/projects/:id/proxy', (req, res) => {
  const p = mustProject(req.params.id);
  if (!deploymentsOf(p.id).some((d) => d.proxy_state)) throw bad('No web proxy is set up for this project');
  const job = enqueue({ type: 'proxy-remove', title: `Remove the web proxy of ${p.name}`, projectId: p.id, params: { project: p.id }, user: who(req) });
  audit(req, 'warn', `Remove the web proxy of ${p.name}`, { projectId: p.id, jobId: job.id });
  res.json({ job });
});

api.delete('/domains/:id', (req, res) => {
  const d = get('SELECT * FROM domains WHERE id = ?', toId(req.params.id));
  if (!d) throw notFound('Domain not found');
  const job = enqueue({ type: 'domain-remove', title: `Disconnect ${d.host}`, serverId: d.server_id, params: { domain: d.id, deleteDns: bool(req.body?.deleteDns) }, user: who(req) });
  res.json({ job });
});

/* ---------- nginx sites (sites-available) ---------- */
api.get('/servers/:id/nginx', async (req, res) => {
  const s = mustServer(req.params.id);
  try {
    res.json({ ok: true, ...(await nginxSites.listSites(s)) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

api.get('/servers/:id/nginx/file', async (req, res) => {
  const s = mustServer(req.params.id);
  try {
    res.json({ text: await nginxSites.readSite(s, str(req.query.dir, 10), str(req.query.name, 100)) });
  } catch (e) {
    throw bad(e.message);
  }
});

const nginxDone = (req, s, r, what) => {
  if (r.ok) audit(req, 'warn', `nginx on ${s.name}: ${what}`, { serverId: s.id });
  return r;
};

api.post('/servers/:id/nginx/setup', async (req, res) => {
  const s = mustServer(req.params.id);
  res.json(nginxDone(req, s, await nginxSites.setupSites(s), 'sites-available set up'));
});

api.put('/servers/:id/nginx/file', async (req, res) => {
  const s = mustServer(req.params.id);
  const dir = str(req.body.dir, 10);
  const name = str(req.body.name, 100);
  if (!nginxSites.sitePath(dir, name)) throw bad('Name: letters, numbers, dot, - and _ (files in conf.d end with .conf)');
  const text = typeof req.body.text === 'string' ? req.body.text : '';
  try {
    res.json(nginxDone(req, s, await nginxSites.saveSite(s, { dir, name, text, enable: bool(req.body.enable) }), `${nginxSites.sitePath(dir, name)} saved`));
  } catch (e) {
    throw bad(e.message);
  }
});

api.post('/servers/:id/nginx/enable', async (req, res) => {
  const s = mustServer(req.params.id);
  const name = str(req.body.name, 100);
  const on = bool(req.body.on);
  if (!nginxSites.sitePath('sites', name)) throw bad('Unknown site');
  res.json(nginxDone(req, s, await nginxSites.enableSite(s, name, on), `site ${name} turned ${on ? 'on' : 'off'}`));
});

api.delete('/servers/:id/nginx/file', async (req, res) => {
  const s = mustServer(req.params.id);
  const dir = str(req.body?.dir, 10);
  const name = str(req.body?.name, 100);
  if (!nginxSites.sitePath(dir, name)) throw bad('Unknown site');
  res.json(nginxDone(req, s, await nginxSites.deleteSite(s, dir, name), `${nginxSites.sitePath(dir, name)} deleted`));
});

/* ---------- users & account ---------- */
api.get('/users', (req, res) => {
  res.json({
    roles: ROLES.map((r) => ({ id: r, info: ROLE_INFO[r] })),
    users: all('SELECT id, username, role, totp_secret IS NOT NULL AS totp, last_login_at, created_at FROM users ORDER BY id').map((u) => ({ ...u, totp: !!u.totp, me: u.id === req.user.id })),
  });
});

const adminCount = () => get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n;

api.post('/users', async (req, res) => {
  const role = ROLES.includes(req.body.role) ? req.body.role : 'developer';
  const id = await auth.createUser(str(req.body.username, 50), String(req.body.password || ''), role);
  audit(req, 'warn', `User ${str(req.body.username, 50)} created (${role})`);
  res.json({ id });
});

api.put('/users/:id', (req, res) => {
  const id = toId(req.params.id);
  const u = get('SELECT id, username, role FROM users WHERE id = ?', id);
  if (!u) throw notFound('User not found');
  const role = str(req.body.role, 20);
  if (!ROLES.includes(role)) throw bad('Unknown role');
  if (u.role === 'admin' && role !== 'admin' && adminCount() <= 1) throw bad('This is the last admin — make someone else admin first');
  update('users', id, { role });
  // Make the change take effect now: log the user out everywhere.
  if (role !== u.role && id !== req.user.id) run('DELETE FROM sessions WHERE user_id = ?', id);
  audit(req, 'warn', `User ${u.username} is now ${role}`);
  res.json({ ok: true });
});

api.delete('/users/:id', (req, res) => {
  const id = toId(req.params.id);
  if (id === req.user.id) throw bad("You can't delete yourself");
  const u = get('SELECT username, role FROM users WHERE id = ?', id);
  if (!u) throw notFound('User not found');
  if (u.role === 'admin' && adminCount() <= 1) throw bad("You can't delete the last admin");
  run('DELETE FROM users WHERE id = ?', id);
  audit(req, 'warn', `User ${u.username} deleted`);
  res.json({ ok: true });
});

api.post('/account/password', async (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!(await verifyPassword(String(req.body.current || ''), u.password_hash))) throw bad('Current password is wrong');
  auth.validatePassword(req.body.password);
  update('users', u.id, { password_hash: await hashPassword(req.body.password) });
  run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', u.id, req.user.sessionId);
  audit(req, 'warn', 'Password changed (other sessions logged out)');
  res.json({ ok: true });
});

api.post('/account/totp/setup', async (req, res) => {
  const secret = newTotpSecret();
  const uri = `otpauth://totp/${encodeURIComponent(`Switchboard:${req.user.username}`)}?secret=${secret}&issuer=Switchboard&algorithm=SHA1&digits=6&period=30`;
  res.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
});

api.post('/account/totp/enable', (req, res) => {
  const secret = str(req.body.secret, 64);
  if (!/^[A-Z2-7]{16,64}$/.test(secret)) throw bad('Invalid secret');
  if (!verifyTotp(secret, req.body.code)) throw bad('That code is not right — check the time on your phone and try again');
  update('users', req.user.id, { totp_secret: encrypt(secret) });
  audit(req, 'warn', 'Two-factor login enabled');
  res.json({ ok: true });
});

api.post('/account/totp/disable', async (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!(await verifyPassword(String(req.body.password || ''), u.password_hash))) throw bad('Password is wrong');
  update('users', u.id, { totp_secret: null });
  audit(req, 'warn', 'Two-factor login disabled');
  res.json({ ok: true });
});

/* ---------- errors ---------- */
api.use((req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));

// eslint-disable-next-line no-unused-vars
api.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error('[api]', req.method, req.originalUrl, err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: err.message || 'Server error' });
});

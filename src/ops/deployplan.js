import { all, get, insert, run, update, now } from '../db.js';
import { bus } from '../bus.js';
import { alert, logEvent } from '../events.js';
import { enqueue } from '../jobs.js';
import { getProject, getDeployment, deploymentsOf } from '../models.js';

/**
 * Deploy some servers now and others later — so the live server is not rebuilt while visitors use it.
 *
 *   plan:   "now" servers get one deploy job (standby first); "later" servers get a held deploy of the SAME commit,
 *           released when someone clicks "Deploy now" or at its time (checked every 30 s).
 *   policy: what the live server does when CI/CD brings a new commit by itself (projects.ci_live_policy):
 *           'now' (with the others) · 'hold' (waits for a click) · 'quiet' (waits until the quiet time).
 */

export const POLICIES = ['now', 'hold', 'quiet'];
const isSha = (s) => /^[0-9a-f]{7,40}$/.test(String(s || ''));

/** 'HH:MM|offset' → { time: 'HH:MM', offset: minutes east of UTC } (offset: the browser's when it was saved). */
export function parseQuiet(spec) {
  const m = String(spec || '').match(/^([01]\d|2[0-3]):([0-5]\d)(?:\|(-?\d{1,4}))?$/);
  if (!m) return null;
  return { time: `${m[1]}:${m[2]}`, h: Number(m[1]), min: Number(m[2]), offset: m[3] !== undefined ? Number(m[3]) : 0 };
}

/** The next moment it is HH:MM in the saved time zone (ISO, UTC). */
export function nextQuietTime(spec, from = new Date()) {
  const q = parseQuiet(spec);
  if (!q) return null;
  const local = new Date(from.getTime() + q.offset * 60000); // "wall clock" of that zone, read with UTC getters
  let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), q.h, q.min) - q.offset * 60000;
  if (t <= from.getTime() + 30000) t += 86400000;
  return new Date(t).toISOString();
}

export const heldOf = (projectId) =>
  all(
    `SELECT h.*, d.server_id, s.name AS server_name, p.name AS project_name, p.active_deployment_id = d.id AS live
     FROM held_deploys h JOIN deployments d ON d.id = h.deployment_id JOIN servers s ON s.id = d.server_id JOIN projects p ON p.id = h.project_id
     WHERE h.project_id = ? OR p.parent_id = ? ORDER BY h.id`,
    projectId,
    projectId,
  );

/** Keep one held deploy per server: a newer commit replaces an older one that was still waiting. */
export function holdDeploy({ project, dep, commit = null, runAt = null, reason = '', user = 'system' }) {
  const row = { project_id: project.id, deployment_id: dep.id, commit_sha: isSha(commit) ? commit : null, run_at: runAt || null, reason: String(reason).slice(0, 200), created_by: user, created_at: now() };
  const ex = get('SELECT id FROM held_deploys WHERE deployment_id = ?', dep.id);
  if (ex) update('held_deploys', ex.id, row);
  else insert('held_deploys', row);
  const when = runAt ? `at ${new Date(runAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'until you click "Deploy now"';
  logEvent('info', `${project.name}: ${dep.server_name}${project.active_deployment_id === dep.id ? ' (live)' : ''} waits ${when}${commit ? ` — commit ${commit.slice(0, 7)}` : ''}`, { projectId: project.id, user });
  bus.emit('state', { projectId: project.id });
}

/** Deploy a held server now (its commit), and forget the hold. */
export function releaseHeld(row, { user = 'system', why = '' } = {}) {
  const project = getProject(row.project_id);
  const dep = getDeployment(row.deployment_id);
  run('DELETE FROM held_deploys WHERE id = ?', row.id);
  if (!project || !dep) return null;
  const job = enqueue({
    type: 'deploy',
    title: `Deploy ${project.name} @ ${dep.server_name}${row.commit_sha ? ` @ ${row.commit_sha.slice(0, 7)}` : ''}${why ? ` (${why})` : ''}`,
    projectId: project.id,
    params: { deployment: dep.id, ...(row.commit_sha ? { commit: row.commit_sha } : {}) },
    user,
  });
  bus.emit('state', { projectId: project.id });
  return job;
}

export function cancelHeld(row, user) {
  run('DELETE FROM held_deploys WHERE id = ?', row.id);
  logEvent('warn', `${row.project_name}: waiting deploy on ${row.server_name} cancelled`, { projectId: row.project_id, user });
  bus.emit('state', { projectId: row.project_id });
}

/** Loop (every 30 s): release held deploys whose time has come. */
export function runDueHeld() {
  for (const row of all('SELECT * FROM held_deploys WHERE run_at IS NOT NULL AND run_at <= ?', now())) {
    const job = releaseHeld(row, { why: 'scheduled' });
    if (job) logEvent('info', `${getProject(row.project_id)?.name}: scheduled deploy started (job #${job.id})`, { projectId: row.project_id });
  }
}

/**
 * Run a plan: `nowIds` deployed in one job (standby first, live last), `later` [{ deployment, at }] held.
 * `commit` pins every part of the plan to the same code (null: each deploy takes the newest).
 */
export function runPlan({ project, nowIds = [], later = [], commit = null, liveFirst = false, rollback = false, user }) {
  const deps = deploymentsOf(project.id);
  const byId = new Map(deps.map((d) => [d.id, d]));
  const nowDeps = nowIds.map((id) => byId.get(Number(id))).filter(Boolean);
  let job = null;
  if (nowDeps.length) {
    const names = nowDeps.map((d) => d.server_name).join(', ');
    job = enqueue({
      type: 'deploy',
      title: `${rollback ? 'Roll back' : 'Deploy'} ${project.name} on ${names}${isSha(commit) ? ` ${rollback ? 'to' : '@'} ${commit.slice(0, 7)}` : ''}${later.length ? ' (others later)' : ''}`,
      projectId: project.id,
      params: { deployments: nowDeps.map((d) => d.id), ...(isSha(commit) ? { commit } : {}), ...(liveFirst ? { liveFirst: true } : {}) },
      user,
    });
  }
  for (const l of later) {
    const dep = byId.get(Number(l.deployment));
    if (dep) holdDeploy({ project, dep, commit, runAt: l.at || null, reason: 'deploy plan', user });
  }
  return job;
}

/**
 * CI/CD brought a new commit: which servers deploy now, and is the live one held?
 * Only holds when the project has a deploy script (a held deploy runs it later) and a live server.
 */
export function splitForPolicy(project, root, { commit, user = 'github' }) {
  const deps = deploymentsOf(project.id);
  const policy = POLICIES.includes(root.ci_live_policy) ? root.ci_live_policy : 'now';
  const live = deps.find((d) => d.id === project.active_deployment_id);
  if (policy === 'now' || !live || !String(project.deploy_script || '').trim()) return { now: deps, held: null };
  const runAt = policy === 'quiet' ? nextQuietTime(root.ci_quiet_time) : null;
  holdDeploy({ project, dep: live, commit, runAt, reason: policy === 'quiet' ? 'quiet time' : 'live server waits', user });
  if (policy === 'hold') alert('info', `${project.name}: new commit ${String(commit || '').slice(0, 7)} — ${live.server_name} (live) waits for you. CI/CD tab → Deploy now`, { projectId: project.id, link: `#/projects/${project.id}` });
  return { now: deps.filter((d) => d.id !== live.id), held: live };
}

import { all, get } from '../db.js';
import { bus } from '../bus.js';
import * as gh from '../github.js';
import { getProject, deploymentsOf, parseJSON } from '../models.js';
import { liveRun, rootOf, ciServers } from './ci.js';

/*
 * CI/CD pulse: which servers get new code from Git right now, for the moving picture on the home screen.
 *
 *   GitHub Actions  — any run of a project's repo that is not finished (your own workflow too). A job on a server's
 *                     self-hosted runner = that server is deploying; a run with no server job yet = GitHub builds.
 *   Switchboard     — "deploy" jobs (pull mode / Deploy buttons) that are queued or running, per server.
 *
 * GitHub is asked by itself (no need to open the CI/CD tab): every 20 s when nothing is going, every 6 s while
 * something is. One call per repo, plus the job list of each run that is going.
 */

const IDLE_S = 20;
const BUSY_S = 6;
let ghItems = [];
let ghError = null;
let checkedAt = null;
let timer = null;
let lastSig = '';

const STEP = { connect: 'connecting', code: 'getting the code', script: 'running deploy script', health: 'health check' };
const short = (s, n = 90) => String(s || '').split('\n')[0].slice(0, n);

async function readGithub() {
  if (!gh.hasToken()) return [];
  const roots = all('SELECT id FROM projects WHERE ci_enabled = 1 AND git_repo IS NOT NULL AND parent_id IS NULL').map((r) => rootOf(getProject(r.id))).filter(Boolean);
  const out = [];
  let err = null;
  for (const root of roots) {
    try {
      const going = (await gh.listRecentRuns(root.git_repo, 15)).filter((r) => r.status && r.status !== 'completed').slice(0, 6);
      const known = new Set(ciServers(root).map((s) => s.id));
      for (const r of going) {
        const live = await liveRun(root, r.id).catch(() => null);
        const jobs = live?.jobs || [];
        const base = {
          source: 'github',
          project_id: root.id,
          project: root.name,
          run_id: r.id,
          run_number: r.run_number,
          workflow: r.name || '',
          title: short(r.display_title || r.head_commit?.message),
          branch: r.head_branch || '',
          sha: r.head_sha || '',
          actor: r.actor?.login || r.triggering_actor?.login || '',
          started_at: r.run_started_at || r.created_at,
          link: `#/projects/${root.id}/cicd`,
          url: r.html_url,
          frac: jobs.length ? jobs.filter((j) => j.status === 'completed').length / jobs.length : 0,
        };
        const step = (j) => j.steps.find((s) => s.status === 'in_progress')?.name || j.name;
        const onServer = new Map();
        for (const j of jobs) {
          if (!j.server || !known.has(j.server.id) || j.status === 'completed') continue;
          const prev = onServer.get(j.server.id);
          if (prev && prev.phase === 'deploy') continue;
          onServer.set(j.server.id, { ...base, server_id: j.server.id, server_name: j.server.name, phase: j.status === 'in_progress' ? 'deploy' : 'wait', step: short(step(j), 60) });
        }
        out.push(...onServer.values());
        // Nothing on a server yet: GitHub is building / testing (or waiting for an approval).
        if (!onServer.size) {
          const j = jobs.find((x) => x.status === 'in_progress') || jobs.find((x) => x.status !== 'completed');
          out.push({ ...base, server_id: null, server_name: null, phase: r.status === 'waiting' ? 'wait' : 'build', step: short(j ? step(j) : r.status, 60) });
        }
      }
    } catch (e) {
      err = `${root.name}: ${e.message}`;
    }
  }
  ghError = err;
  return out;
}

/** Deploy jobs of Switchboard itself (pull mode, Deploy buttons), per server. */
function switchboardItems() {
  const jobs = all("SELECT id, title, project_id, params, progress, status, user, created_at, started_at FROM jobs WHERE type = 'deploy' AND status IN ('queued', 'running') ORDER BY id LIMIT 20");
  const out = [];
  for (const j of jobs) {
    const project = getProject(j.project_id);
    if (!project) continue;
    const p = parseJSON(j.params, {}) || {};
    const prog = parseJSON(j.progress, null);
    const deps = deploymentsOf(project.id);
    const byId = new Map(deps.map((d) => [d.id, d]));
    const ids = p.all ? deps.map((d) => d.id) : Array.isArray(p.deployments) ? p.deployments : [p.deployment];
    const done = prog?.servers?.filter((s) => s.state === 'success' || s.state === 'failure').length || 0;
    for (const id of ids) {
      const d = byId.get(Number(id));
      if (!d) continue;
      const st = prog?.servers?.find((s) => s.id === d.id);
      if (st && ['success', 'failure', 'skipped'].includes(st.state)) continue;
      out.push({
        source: 'switchboard',
        job_id: j.id,
        project_id: rootOf(project).id, // same id as the GitHub items (a part of a main project counts as the main one)
        project: project.name,
        server_id: d.server_id,
        server_name: d.server_name,
        phase: j.status === 'running' && st?.state === 'running' ? 'deploy' : 'wait',
        title: short(j.title),
        sha: p.commit || '',
        branch: project.git_branch || '',
        actor: j.user || '',
        step: st?.phase ? STEP[st.phase] || st.phase : j.status === 'queued' ? 'queued' : 'waiting for its turn',
        started_at: j.started_at || j.created_at,
        link: `#/projects/${project.id}`,
        frac: ids.length ? done / ids.length : 0,
        via: j.user === 'github' ? 'git' : 'manual',
      });
    }
  }
  return out;
}

/** What the home screen shows: every server that gets code now, and repos that GitHub is building. */
export function ciPulse() {
  const items = [...ghItems, ...switchboardItems()];
  const servers = new Set(items.filter((i) => i.server_id && i.phase === 'deploy').map((i) => i.server_id));
  return {
    items,
    deploying: servers.size,
    building: items.filter((i) => !i.server_id && i.phase === 'build').length,
    projects: new Set(items.map((i) => i.project_id)).size,
    checked_at: checkedAt,
    error: ghError,
    watching: gh.hasToken() ? get('SELECT COUNT(*) AS n FROM projects WHERE ci_enabled = 1 AND git_repo IS NOT NULL AND parent_id IS NULL').n : 0,
  };
}

async function tick() {
  try {
    ghItems = await readGithub();
    checkedAt = new Date().toISOString();
    const sig = JSON.stringify(ghItems.map((i) => [i.run_id, i.server_id, i.phase, i.step, Math.round(i.frac * 10)]));
    if (sig !== lastSig) {
      lastSig = sig;
      bus.emit('state', { ci: true });
    }
  } catch (e) {
    console.warn('[ci-pulse]', e.message);
  } finally {
    timer = setTimeout(tick, (ghItems.length ? BUSY_S : IDLE_S) * 1000);
  }
}

export function startCiPulse(firstDelayMs = 8000) {
  clearTimeout(timer);
  timer = setTimeout(tick, firstDelayMs);
}
export const stopCiPulse = () => clearTimeout(timer);
/** Look again soon (e.g. right after Switchboard started a workflow). */
export function pokeCiPulse(ms = 3000) {
  clearTimeout(timer);
  timer = setTimeout(tick, ms);
}

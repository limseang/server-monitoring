import { bus } from './bus.js';
import { get, insert, run, now } from './db.js';
import { localTime, stripAnsi } from './util.js';

/**
 * Background job runner. Jobs of the same project run one at a time (in order),
 * so a switch and a sync can never overlap. Logs stream live to the browser.
 */

const handlers = new Map();
const active = new Map(); // jobId -> { controller, state }
const chains = new Map(); // lock key -> promise of last queued job
const MAX_LOG = 3 * 1024 * 1024;
const NOISE = [
  /Using a password on the command line interface can be insecure/i,
  /Deprecated program name/i,
  /^\[Warning\] /i,
];
const PAD = ' '.repeat(11);

export function defineJob(type, handler) {
  handlers.set(type, handler);
}

export const summary = (j) =>
  j && {
    id: j.id,
    type: j.type,
    title: j.title,
    status: j.status,
    project_id: j.project_id,
    server_id: j.server_id,
    user: j.user,
    error: j.error,
    created_at: j.created_at,
    started_at: j.started_at,
    finished_at: j.finished_at,
  };

export function getJob(id) {
  const j = get('SELECT * FROM jobs WHERE id = ?', id);
  if (j && active.has(j.id)) {
    j.log = active.get(j.id).state.log;
    if (active.get(j.id).state.progress) j.progress = JSON.stringify(active.get(j.id).state.progress);
  }
  return j;
}

export function hasActiveJob(projectId) {
  return !!get("SELECT 1 AS x FROM jobs WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1", projectId);
}

export function enqueue({ type, title, projectId = null, serverId = null, params = {}, user = null }) {
  if (!handlers.has(type)) throw new Error(`Unknown job type: ${type}`);
  const id = insert('jobs', {
    type,
    title,
    project_id: projectId,
    server_id: serverId,
    params: JSON.stringify(params),
    status: 'queued',
    log: '',
    user,
    created_at: now(),
  });
  const key = projectId ? `project:${projectId}` : `job:${id}`;
  const prev = chains.get(key) || Promise.resolve();
  const p = prev.then(() => execute(id)).catch((e) => console.error('[jobs]', e));
  chains.set(key, p);
  p.then(() => {
    if (chains.get(key) === p) chains.delete(key);
  });
  const job = get('SELECT * FROM jobs WHERE id = ?', id);
  bus.emit('job', summary(job));
  return summary(job);
}

function makeCtx(job, controller, state) {
  const append = (line) => {
    if (state.log.length > MAX_LOG) {
      if (!state.truncated) {
        state.truncated = true;
        state.log += '… (log truncated) …\n';
      }
      return;
    }
    state.log += line + '\n';
    state.dirty = true;
    bus.emit(`job:${job.id}`, { type: 'log', line });
  };
  const outLine = (raw) => {
    const line = stripAnsi(raw).trimEnd();
    if (!line.trim() || NOISE.some((r) => r.test(line))) return;
    append(`${PAD}│ ${line}`);
  };
  return {
    id: job.id,
    job,
    user: job.user,
    signal: controller.signal,
    log: (msg) => append(`[${localTime()}] ${msg}`),
    step: (msg) => append(`[${localTime()}] ▶ ${msg}`),
    warn: (msg) => append(`[${localTime()}] ⚠ ${msg}`),
    /** Raw remote output; split into lines, buffering partial lines per stream key. */
    output: (chunk, key = 'o') => {
      state.partial[key] = (state.partial[key] || '') + chunk.toString('utf8');
      const parts = state.partial[key].split(/\r?\n|\r/);
      state.partial[key] = parts.pop();
      for (const p of parts) outLine(p);
      if (state.partial[key].length > 8192) {
        outLine(state.partial[key]);
        state.partial[key] = '';
      }
    },
    flushOutput: () => {
      for (const key of Object.keys(state.partial)) {
        if (state.partial[key]) outLine(state.partial[key]);
        state.partial[key] = '';
      }
    },
    /** Live progress for the job views (any JSON); sent right away, saved with the log. */
    progress: (data) => {
      state.progress = data;
      state.progressDirty = true;
      bus.emit(`job:${job.id}`, { type: 'progress', progress: data });
    },
    throwIfCancelled: () => {
      if (controller.signal.aborted) throw new Error('Cancelled by user');
    },
  };
}

async function execute(id) {
  const job = get('SELECT * FROM jobs WHERE id = ?', id);
  if (!job || job.status !== 'queued') return;
  const controller = new AbortController();
  const state = { log: '', dirty: false, partial: {}, truncated: false };
  active.set(id, { controller, state });
  run("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", now(), id);
  bus.emit('job', summary(get('SELECT * FROM jobs WHERE id = ?', id)));

  const ctx = makeCtx(job, controller, state);
  const flush = () => {
    if (state.progressDirty) {
      state.progressDirty = false;
      run('UPDATE jobs SET progress = ? WHERE id = ?', JSON.stringify(state.progress), id);
    }
    if (!state.dirty) return;
    state.dirty = false;
    run('UPDATE jobs SET log = ? WHERE id = ?', state.log, id);
  };
  const timer = setInterval(flush, 1500);
  let status = 'success';
  let error = null;
  try {
    await handlers.get(job.type)(ctx, JSON.parse(job.params || '{}'));
    ctx.flushOutput();
    ctx.log('✔ Finished successfully');
  } catch (e) {
    ctx.flushOutput();
    status = controller.signal.aborted ? 'cancelled' : 'failed';
    error = String(e?.message || e).slice(0, 2000);
    ctx.log(`✖ ${status === 'cancelled' ? 'Cancelled' : 'Failed'}: ${error}`);
    if (process.env.DEBUG) console.error(e);
  } finally {
    clearInterval(timer);
    run('UPDATE jobs SET status = ?, error = ?, log = ?, progress = ?, finished_at = ? WHERE id = ?', status, error, state.log, state.progress ? JSON.stringify(state.progress) : null, now(), id);
    active.delete(id);
    bus.emit(`job:${id}`, { type: 'end', status, error });
    bus.emit('job', summary(get('SELECT * FROM jobs WHERE id = ?', id)));
  }
}

export function cancelJob(id) {
  const a = active.get(id);
  if (a) {
    a.state.log += `[${localTime()}] ⚠ Cancel requested…\n`;
    a.controller.abort();
    return true;
  }
  const r = run(
    "UPDATE jobs SET status = 'cancelled', error = 'Cancelled before it started', finished_at = ? WHERE id = ? AND status = 'queued'",
    now(),
    id,
  );
  if (r.changes) {
    bus.emit(`job:${id}`, { type: 'end', status: 'cancelled', error: 'Cancelled before it started' });
    bus.emit('job', summary(get('SELECT * FROM jobs WHERE id = ?', id)));
  }
  return r.changes > 0;
}

/** Jobs that were running when the dashboard stopped can't be resumed. */
export function recoverJobs() {
  run(
    "UPDATE jobs SET status = 'failed', error = 'Interrupted: the dashboard restarted while this job was running', finished_at = ? WHERE status IN ('queued', 'running')",
    now(),
  );
}

export const isJobRunning = (id) => active.has(id);

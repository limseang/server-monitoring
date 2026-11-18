import { insert, now } from './db.js';
import { bus } from './bus.js';
import { sendNotification } from './notify.js';
import { getSetting } from './settings.js';

/**
 * Record an activity/audit event. With ctx.notify it is also pushed to Telegram/webhook.
 * ctx: { projectId, serverId, jobId, user, link, notify }
 */
export function logEvent(level, message, ctx = {}) {
  const row = {
    level,
    message,
    project_id: ctx.projectId ?? null,
    server_id: ctx.serverId ?? null,
    job_id: ctx.jobId ?? null,
    user: ctx.user ?? null,
    at: now(),
  };
  const id = insert('events', row);
  bus.emit('event', { id, ...row, notify: !!ctx.notify });
  if (ctx.notify) {
    let text = message;
    const base = getSetting('dashboard_url');
    if (base && ctx.link) text += `\n${String(base).replace(/\/+$/, '')}/${ctx.link}`;
    sendNotification(level, text).catch(() => {});
  }
  return id;
}

/** Important event: stored and pushed to notification channels. */
export const alert = (level, message, ctx = {}) => {
  if (ctx.jobId) alerted.add(ctx.jobId);
  return logEvent(level, message, { ...ctx, notify: true });
};

/* ------------------------------------------------------------------ "message me when this job finishes" */
const alerted = new Set(); // jobs that already sent their own alert (no second message for them)
const done = new Set();
const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const ts = (t) => (t ? new Date(`${String(t).replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(t) ? '' : 'Z'}`).getTime() : NaN);

export function jobMessage(j) {
  const took = dur(ts(j.finished_at) - ts(j.started_at || j.created_at));
  const who = j.user ? ` (started by ${j.user})` : '';
  if (j.status === 'success') return { level: 'success', text: `Job done: ${j.title} — took ${took}${who}` };
  if (j.status === 'cancelled') return { level: 'warn', text: `Job cancelled: ${j.title}${who}` };
  return { level: 'error', text: `Job FAILED: ${j.title} after ${took}${who}\n${String(j.error || '').slice(0, 600)}` };
}

bus.on('job', (j) => {
  if (!j || !['success', 'failed', 'cancelled'].includes(j.status) || done.has(j.id)) return;
  done.add(j.id);
  if (done.size > 5000) done.clear();
  const already = alerted.delete(j.id);
  const types = getSetting('notify_jobs');
  if (!Array.isArray(types) || !types.includes(j.type)) return;
  if (getSetting('notify_jobs_failed_only') && j.status === 'success') return;
  if (already) return; // the job sent its own alert about the result
  const { level, text } = jobMessage(j);
  const base = getSetting('dashboard_url');
  sendNotification(level, base ? `${text}\n${String(base).replace(/\/+$/, '')}/#/jobs/${j.id}` : text).catch(() => {});
});

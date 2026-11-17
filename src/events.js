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
export const alert = (level, message, ctx = {}) => logEvent(level, message, { ...ctx, notify: true });

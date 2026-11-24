import crypto from 'node:crypto';
import { getSetting } from './settings.js';
import { telegramApi } from './notify.js';

/**
 * "Ask me first": a deploy job waits until you press Approve (Telegram button or the dashboard) before it builds.
 *
 * Telegram: the message has two buttons; Switchboard reads the button presses with getUpdates (no webhook, so it
 * also works behind Cloudflare Access / at home). It only reads while something waits, and never confirms updates
 * it did not make (another program using the same bot, e.g. your GitHub workflow, still gets its own).
 */

const WAIT_MS = 60 * 60000; // no answer within an hour: the deploy does not run
const POLL_MS = 3000;
const waiting = new Map(); // job id → { resolve, reject, nonce, chatId, messageId, text }

export const approvalOn = () => !!Number(getSetting('deploy_approval'));
export const isWaiting = (jobId) => waiting.has(Number(jobId));
const telegramReady = () => !!(getSetting('telegram_token') && getSetting('telegram_chat_id'));

/** Approve (true) or reject (false) a waiting job. Returns false when it was not waiting. */
export function answer(jobId, ok, who = 'someone') {
  const w = waiting.get(Number(jobId));
  if (!w) return false;
  waiting.delete(Number(jobId));
  if (w.messageId) {
    const line = ok ? `✅ Approved by ${who}` : `🚫 Rejected by ${who}`;
    telegramApi(getSetting('telegram_token'), 'editMessageText', { chat_id: w.chatId, message_id: w.messageId, text: `${w.text}\n\n${line}`.slice(0, 4000), disable_web_page_preview: true }).catch(() => {});
  }
  if (ok) w.resolve(who);
  else w.reject(Object.assign(new Error(`Not approved — rejected by ${who}`), { notApproved: true }));
  return true;
}

/**
 * Wait for your OK before a job runs (when "Ask me before every deploy" is on). Throws when rejected,
 * cancelled or not answered within an hour.
 */
export async function waitForApproval(ctx, { title, user }) {
  if (!approvalOn()) return;
  const id = ctx.id;
  const base = getSetting('dashboard_url');
  const text = [`✋ Deploy waits for your OK`, title, user ? `Started by: ${user}` : null, base ? `${base}/#/jobs/${id}` : null].filter(Boolean).join('\n');
  const w = { nonce: crypto.randomBytes(4).toString('hex'), text, chatId: getSetting('telegram_chat_id'), messageId: null };
  const done = new Promise((resolve, reject) => Object.assign(w, { resolve, reject }));
  waiting.set(id, w);
  ctx.log('✋ Waiting for your OK before building — press Approve in Telegram or on this page');
  if (telegramReady()) {
    try {
      const m = await telegramApi(getSetting('telegram_token'), 'sendMessage', {
        chat_id: w.chatId,
        text,
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `sb:ok:${id}:${w.nonce}` }, { text: '🚫 Reject', callback_data: `sb:no:${id}:${w.nonce}` }]] },
      });
      w.messageId = m?.message_id || null;
      ctx.log('Approval request sent to Telegram');
      startPolling();
    } catch (e) {
      ctx.warn(`Could not send the approval request to Telegram (${e.message}) — approve it on this page`);
    }
  } else ctx.warn('Telegram is not set up (Settings → Alerts) — approve it on this page');

  const timer = setTimeout(() => waiting.get(id) === w && (waiting.delete(id), w.reject(Object.assign(new Error('Not approved within an hour — the deploy did not run'), { notApproved: true }))), WAIT_MS);
  const onAbort = () => answer(id, false, 'cancel');
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const who = await done;
    ctx.log(`✅ Approved by ${who}`);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
    waiting.delete(id);
  }
}

/* ------------------------------------------------------------------ Telegram button presses */
let polling = false;
const seen = new Set(); // update ids already handled (we don't confirm other programs' updates, so they come back)

async function pollOnce() {
  const token = getSetting('telegram_token');
  // timeout 0 (no long poll): a second reader of the same bot gets fewer "Conflict" errors.
  const updates = (await telegramApi(token, 'getUpdates', { timeout: 0, limit: 100 })) || [];
  for (const u of updates) {
    if (seen.has(u.update_id)) continue;
    seen.add(u.update_id);
    const q = u.callback_query;
    const m = /^sb:(ok|no):(\d+):([0-9a-f]+)$/.exec(q?.data || '');
    if (!m) continue;
    const w = waiting.get(Number(m[2]));
    // Only a press in the configured chat, on the message Switchboard sent for this job.
    const fromChat = String(q.message?.chat?.id) === String(getSetting('telegram_chat_id')) || String(q.from?.id) === String(getSetting('telegram_chat_id'));
    let note = 'This deploy is no longer waiting';
    if (w && w.nonce === m[3] && fromChat) {
      const who = q.from?.username ? `@${q.from.username}` : q.from?.first_name || 'Telegram';
      answer(m[2], m[1] === 'ok', `${who} (Telegram)`);
      note = m[1] === 'ok' ? 'Approved — building now' : 'Rejected';
    }
    telegramApi(token, 'answerCallbackQuery', { callback_query_id: q.id, text: note }).catch(() => {});
  }
  // Telegram returns at most 100 waiting updates: when it is full, confirm them so new presses can come through.
  if (updates.length >= 100) await telegramApi(token, 'getUpdates', { offset: updates.at(-1).update_id + 1, timeout: 0, limit: 1 });
  if (seen.size > 5000) for (const x of [...seen].slice(0, 2500)) seen.delete(x);
}

function startPolling() {
  if (polling) return;
  polling = true;
  (async () => {
    while (waiting.size && telegramReady()) {
      await pollOnce().catch((e) => {
        if (!/Conflict|terminated by other/i.test(e.message)) console.warn(`[approval] Telegram: ${e.message}`);
      });
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    polling = false;
  })();
}

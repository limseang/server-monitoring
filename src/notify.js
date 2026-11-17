import { config } from './config.js';
import { getSetting } from './settings.js';

const ICON = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '🚨' };

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

export async function sendTelegram(token, chatId, text) {
  await postJson(`${config.telegramApiBase}/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: text.slice(0, 4000),
    disable_web_page_preview: true,
  });
}

export async function sendWebhook(url, level, text) {
  let body;
  if (/discord(app)?\.com\/api\/webhooks/i.test(url)) body = { content: text.slice(0, 1900), username: 'Switchboard' };
  else if (/hooks\.slack\.com/i.test(url)) body = { text };
  else body = { text, level, source: 'switchboard', at: new Date().toISOString() };
  await postJson(url, body);
}

/**
 * Push a message to every configured channel (Telegram, webhook).
 * `overrides` lets the settings page test values before saving them.
 */
export async function sendNotification(level, message, overrides = {}) {
  const tgToken = overrides.telegram_token ?? getSetting('telegram_token');
  const tgChat = overrides.telegram_chat_id ?? getSetting('telegram_chat_id');
  const hook = overrides.webhook_url ?? getSetting('webhook_url');
  const text = `${ICON[level] || '•'} ${message}`;
  const tasks = [];
  if (tgToken && tgChat) tasks.push(sendTelegram(tgToken, tgChat, text).then(() => 'telegram'));
  if (hook) tasks.push(sendWebhook(hook, level, text).then(() => 'webhook'));
  const results = await Promise.allSettled(tasks);
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message || String(r.reason));
  if (errors.length) console.warn('[notify]', errors.join('; '));
  return { sent: results.filter((r) => r.status === 'fulfilled').map((r) => r.value), errors };
}

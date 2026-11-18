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

/** Call the Telegram Bot API; errors come back in plain words with what to do. */
async function telegramApi(token, method, body) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(String(token || '').trim())) {
    throw new Error('The bot token looks wrong — it looks like 123456789:ABCdef… (copy it from @BotFather)');
  }
  let res;
  try {
    res = await fetch(`${config.telegramApiBase}/bot${String(token).trim()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(`Could not reach Telegram (${e.cause?.code || e.message}) — is the internet reachable from the Switchboard machine?`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok) return data.result;
  throw new Error(telegramHint(res.status, data.description || `HTTP ${res.status}`, body?.chat_id));
}

export function telegramHint(status, description, chatId) {
  const d = String(description || '');
  if (status === 401 || /Unauthorized/i.test(d)) return 'Telegram does not accept this bot token (Unauthorized). Copy the token again from @BotFather (/mybots → your bot → API Token).';
  if (/chat not found/i.test(d))
    return `Telegram can't find chat ${chatId} for this bot. A bot may only message people who wrote to it first: open your bot in Telegram, press Start (or send it any message) — for a group, add the bot to the group — then click "Find my chat id".`;
  if (/bot was blocked by the user/i.test(d)) return 'You blocked this bot in Telegram. Open the bot, unblock it (Restart), then send the test again.';
  if (/bot is not a member|bot was kicked|not enough rights/i.test(d)) return 'The bot is not in that group/channel (or may not post there). Add the bot to it — for a channel, make it an admin — then try again.';
  if (/group chat was upgraded to a supergroup/i.test(d)) return 'That group became a supergroup and got a new id (starting with -100). Click "Find my chat id" to get the new one.';
  if (/terminated by other getUpdates|webhook is active|can't use getUpdates method while webhook is active/i.test(d))
    return 'This bot has a webhook set (it is used by another app), so Switchboard can\'t read its chats. Type the chat id by hand, or use a separate bot for Switchboard.';
  return `Telegram said: ${d}`;
}

export async function sendTelegram(token, chatId, text) {
  await telegramApi(token, 'sendMessage', { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true });
}

/**
 * The bot's name and the chats that wrote to it recently (from getUpdates), so the chat id
 * can be picked instead of looked up. Telegram keeps updates for 24 hours.
 */
export async function telegramChats(token) {
  const me = await telegramApi(token, 'getMe');
  const updates = await telegramApi(token, 'getUpdates', { limit: 100, timeout: 0, allowed_updates: ['message', 'channel_post', 'my_chat_member'] });
  const chats = new Map();
  for (const u of updates || []) {
    const c = (u.message || u.edited_message || u.channel_post || u.my_chat_member)?.chat;
    if (!c || chats.has(c.id)) continue;
    const name = c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id);
    chats.set(c.id, { id: String(c.id), type: c.type, name, username: c.username || null });
  }
  return { bot: me?.username || null, chats: [...chats.values()] };
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

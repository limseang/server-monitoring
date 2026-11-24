// "Ask me before every deploy": a deploy job waits for Approve (Telegram button or dashboard):  npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// A fake Telegram Bot API: records calls, hands out the button presses we queue.
const calls = [];
let updates = [];
const tg = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const method = req.url.split('/').pop();
    const b = body ? JSON.parse(body) : {};
    calls.push({ method, body: b });
    let result = true;
    if (method === 'sendMessage') result = { message_id: 77, chat: { id: 42 } };
    if (method === 'getUpdates') result = updates;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  });
});
await new Promise((r) => tg.listen(0, '127.0.0.1', r));
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-approval-'));
process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${tg.address().port}`;

const { setSetting } = await import('../src/settings.js');
const { defineJob, enqueue, getJob } = await import('../src/jobs.js');
const { answer, isWaiting } = await import('../src/approval.js');

const ran = [];
defineJob('deploy', async (ctx) => ran.push(ctx.id));
const until = async (fn, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (fn()) return;
  throw new Error('timed out');
};
const done = (id) => ['success', 'failed', 'cancelled'].includes(getJob(id).status);

after(() => tg.close());

test('off: a deploy runs right away', async () => {
  const j = enqueue({ type: 'deploy', title: 'Deploy A', params: {} });
  await until(() => done(j.id));
  assert.equal(getJob(j.id).status, 'success');
  assert.ok(ran.includes(j.id));
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 0);
});

test('on: waits for the Telegram button, ignores a forged press, then runs', async () => {
  setSetting('telegram_token', '123456:abcDEF');
  setSetting('telegram_chat_id', '42');
  setSetting('deploy_approval', 1);
  const j = enqueue({ type: 'deploy', title: 'Deploy B', params: {}, user: 'popcorn' });
  await until(() => isWaiting(j.id) && calls.some((c) => c.method === 'sendMessage'));
  const msg = calls.find((c) => c.method === 'sendMessage').body;
  assert.match(msg.text, /Deploy B/);
  const [ok, no] = msg.reply_markup.inline_keyboard[0].map((b) => b.callback_data);
  assert.match(ok, new RegExp(`^sb:ok:${j.id}:`));
  assert.match(no, new RegExp(`^sb:no:${j.id}:`));
  assert.ok(!ran.includes(j.id));

  // Wrong nonce and wrong chat: ignored.
  updates = [
    { update_id: 1, callback_query: { id: 'q1', data: `sb:ok:${j.id}:deadbeef`, from: { id: 42 }, message: { chat: { id: 42 } } } },
    { update_id: 2, callback_query: { id: 'q2', data: ok, from: { id: 9 }, message: { chat: { id: 9 } } } },
  ];
  await until(() => calls.filter((c) => c.method === 'answerCallbackQuery').length >= 2);
  assert.ok(isWaiting(j.id));

  updates.push({ update_id: 3, callback_query: { id: 'q3', data: ok, from: { id: 42, username: 'me' }, message: { chat: { id: 42 } } } });
  await until(() => done(j.id));
  assert.equal(getJob(j.id).status, 'success');
  assert.ok(ran.includes(j.id));
  assert.match(getJob(j.id).log, /Approved by @me \(Telegram\)/);
  assert.ok(calls.some((c) => c.method === 'editMessageText' && /Approved by @me/.test(c.body.text)));
  // Never confirms updates it did not need to (another program may read the same bot).
  assert.ok(calls.filter((c) => c.method === 'getUpdates').every((c) => c.body.offset === undefined));
  updates = [];
});

test('on: rejected from the dashboard → cancelled, never built', async () => {
  const j = enqueue({ type: 'deploy', title: 'Deploy C', params: {} });
  await until(() => isWaiting(j.id));
  assert.equal(answer(j.id, false, 'popcorn'), true);
  await until(() => done(j.id));
  assert.equal(getJob(j.id).status, 'cancelled');
  assert.match(getJob(j.id).error, /rejected by popcorn/);
  assert.ok(!ran.includes(j.id));
  assert.equal(answer(j.id, true), false);
});

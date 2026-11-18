#!/usr/bin/env node
// End-to-end test for server billing / payment reminders. Needs NO lab servers — only a running
// Switchboard that sends Telegram to the fake API (dev/cf-mock/server.js, port 8787):
//   node dev/cf-mock/server.js &
//   DATA_DIR=/tmp/sb-billing PORT=8093 ADMIN_USER=admin ADMIN_PASSWORD=admin-password-123 \
//     TELEGRAM_API_BASE=http://127.0.0.1:8787 node src/index.js &
//   SB_URL=http://localhost:8093 node dev/e2e-billing.mjs
// It adds a few fake servers (unreachable over SSH — that's fine) with billing info, checks the
// overview alerts, sends the reminders (each only once), marks a payment as paid, and removes
// everything it added at the end.
//   SB_URL     Switchboard to test (default http://localhost:8093)
//   SB_USER / SB_PASSWORD   admin login (default admin / admin-password-123)
//   MOCK_URL   fake Telegram (default http://127.0.0.1:8787)
const BASE = process.env.SB_URL || 'http://localhost:8093';
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:8787';
const TAG = `bill${Date.now().toString(36).slice(-5)}`;
let cookie = '';
let failures = 0;

async function api(method, url, body, jar) {
  const res = await fetch(`${BASE}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard', Cookie: jar ?? cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=') && jar === undefined) cookie = c.split(';')[0];
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error(`${method} ${url} → ${res.status} ${data?.error}`);
    e.status = res.status;
    throw e;
  }
  return data;
}
function check(cond, msg) {
  if (cond) console.log('  ✔', msg);
  else {
    failures++;
    console.log('  ✖', msg);
  }
}
async function step(name, fn) {
  console.log(`\n▶ ${name}`);
  try {
    await fn();
  } catch (e) {
    failures++;
    console.log('  ✖ ERROR', e.message);
  }
}
const telegram = async () => ((await (await fetch(`${MOCK}/__state`)).json()).telegram || []).filter((m) => m.text.includes(TAG));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Alerts are sent in the background: wait until the fake Telegram has `n` of our messages (or 5 s). */
async function telegramAtLeast(n) {
  for (let i = 0; i < 25; i++) {
    const m = await telegram();
    if (m.length >= n) return m;
    await sleep(200);
  }
  return telegram();
}
const addDays = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const ids = {};
let today;
let before = {};

await step('log in and turn on Telegram (fake)', async () => {
  await api('POST', '/auth/login', { username: process.env.SB_USER || 'admin', password: process.env.SB_PASSWORD || 'admin-password-123' });
  before = await api('GET', '/settings');
  await api('PUT', '/settings', { telegram_token: '123:fake', telegram_chat_id: '111222333', billing_reminders: 1, billing_remind_days: '7, 3,1,0', billing_overdue_daily: 1, billing_remind_hour: 0 });
  const s = await api('GET', '/settings');
  check(s.billing_remind_days === '7,3,1,0', `reminder days saved as "${s.billing_remind_days}"`);
  let rejected = false;
  await api('PUT', '/settings', { billing_remind_days: 'soon' }).catch(() => (rejected = true));
  check(rejected, 'bad reminder days are refused');
});

await step('add fake servers with billing info', async () => {
  for (const n of ['soon', 'late', 'auto', 'far']) {
    const s = await api('POST', '/servers', { name: `${TAG}-${n}`, ip: '203.0.113.50', ssh_host: '127.0.0.1', ssh_port: 1, auth_type: 'password', ssh_password: 'x' });
    ids[n] = s.id;
  }
  today = (await api('GET', '/billing')).today;
  const hz = await api('PUT', `/servers/${ids.soon}/billing`, { provider: 'Hetzner', provider_url: 'https://accounts.hetzner.com/invoice', price: '30', currency: 'eur', cycle_months: 3, due_date: addDays(today, 2) });
  check(hz.days_left === 2 && hz.monthly === 10 && hz.currency === 'EUR', `soon: due in ${hz.days_left} days, ${hz.monthly} EUR/month`);
  await api('PUT', `/servers/${ids.late}/billing`, { provider: 'DigitalOcean', provider_url: 'https://cloud.digitalocean.com/account/billing', price: 12, currency: 'USD', cycle_months: 1, due_date: addDays(today, -3) });
  await api('PUT', `/servers/${ids.auto}/billing`, { provider: 'Vultr', price: 6, currency: 'USD', cycle_months: 1, due_date: addDays(today, -1), auto_renew: true });
  await api('PUT', `/servers/${ids.far}/billing`, { provider: 'Home', price: 5, currency: 'USD', cycle_months: 12, due_date: addDays(today, 40) });
  let bad = 0;
  for (const body of [{ due_date: '2026-02-30' }, { price: 'abc' }, { provider_url: 'javascript:alert(1)' }, { currency: 'dollars' }]) {
    await api('PUT', `/servers/${ids.far}/billing`, { due_date: addDays(today, 40), ...body }).catch(() => bad++);
  }
  check(bad === 4, 'bad date / price / link / currency are refused');
});

await step('overview: alerts, badges, upcoming payments', async () => {
  const o = await api('GET', '/overview');
  const mine = o.alerts.filter((a) => a.message.includes(TAG) && /payment|renews/.test(a.message)); // (the fake servers are also "unreachable over SSH")
  check(mine.some((a) => a.level === 'error' && /late.*OVERDUE by 3 days/.test(a.message)), 'overdue server is a critical problem');
  check(mine.some((a) => a.level === 'warn' && /soon.*due in 2 days/.test(a.message)), 'due in 2 days is a warning');
  check(!mine.some((a) => a.message.includes(`${TAG}-auto`) && a.level !== 'info'), 'auto-renew is not a problem');
  check(!mine.some((a) => a.message.includes(`${TAG}-far`)), 'payment in 40 days is not listed');
  const srv = o.servers.find((s) => s.id === ids.soon);
  check(srv.billing?.days_left === 2, 'server list carries the due badge data');
  check(o.billing.count >= 4 && o.billing.totals.EUR >= 10, `monthly totals ${JSON.stringify(o.billing.totals)}`);
});

await step('reminders go out once', async () => {
  const r = await api('POST', '/billing/check');
  check(r.sent >= 2, `${r.sent} reminders sent (other servers on this dashboard may add more)`);
  const msgs = await telegramAtLeast(3);
  check(msgs.some((m) => /due in 2 days/.test(m.text) && m.text.includes(`${TAG}-soon (Hetzner)`) && m.text.includes('https://accounts.hetzner.com/invoice')), 'reminder "due in 2 days" with the Hetzner link');
  check(msgs.some((m) => /OVERDUE by 3 days/.test(m.text) && m.text.includes(`${TAG}-late`)), 'overdue reminder');
  check(msgs.some((m) => m.text.includes(`${TAG}-auto`) && /renewed automatically/.test(m.text)), 'auto-renew heads-up');
  check(!msgs.some((m) => m.text.includes(`${TAG}-far`)), 'nothing for the payment in 40 days');
  check(r.renewed >= 1, `auto-renew rolled forward (${r.renewed})`);
  const auto = (await api('GET', `/servers/${ids.auto}/billing`)).billing;
  check(auto.due_date === addMonthsSimple(addDays(today, -1), 1), `auto-renew next date ${auto.due_date}`);
  const n = msgs.length;
  const again = await api('POST', '/billing/check');
  await sleep(1000);
  check(again.sent === 0 && again.renewed === 0 && (await telegram()).length === n, 'second check sends nothing new');
});

await step('mark as paid moves the date and keeps history', async () => {
  const due = addDays(today, 2);
  const r = await api('POST', `/servers/${ids.soon}/billing/paid`, { note: 'invoice 42' });
  check(r.from === due && r.to === addMonthsSimple(due, 3), `paid ${r.from} → ${r.to}`);
  const b = await api('GET', `/servers/${ids.soon}/billing`);
  check(b.payments.length === 1 && b.payments[0].amount === 30 && b.payments[0].user === 'admin' && b.payments[0].note === 'invoice 42', 'payment recorded (30 EUR, by admin)');
  const all = await api('GET', '/billing');
  check(all.payments.some((p) => p.server_id === ids.soon), 'payment shows on the Billing page');
  const o = await api('GET', '/overview');
  check(!o.alerts.some((a) => a.message.includes(`${TAG}-soon:`) && /payment/.test(a.message)), 'no more payment alert after paying');
  const d = await api('DELETE', `/payments/${b.payments[0].id}`);
  check(d.reverted_to === due, 'deleting the payment puts the date back');
});

await step('only admins may change billing', async () => {
  const user = `${TAG}v`;
  const u = await api('POST', '/users', { username: user, password: 'viewer-password-123', role: 'viewer' });
  ids.user = u.id;
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard' }, body: JSON.stringify({ username: user, password: 'viewer-password-123' }) });
  const jar = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('sb_session='))?.split(';')[0] || '';
  let status = 0;
  await api('POST', `/servers/${ids.late}/billing/paid`, {}, jar).catch((e) => (status = e.status));
  check(status === 403, 'viewer cannot mark as paid');
  const view = await api('GET', '/billing', undefined, jar);
  check(Array.isArray(view.items), 'viewer can look at the Billing page');
});

function addMonthsSimple(date, months) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const dim = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
}

await step('clean up', async () => {
  for (const n of ['soon', 'late', 'auto', 'far']) if (ids[n]) await api('DELETE', `/servers/${ids[n]}`);
  if (ids.user) await api('DELETE', `/users/${ids.user}`);
  await api('PUT', '/settings', { telegram_chat_id: before.telegram_chat_id || '', billing_remind_days: before.billing_remind_days, billing_remind_hour: before.billing_remind_hour, ...(before.has_telegram_token ? {} : { clear_telegram_token: true }) });
  check(!(await api('GET', '/billing')).items.some((b) => b.server_name.startsWith(TAG)), 'test servers and their billing removed');
});

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all billing checks passed');
process.exit(failures ? 1 : 0);

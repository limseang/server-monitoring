/**
 * Server billing: date math and "which reminder is due" — plain functions, no database,
 * so they are easy to test (test/billing.test.js).
 *
 * Dates are plain 'YYYY-MM-DD' strings in Switchboard's own time zone (TZ of the container).
 */

/** Common hosting providers and where to pay / see invoices. The user can change the link. */
export const PROVIDERS = [
  { id: 'digitalocean', name: 'DigitalOcean', url: 'https://cloud.digitalocean.com/account/billing' },
  { id: 'hetzner', name: 'Hetzner', url: 'https://accounts.hetzner.com/invoice' },
  { id: 'vultr', name: 'Vultr', url: 'https://my.vultr.com/billing/' },
  { id: 'linode', name: 'Linode / Akamai', url: 'https://cloud.linode.com/account/billing' },
  { id: 'aws', name: 'AWS', url: 'https://console.aws.amazon.com/billing/home' },
  { id: 'gcp', name: 'Google Cloud', url: 'https://console.cloud.google.com/billing' },
  { id: 'azure', name: 'Microsoft Azure', url: 'https://portal.azure.com/#view/Microsoft_Azure_GTM/ModernBillingMenuBlade' },
  { id: 'contabo', name: 'Contabo', url: 'https://my.contabo.com/' },
  { id: 'ovh', name: 'OVHcloud', url: 'https://www.ovh.com/manager/' },
  { id: 'scaleway', name: 'Scaleway', url: 'https://console.scaleway.com/billing/' },
  { id: 'home', name: 'Home / own hardware', url: '' },
];

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'KHR', 'THB', 'SGD', 'JPY', 'AUD', 'CAD', 'INR', 'VND'];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');

export function isDate(s) {
  const m = DATE_RE.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Today (or the given moment) as YYYY-MM-DD in the local time zone. */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const utc = (s) => {
  const m = DATE_RE.exec(s);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
};

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / 864e5);

const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/**
 * Add whole months. `anchorDay` is the day of the month the bill normally falls on, so
 * Jan 31 → Feb 28 → Mar 31 (and not Mar 28).
 */
export function addMonths(date, months, anchorDay) {
  const m = DATE_RE.exec(date);
  let y = +m[1];
  let mo = +m[2] - 1 + Number(months || 0);
  y += Math.floor(mo / 12);
  mo = ((mo % 12) + 12) % 12;
  const want = anchorDay || +m[3];
  return `${y}-${pad(mo + 1)}-${pad(Math.min(want, daysInMonth(y, mo)))}`;
}

/** "7,3,1,0" → [7, 3, 1, 0] (largest first, unique, 0–365). */
export function parseRemindDays(v) {
  const list = String(v ?? '')
    .split(/[\s,;]+/)
    .filter((x) => /^\d+$/.test(x))
    .map(Number)
    .filter((n) => n <= 365);
  return [...new Set(list)].sort((a, b) => b - a);
}

export const monthlyCost = (b) => (b.price > 0 ? b.price / Math.max(1, Number(b.cycle_months) || 1) : 0);

export function money(amount, currency) {
  if (amount === null || amount === undefined || amount === '') return '';
  const n = Number(amount);
  return `${n.toFixed(Number.isInteger(n) && n >= 1000 ? 0 : 2)} ${currency || ''}`.trim();
}

export function prettyDate(s) {
  if (!isDate(s)) return s || '';
  return new Date(utc(s)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function dueText(days) {
  if (days === null || days === undefined) return '';
  if (days < 0) return `OVERDUE by ${-days} day${days === -1 ? '' : 's'}`;
  if (days === 0) return 'due TODAY';
  if (days === 1) return 'due tomorrow';
  return `due in ${days} days`;
}

/** Parse the remembered-reminders column; it is reset when the due date changes. */
export function reminderState(b) {
  let st = {};
  try {
    st = JSON.parse(b.reminded || '{}') || {};
  } catch {}
  if (st.due !== b.due_date) st = { due: b.due_date, sent: [] };
  if (!Array.isArray(st.sent)) st.sent = [];
  return st;
}

/**
 * What to do for one server's bill today.
 *   b: billing row (+ server_name); today: 'YYYY-MM-DD'; opts: { days: [7,3,1,0], overdueDaily }
 * Returns null (nothing to do), { renew: true } (auto-renew date passed → move it forward),
 * or { level, text, state } — send `text`, then save `state` so it is never sent twice.
 */
export function decideReminder(b, today, { days = [7, 3, 1, 0], overdueDaily = true } = {}) {
  if (!b?.due_date || !isDate(b.due_date) || !days.length) return null;
  const left = daysBetween(today, b.due_date);
  const st = reminderState(b);
  const who = `${b.server_name}${b.provider ? ` (${b.provider})` : ''}`;
  const price = b.price ? ` — ${money(b.price, b.currency)}` : '';
  const pay = b.provider_url ? `\nPay / check: ${b.provider_url}` : '';
  if (left < 0) {
    if (b.auto_renew) return { renew: true };
    if (st.overdue_on === today || (!overdueDaily && st.overdue_on)) return null;
    return {
      level: 'error',
      text: `💳 Server payment ${dueText(left)}: ${who}${price}, was due ${prettyDate(b.due_date)}. Pay it, then press "Mark as paid" in Switchboard.${pay}`,
      state: { ...st, overdue_on: today },
    };
  }
  const reached = days.filter((t) => left <= t);
  if (!reached.length) return null;
  const sent = new Set(st.sent);
  if (b.auto_renew) {
    // softer: one heads-up only, so you can check the card on file has money
    if (sent.size) return null;
    return {
      level: 'info',
      text: `💳 ${who} renews automatically ${left === 0 ? 'TODAY' : left === 1 ? 'tomorrow' : `in ${left} days`} (${prettyDate(b.due_date)})${price}. Make sure the card on file can pay.${pay}`,
      state: { ...st, sent: [...new Set([...sent, ...reached])] },
    };
  }
  const t = Math.min(...reached);
  if (sent.has(t)) return null;
  return {
    level: left <= 1 ? 'warn' : 'info',
    text: `💳 Server payment ${dueText(left)}: ${who}${price}, due ${prettyDate(b.due_date)}.${pay}`,
    // everything up to today counts as sent: after downtime you get one message, not three
    state: { ...st, sent: [...new Set([...sent, ...reached])] },
  };
}

/** Next due date after paying `months` from the current due date (or today when none is set). */
export function nextDue(b, months, today) {
  const from = b?.due_date && isDate(b.due_date) ? b.due_date : today;
  return { from, to: addMonths(from, months, b?.anchor_day || undefined) };
}

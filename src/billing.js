import { all, get, run, insert, now, tx } from './db.js';
import { getSetting } from './settings.js';
import { alert, logEvent } from './events.js';
import { bus } from './bus.js';
import { localDate, daysBetween, isDate, monthlyCost, parseRemindDays, decideReminder, nextDue, prettyDate, money } from './billingcalc.js';

const ROWS_SQL = `SELECT b.*, s.name AS server_name, s.ip AS server_ip FROM billing b JOIN servers s ON s.id = b.server_id`;

export const getBilling = (serverId) => get(`${ROWS_SQL} WHERE b.server_id = ?`, serverId);

/** Billing row for the browser, with days left and the cost per month. */
export function billingPublic(b, today = localDate()) {
  if (!b) return null;
  const { reminded, ...rest } = b;
  return {
    ...rest,
    auto_renew: !!b.auto_renew,
    days_left: b.due_date && isDate(b.due_date) ? daysBetween(today, b.due_date) : null,
    monthly: monthlyCost(b),
  };
}

export function allBilling(today = localDate()) {
  return all(`${ROWS_SQL} ORDER BY b.due_date IS NULL, b.due_date, s.name`).map((b) => billingPublic(b, today));
}

/** Total cost per month, per currency: { USD: 24.5, EUR: 8 } */
export function monthlyTotals(items) {
  const out = {};
  for (const b of items) {
    if (!(b.price > 0)) continue;
    out[b.currency] = Math.round(((out[b.currency] || 0) + monthlyCost(b)) * 100) / 100;
  }
  return out;
}

/** Map server id → short billing summary (for server cards and the overview). */
export function billingByServer(today = localDate()) {
  const map = new Map();
  for (const b of allBilling(today)) map.set(b.server_id, { provider: b.provider, provider_url: b.provider_url, due_date: b.due_date, days_left: b.days_left, auto_renew: b.auto_renew, price: b.price, currency: b.currency, cycle_months: b.cycle_months });
  return map;
}

export const remindDays = () => parseRemindDays(getSetting('billing_remind_days'));

export function paymentsOf(serverId, limit = 50) {
  return all('SELECT * FROM payments WHERE server_id = ? ORDER BY paid_on DESC, id DESC LIMIT ?', serverId, limit);
}

export function recentPayments(limit = 100) {
  return all('SELECT p.*, s.name AS server_name FROM payments p JOIN servers s ON s.id = p.server_id ORDER BY p.paid_on DESC, p.id DESC LIMIT ?', limit);
}

/**
 * Record a payment and move the due date forward.
 * p: { paid_on, amount, currency, months, note, due_date (override), user }
 */
export function recordPayment(serverId, p) {
  const b = getBilling(serverId);
  if (!b) throw new Error('Add billing info for this server first');
  const today = localDate();
  const months = p.months || b.cycle_months || 1;
  const { from, to: computed } = nextDue(b, months, today);
  const to = p.due_date || computed;
  const id = tx(() => {
    const pid = insert('payments', {
      server_id: serverId,
      paid_on: p.paid_on || today,
      amount: p.amount ?? b.price ?? null,
      currency: p.currency || b.currency,
      months,
      period_from: from,
      period_to: to,
      user: p.user || null,
      note: p.note || null,
      created_at: now(),
    });
    run('UPDATE billing SET due_date = ?, reminded = NULL, updated_at = ? WHERE server_id = ?', to, now(), serverId);
    return pid;
  });
  bus.emit('state', { serverId });
  return { id, from, to };
}

/** Delete a payment. If it was the last one and nothing changed since, the due date goes back. */
export function deletePayment(id) {
  const p = get('SELECT * FROM payments WHERE id = ?', id);
  if (!p) return null;
  const b = getBilling(p.server_id);
  const last = get('SELECT id FROM payments WHERE server_id = ? ORDER BY id DESC LIMIT 1', p.server_id);
  const revert = !!(b && last?.id === p.id && p.period_from && b.due_date === p.period_to);
  tx(() => {
    run('DELETE FROM payments WHERE id = ?', id);
    if (revert) run('UPDATE billing SET due_date = ?, reminded = NULL, updated_at = ? WHERE server_id = ?', p.period_from, now(), p.server_id);
  });
  bus.emit('state', { serverId: p.server_id });
  return { ...p, reverted_to: revert ? p.period_from : null };
}

/**
 * The reminder check (runs every hour). Sends each reminder once per due date through the
 * normal alerts (Telegram / webhook). force = ignore the "not before" hour (Check now button).
 */
export function checkBilling({ force = false, at = new Date() } = {}) {
  const out = { sent: 0, renewed: 0 };
  if (!getSetting('billing_reminders') && !force) return out;
  const today = localDate(at);
  const hourOk = force || at.getHours() >= (Number(getSetting('billing_remind_hour')) || 0);
  const opts = { days: remindDays(), overdueDaily: !!getSetting('billing_overdue_daily') };
  for (const b of all(ROWS_SQL)) {
    const r = decideReminder(b, today, opts);
    if (!r) continue;
    const ctx = { serverId: b.server_id, link: `#/servers/${b.server_id}` };
    if (r.renew) {
      // auto-renew: the provider charges by itself — roll the date forward (one or more periods)
      let due = b.due_date;
      for (let i = 0; i < 120 && daysBetween(today, due) < 0; i++) {
        due = recordPayment(b.server_id, { user: 'auto-renew', note: 'Renewed automatically (assumed paid — check the invoice)' }).to;
      }
      out.renewed++;
      const msg = `💳 ${b.server_name}${b.provider ? ` (${b.provider})` : ''} renewed automatically${b.price ? ` — ${money(b.price, b.currency)}` : ''}. Next payment ${prettyDate(due)}.${b.provider_url ? `\nCheck the invoice: ${b.provider_url}` : ''}`;
      if (hourOk) alert('info', msg, ctx);
      else logEvent('info', msg, ctx);
      continue;
    }
    if (!hourOk) continue;
    alert(r.level, r.text, ctx);
    run('UPDATE billing SET reminded = ? WHERE server_id = ?', JSON.stringify(r.state), b.server_id);
    out.sent++;
  }
  return out;
}

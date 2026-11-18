// Unit tests for server billing date math and reminders:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, daysBetween, isDate, parseRemindDays, decideReminder, nextDue, monthlyCost } from '../src/billingcalc.js';

test('dates', () => {
  assert.equal(isDate('2026-02-29'), false);
  assert.equal(isDate('2028-02-29'), true);
  assert.equal(isDate('2026-1-01'), false);
  assert.equal(daysBetween('2026-11-18', '2026-11-25'), 7);
  assert.equal(daysBetween('2026-11-18', '2026-11-16'), -2);
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2); // across a DST change
});

test('addMonths keeps the billing day', () => {
  assert.equal(addMonths('2026-01-15', 1), '2026-02-15');
  assert.equal(addMonths('2026-01-31', 1, 31), '2026-02-28');
  assert.equal(addMonths('2026-02-28', 1, 31), '2026-03-31');
  assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(addMonths('2026-12-05', 12), '2027-12-05');
  assert.equal(addMonths('2026-10-10', 6), '2027-04-10');
});

test('reminder days setting', () => {
  assert.deepEqual(parseRemindDays('7, 3,1,0'), [7, 3, 1, 0]);
  assert.deepEqual(parseRemindDays('1 14 1 x 999'), [14, 1]);
  assert.deepEqual(parseRemindDays(''), []);
});

test('cost per month', () => {
  assert.equal(monthlyCost({ price: 30, cycle_months: 3 }), 10);
  assert.equal(monthlyCost({ price: null, cycle_months: 1 }), 0);
});

test('mark as paid moves the due date by the cycle', () => {
  assert.deepEqual(nextDue({ due_date: '2026-11-20', anchor_day: 20 }, 3, '2026-11-18'), { from: '2026-11-20', to: '2027-02-20' });
  assert.deepEqual(nextDue({ due_date: null }, 1, '2026-11-18'), { from: '2026-11-18', to: '2026-12-18' });
});

const bill = (extra = {}) => ({ server_name: 'web-1', provider: 'Hetzner', provider_url: 'https://accounts.hetzner.com/invoice', price: 12, currency: 'EUR', due_date: '2026-11-25', reminded: null, auto_renew: 0, ...extra });
const opts = { days: [7, 3, 1, 0], overdueDaily: true };

test('each reminder is sent once per due date', () => {
  // 10 days before: nothing yet
  assert.equal(decideReminder(bill(), '2026-11-15', opts), null);
  // 7 days before
  const r7 = decideReminder(bill(), '2026-11-18', opts);
  assert.equal(r7.level, 'info');
  assert.match(r7.text, /due in 7 days.*web-1 \(Hetzner\).*12\.00 EUR/s);
  assert.match(r7.text, /accounts\.hetzner\.com/);
  const after7 = bill({ reminded: JSON.stringify(r7.state) });
  // same day again, and 5 days before: already sent
  assert.equal(decideReminder(after7, '2026-11-18', opts), null);
  assert.equal(decideReminder(after7, '2026-11-20', opts), null);
  // 3 days before
  const r3 = decideReminder(after7, '2026-11-22', opts);
  assert.match(r3.text, /due in 3 days/);
  // Switchboard was off for days → only ONE message (due today), not 1 + 0
  const r0 = decideReminder(bill({ reminded: JSON.stringify(r3.state) }), '2026-11-25', opts);
  assert.equal(r0.level, 'warn');
  assert.match(r0.text, /due TODAY/);
  assert.equal(decideReminder(bill({ reminded: JSON.stringify(r0.state) }), '2026-11-25', opts), null);
});

test('overdue: once a day, or once only', () => {
  const r = decideReminder(bill(), '2026-11-27', opts);
  assert.equal(r.level, 'error');
  assert.match(r.text, /OVERDUE by 2 days/);
  const st = JSON.stringify(r.state);
  assert.equal(decideReminder(bill({ reminded: st }), '2026-11-27', opts), null);
  assert.ok(decideReminder(bill({ reminded: st }), '2026-11-28', opts));
  assert.equal(decideReminder(bill({ reminded: st }), '2026-11-28', { ...opts, overdueDaily: false }), null);
});

test('a new due date starts fresh reminders', () => {
  const r7 = decideReminder(bill(), '2026-11-18', opts);
  const moved = bill({ due_date: '2026-12-25', reminded: JSON.stringify(r7.state) });
  assert.match(decideReminder(moved, '2026-12-18', opts).text, /due in 7 days/);
});

test('auto-renew: one soft heads-up, then the date rolls forward', () => {
  const r = decideReminder(bill({ auto_renew: 1 }), '2026-11-18', opts);
  assert.equal(r.level, 'info');
  assert.match(r.text, /renews automatically in 7 days/);
  assert.equal(decideReminder(bill({ auto_renew: 1, reminded: JSON.stringify(r.state) }), '2026-11-24', opts), null);
  assert.deepEqual(decideReminder(bill({ auto_renew: 1 }), '2026-11-26', opts), { renew: true });
});

test('no date or no reminder days: nothing', () => {
  assert.equal(decideReminder(bill({ due_date: null }), '2026-11-18', opts), null);
  assert.equal(decideReminder(bill(), '2026-11-25', { days: [] }), null);
});

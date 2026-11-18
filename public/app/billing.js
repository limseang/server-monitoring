import { ref, reactive, computed, watch, onMounted } from '/vendor/vue.js';
import { store, http, toast, openDialog, closeDialog, confirmBox } from './lib.js';
import { Modal } from './components.js';

/* ------------------------------------------------------------------ helpers */
export const CYCLES = [
  [1, 'Every month'],
  [3, 'Every 3 months'],
  [6, 'Every 6 months'],
  [12, 'Every year'],
];
export const cycleText = (m) => (CYCLES.find((c) => c[0] === Number(m)) || [0, `Every ${m} months`])[1];
export const money = (n, cur) => (n === null || n === undefined || n === '' ? '—' : `${Number(n).toFixed(2)} ${cur || ''}`.trim());
export function dueLabel(days) {
  if (days === null || days === undefined) return 'no date';
  if (days < 0) return `overdue ${-days}d`;
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return `due in ${days}d`;
}
export function dueClass(days, autoRenew) {
  if (days === null || days === undefined) return 'badge-gray';
  if (days < 0) return autoRenew ? 'badge-amber' : 'badge-red';
  if (days <= 3) return autoRenew ? 'badge-blue' : 'badge-amber';
  if (days <= 7) return 'badge-blue';
  return 'badge-gray';
}
export const dateText = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function addMonths(date, months, anchor) {
  const [y0, m0, d0] = date.split('-').map(Number);
  let mo = m0 - 1 + Number(months || 0);
  const y = y0 + Math.floor(mo / 12);
  mo = ((mo % 12) + 12) % 12;
  const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(Math.min(anchor || d0, dim)).padStart(2, '0')}`;
}
export const totalsText = (t) => Object.entries(t || {}).map(([c, v]) => money(v, c)).join(' + ') || '—';

/** Small "due in 5d" badge for server cards and lists. */
export const DueBadge = {
  props: { billing: Object },
  setup: () => ({ dueLabel, dueClass }),
  template: `<span v-if="billing && billing.days_left !== null && billing.days_left !== undefined" class="badge" :class="dueClass(billing.days_left, billing.auto_renew)" :title="'Next payment ' + billing.due_date + (billing.auto_renew ? ' (auto-renew)' : '')">💳 {{ dueLabel(billing.days_left) }}</span>`,
};

/* ------------------------------------------------------------------ edit billing */
export const BillingDialog = {
  props: { server: Object, billing: Object, onDone: Function },
  components: { Modal },
  setup(props) {
    const b = props.billing;
    const meta = ref({ providers: [], currencies: [] });
    const f = reactive({
      provider: b?.provider || '',
      provider_url: b?.provider_url || '',
      price: b?.price ?? '',
      currency: b?.currency || 'USD',
      cycle_months: b?.cycle_months || 1,
      due_date: b?.due_date || '',
      auto_renew: !!b?.auto_renew,
      notes: b?.notes || '',
    });
    const preset = ref('');
    const custom = ref(![1, 3, 6, 12].includes(Number(f.cycle_months)));
    const saving = ref(false);
    onMounted(async () => {
      meta.value = await http.get(`/servers/${props.server.id}/billing`).catch(() => meta.value);
      const p = meta.value.providers.find((x) => x.name === f.provider);
      preset.value = p ? p.id : f.provider ? 'custom' : '';
    });
    function pick(id) {
      preset.value = id;
      const p = meta.value.providers.find((x) => x.id === id);
      if (!p) return;
      const oldPreset = meta.value.providers.find((x) => x.url && x.url === f.provider_url);
      f.provider = p.name;
      if (!f.provider_url || oldPreset) f.provider_url = p.url;
    }
    async function save() {
      saving.value = true;
      try {
        await http.put(`/servers/${props.server.id}/billing`, f);
        toast('Billing saved', 'success');
        store.live++;
        props.onDone?.();
        closeDialog();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        saving.value = false;
      }
    }
    async function remove() {
      if (!(await confirmBox({ title: `Remove billing of ${props.server.name}?`, message: 'No more payment reminders for this server. The payment history is kept.', confirmText: 'Remove', danger: true }))) return;
      try {
        await http.del(`/servers/${props.server.id}/billing`);
        store.live++;
        props.onDone?.();
        closeDialog();
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    return { s: props.server, b, f, meta, preset, custom, saving, pick, save, remove, closeDialog, CYCLES };
  },
  template: `
  <modal :title="(b ? 'Edit billing — ' : 'Add billing — ') + s.name" size="md" @close="closeDialog">
    <div class="form">
      <div class="field"><label>Provider</label>
        <div class="row gap-6 wrap">
          <button v-for="p in meta.providers" :key="p.id" type="button" class="btn btn-sm" :class="preset === p.id ? 'btn-primary' : ''" @click="pick(p.id)">{{ p.name }}</button>
          <button type="button" class="btn btn-sm" :class="preset === 'custom' ? 'btn-primary' : ''" @click="preset = 'custom'">Other…</button>
        </div>
      </div>
      <div class="form-row">
        <div class="field"><label>Provider name</label><input v-model="f.provider" placeholder="e.g. DigitalOcean"></div>
        <div class="field"><label>Billing / panel link</label><input v-model="f.provider_url" class="code" placeholder="https://…"><span class="hint">Opens with one click to pay or check invoices.</span></div>
      </div>
      <div class="form-row-3">
        <div class="field"><label>Price</label><input v-model="f.price" inputmode="decimal" placeholder="12.00"></div>
        <div class="field"><label>Currency</label><input v-model="f.currency" list="sb-currencies" class="code" maxlength="3" style="text-transform:uppercase"><datalist id="sb-currencies"><option v-for="c in meta.currencies" :key="c" :value="c" /></datalist></div>
        <div class="field"><label>Paid</label>
          <select v-if="!custom" :value="f.cycle_months" @change="$event.target.value === 'x' ? (custom = true) : (f.cycle_months = Number($event.target.value))">
            <option v-for="c in CYCLES" :key="c[0]" :value="c[0]">{{ c[1] }}</option><option value="x">Custom…</option>
          </select>
          <div v-else class="row gap-6"><span class="small muted">every</span><input type="number" min="1" max="60" v-model.number="f.cycle_months" style="width:80px"><span class="small muted">months</span></div>
        </div>
      </div>
      <div class="form-row">
        <div class="field"><label>Next payment date <span class="muted">(paid until)</span></label><input type="date" v-model="f.due_date"><span class="hint">You get reminders before this day.</span></div>
        <div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" v-model="f.auto_renew"><span class="check-text"><b>Renews automatically</b><span class="hint">The provider charges your card by itself: you get one gentle heads-up, and the date moves forward by itself.</span></span></label></div>
      </div>
      <div class="field"><label>Notes</label><textarea v-model="f.notes" rows="2" placeholder="Account email, plan name, card used…"></textarea></div>
    </div>
    <template #footer>
      <button v-if="b" class="btn btn-ghost btn-danger" @click="remove">Remove billing</button>
      <span class="grow"></span>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="save" :disabled="saving">Save</button>
    </template>
  </modal>`,
};

/* ------------------------------------------------------------------ mark as paid */
export const PaidDialog = {
  props: { server: Object, billing: Object, onDone: Function },
  components: { Modal },
  setup(props) {
    const b = props.billing;
    const today = todayStr();
    const from = b.due_date || today;
    const f = reactive({ paid_on: today, amount: b.price ?? '', currency: b.currency || 'USD', months: b.cycle_months || 1, note: '', due_date: '' });
    const next = computed(() => f.due_date || addMonths(from, f.months, b.anchor_day));
    watch(() => f.months, () => (f.due_date = ''));
    const saving = ref(false);
    async function save() {
      saving.value = true;
      try {
        const r = await http.post(`/servers/${props.server.id}/billing/paid`, { ...f, due_date: f.due_date || undefined });
        toast(`Payment saved — next payment ${dateText(r.to)}`, 'success');
        store.live++;
        props.onDone?.();
        closeDialog();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        saving.value = false;
      }
    }
    return { s: props.server, b, f, from, next, saving, save, closeDialog, dateText, cycleText };
  },
  template: `
  <modal :title="'Mark as paid — ' + s.name" size="sm" @close="closeDialog">
    <div class="form">
      <div class="form-row">
        <div class="field"><label>Paid on</label><input type="date" v-model="f.paid_on"></div>
        <div class="field"><label>Months paid</label><input type="number" min="1" max="60" v-model.number="f.months"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Amount</label><input v-model="f.amount" inputmode="decimal"></div>
        <div class="field"><label>Currency</label><input v-model="f.currency" class="code" maxlength="3" style="text-transform:uppercase"></div>
      </div>
      <div class="field"><label>Note <span class="muted">(optional)</span></label><input v-model="f.note" placeholder="Invoice number, card…"></div>
      <div class="result ok">Paid period {{ dateText(from) }} → {{ dateText(next) }}. Next reminder before <b>{{ dateText(next) }}</b>.</div>
      <details><summary class="small muted" style="cursor:pointer">Pick another next payment date</summary>
        <div class="field mt-8"><input type="date" v-model="f.due_date"></div></details>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="save" :disabled="saving">Save payment</button>
    </template>
  </modal>`,
};

/* ------------------------------------------------------------------ payment history table */
export const PaymentsTable = {
  props: { payments: Array, showServer: Boolean },
  emits: ['changed'],
  setup(props, { emit }) {
    async function del(p) {
      if (!(await confirmBox({ title: 'Delete this payment?', message: `${money(p.amount, p.currency)} paid on ${p.paid_on}. If it is the latest payment, the next payment date goes back to ${p.period_from}.`, confirmText: 'Delete', danger: true }))) return;
      try {
        const r = await http.del(`/payments/${p.id}`);
        toast(r.reverted_to ? `Deleted — next payment back to ${dateText(r.reverted_to)}` : 'Payment deleted', 'success');
        store.live++;
        emit('changed');
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    return { del, money, dateText };
  },
  template: `
  <div class="card table-wrap">
    <table class="table" v-if="payments && payments.length">
      <thead><tr><th>Paid on</th><th v-if="showServer">Server</th><th>Amount</th><th>Period</th><th>By</th><th>Note</th><th></th></tr></thead>
      <tbody><tr v-for="p in payments" :key="p.id">
        <td>{{ dateText(p.paid_on) }}</td>
        <td v-if="showServer"><a :href="'#/servers/' + p.server_id">{{ p.server_name }}</a></td>
        <td class="strong">{{ money(p.amount, p.currency) }}</td>
        <td class="small">{{ p.months }} mo<span class="muted" v-if="p.period_from"> · {{ p.period_from }} → {{ p.period_to }}</span></td>
        <td class="small muted">{{ p.user || '—' }}</td>
        <td class="small">{{ p.note || '' }}</td>
        <td class="actions"><button class="admin-only btn btn-xs btn-danger" @click="del(p)">Delete</button></td>
      </tr></tbody>
    </table>
    <div v-else class="empty">No payments recorded yet.</div>
  </div>`,
};

/* ------------------------------------------------------------------ billing card on the server page */
export const BillingCard = {
  props: { server: Object },
  components: { PaymentsTable, DueBadge },
  setup(props) {
    const data = ref(null);
    const showHistory = ref(false);
    const load = async () => (data.value = await http.get(`/servers/${props.server.id}/billing`).catch(() => null));
    onMounted(load);
    watch(() => store.live, load);
    const b = computed(() => data.value?.billing);
    const edit = () => openDialog('billing', { server: props.server, billing: b.value, onDone: load });
    const paid = () => openDialog('billing-paid', { server: props.server, billing: b.value, onDone: load });
    return { data, b, showHistory, load, edit, paid, money, cycleText, dateText, dueLabel };
  },
  template: `
  <section class="section" v-if="data">
    <div class="section-head"><h2>Billing</h2>
      <div class="row gap-6" v-if="b">
        <a v-if="b.provider_url" class="btn btn-sm" :href="b.provider_url" target="_blank" rel="noopener noreferrer">Open {{ b.provider || 'provider' }} ↗</a>
        <button class="admin-only btn btn-sm btn-primary" @click="paid">Mark as paid</button>
        <button class="admin-only btn btn-sm" @click="edit">Edit billing</button>
      </div>
    </div>
    <div v-if="!b" class="empty-card"><p class="muted">Rented server? Save when it must be paid and get a Telegram reminder before the due date.</p><button class="admin-only btn" @click="edit">+ Add billing info</button></div>
    <template v-else>
      <div class="tiles">
        <div class="tile" :class="{ 'tile-bad': b.days_left !== null && b.days_left < 0 && !b.auto_renew }">
          <div class="tile-label">Next payment</div>
          <div class="tile-value" style="font-size:20px">{{ b.due_date ? dateText(b.due_date) : 'not set' }}</div>
          <div class="tile-sub" :class="b.days_left !== null && b.days_left < 0 ? 'text-red' : b.days_left !== null && b.days_left <= 3 ? 'text-amber' : ''">{{ dueLabel(b.days_left) }}{{ b.auto_renew ? ' · auto-renew' : '' }}</div>
        </div>
        <div class="tile"><div class="tile-label">Price</div><div class="tile-value" style="font-size:20px">{{ money(b.price, b.currency) }}</div><div class="tile-sub">{{ cycleText(b.cycle_months) }}<template v-if="b.cycle_months > 1 && b.price"> · {{ money(b.monthly, b.currency) }}/month</template></div></div>
        <div class="tile"><div class="tile-label">Provider</div><div class="strong mt-8">{{ b.provider || '—' }}</div><div class="tile-sub ellipsis" v-if="b.provider_url"><a :href="b.provider_url" target="_blank" rel="noopener noreferrer">{{ b.provider_url.replace(/^https?:\\/\\//, '') }}</a></div></div>
        <div class="tile"><div class="tile-label">Payments recorded</div><div class="tile-value" style="font-size:20px">{{ data.payments.length }}</div><div class="tile-sub"><button class="link-btn" @click="showHistory = !showHistory">{{ showHistory ? 'Hide' : 'Show' }} history</button></div></div>
      </div>
      <div v-if="b.notes" class="muted small mt-8" style="white-space:pre-wrap">{{ b.notes }}</div>
      <div v-if="showHistory" class="mt-12"><payments-table :payments="data.payments" @changed="load" /></div>
    </template>
  </section>`,
};

/* ------------------------------------------------------------------ Billing page (all servers) */
export const BillingPage = {
  components: { PaymentsTable, DueBadge },
  setup() {
    const data = ref(null);
    const checking = ref(false);
    const load = async () => (data.value = await http.get('/billing').catch((e) => (toast(e.message, 'error'), null)));
    onMounted(load);
    watch(() => store.live, load);
    const edit = (row) => openDialog('billing', { server: { id: row.server_id ?? row.id, name: row.server_name ?? row.name }, billing: row.server_id ? row : null, onDone: load });
    const paid = (row) => openDialog('billing-paid', { server: { id: row.server_id, name: row.server_name }, billing: row, onDone: load });
    async function checkNow() {
      checking.value = true;
      try {
        const r = await http.post('/billing/check');
        toast(r.sent || r.renewed ? `Sent ${r.sent} reminder(s)${r.renewed ? `, ${r.renewed} auto-renewed` : ''}` : 'Nothing to remind right now (each reminder is sent once)', 'success');
        load();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        checking.value = false;
      }
    }
    return { data, checking, load, edit, paid, checkNow, money, cycleText, dateText, totalsText };
  },
  template: `
  <div>
    <div class="page-head">
      <div><h1>Billing</h1><div class="sub">When each server must be paid. Reminders go to Telegram / webhook before the due date (Settings → Payment reminders).</div></div>
      <div class="actions"><button class="admin-only btn" @click="checkNow" :disabled="checking"><span v-if="checking" class="spinner"></span>Send due reminders now</button></div>
    </div>
    <div v-if="!data" class="muted">Loading…</div>
    <template v-else>
      <div class="tiles">
        <div class="tile"><div class="tile-label">Cost per month</div><div class="tile-value" style="font-size:20px">{{ totalsText(data.totals) }}</div><div class="tile-sub">{{ data.items.length }} server{{ data.items.length === 1 ? '' : 's' }} with billing</div></div>
        <div class="tile" :class="{ 'tile-bad': data.items.some((b) => b.days_left !== null && b.days_left < 0 && !b.auto_renew) }"><div class="tile-label">Overdue</div><div class="tile-value">{{ data.items.filter((b) => b.days_left !== null && b.days_left < 0 && !b.auto_renew).length }}</div></div>
        <div class="tile"><div class="tile-label">Due in 7 days</div><div class="tile-value">{{ data.items.filter((b) => b.days_left !== null && b.days_left >= 0 && b.days_left <= 7).length }}</div></div>
        <div class="tile"><div class="tile-label">Reminders</div><div class="strong mt-8">{{ data.remind_days.length ? data.remind_days.join(', ') + ' days before' : 'off' }}</div><div class="tile-sub"><a href="#/settings">Change</a></div></div>
      </div>

      <section class="section">
        <div class="section-head"><h2>Servers</h2></div>
        <div class="card table-wrap">
          <table class="table" v-if="data.items.length">
            <thead><tr><th>Server</th><th>Provider</th><th>Price</th><th>Next payment</th><th></th></tr></thead>
            <tbody><tr v-for="b in data.items" :key="b.server_id">
              <td><a :href="'#/servers/' + b.server_id" class="strong">{{ b.server_name }}</a><div class="tiny muted mono">{{ b.server_ip }}</div></td>
              <td>{{ b.provider || '—' }}<div v-if="b.provider_url"><a class="tiny" :href="b.provider_url" target="_blank" rel="noopener noreferrer">Open ↗</a></div></td>
              <td><span class="strong">{{ money(b.price, b.currency) }}</span><div class="tiny muted">{{ cycleText(b.cycle_months) }}</div></td>
              <td>{{ dateText(b.due_date) }}<div><due-badge :billing="b" /><span v-if="b.auto_renew" class="badge badge-gray" style="margin-left:4px">auto-renew</span></div></td>
              <td class="actions"><button class="admin-only btn btn-xs btn-primary" @click="paid(b)">Mark as paid</button><button class="admin-only btn btn-xs" @click="edit(b)">Edit</button></td>
            </tr></tbody>
          </table>
          <div v-else class="empty">No billing info yet — add it to a server below.</div>
        </div>
        <div v-if="data.without.length" class="admin-only mt-12 small muted">No billing info: <template v-for="(s, i) in data.without" :key="s.id"><button class="link-btn" @click="edit(s)">{{ s.name }}</button><span v-if="i < data.without.length - 1">, </span></template></div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Payment history</h2></div>
        <payments-table :payments="data.payments" show-server @changed="load" />
      </section>
    </template>
  </div>`,
};

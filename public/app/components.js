import { ref, computed, watch, onMounted, onUnmounted, nextTick } from '/vendor/vue.js';
import { store, http, toast, ago, fmtDate, dur, tick, HEALTH, JOB_TYPES, showJob, confirmBox } from './lib.js';

export const Ago = {
  props: { at: String, prefix: { type: String, default: '' } },
  setup(props) {
    const text = computed(() => (tick.value, props.at ? `${props.prefix}${ago(props.at)}` : '—'));
    return { text, full: computed(() => fmtDate(props.at)) };
  },
  template: `<span :title="full">{{ text }}</span>`,
};

export const HealthPill = {
  props: { dep: Object },
  setup(props) {
    const h = computed(() => HEALTH[props.dep?.health] || HEALTH.unknown);
    return { h };
  },
  template: `<span class="pill"><span class="dot" :class="'dot-' + h.cls"></span>{{ h.label }}</span>`,
};

/** 24h strip: each segment is one time bucket (green = all checks passed). */
export const UptimeBar = {
  props: { bars: Array, hours: { type: Number, default: 24 } },
  setup(props) {
    const n = computed(() => props.bars?.length || 0);
    const cls = (b) => (!b ? '' : b.r >= 0.999 ? 'ub-ok' : b.r >= 0.8 ? 'ub-warn' : 'ub-bad');
    const tip = (b, i) => {
      const size = (props.hours * 3600e3) / n.value;
      const start = new Date(Date.now() - props.hours * 3600e3 + i * size);
      const t = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (!b) return `${t} — no data`;
      return `${t} — ${Math.round(b.r * 1000) / 10}% up (${b.n} checks${b.ms != null ? `, ~${b.ms} ms` : ''})`;
    };
    return { cls, tip };
  },
  template: `<div class="uptime"><span v-for="(b, i) in bars || []" :key="i" class="ub" :class="cls(b)" :title="tip(b, i)"></span></div>`,
};

export const MeterBar = {
  props: { label: String, value: Number, text: String, warn: { type: Number, default: 75 }, danger: { type: Number, default: 90 } },
  computed: {
    cls() {
      return this.value >= this.danger ? 'bad' : this.value >= this.warn ? 'warn' : '';
    },
    width() {
      return `${Math.min(100, Math.max(0, Number(this.value) || 0))}%`;
    },
  },
  template: `<div class="meter"><div class="meter-top"><span>{{ label }}</span><span class="muted">{{ text }}</span></div><div class="meter-track"><div class="meter-fill" :class="cls" :style="{ width }"></div></div></div>`,
};

export const Modal = {
  props: { title: String, size: { type: String, default: 'md' } },
  emits: ['close'],
  setup(props, { emit }) {
    const onKey = (e) => {
      if (e.key === 'Escape') emit('close');
    };
    onMounted(() => window.addEventListener('keydown', onKey));
    onUnmounted(() => window.removeEventListener('keydown', onKey));
    return {};
  },
  template: `
    <div class="modal-backdrop" @mousedown.self="$emit('close')">
      <div class="modal" :class="'modal-' + size" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>{{ title }}</h3><button class="icon-btn" @click="$emit('close')" aria-label="Close">✕</button></div>
        <div class="modal-body"><slot /></div>
        <div class="modal-foot" v-if="$slots.footer"><slot name="footer" /></div>
      </div>
    </div>`,
};

/** Only one dropdown is open at a time across the whole page. */
const openMenu = ref(null);

/**
 * Dropdown button. The panel is moved to <body> (so cards, tables and scroll
 * boxes never clip or cover it), placed with fixed coordinates under the
 * button, and flipped/shifted to stay on screen. Closes on a tap/click
 * outside (pointer events, so it works on iPad), Escape, picking an item,
 * or when another menu opens.
 */
export const MenuBtn = {
  props: { label: { type: String, default: '⋯' }, align: { type: String, default: 'right' }, small: Boolean },
  setup(props) {
    const id = Symbol('menu');
    const open = computed(() => openMenu.value === id);
    const btn = ref(null);
    const pop = ref(null);
    const pos = ref({ top: '0px', left: '0px', visibility: 'hidden' });
    const up = ref(false);

    const place = () => {
      if (!open.value || !btn.value || !pop.value) return;
      const b = btn.value.getBoundingClientRect();
      const vw = document.documentElement.clientWidth, vh = window.innerHeight, m = 8;
      const w = pop.value.offsetWidth, h = pop.value.offsetHeight;
      let left = props.align === 'left' ? b.left : b.right - w;
      left = Math.max(m, Math.min(left, vw - w - m));
      let top = b.bottom + 6;
      up.value = top + h > vh - m && b.top - 6 - h >= m; // not enough room below → open upwards
      if (up.value) top = b.top - 6 - h;
      pos.value = { top: `${Math.round(top)}px`, left: `${Math.round(left)}px`, maxHeight: `${vh - 2 * m}px` };
    };
    const close = () => { if (open.value) openMenu.value = null; };
    const toggle = () => {
      openMenu.value = open.value ? null : id;
      if (open.value) { pos.value = { ...pos.value, visibility: 'hidden' }; nextTick(place); }
    };
    const onDown = (e) => {
      if (!open.value) return;
      if (pop.value?.contains(e.target) || btn.value?.contains(e.target)) return;
      close();
    };
    const onKey = (e) => { if (open.value && e.key === 'Escape') { close(); btn.value?.focus(); } };
    const onPick = (e) => {
      const item = e.target.closest('button, a');
      if (item && !item.disabled) close();
    };
    const onMove = () => open.value && place();
    onMounted(() => {
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('keydown', onKey);
      window.addEventListener('resize', onMove);
      window.addEventListener('scroll', onMove, true);
    });
    onUnmounted(() => {
      close();
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    });
    return { open, toggle, btn, pop, pos, up, onPick };
  },
  template: `
    <div class="menu">
      <button ref="btn" class="btn" :class="[small ? 'btn-ghost btn-sm' : '', { 'is-open': open }]" @click="toggle" aria-haspopup="menu" :aria-expanded="open">{{ label }}</button>
      <teleport to="body">
        <transition name="menu-fade">
          <div v-if="open" ref="pop" class="menu-pop" :class="{ 'menu-up': up }" :style="pos" role="menu" @click="onPick"><slot /></div>
        </transition>
      </teleport>
    </div>`,
};

export const JobStatus = {
  props: { status: String },
  setup(props) {
    const map = { queued: ['gray', 'Queued'], running: ['blue', 'Running'], success: ['green', 'Success'], failed: ['red', 'Failed'], cancelled: ['amber', 'Cancelled'] };
    const v = computed(() => map[props.status] || ['gray', props.status]);
    return { v };
  },
  template: `<span class="badge" :class="'badge-' + v[0]"><span v-if="status === 'running'" class="spinner" style="width:10px;height:10px"></span>{{ v[1] }}</span>`,
};

export const JobsTable = {
  props: { jobs: Array, showProject: { type: Boolean, default: true } },
  components: { JobStatus, Ago },
  setup() {
    const took = (j) => (j.started_at ? dur((j.finished_at ? Date.parse(j.finished_at) : Date.now()) - Date.parse(j.started_at)) : '—');
    const projectName = (id) => store.nav.projects.find((p) => p.id === id)?.name || '';
    return { took, showJob, JOB_TYPES, projectName };
  },
  template: `
    <div class="card table-wrap">
      <table class="table" v-if="jobs && jobs.length">
        <thead><tr><th>#</th><th>Job</th><th>Status</th><th>By</th><th>Started</th><th>Took</th></tr></thead>
        <tbody>
          <tr v-for="j in jobs" :key="j.id" class="clickable" @click="showJob(j.id)">
            <td class="muted mono">{{ j.id }}</td>
            <td><div class="strong">{{ j.title }}</div><div class="small text-red" v-if="j.status === 'failed' && j.error">{{ j.error }}</div></td>
            <td><job-status :status="j.status" /></td>
            <td class="muted small">{{ j.user || '—' }}</td>
            <td class="muted small nowrap"><ago :at="j.started_at || j.created_at" /></td>
            <td class="muted small">{{ took(j) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">No jobs yet.</div>
    </div>`,
};

export const EventsList = {
  props: { events: Array },
  components: { Ago },
  setup() {
    const icon = { info: 'ℹ', success: '✔', warn: '⚠', error: '✖' };
    const cls = { info: 'muted', success: 'text-green', warn: 'text-amber', error: 'text-red' };
    return { icon, cls, showJob };
  },
  template: `
    <div class="card table-wrap">
      <table class="table" v-if="events && events.length">
        <tbody>
          <tr v-for="e in events" :key="e.id">
            <td style="width:28px" :class="cls[e.level]">{{ icon[e.level] }}</td>
            <td>{{ e.message }} <button v-if="e.job_id" class="link-btn small" @click="showJob(e.job_id)">log</button></td>
            <td class="muted small nowrap">{{ e.user || '' }}</td>
            <td class="muted small nowrap right"><ago :at="e.at" /></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">Nothing here yet.</div>
    </div>`,
};

/** Live job log (Server-Sent Events). */
export const JobLog = {
  props: { jobId: Number, tall: Boolean },
  emits: ['status'],
  components: { JobStatus },
  setup(props, { emit }) {
    const lines = ref([]);
    const status = ref(null);
    const error = ref(null);
    const job = ref(null);
    const box = ref(null);
    let follow = true;
    let es = null;
    const scroll = () =>
      nextTick(() => {
        if (follow && box.value) box.value.scrollTop = box.value.scrollHeight;
      });
    const onScroll = () => {
      const el = box.value;
      follow = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    const cls = (l) => (l.includes(' │ ') ? 'l-out' : l.includes('▶') ? 'l-step' : l.includes('✖') ? 'l-err' : l.includes('⚠') ? 'l-warn' : l.includes('✔') ? 'l-ok' : '');
    function open() {
      es?.close();
      lines.value = [];
      status.value = null;
      error.value = null;
      http.get(`/jobs/${props.jobId}`).then((j) => (job.value = j)).catch((e) => toast(e.message, 'error'));
      es = new EventSource(`/api/jobs/${props.jobId}/stream`);
      es.addEventListener('init', (e) => {
        const d = JSON.parse(e.data);
        lines.value = (d.log || '').split('\n').filter(Boolean);
        status.value = d.status;
        error.value = d.error;
        emit('status', d.status);
        scroll();
      });
      es.addEventListener('log', (e) => {
        lines.value.push(JSON.parse(e.data).line);
        if (lines.value.length > 10000) lines.value.splice(0, lines.value.length - 10000);
        if (status.value === 'queued') status.value = 'running';
        scroll();
      });
      es.addEventListener('end', (e) => {
        const d = JSON.parse(e.data);
        status.value = d.status;
        error.value = d.error;
        emit('status', d.status);
        es.close();
        scroll();
        http.get(`/jobs/${props.jobId}`).then((j) => (job.value = j)).catch(() => {});
      });
    }
    async function cancel() {
      if (!(await confirmBox({ title: 'Cancel this job?', message: 'Steps that already finished are not undone. A database copy that is interrupted is restored from its safety backup when possible.', confirmText: 'Cancel job', danger: true }))) return;
      await http.post(`/jobs/${props.jobId}/cancel`).catch((e) => toast(e.message, 'error'));
    }
    function copy() {
      navigator.clipboard?.writeText(lines.value.join('\n')).then(() => toast('Log copied', 'success'));
    }
    onMounted(open);
    watch(() => props.jobId, open);
    onUnmounted(() => es?.close());
    return { lines, status, error, job, box, onScroll, cls, cancel, copy };
  },
  template: `
    <div class="stack" style="gap:10px">
      <div class="row between wrap gap-8">
        <div class="row gap-8 wrap">
          <job-status :status="status || 'queued'" />
          <span class="strong">{{ job?.title }}</span>
          <span class="muted small" v-if="job?.user">by {{ job.user }}</span>
        </div>
        <div class="row gap-6">
          <button class="btn btn-sm" @click="copy">Copy log</button>
          <button v-if="status === 'running' || status === 'queued'" class="btn btn-sm btn-danger" @click="cancel">Cancel</button>
        </div>
      </div>
      <div v-if="status === 'failed' && error" class="alert alert-error"><span class="alert-icon">✖</span><span>{{ error }}</span></div>
      <div ref="box" class="log" :class="{ tall }" @scroll="onScroll">
        <div v-if="!lines.length" class="log-empty">{{ status === 'queued' ? 'Waiting for another job on this project to finish…' : 'Starting…' }}</div>
        <div v-for="(l, i) in lines" :key="i" :class="cls(l)">{{ l }}</div>
      </div>
    </div>`,
};

/** Pick which Cloudflare DNS records belong to a project. v-model = [{zone_id, zone_name, id, name, type}] */
export const RecordsPicker = {
  props: { modelValue: Array, domain: String },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const zones = ref([]);
    const zone = ref('');
    const records = ref([]);
    const loading = ref(false);
    const error = ref('');
    const selected = computed(() => new Set((props.modelValue || []).map((r) => r.id)));
    async function loadZones() {
      loading.value = true;
      error.value = '';
      try {
        zones.value = await http.get('/cloudflare/zones');
        const first = (props.modelValue || [])[0];
        const d = (props.domain || '').toLowerCase();
        const guess = first ? zones.value.find((z) => z.id === first.zone_id) : zones.value.filter((z) => d === z.name || d.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
        zone.value = guess?.id || zones.value[0]?.id || '';
      } catch (e) {
        error.value = e.message;
      } finally {
        loading.value = false;
      }
    }
    async function loadRecords() {
      if (!zone.value) return (records.value = []);
      loading.value = true;
      error.value = '';
      try {
        records.value = (await http.get(`/cloudflare/zones/${zone.value}/records`)).filter((r) => r.type === 'A' || r.type === 'AAAA');
        if (!(props.modelValue || []).length && props.domain) {
          const d = props.domain.toLowerCase();
          const auto = records.value.filter((r) => r.name === d || r.name === `www.${d}`);
          if (auto.length) emit('update:modelValue', auto.map(toRec));
        }
      } catch (e) {
        error.value = e.message;
      } finally {
        loading.value = false;
      }
    }
    const zoneName = () => zones.value.find((z) => z.id === zone.value)?.name || '';
    const toRec = (r) => ({ zone_id: zone.value, zone_name: zoneName(), id: r.id, name: r.name, type: r.type });
    function toggle(r) {
      const list = [...(props.modelValue || [])];
      const i = list.findIndex((x) => x.id === r.id);
      if (i >= 0) list.splice(i, 1);
      else list.push(toRec(r));
      emit('update:modelValue', list);
    }
    function remove(id) {
      emit('update:modelValue', (props.modelValue || []).filter((x) => x.id !== id));
    }
    watch(zone, loadRecords);
    onMounted(loadZones);
    return { zones, zone, records, loading, error, selected, toggle, remove, loadZones };
  },
  template: `
    <div class="stack" style="gap:10px">
      <div v-if="error" class="result err">{{ error }} <button class="link-btn" @click="loadZones">Retry</button></div>
      <div class="row gap-8">
        <select v-model="zone" :disabled="loading" style="max-width:320px">
          <option v-for="z in zones" :key="z.id" :value="z.id">{{ z.name }}</option>
        </select>
        <span v-if="loading" class="spinner"></span>
      </div>
      <div class="card table-wrap" v-if="records.length" style="max-height:260px;overflow-y:auto">
        <table class="table">
          <tbody>
            <tr v-for="r in records" :key="r.id" class="clickable" @click="toggle(r)">
              <td style="width:30px"><input type="checkbox" :checked="selected.has(r.id)" @click.stop="toggle(r)"></td>
              <td class="strong">{{ r.name }}</td><td><span class="badge">{{ r.type }}</span></td>
              <td class="mono small">{{ r.content }}</td>
              <td><span class="badge" :class="r.proxied ? 'badge-amber' : 'badge-gray'">{{ r.proxied ? 'Proxied' : 'DNS only' }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="!loading && zone && !error" class="muted small">No A/AAAA records in this zone.</div>
      <div v-if="modelValue && modelValue.length" class="chips">
        <span v-for="r in modelValue" :key="r.id" class="chip on">{{ r.type }} {{ r.name }} <button class="link-btn" @click="remove(r.id)" title="Remove">✕</button></span>
      </div>
    </div>`,
};

/** Cron field with presets and next-run preview. */
export const CronField = {
  props: { modelValue: String, presets: Array, next: String },
  emits: ['update:modelValue'],
  components: { Ago },
  template: `
    <div class="stack" style="gap:6px">
      <div class="chips">
        <button type="button" class="chip" :class="{ on: !modelValue }" @click="$emit('update:modelValue', '')">Off</button>
        <button type="button" v-for="p in presets" :key="p[1]" class="chip" :class="{ on: modelValue === p[1] }" @click="$emit('update:modelValue', p[1])">{{ p[0] }}</button>
      </div>
      <input class="code" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" placeholder="cron, e.g. 0 3 * * *  (minute hour day month weekday)">
      <div v-if="modelValue && next" class="hint">Next run: <ago :at="next" /> ({{ new Date(next).toLocaleString() }})</div>
    </div>`,
};


/* ------------------------------------------------------------------ icons (stroke, 24x24) */
const ICONS = {
  overview: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  servers: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',
  jobs: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  power: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
  restart: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  plug: 'M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5',
  key: 'M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7zM16 10h.01',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  box: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  logout: 'M15 4h4v16h-4M10 17l5-5-5-5M15 12H3',
  theme: 'M12 21a9 9 0 0 0 0-18v18z M12 3a9 9 0 1 0 0 18',
  check: 'M5 12l5 5 9-10',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  port: 'M4 12h4M16 12h4M8 8h8v8H8zM12 4v4M12 16v4',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
};
export const Icon = {
  props: { name: String, size: { type: Number, default: 16 } },
  template: `<svg class="ico" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="$options.ICONS[name] || ''" /></svg>`,
  ICONS,
};

export const components = { Icon, Ago, HealthPill, UptimeBar, MeterBar, Modal, MenuBtn, JobStatus, JobsTable, EventsList, JobLog, RecordsPicker, CronField };

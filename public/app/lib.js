import { reactive, ref } from '/vendor/vue.js';

/* ------------------------------------------------------------------ global state */
export const store = reactive({
  ready: false,
  user: null,
  setupRequired: false,
  version: '',
  live: 0, // bumped when the server pushes "something changed" → pages reload their data
  jobsLive: 0,
  toasts: [],
  dialog: null, // { type, props, key }
  confirm: null, // { title, message, confirmText, danger, typeToConfirm, resolve }
  jobId: null, // job log modal
  nav: { projects: [], running: 0 },
  overview: null, // /api/overview, refreshed on live events
  settings: null,
});

/* ------------------------------------------------------------------ API */
export class ApiError extends Error {}

export async function api(method, url, body) {
  const opt = { method, headers: { 'X-Requested-With': 'switchboard' }, credentials: 'same-origin' };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${url}`, opt);
  } catch {
    throw new ApiError('Cannot reach Switchboard — is it running?');
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : await res.text();
  if (res.status === 401 && !url.startsWith('/auth/')) store.user = null;
  if (!res.ok) throw new ApiError((data && data.error) || `HTTP ${res.status}`);
  return data;
}

export const http = {
  get: (u) => api('GET', u),
  post: (u, b = {}) => api('POST', u, b),
  put: (u, b = {}) => api('PUT', u, b),
  patch: (u, b = {}) => api('PATCH', u, b),
  del: (u, b) => api('DELETE', u, b),
};

/* ------------------------------------------------------------------ UI helpers */
let toastSeq = 0;
export function toast(message, type = 'info', ms) {
  const id = ++toastSeq;
  store.toasts.push({ id, message, type });
  if (store.toasts.length > 5) store.toasts.shift();
  setTimeout(() => dismissToast(id), ms ?? (type === 'error' ? 9000 : 4500));
}
export function dismissToast(id) {
  const i = store.toasts.findIndex((t) => t.id === id);
  if (i >= 0) store.toasts.splice(i, 1);
}

/** Promise-based confirm dialog. opts: { title, message, confirmText, danger, typeToConfirm } */
export function confirmBox(opts) {
  return new Promise((resolve) => {
    store.confirm = { confirmText: 'Confirm', ...opts, resolve };
  });
}

export function openDialog(type, props = {}) {
  store.dialog = { type, props, key: Date.now() };
}
export function closeDialog() {
  store.dialog = null;
}
export function showJob(id) {
  store.jobId = id;
}

/** Call an API that starts a job ({ job }) and open its live log. */
export async function runJob(promise) {
  try {
    const r = await promise;
    if (r?.job) showJob(r.job.id);
    return r;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

/* ------------------------------------------------------------------ formatting */
export const tick = ref(Date.now());
setInterval(() => (tick.value = Date.now()), 20000);

export function dur(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 && h < 10 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function ago(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (ms < 0) return `in ${dur(-ms)}`;
  if (ms < 45000) return 'just now';
  return `${dur(ms)} ago`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function bytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function uptimeStr(sec) {
  if (!sec) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((sec % 3600) / 60)}m`;
}

export const HEALTH = {
  up: { cls: 'green', label: 'Healthy' },
  degraded: { cls: 'amber', label: 'Unstable' },
  down: { cls: 'red', label: 'Down' },
  maintenance: { cls: 'blue', label: 'Maintenance' },
  unknown: { cls: 'gray', label: 'Checking…' },
};

/** How fresh is the database on this server? */
export function freshness(d, staleHours = 24) {
  tick.value;
  if (d.db_type === 'none') return { text: 'No database', cls: 'muted' };
  if (d.is_active) return { text: 'Live data', cls: 'text-green' };
  if (!d.data_at) return { text: 'Never copied', cls: 'text-amber' };
  const h = (Date.now() - Date.parse(d.data_at)) / 3600e3;
  return { text: `Copy from ${ago(d.data_at)}`, cls: h > staleHours ? 'text-amber' : 'muted' };
}

export const JOB_TYPES = {
  switch: 'Switch',
  sync: 'Copy data',
  backup: 'Backup',
  restore: 'Restore',
  deploy: 'Deploy',
  command: 'Command',
  container: 'Container',
  maintenance: 'Maintenance',
  dns: 'DNS',
  provision: 'Template setup',
  'staging-data': 'Copy to staging',
  'ci-setup': 'CI/CD setup',
  'ci-servers': 'Update servers',
  'runner-remove': 'Remove runner',
  'preview-down': 'Remove preview',
  'project-copy': 'Copy project',
};

/* ------------------------------------------------------------------ router (hash based) */
export const route = reactive({ name: 'overview', params: {}, path: '/' });
const ROUTES = [
  [/^\/$/, 'overview'],
  [/^\/projects\/(\d+)$/, 'project', ['id']],
  [/^\/servers$/, 'servers'],
  [/^\/servers\/(\d+)$/, 'server', ['id']],
  [/^\/jobs$/, 'jobs'],
  [/^\/jobs\/(\d+)$/, 'job', ['id']],
  [/^\/activity$/, 'activity'],
  [/^\/settings$/, 'settings'],
  [/^\/billing$/, 'billing'],
];

export function parseRoute() {
  const path = (location.hash || '#/').slice(1).split('?')[0] || '/';
  for (const [re, name, keys = []] of ROUTES) {
    const m = path.match(re);
    if (m) {
      const params = {};
      keys.forEach((k, i) => (params[k] = Number(m[i + 1])));
      Object.assign(route, { name, params, path });
      return;
    }
  }
  Object.assign(route, { name: 'notfound', params: {}, path });
}
window.addEventListener('hashchange', () => {
  parseRoute();
  window.scrollTo(0, 0);
});
parseRoute();

export const go = (path) => (location.hash = `#${path}`);

/** Same rule as the server: LAN / internal addresses visitors can't reach. */
export function isPrivateIp(ip) {
  const v = String(ip || '').trim().toLowerCase();
  const m = v.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  return v === '::1' || /^f[cd][0-9a-f]{2}:/.test(v) || /^fe[89ab][0-9a-f]:/.test(v);
}

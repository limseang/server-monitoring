import { createApp, computed, watch } from '/vendor/vue.js';
import { store, http, route, toast, dismissToast, HEALTH } from './lib.js';
import { components } from './components.js';
import { DIALOGS, JobModal, ConfirmDialog } from './dialogs.js';
import Overview from './pages/overview.js';
import ProjectPage from './pages/project.js';
import { ServersPage, ServerPage } from './pages/servers.js';
import { BillingPage } from './billing.js';
import { JobsPage, JobPage, ActivityPage, SettingsPage, AuthPage } from './pages/misc.js';

const PAGES = {
  overview: Overview,
  project: ProjectPage,
  servers: ServersPage,
  server: ServerPage,
  jobs: JobsPage,
  job: JobPage,
  activity: ActivityPage,
  settings: SettingsPage,
  billing: BillingPage,
};

/* ------------------------------------------------------------------ data + live updates */
async function loadOverview() {
  try {
    store.overview = await http.get('/overview');
    store.nav.projects = store.overview.projects.map((p) => ({ id: p.id, name: p.name }));
  } catch (e) {
    if (store.user) console.warn(e);
  }
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadOverview();
    store.live++;
  }, 350);
}

let es = null;
function startStream() {
  es?.close();
  es = new EventSource('/api/stream');
  es.addEventListener('state', scheduleRefresh);
  es.addEventListener('job', (e) => {
    const j = JSON.parse(e.data);
    store.jobsLive++;
    scheduleRefresh();
    if (['success', 'failed', 'cancelled'].includes(j.status) && store.jobId !== j.id) {
      toast(`${j.title} — ${j.status === 'success' ? 'done' : j.status}`, j.status === 'success' ? 'success' : j.status === 'failed' ? 'error' : 'warn');
    }
  });
  es.addEventListener('event', (e) => {
    const ev = JSON.parse(e.data);
    if (ev.notify && (ev.level === 'error' || ev.level === 'warn')) toast(ev.message, ev.level === 'error' ? 'error' : 'warn', 12000);
  });
}

/* ------------------------------------------------------------------ root component */
const App = {
  setup() {
    const page = computed(() => PAGES[route.name]);
    const dialog = computed(() => (store.dialog ? DIALOGS[store.dialog.type] : null));
    const projects = computed(() => store.overview?.projects || []);
    const running = computed(() => store.overview?.running || 0);
    const billingDue = computed(() => (store.overview?.servers || []).filter((s) => s.billing && s.billing.days_left !== null && s.billing.days_left <= 3 && !(s.billing.auto_renew && s.billing.days_left >= 0)).length);
    const projDot = (p) => {
      const a = p.deployments.find((d) => d.is_active);
      return a ? (HEALTH[a.health] || HEALTH.unknown).cls : 'gray';
    };
    function toggleTheme() {
      const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = t;
      try {
        localStorage.setItem('sb-theme', t);
      } catch {}
    }
    async function logout() {
      await http.post('/auth/logout').catch(() => {});
      location.reload();
    }
    watch(
      () => store.user,
      (u) => {
        if (!u) es?.close();
        document.documentElement.dataset.role = u?.role || '';
      },
      { immediate: true },
    );
    return { store, route, page, dialog, projects, running, billingDue, projDot, toggleTheme, logout, dismissToast };
  },
  template: `
  <auth-page v-if="store.ready && !store.user" />
  <div v-else-if="store.ready" class="layout">
    <aside class="sidebar">
      <a class="brand" href="#/"><span class="brand-logo"><icon name="bolt" :size="17" /></span><span>Switchboard<small>server failover & ops</small></span></a>
      <a class="nav-link" :class="{ active: route.name === 'overview' }" href="#/"><icon name="overview" />Overview</a>
      <a class="nav-link" :class="{ active: route.name === 'servers' || route.name === 'server' }" href="#/servers"><icon name="servers" />Servers</a>
      <a class="nav-link" :class="{ active: route.name === 'billing' }" href="#/billing"><icon name="card" />Billing<span v-if="billingDue" class="count" :title="billingDue + ' payment(s) due within 3 days or overdue'">{{ billingDue }}</span></a>
      <a class="nav-link" :class="{ active: route.name === 'jobs' || route.name === 'job' }" href="#/jobs"><icon name="jobs" />Jobs<span v-if="running" class="count">{{ running }}</span></a>
      <a class="nav-link" :class="{ active: route.name === 'activity' }" href="#/activity"><icon name="activity" />Activity</a>
      <a class="nav-link" :class="{ active: route.name === 'settings' }" href="#/settings"><icon name="settings" />Settings</a>
      <div class="nav-section" v-if="projects.length">Projects</div>
      <a v-for="p in projects" :key="p.id" class="nav-link nav-sub" :class="{ active: route.name === 'project' && route.params.id === p.id }" :href="'#/projects/' + p.id">
        <span class="dot" :class="'dot-' + projDot(p)"></span><span class="ellipsis">{{ p.name }}</span></a>
      <div class="sidebar-foot">
        <span class="avatar">{{ store.user.username.slice(0, 1).toUpperCase() }}</span><span class="user-name ellipsis grow"><b>{{ store.user.username }}</b><small>{{ store.user.role }}</small></span>
        <button class="icon-btn" title="Light / dark theme" @click="toggleTheme"><icon name="theme" /></button>
        <button class="icon-btn" title="Log out" @click="logout"><icon name="logout" /></button>
      </div>
    </aside>
    <main class="main">
      <component v-if="page" :is="page" v-bind="route.params" :key="route.name" />
      <div v-else class="empty-card"><div class="empty-title">Page not found</div><a href="#/">Go to the overview</a></div>
    </main>
  </div>
  <div v-else class="boot">Loading…</div>
  <component v-if="dialog" :is="dialog" v-bind="store.dialog.props" :key="store.dialog.key" />
  <job-modal />
  <confirm-dialog />
  <div class="toasts"><div v-for="t in store.toasts" :key="t.id" class="toast" :class="'toast-' + t.type" @click="dismissToast(t.id)">{{ t.message }}</div></div>`,
};

/* ------------------------------------------------------------------ boot */
const app = createApp(App);
for (const [name, c] of Object.entries(components)) app.component(name, c);
app.component('AuthPage', AuthPage);
app.component('JobModal', JobModal);
app.component('ConfirmDialog', ConfirmDialog);
app.config.errorHandler = (err) => {
  console.error(err);
  toast(`UI error: ${err.message}`, 'error');
};
app.mount('#app');

(async function boot() {
  try {
    const s = await http.get('/auth/state');
    store.user = s.user;
    store.setupRequired = s.setupRequired;
    store.version = s.version;
    if (s.user) {
      await loadOverview();
      startStream();
      http.get('/settings').then((x) => (store.settings = x)).catch(() => {});
    }
  } catch (e) {
    toast(e.message, 'error');
  }
  store.ready = true;
})();

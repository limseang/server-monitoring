import { ref, reactive, computed, watch, onMounted } from '/vendor/vue.js';
import { store, http, toast, closeDialog, openDialog, showJob, confirmBox, runJob } from './lib.js';
import { ZoneSelect } from './cicd.js';

/* ------------------------------------------------------------------ power */
const POWER_INFO = {
  reboot: { title: 'Restart', icon: 'restart', text: 'Shuts down cleanly and starts again. Containers with a restart policy start by themselves. Usually back in 1–2 minutes.' },
  'force-reboot': { title: 'Force restart', icon: 'bolt', text: 'Like pressing the reset button: restarts immediately without stopping services. Use it only when a normal restart hangs — unsaved data in memory is lost.' },
  shutdown: { title: 'Turn off', icon: 'power', text: 'Powers the server off. Switchboard can NOT turn it on again — you need your VPS provider\'s panel (or the power button for a home server).' },
};

export const PowerDialog = {
  props: { server: Object, action: String },
  setup(props) {
    const s = props.server;
    const info = POWER_INFO[props.action];
    const f = reactive({ confirm: '', force: false });
    const busy = ref(false);
    const roles = s.roles || [];
    async function go() {
      busy.value = true;
      try {
        const r = await http.post(`/servers/${s.id}/power`, { action: props.action, confirm: f.confirm, force: f.force });
        closeDialog();
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    return { s, info, f, busy, roles, go, closeDialog, action: props.action };
  },
  template: `
  <modal :title="info.title + ' ' + s.name" size="sm" @close="closeDialog">
    <div class="form">
      <div class="power-hero" :class="'power-' + action"><icon :name="info.icon" :size="22" /><span>{{ info.text }}</span></div>
      <div v-if="roles.length" class="alert alert-error"><span class="alert-icon">✖</span><span><b>Visitors depend on this server</b> — it is the {{ roles.join(', ') }}. Switch traffic to another server first.</span></div>
      <label v-if="roles.length" class="check"><input type="checkbox" v-model="f.force"><span class="check-text"><b>I understand the site goes down meanwhile</b></span></label>
      <div class="field"><label>Type <code>{{ s.name }}</code> to confirm</label><input v-model="f.confirm" autocomplete="off" @keydown.enter="f.confirm === s.name && go()"></div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-danger solid" @click="go" :disabled="busy || f.confirm !== s.name || (roles.length && !f.force)">{{ info.title }}</button>
    </template>
  </modal>`,
};

/* ------------------------------------------------------------------ password */
function strongPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.';
  const a = new Uint32Array(20);
  crypto.getRandomValues(a);
  return [...a].map((n) => chars[n % chars.length]).join('');
}

export const PasswordDialog = {
  props: { server: Object },
  setup(props) {
    const s = props.server;
    const users = ref(null);
    const f = reactive({ user: '', password: '', show: false });
    const busy = ref(false);
    onMounted(async () => {
      try {
        users.value = await http.get(`/servers/${s.id}/users`);
        f.user = (users.value.find((u) => u.name === s.ssh_user) || users.value[0])?.name || '';
      } catch (e) {
        toast(e.message, 'error');
        users.value = [];
      }
    });
    const generate = () => Object.assign(f, { password: strongPassword(), show: true });
    const copy = () => navigator.clipboard?.writeText(f.password).then(() => toast('Copied', 'success'));
    async function save() {
      busy.value = true;
      try {
        const r = await http.post(`/servers/${s.id}/password`, { user: f.user, password: f.password });
        toast(`Password of ${f.user} changed${r.synced ? ' — Switchboard will use the new one to log in' : ''}`, 'success');
        closeDialog();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    const isLogin = computed(() => f.user === s.ssh_user && s.auth_type === 'password');
    return { s, users, f, busy, generate, copy, save, isLogin, closeDialog };
  },
  template: `
  <modal :title="'Change a password on ' + s.name" size="sm" @close="closeDialog">
    <div class="form">
      <div class="field"><label>User</label>
        <select v-model="f.user" :disabled="!users"><option v-if="!users" value="">Loading…</option><option v-for="u in users || []" :key="u.name" :value="u.name">{{ u.name }}{{ u.uid === 0 ? ' (administrator)' : '' }}{{ u.name === s.ssh_user ? ' — Switchboard logs in as this user' : '' }}</option></select></div>
      <div class="field"><label>New password</label>
        <div class="row gap-6"><input v-model="f.password" :type="f.show ? 'text' : 'password'" autocomplete="new-password" class="code" placeholder="at least 12 characters">
          <button class="btn" type="button" @click="f.show = !f.show">{{ f.show ? 'Hide' : 'Show' }}</button></div>
        <div class="row gap-8 mt-8"><button class="btn btn-sm" type="button" @click="generate"><icon name="key" />Generate a strong one</button><button v-if="f.password && f.show" class="btn btn-sm btn-ghost" type="button" @click="copy"><icon name="copy" />Copy</button></div></div>
      <div class="hint">Used for SSH password logins and <code>sudo</code>. SSH key logins keep working. <template v-if="isLogin">Switchboard saves the new password for its own logins too.</template></div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="save" :disabled="busy || !f.user || f.password.length < 12">Change password</button>
    </template>
  </modal>`,
};

/* ------------------------------------------------------------------ change port */
export const PortDialog = {
  props: { server: Object, port: Object },
  setup(props) {
    const p = props.port;
    const to = ref('');
    const busy = ref(false);
    async function save() {
      busy.value = true;
      try {
        const r = await http.post(`/servers/${props.server.id}/ports/change`, { container: p.container, from: p.port, to: Number(to.value) });
        closeDialog();
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    return { p, to, busy, save, closeDialog };
  },
  template: `
  <modal :title="'Change the port of ' + p.container" size="sm" @close="closeDialog">
    <div class="form">
      <div class="port-flow"><div class="port-big">{{ p.port }}</div><icon name="arrow" :size="20" /><input v-model="to" class="port-input" inputmode="numeric" placeholder="new" autofocus @keydown.enter="to && save()"></div>
      <ul class="steps">
        <li>The port is changed in the compose file{{ p.compose ? ' of ' + p.compose.project : '' }} (or its <code>.env</code>), a backup copy is kept</li>
        <li><code>{{ p.compose && p.compose.service }}</code> is recreated with the new port (a few seconds offline)</li>
        <li v-if="p.domains.length">Web proxy sites ({{ p.domains.join(', ') }}) are moved to the new port</li>
        <li>If anything fails, the old file is put back</li>
      </ul>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="save" :disabled="busy || !/^\\d{2,5}$/.test(to) || Number(to) === p.port">Change port</button>
    </template>
  </modal>`,
};

/* ------------------------------------------------------------------ connect a domain */
export const DomainDialog = {
  props: { server: Object, ports: Array, port: Number },
  components: { ZoneSelect },
  setup(props) {
    const s = props.server;
    const scanned = ref(props.ports || null);
    onMounted(async () => {
      if (scanned.value) return;
      const r = await http.get(`/servers/${s.id}/ports`).catch(() => null);
      scanned.value = r?.ports || [];
      if (!f.port) f.port = apps.value[0]?.port || '';
    });
    const apps = computed(() => (scanned.value || []).filter((p) => p.proto === 'tcp' && p.kind !== 'ssh' && !(p.kind === 'web' && [80, 443].includes(p.port))));
    const f = reactive({ port: props.port || apps.value[0]?.port || '', zone: null, sub: '', proxied: true, takeover: false, project: '' });
    const projects = computed(() => (s.deployments || []).map((d) => ({ id: d.project_id, name: d.project_name })));
    const host = computed(() => (f.zone ? (f.sub ? `${f.sub.toLowerCase()}.${f.zone.zone_name}` : f.zone.zone_name) : ''));
    const busy = ref(false);
    async function save() {
      busy.value = true;
      try {
        const r = await http.post(`/servers/${s.id}/domains`, { ...f, port: Number(f.port), project: f.project || null });
        closeDialog();
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    return { s, apps, f, projects, host, busy, save, closeDialog };
  },
  template: `
  <modal :title="'Connect a domain to ' + s.name" @close="closeDialog">
    <div class="form">
      <div v-if="s.private_ip_warning" class="alert alert-warn"><span class="alert-icon">⚠</span><span>{{ s.name }} has a private IP ({{ s.ip }}) — set its public IP first (Edit server), or visitors can't reach it.</span></div>
      <div class="field"><label>App (port on this server)</label>
        <select v-model="f.port" :disabled="!scanned"><option v-if="!scanned" value="">Scanning ports…</option><option v-for="p in apps" :key="p.proto + p.port" :value="p.port">{{ p.port }} — {{ p.container || p.process || 'process' }}{{ p.project ? ' · ' + p.project.name : '' }}{{ p.domains.length ? ' · ' + p.domains.join(', ') : '' }}</option><option value="">Other port…</option></select>
        <input v-if="f.port === '' || !apps.some(a => a.port === f.port)" v-model.number="f.port" class="code mt-8" placeholder="port, e.g. 3000"></div>
      <div class="form-row">
        <div class="field"><label>Domain</label><zone-select v-model="f.zone" /></div>
        <div class="field"><label>Subdomain <span class="muted">(empty = the domain itself)</span></label><input v-model="f.sub" class="code" placeholder="api"></div>
      </div>
      <div v-if="host" class="domain-preview"><icon name="globe" /><b>https://{{ host }}</b><icon name="arrow" /><span class="mono">{{ s.name }}:{{ f.port || '?' }}</span></div>
      <label class="check"><input type="checkbox" v-model="f.proxied"><span class="check-text"><b>Through Cloudflare (orange cloud)</b><span class="hint">Free HTTPS for visitors and hides the server IP. Cloudflare SSL mode must be "Full".</span></span></label>
      <label class="check"><input type="checkbox" v-model="f.takeover"><span class="check-text"><b>If the record already exists, point it here</b><span class="hint">Off = an existing record is left as it is.</span></span></label>
      <div class="field" v-if="projects.length"><label>Belongs to project <span class="muted">(optional)</span></label>
        <select v-model="f.project"><option value="">— none —</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }} (moves with it when you switch servers)</option></select></div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="save" :disabled="busy || !f.zone || !f.port"><icon name="plug" />Connect</button>
    </template>
  </modal>`,
};

/* ------------------------------------------------------------------ ports & domains tab */
const KIND = { ssh: ['badge-gray', 'SSH'], web: ['badge-blue', 'Web server'], container: ['badge-accent', 'Container'], process: ['badge-gray', 'Program'] };

export const PortsTab = {
  props: { server: Object },
  setup(props) {
    const data = ref(null);
    const loading = ref(false);
    const showLocal = ref(true);
    async function load() {
      loading.value = true;
      try {
        data.value = await http.get(`/servers/${props.server.id}/ports`);
      } catch (e) {
        data.value = { ok: false, error: e.message };
      } finally {
        loading.value = false;
      }
    }
    onMounted(load);
    watch(() => store.jobsLive, () => setTimeout(load, 1500));
    const rows = computed(() => (data.value?.ports || []).filter((p) => showLocal.value || p.public));
    const connect = (port) => openDialog('domain', { server: props.server, ports: data.value?.ports || [], port });
    const change = (p) => openDialog('port', { server: props.server, port: p });
    async function disconnect(d) {
      const ok = await confirmBox({ title: `Disconnect ${d.host}?`, message: `The web proxy site is removed from ${props.server.name}.${d.record_created ? '\nThe Cloudflare record Switchboard created is deleted too.' : '\nThe Cloudflare record existed before, so it is kept.'}`, confirmText: 'Disconnect', danger: true });
      if (ok) runJob(http.del(`/domains/${d.id}`, { deleteDns: true }));
    }
    return { data, loading, load, rows, showLocal, connect, change, disconnect, KIND };
  },
  template: `
  <div class="stack">
    <div class="card">
      <div class="card-head"><div><h3>Domains</h3><div class="hint">Shortcut: a domain or subdomain → an app on this server (Cloudflare record + web proxy, HTTPS through Cloudflare).</div></div>
        <button class="btn btn-primary btn-sm admin-only" @click="connect()"><icon name="plug" />Connect a domain</button></div>
      <div class="table-wrap" v-if="data && data.domains && data.domains.length"><table class="table">
        <thead><tr><th>Domain</th><th>Goes to</th><th>Project</th><th></th></tr></thead>
        <tbody><tr v-for="d in data.domains" :key="d.id">
          <td><a :href="'https://' + d.host" target="_blank" rel="noopener" class="strong">{{ d.host }} <icon name="external" :size="12" /></a></td>
          <td class="mono small">port {{ d.port }}</td>
          <td class="small">{{ d.project_name || '—' }}</td>
          <td class="actions"><button class="btn btn-xs btn-danger admin-only" @click="disconnect(d)">Disconnect</button></td>
        </tr></tbody>
      </table></div>
      <div v-else class="empty">{{ data ? 'No domains connected from Switchboard yet.' : 'Loading…' }}</div>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>Open ports</h3><div class="hint">What listens on this server, and which app, container, project and domain is behind each port.</div></div>
        <div class="row gap-8"><label class="check small" style="align-items:center"><input type="checkbox" v-model="showLocal" style="margin:0">Show local-only</label>
          <button class="btn btn-sm" @click="load" :disabled="loading"><span v-if="loading" class="spinner"></span><icon v-else name="refresh" />Scan</button></div></div>
      <div v-if="data && !data.ok" class="alert alert-warn" style="margin:12px 18px"><span class="alert-icon">⚠</span><span>{{ data.error }}</span></div>
      <div class="table-wrap" v-else-if="data"><table class="table">
        <thead><tr><th>Port</th><th>Open to</th><th>What</th><th>Project / domains</th><th></th></tr></thead>
        <tbody><tr v-for="p in rows" :key="p.proto + p.port">
          <td><span class="port-chip">{{ p.port }}</span><span class="tiny muted"> {{ p.proto }}</span></td>
          <td><span class="badge" :class="p.public ? 'badge-amber' : 'badge-gray'">{{ p.public ? 'Internet' : 'This server only' }}</span></td>
          <td><div class="what-line"><span class="badge" :class="KIND[p.kind][0]">{{ KIND[p.kind][1] }}</span><span class="what-name">{{ p.container || p.process || '—' }}</span></div>
            <div class="tiny muted mt-8" v-if="p.compose || p.target">{{ p.target ? 'inside: port ' + p.target : '' }}{{ p.compose ? (p.target ? ' · ' : '') + p.compose.project + ' / ' + p.compose.service + ' · ' + p.compose.dir : '' }}</div></td>
          <td class="small"><a v-if="p.project" :href="'#/projects/' + p.project.id">{{ p.project.name }}</a>
            <div v-for="h in p.domains" :key="h"><a :href="'https://' + h" target="_blank" rel="noopener" class="tiny">{{ h }}</a></div>
            <span v-if="!p.project && !p.domains.length" class="muted">—</span></td>
          <td class="actions admin-only">
            <button v-if="p.kind !== 'ssh' && !(p.kind === 'web')" class="btn btn-xs" @click="connect(p.port)"><icon name="plug" :size="13" />Domain</button>
            <button v-if="p.can_change" class="btn btn-xs" @click="change(p)"><icon name="edit" :size="13" />Port</button></td>
        </tr></tbody>
      </table></div>
      <div v-else class="empty">Scanning…</div>
    </div>
  </div>`,
};

/* ------------------------------------------------------------------ power & access tab */
export const PowerTab = {
  props: { server: Object },
  setup(props) {
    const open = (action) => openDialog('power', { server: props.server, action });
    const password = () => openDialog('password', { server: props.server });
    return { open, password, POWER_INFO };
  },
  template: `
  <div class="power-grid">
    <button class="power-card" @click="open('reboot')"><span class="power-ico"><icon name="restart" :size="22" /></span><b>Restart</b><span>{{ POWER_INFO.reboot.text }}</span></button>
    <button class="power-card warn" @click="open('force-reboot')"><span class="power-ico"><icon name="bolt" :size="22" /></span><b>Force restart</b><span>{{ POWER_INFO['force-reboot'].text }}</span></button>
    <button class="power-card danger" @click="open('shutdown')"><span class="power-ico"><icon name="power" :size="22" /></span><b>Turn off</b><span>{{ POWER_INFO.shutdown.text }}</span></button>
    <button class="power-card" @click="password"><span class="power-ico"><icon name="key" :size="22" /></span><b>Change a password</b><span>Set a new login password for root or any user on this server. Generates a strong one if you like.</span></button>
  </div>`,
};

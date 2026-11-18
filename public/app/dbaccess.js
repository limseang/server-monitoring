import { ref, reactive, computed, watch, onMounted } from '/vendor/vue.js';
import { store, http, toast, confirmBox, runJob } from './lib.js';
import { Ago } from './components.js';

/* Project → "Database access": let another service (media server, worker…) use this project's
   database through one host name that always points to the live server. */
export const DbAccessTab = {
  props: { project: Object },
  components: { Ago },
  setup(props) {
    const v = ref(null);
    const editing = ref(false);
    const saving = ref(false);
    const f = reactive({ host: '', port: 3306, ips: [] });
    const isAdmin = computed(() => store.user?.role === 'admin');
    async function load() {
      try {
        v.value = await http.get(`/projects/${props.project.id}/db-access`);
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    function startEdit() {
      const c = v.value.config;
      Object.assign(f, {
        host: c?.host || v.value.suggested_host,
        port: c?.port || v.value.default_port,
        ips: (c?.ips || []).map((x) => ({ ...x })),
      });
      if (!f.ips.length) f.ips.push({ ip: '', label: '' });
      editing.value = true;
    }
    onMounted(load);
    watch(() => store.live, () => !saving.value && load());
    const on = computed(() => !!v.value?.config?.enabled);
    const cfg = computed(() => v.value?.config || {});
    const envText = computed(() => {
      const c = cfg.value;
      if (!c.host) return '';
      const pg = v.value.db_type === 'postgres';
      return [`DB_CONNECTION=${pg ? 'pgsql' : 'mysql'}`, `DB_HOST=${c.host}`, `DB_PORT=${c.port}`, `DB_DATABASE=${v.value.env?.database || '…'}`, `DB_USERNAME=${v.value.env?.username || '…'}`, 'DB_PASSWORD=(same as the app)'].join('\n');
    });
    async function save() {
      saving.value = true;
      try {
        const r = await http.put(`/projects/${props.project.id}/db-access`, { host: f.host, port: f.port, ips: f.ips.filter((x) => x.ip.trim()) });
        editing.value = false;
        v.value = r;
        runJob(Promise.resolve(r));
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        saving.value = false;
      }
    }
    const apply = () => runJob(http.post(`/projects/${props.project.id}/db-access/apply`));
    async function turnOff() {
      const ok = await confirmBox({
        title: 'Turn off outside database access?',
        message: `The proxy and the firewall rules are removed from every server, so other services can no longer connect.${cfg.value.record_created ? ` The DNS record ${cfg.value.host} is deleted from Cloudflare.` : ''}`,
        confirmText: 'Turn off',
        danger: true,
      });
      if (ok) runJob(http.del(`/projects/${props.project.id}/db-access`, {}));
    }
    const copyEnv = () => navigator.clipboard?.writeText(envText.value).then(() => toast('Copied', 'success'));
    const stateBadge = (s) => (!s.state ? ['badge-gray', s.has_db ? 'not set up' : 'no database'] : s.state === 'open' ? ['badge-green', 'OPEN'] : s.state === 'closed' ? ['badge-gray', 'closed'] : ['badge-red', 'error']);
    return { v, f, on, cfg, editing, saving, isAdmin, envText, startEdit, save, apply, turnOff, copyEnv, stateBadge };
  },
  template: `
  <div v-if="!v" class="muted">Loading…</div>
  <div v-else class="stack">
    <div class="card card-body">
      <div class="row between gap-12 wrap">
        <div style="max-width:720px">
          <h3 style="margin:0 0 4px">Use this database from another service</h3>
          <div class="hint">For a media server, a worker or any app that connects straight to this database. It uses <b>one host name</b> that always points to the live server, so switching servers never breaks it. Only the IPs you allow can connect, only the <b>live</b> server accepts them, and a switch pauses outside connections while the database is copied, so nothing gets lost.</div>
        </div>
        <div class="row gap-6" v-if="isAdmin && !editing">
          <template v-if="on"><button class="btn" @click="apply">Apply again</button><button class="btn" @click="startEdit">Edit</button><button class="btn btn-ghost btn-danger" @click="turnOff">Turn off</button></template>
          <button v-else class="btn btn-primary" :disabled="!!v.problem" @click="startEdit">Turn on…</button>
        </div>
      </div>
      <div v-if="v.problem" class="alert alert-info mt-12"><span class="alert-icon">ℹ</span><span>{{ v.problem }}</span></div>
    </div>

    <div v-if="editing" class="card card-body form">
      <div class="form-row">
        <div class="field"><label>Host name</label><input v-model="f.host" class="code" placeholder="db.example.com"><span class="hint">Switchboard creates it in Cloudflare as <b>DNS only</b> (grey cloud) — the database can't go through Cloudflare's proxy.</span></div>
        <div class="field"><label>Port</label><input v-model.number="f.port" type="number"><span class="hint">{{ v.db_type === 'postgres' ? '5432' : '3306' }} is normal. Use another one if that port is already taken on a server.</span></div>
      </div>
      <div class="field"><label>Who may connect <span class="muted">(public IPv4 of your other servers)</span></label>
        <div v-for="(x, i) in f.ips" :key="i" class="row gap-6 mb-8">
          <input v-model="x.ip" class="code" placeholder="203.0.113.5" style="max-width:200px">
          <input v-model="x.label" placeholder="what is it, e.g. media server" style="max-width:260px">
          <button class="btn btn-ghost btn-sm" @click="f.ips.splice(i, 1)">Remove</button>
        </div>
        <div><button class="btn btn-sm" @click="f.ips.push({ ip: '', label: '' })">+ Add IP</button></div>
        <span class="hint">On the other server, <code>curl -4 ifconfig.me</code> shows its public IP. Nobody else can reach the port.</span>
      </div>
      <div class="row gap-8"><button class="btn btn-primary" @click="save" :disabled="saving"><span v-if="saving" class="spinner"></span>Save and set up on all servers</button><button class="btn btn-ghost" @click="editing = false">Cancel</button></div>
    </div>

    <template v-if="on && !editing">
      <div v-for="(i, n) in v.issues" :key="n" class="alert" :class="'alert-' + i.level"><span class="alert-icon">{{ i.level === 'error' ? '✖' : '⚠' }}</span><span>{{ i.message }}</span></div>
      <div class="grid grid-2">
        <div class="card card-body">
          <div class="row between"><h3 style="margin:0">Settings for your other service</h3><button class="btn btn-sm" @click="copyEnv">Copy</button></div>
          <pre class="code mt-8" style="white-space:pre-wrap;margin:8px 0 0">{{ envText }}</pre>
          <div class="hint mt-8">Laravel: after changing <code>.env</code> run <code>php artisan config:clear</code>. After a switch, run <code>php artisan queue:restart</code> there so long-running workers connect to the new server.</div>
        </div>
        <div class="card card-body">
          <h3 style="margin:0 0 8px">Allowed IPs</h3>
          <div v-if="!cfg.ips || !cfg.ips.length" class="text-amber small">Nobody yet — click Edit and add the IP of your other server.</div>
          <div v-for="x in cfg.ips" :key="x.ip" class="row gap-8 small"><span class="mono strong">{{ x.ip }}</span><span class="muted">{{ x.label || '' }}</span></div>
          <div class="hint mt-8">If your provider has its own firewall (DigitalOcean Cloud Firewall, AWS security group…), allow port {{ cfg.port }} there too, from the same IPs.</div>
        </div>
      </div>
      <div class="card table-wrap">
        <table class="table">
          <thead><tr><th>Server</th><th>Outside access</th><th>Port</th><th>Checked</th></tr></thead>
          <tbody><tr v-for="s in v.servers" :key="s.id">
            <td><span class="strong">{{ s.server_name }}</span> <span v-if="s.is_active" class="badge badge-green">LIVE</span><div class="tiny muted mono">{{ s.server_ip }}<template v-if="s.db_container"> · {{ s.db_container }}</template></div></td>
            <td><span class="badge" :class="stateBadge(s)[0]">{{ stateBadge(s)[1] }}</span><div v-if="s.error" class="tiny text-red">{{ s.error }}</div><div v-else-if="s.state && s.ok" class="tiny muted">{{ s.via === 'own-port' ? 'the database publishes this port itself — protected by the firewall' : 'database answers through the proxy' }}</div></td>
            <td class="mono">{{ s.port || '—' }}</td>
            <td class="small muted"><ago v-if="s.at" :at="s.at" /><span v-else>—</span></td>
          </tr></tbody>
        </table>
      </div>
    </template>
  </div>`,
};

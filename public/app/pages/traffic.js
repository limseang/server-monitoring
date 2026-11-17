import { ref, reactive, computed, watch, onMounted } from '/vendor/vue.js';
import { store, http, toast, openDialog, confirmBox, runJob } from '../lib.js';
import { HealthPill, Ago } from '../components.js';

const STATE = {
  active: ['badge-green', 'Gets visitors'],
  draining: ['badge-amber', 'Draining'],
  off: ['badge-gray', 'Out'],
};

/** Project → Traffic tab: single server vs load balanced, shared database, pool members. */
export const TrafficTab = {
  props: { project: Object },
  emits: ['reload'],
  components: { HealthPill, Ago },
  setup(props, { emit }) {
    const info = ref(null);
    const dbServers = ref([]);
    const f = reactive({ moveTo: null, offTarget: null, drain: props.project.drain_seconds ?? 30 });
    const weights = reactive({});
    const lb = computed(() => props.project.traffic_mode === 'lb');
    async function load() {
      try {
        info.value = await http.get(`/projects/${props.project.id}/lb`);
        const d = await http.get('/db-servers');
        dbServers.value = d.servers;
        if (!f.moveTo) f.moveTo = d.servers.find((x) => x.status === 'ready')?.id || null;
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    onMounted(load);
    watch(() => store.live, load);
    watch(() => props.project, () => {
      for (const d of props.project.deployments) weights[d.id] = d.lb_weight;
      if (!f.offTarget) f.offTarget = (props.project.deployments.find((d) => d.is_active) || props.project.deployments[0])?.id;
    }, { immediate: true });

    const p = computed(() => props.project);
    const hasDb = computed(() => p.value.deployments.some((d) => d.db_type !== 'none'));
    const cfHealth = (d) => {
      const h = info.value?.cloudflare_health;
      if (!h || h.error) return null;
      return h[d.server_ip];
    };
    const enable = () => openDialog('lb-setup', { project: p.value });
    const setupDb = () => openDialog('db-server', { project: p.value });
    const scaleOut = () => openDialog('scale-out', { project: p.value });
    const member = (d, action, extra = {}) => runJob(http.post(`/projects/${p.value.id}/lb/member`, { deployment: d.id, action, ...extra }));
    async function drain(d) {
      const ok = await confirmBox({ title: `Take ${d.server_name} out?`, message: `No new visitors go to ${d.server_name}; running requests get ${p.value.drain_seconds}s to finish. Nobody is cut off.`, confirmText: 'Drain' });
      if (ok) member(d, 'drain');
    }
    const add = (d) => member(d, 'add');
    const setWeight = (d) => member(d, 'weight', { weight: weights[d.id] });
    async function moveDb() {
      const dbs = dbServers.value.find((x) => x.id === f.moveTo);
      const ok = await confirmBox({
        title: `Move the database of ${p.value.name} to ${dbs?.server_name}?`,
        message:
          'Maintenance mode is on during the move (usually a minute or two). The database is copied and checked, then each app server gets a new .env (old one kept as .env.switchboard-bak) and is restarted. If anything fails, the old .env files are put back.',
        confirmText: 'Move database',
      });
      if (ok) runJob(http.post(`/projects/${p.value.id}/db/move`, { db_server: f.moveTo }));
    }
    async function turnOff() {
      const t = p.value.deployments.find((d) => d.id === f.offTarget);
      const ok = await confirmBox({ title: 'Turn off load balancing?', message: `${t?.server_name} becomes the only live server and DNS points straight at it. The shared database stays.`, confirmText: 'Turn off', danger: true });
      if (ok) runJob(http.post(`/projects/${p.value.id}/lb/disable`, { target: f.offTarget }));
    }
    async function saveDrain() {
      try {
        await http.put(`/projects/${p.value.id}`, { name: p.value.name, drain_seconds: f.drain });
        toast('Saved', 'success');
        emit('reload');
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    const backupShared = () => runJob(http.post(`/projects/${p.value.id}/backup-shared`));
    return { p, info, dbServers, f, weights, lb, hasDb, STATE, cfHealth, enable, setupDb, scaleOut, drain, add, setWeight, moveDb, turnOff, saveDrain, backupShared };
  },
  template: `
  <div class="stack">
    <div class="card">
      <div class="card-head"><h3>How visitors reach {{ p.name }}</h3>
        <span class="badge" :class="lb ? 'badge-accent' : 'badge-gray'">{{ lb ? 'Load balanced' : 'One live server' }}</span></div>
      <div class="card-body stack" style="gap:12px">
        <template v-if="!lb">
          <div class="small">Cloudflare DNS points at one live server. Switching moves DNS, so visitors see a short maintenance page while the data is copied.</div>
          <div class="small"><b>Load balancing</b> puts several servers behind one load balancer: switching, deploying and fixing a server happen <b>without downtime</b>, and you can add servers when it gets busy. All servers then share one database.</div>
          <div class="row gap-8"><button class="btn btn-primary" @click="enable" :disabled="!p.dns_records.length">Turn on load balancing…</button>
            <span v-if="!p.dns_records.length" class="muted small">Link the Cloudflare DNS records first (Settings tab).</span></div>
        </template>
        <template v-else>
          <div class="kv">
            <div><span>Load balancer</span><span v-if="p.lb_provider === 'cloudflare'">Cloudflare Load Balancing</span>
              <span v-else>nginx on <a :href="'#/servers/' + (info && info.lb_server ? info.lb_server.id : '')">{{ info && info.lb_server ? info.lb_server.name : '?' }}</a> <span class="mono small muted">{{ info && info.lb_server ? info.lb_server.ip : '' }}</span>
                <span v-if="p.lb_state.lb_health" class="badge" :class="p.lb_state.lb_health === 'up' ? 'badge-green' : 'badge-red'">{{ p.lb_state.lb_health === 'up' ? 'up' : 'DOWN' }}</span></span></div>
            <div v-if="p.lb_provider === 'own'"><span>Spreading</span><span>{{ { least_conn: 'least busy server', round_robin: 'take turns', ip_hash: 'same visitor → same server' }[p.lb_config.method] || 'least busy server' }}{{ p.lb_config.tls_cert ? ' · HTTPS on the LB' : ' · HTTP only on the LB (Cloudflare "Flexible")' }}</span></div>
            <div><span>Last change</span><span><ago v-if="p.lb_state.applied_at" :at="p.lb_state.applied_at" /><span v-else>—</span></span></div>
          </div>
          <div v-if="p.lb_state.error" class="alert alert-error"><span class="alert-icon">✖</span><span>Last load balancer change failed: {{ p.lb_state.error }}</span></div>
          <div v-if="p.lb_provider === 'own'" class="hint">The load balancer server is a single point of failure — Switchboard checks it every minute and alerts you if it stops answering.</div>
          <div v-if="p.sync_paths" class="alert alert-warn"><span class="alert-icon">⚠</span><span>This project has upload folders ({{ p.sync_paths.split('\\n')[0] }}…). Each server keeps its own copy, so a file uploaded on one server is missing on the others. Use S3/R2 storage for uploads when load balancing.</span></div>
          <div class="row gap-8 wrap">
            <button class="btn btn-primary" @click="scaleOut">+ Add server</button>
            <span class="grow"></span>
            <select v-model.number="f.offTarget" style="width:auto"><option v-for="d in p.deployments" :key="d.id" :value="d.id">{{ d.server_name }}</option></select>
            <button class="btn btn-danger" @click="turnOff">Turn off load balancing</button>
          </div>
        </template>
      </div>
    </div>

    <div class="card" v-if="lb">
      <div class="card-head"><h3>Servers in the load balancer</h3>
        <div class="row gap-6"><span class="small muted">Drain time</span><input type="number" v-model.number="f.drain" style="width:70px;height:30px"><span class="small muted">s</span><button class="btn btn-sm" @click="saveDrain">Save</button></div></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Server</th><th>Visitors</th><th>Health (Switchboard)</th><th v-if="p.lb_provider === 'cloudflare'">Cloudflare sees</th><th>Weight</th><th></th></tr></thead>
        <tbody><tr v-for="d in p.deployments" :key="d.id">
          <td><a :href="'#/servers/' + d.server_id" class="strong">{{ d.server_name }}</a><div class="tiny muted mono">{{ d.server_ip }}</div></td>
          <td><span class="badge" :class="STATE[d.lb_state][0]">{{ STATE[d.lb_state][1] }}</span>
            <div v-if="d.lb_state === 'active' && d.health === 'down'" class="tiny text-red">down → taken out automatically</div></td>
          <td><health-pill :dep="d" /></td>
          <td v-if="p.lb_provider === 'cloudflare'"><span v-if="cfHealth(d) === true" class="text-green small">healthy</span><span v-else-if="cfHealth(d) === false" class="text-red small">unhealthy</span><span v-else class="muted small">—</span></td>
          <td><div class="row gap-6"><input type="number" min="1" max="100" v-model.number="weights[d.id]" style="width:62px;height:28px"><button v-if="weights[d.id] !== d.lb_weight" class="btn btn-xs" @click="setWeight(d)">Set</button></div></td>
          <td class="actions"><button v-if="d.lb_state === 'off'" class="btn btn-xs btn-primary" @click="add(d)">Add</button>
            <button v-else class="btn btn-xs" @click="drain(d)">Drain</button></td>
        </tr></tbody>
      </table></div>
      <div class="hint" style="padding:0 18px 14px">Higher weight = more visitors. "Drain" stops new visitors and lets running requests finish — use it before maintenance; "Switch traffic here" on a server card adds it and drains all the others, without downtime.</div>
      <details v-if="info && info.nginx_preview" style="padding:0 18px 14px"><summary class="small muted">nginx config on the load balancer</summary><pre class="code-block" style="max-height:280px">{{ info.nginx_preview }}</pre></details>
    </div>

    <div class="card">
      <div class="card-head"><h3>Shared database</h3><span v-if="p.shared_db" class="badge badge-green">In use</span></div>
      <div class="card-body stack" style="gap:12px">
        <template v-if="p.shared_db && info && info.db_server">
          <div class="kv">
            <div><span>Server</span><span><a :href="'#/servers/' + info.db_server.server_id">{{ info.db_server.server_name }}</a> · {{ info.db_server.engine }} on <span class="mono">{{ p.shared_db.host }}:{{ p.shared_db.port }}</span></span></div>
            <div><span>Database</span><span class="mono">{{ p.shared_db.name }} · user {{ p.shared_db.user }}</span></div>
            <div><span>Redis</span><span>{{ p.shared_db.redis ? 'sessions + cache' : 'not used' }}</span></div>
            <div><span>Allowed</span><span class="mono small">{{ info.db_server.allowed.join(', ') }}</span></div>
          </div>
          <div class="row gap-8"><button class="btn btn-sm" @click="backupShared">Back up now</button><span class="hint">Backups and the backup schedule now use this database.</span></div>
        </template>
        <template v-else-if="!hasDb"><div class="small muted">This project has no database — nothing to share.</div></template>
        <template v-else>
          <div class="small">Each server has its own database now. Before several servers get visitors, the data must live in <b>one</b> place.</div>
          <div class="row gap-8 wrap" v-if="dbServers.some(x => x.status === 'ready')">
            <select v-model.number="f.moveTo" style="width:auto"><option v-for="x in dbServers.filter(x => x.status === 'ready')" :key="x.id" :value="x.id">{{ x.server_name }} ({{ x.engine }})</option></select>
            <button class="btn btn-primary" @click="moveDb">Move database there…</button>
            <span class="muted small">or</span><button class="btn" @click="setupDb">Set up another database server…</button>
          </div>
          <div v-else class="row gap-8"><button class="btn btn-primary" @click="setupDb">Set up a database server…</button><span class="muted small">Then move this project's database to it.</span></div>
        </template>
      </div>
    </div>
  </div>`,
};

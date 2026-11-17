import { ref, reactive, computed } from '/vendor/vue.js';
import { store, http, toast, closeDialog, showJob } from './lib.js';
import { Modal } from './components.js';

async function start(busy, url, body) {
  busy.value = true;
  try {
    const r = await http.post(url, body);
    closeDialog();
    showJob(r.job.id);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busy.value = false;
  }
}

/* ======================================================================= TURN ON LOAD BALANCING */
export const LbSetupDialog = {
  props: { project: Object },
  components: { Modal },
  setup(props) {
    const p = props.project;
    const servers = computed(() => store.overview?.servers || []);
    const projectServerIds = new Set(p.deployments.map((d) => d.server_id));
    const hasDb = p.deployments.some((d) => d.db_type !== 'none');
    const f = reactive({
      provider: 'own',
      lb_server: servers.value.find((s) => !projectServerIds.has(s.id))?.id || null,
      method: 'least_conn',
      tls_cert: '',
      tls_key: '',
      use_private: true,
      sticky: false,
      members: p.deployments.filter((d) => d.is_active).map((d) => d.id),
      force: false,
    });
    const lbServer = computed(() => servers.value.find((s) => s.id === f.lb_server));
    const needsDb = computed(() => hasDb && !p.db_server_id);
    const busy = ref(false);
    const toggle = (id) => (f.members = f.members.includes(id) ? f.members.filter((x) => x !== id) : [...f.members, id]);
    const canStart = computed(() => f.members.length && (f.provider === 'cloudflare' || f.lb_server) && (!needsDb.value || f.force));
    const submit = () => start(busy, `/projects/${p.id}/lb/enable`, f);
    return { p, f, servers, projectServerIds, lbServer, needsDb, busy, toggle, canStart, submit, closeDialog };
  },
  template: `
  <modal :title="'Turn on load balancing — ' + p.name" size="lg" @close="closeDialog">
    <div class="form">
      <p class="muted small" style="margin:0">Visitors are spread over several servers. Taking a server out (to switch, deploy or fix it) no longer causes downtime, and a busy project can get more servers.</p>
      <div v-if="needsDb" class="alert alert-error"><span class="alert-icon">⚠</span><div class="grow">
        <b>Move the database to a database server first.</b> With several live servers, each server must use the <b>same</b> database — otherwise an order saved on one server is missing on the other. Use "Database server" on the Traffic tab.
        <label class="check mt-8"><input type="checkbox" v-model="f.force"><span class="check-text">This app has no data to share (e.g. a static Vue site) — continue anyway</span></label></div></div>

      <div class="seg" style="align-self:flex-start">
        <button type="button" :class="{ on: f.provider === 'own' }" @click="f.provider = 'own'">My own LB server (nginx)</button>
        <button type="button" :class="{ on: f.provider === 'cloudflare' }" @click="f.provider = 'cloudflare'">Cloudflare Load Balancing</button>
      </div>

      <template v-if="f.provider === 'own'">
        <div class="field"><label>Load balancer server</label>
          <select v-model.number="f.lb_server"><option :value="null" disabled>Pick a server…</option><option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name }} ({{ s.ip }}){{ projectServerIds.has(s.id) ? ' — also an app server' : '' }}</option></select>
          <span class="hint">A small VPS is enough. Switchboard installs nginx there and points the domain's DNS at it. It is a single point of failure — Switchboard checks it every minute and alerts you.</span></div>
        <div class="form-row">
          <div class="field"><label>How to spread visitors</label>
            <select v-model="f.method"><option value="least_conn">Least busy server (recommended)</option><option value="round_robin">Take turns (round robin)</option><option value="ip_hash">Same visitor → same server (sticky by IP)</option></select></div>
          <div class="field"><label class="check" style="margin-top:22px"><input type="checkbox" v-model="f.use_private"><span class="check-text">Use private IPs to reach the app servers when set</span></label></div>
        </div>
        <div class="form-row">
          <div class="field"><label>TLS certificate path <span class="muted">(optional)</span></label><input v-model="f.tls_cert" class="code" placeholder="/etc/ssl/cloudflare-origin.pem"></div>
          <div class="field"><label>TLS key path</label><input v-model="f.tls_key" class="code" placeholder="/etc/ssl/cloudflare-origin.key"></div>
        </div>
        <div class="hint">Files on the load balancer server. Needed for Cloudflare SSL "Full (strict)" — e.g. the same Cloudflare Origin Certificate as your app servers. Without them the load balancer listens on port 80 only (Cloudflare SSL mode "Flexible").</div>
      </template>
      <template v-else>
        <div class="alert alert-warn"><span class="alert-icon">ℹ</span><span>Cloudflare Load Balancing is a <b>paid add-on</b> (about $5/month). Enable it in Cloudflare (Traffic → Load Balancing), and give your API token <b>Load Balancing: Monitors and Pools — Edit</b> (account) and <b>Load Balancers — Edit</b> (zone).</span></div>
        <label class="check"><input type="checkbox" v-model="f.sticky"><span class="check-text"><b>Keep each visitor on the same server</b><span class="hint">Cookie-based. Not needed when sessions are in Redis on the database server.</span></span></label>
      </template>

      <div><div class="label mb-8">Servers that get visitors right away</div>
        <label v-for="d in p.deployments" :key="d.id" class="check"><input type="checkbox" :checked="f.members.includes(d.id)" @change="toggle(d.id)"><span class="check-text"><b>{{ d.server_name }}</b> <span class="muted">{{ d.server_ip }} · {{ d.health }}</span></span></label>
        <div class="hint">Each is health-checked first. You can add more later (also brand-new servers with "Add server").</div></div>

      <div><div class="label mb-8">What will happen</div><ol class="steps">
        <li>Health check the chosen servers</li>
        <li v-if="f.provider === 'own'">Install nginx on {{ lbServer ? lbServer.name : 'the LB server' }} and write the config (tested with nginx -t)</li>
        <li v-if="f.provider === 'own'">Test the site through the load balancer</li>
        <li v-if="f.provider === 'own'">Point the Cloudflare DNS records to {{ lbServer ? lbServer.ip : 'the LB server' }}</li>
        <li v-else>Create a Cloudflare health monitor, a pool and one load balancer per hostname</li>
      </ol></div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="submit" :disabled="busy || !canStart">Turn on load balancing</button>
    </template>
  </modal>`,
};

/* ======================================================================= DATABASE SERVER */
export const DbServerDialog = {
  props: { project: Object },
  components: { Modal },
  setup(props) {
    const p = props.project;
    const servers = computed(() => store.overview?.servers || []);
    const projectServerIds = new Set(p?.deployments.map((d) => d.server_id) || []);
    const engine = p?.deployments.some((d) => d.db_type === 'postgres') ? 'postgres' : 'mysql';
    const f = reactive({ server: servers.value.find((s) => !projectServerIds.has(s.id))?.id || null, engine, redis: true, allow: [...projectServerIds] });
    const busy = ref(false);
    const submit = () => start(busy, '/db-servers', f);
    return { p, f, servers, projectServerIds, busy, submit, closeDialog };
  },
  template: `
  <modal title="Set up a database server" size="lg" @close="closeDialog">
    <div class="form">
      <p class="muted small" style="margin:0">One server runs the database (and Redis for sessions and cache) for all your app servers. Switchboard installs Docker if needed and starts it in <code>/opt/switchboard-db</code>. Only your app servers may connect (firewall allow-list).</p>
      <div class="field"><label>Server</label>
        <select v-model.number="f.server"><option :value="null" disabled>Pick a server…</option><option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name }} ({{ s.private_ip ? 'private ' + s.private_ip : s.ip }}){{ projectServerIds.has(s.id) ? ' — also an app server' : '' }}</option></select>
        <span class="hint">Best: a separate server with a private IP set (Edit server → Private IP), in the same data center as the app servers. Without a private IP the database listens on the public IP, protected by the allow-list.</span></div>
      <div class="seg" style="align-self:flex-start">
        <button type="button" :class="{ on: f.engine === 'mysql' }" @click="f.engine = 'mysql'">MySQL 8.4</button>
        <button type="button" :class="{ on: f.engine === 'mariadb' }" @click="f.engine = 'mariadb'">MariaDB 11.4</button>
        <button type="button" :class="{ on: f.engine === 'postgres' }" @click="f.engine = 'postgres'">PostgreSQL 17</button>
      </div>
      <label class="check"><input type="checkbox" v-model="f.redis"><span class="check-text"><b>Also run Redis</b><span class="hint">Shared sessions and cache, so a visitor stays logged in whichever server answers.</span></span></label>
      <div><div class="label mb-8">Allowed to connect</div>
        <label v-for="s in servers" :key="s.id" class="check" v-show="s.id !== f.server"><input type="checkbox" :value="s.id" v-model="f.allow"><span class="check-text">{{ s.name }} <span class="muted">{{ s.ip }}{{ s.private_ip ? ' · ' + s.private_ip : '' }}</span></span></label>
        <div class="hint">Servers of projects that use this database are allowed automatically, also ones you add later.</div></div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="submit" :disabled="busy || !f.server">Set up database server</button>
    </template>
  </modal>`,
};

/* ======================================================================= ADD SERVER (SCALE OUT) */
export const ScaleOutDialog = {
  props: { project: Object },
  components: { Modal },
  setup(props) {
    const p = props.project;
    const inPool = new Set(p.deployments.filter((d) => d.lb_state !== 'off').map((d) => d.server_id));
    const candidates = computed(() => (store.overview?.servers || []).filter((s) => !inPool.has(s.id) && s.id !== p.lb_server_id));
    const actives = p.deployments.filter((d) => d.lb_state === 'active');
    const f = reactive({ server: candidates.value[0]?.id || null, source: (actives.find((d) => d.is_active) || actives[0])?.id, clone: true, replace: false });
    const target = computed(() => candidates.value.find((s) => s.id === f.server));
    const existing = computed(() => p.deployments.find((d) => d.server_id === f.server));
    const busy = ref(false);
    const submit = () => start(busy, `/projects/${p.id}/lb/scale-out`, f);
    return { p, f, candidates, actives, target, existing, busy, submit, closeDialog };
  },
  template: `
  <modal :title="'Add a server — ' + p.name" @close="closeDialog">
    <div class="form">
      <div class="field"><label>Server to add</label>
        <select v-model.number="f.server"><option :value="null" disabled>Pick a server…</option><option v-for="s in candidates" :key="s.id" :value="s.id">{{ s.name }} ({{ s.ip }})</option></select>
        <span class="hint" v-if="!candidates.length">No spare server. Add a new VPS first (Servers → Add server) — a fresh one is fine.</span></div>
      <label class="check"><input type="checkbox" v-model="f.clone"><span class="check-text"><b>Copy the app onto it first (clone)</b><span class="hint">Docker, images, app folders, .env, PM2 apps and host settings are copied from the server below. Untick if the server is already set up.</span></span></label>
      <div v-if="f.clone" class="field" style="margin-left:26px"><label>Copy from</label><select v-model.number="f.source"><option v-for="d in actives" :key="d.id" :value="d.id">{{ d.server_name }}</option></select>
        <span class="hint">Nothing is paused: the database is shared.</span></div>
      <label v-if="f.clone" class="check" style="margin-left:26px"><input type="checkbox" v-model="f.replace"><span class="check-text">Replace stacks that already exist on {{ target ? target.name : 'it' }}</span></label>
      <div><div class="label mb-8">What will happen</div><ol class="steps">
        <li v-if="f.clone">Clone {{ (actives.find(d => d.id === f.source) || {}).server_name }} → {{ target ? target.name : 'the new server' }}</li>
        <li v-if="!existing">Add it to {{ p.name }}</li>
        <li v-if="p.db_server_id">Allow it through the database firewall</li>
        <li>Health check it directly</li>
        <li>Put it in the load balancer — visitors are spread over one more server</li>
      </ol></div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="submit" :disabled="busy || !f.server">Add server</button>
    </template>
  </modal>`,
};

/* ======================================================================= UPGRADE OS */
export const OsUpgradeDialog = {
  props: { server: Object },
  components: { Modal },
  setup(props) {
    const s = props.server;
    const plan = ref(null);
    const error = ref('');
    const loading = ref(false);
    const f = reactive({ target: null, snapshot: false, confirm: '' });
    async function check() {
      loading.value = true;
      error.value = '';
      try {
        const r = await http.post(`/servers/${s.id}/os-upgrade/preview`, { target: f.target });
        if (!r.ok) throw new Error(r.error);
        plan.value = r.plan;
        if (!f.target && r.plan.path.length) {
          f.target = r.plan.path[r.plan.path.length - 1];
          return check();
        }
      } catch (e) {
        error.value = e.message;
      } finally {
        loading.value = false;
      }
    }
    check();
    const busy = ref(false);
    const name = computed(() => (plan.value?.os.id === 'ubuntu' ? 'Ubuntu' : 'Debian'));
    const ready = computed(() => plan.value && f.target && plan.value.steps.length && !plan.value.problems.length && f.snapshot && f.confirm === s.name);
    const submit = () => start(busy, `/servers/${s.id}/os-upgrade`, f);
    return { s, plan, error, loading, f, busy, name, ready, check, submit, closeDialog };
  },
  template: `
  <modal :title="'Upgrade the OS of ' + s.name" size="lg" @close="closeDialog">
    <div class="form">
      <div v-if="loading && !plan" class="muted">Reading the server…</div>
      <div v-if="error" class="result err">{{ error }}</div>
      <template v-if="plan">
        <div class="kv"><div><span>Now</span><span class="strong">{{ plan.os.pretty }}</span></div>
          <div><span>Can go to</span><span>{{ plan.path.length ? plan.path.join(', ') : 'nothing newer' }}</span></div></div>
        <div v-if="plan.path.length" class="field"><label>Upgrade to</label>
          <select v-model="f.target" @change="check"><option v-for="v in plan.path" :key="v" :value="v">{{ name }} {{ v }}</option></select>
          <span class="hint" v-if="plan.steps.length">Steps: {{ [plan.os.version, ...plan.steps].join(' → ') }} — one release at a time, as {{ name }} requires.</span></div>

        <div v-for="p in plan.problems" :key="p" class="result err">✖ {{ p }}</div>
        <div v-for="w in plan.warnings" :key="w" class="alert alert-warn"><span class="alert-icon">⚠</span><span>{{ w }}</span></div>
        <div v-if="plan.drain.length" class="alert alert-warn"><span class="alert-icon">ℹ</span><span>First taken out of the load balancer of {{ plan.drain.map(d => d.project).join(', ') }} (the other servers keep serving), and put back when it's healthy again.</span></div>

        <div><div class="label mb-8">What will happen</div><ol class="steps">
          <li>For each release: update all packages, reboot if needed, run the {{ plan.os.id === 'ubuntu' ? 'do-release-upgrade' : 'apt source switch + full-upgrade' }}, reboot, re-enable Docker's repository and update again</li>
          <li>Config files you changed are kept (new defaults only for files you never touched)</li>
          <li>Start Docker, the containers and PM2 apps that ran before; health check the projects on this server</li>
        </ol><div class="hint">It runs on the server itself, so a dropped connection doesn't stop it. Expect 20–60 minutes per release. A server that visitors depend on right now (a project's live server, a load balancer, a shared database) can't be upgraded — switch traffic away first.</div></div>

        <div class="fieldset" style="gap:8px">
          <div class="fieldset-title">Downgrade?</div>
          <div class="small">{{ name }} can't go back to an older version in place. Do this instead: <b>1.</b> make sure another server has your setup (or clone this one to a spare server), <b>2.</b> reinstall this server with the version you want in your provider's panel, <b>3.</b> here: Edit server → <b>Reset SSH host key</b>, <b>4.</b> <b>Clone</b> the setup back onto it.</div>
        </div>

        <template v-if="plan.steps.length && !plan.problems.length">
          <label class="check"><input type="checkbox" v-model="f.snapshot"><span class="check-text"><b>I made a snapshot / backup of this server at my provider</b><span class="hint">If a release upgrade goes wrong, a snapshot is the only quick way back.</span></span></label>
          <div class="field"><label>Type <code>{{ s.name }}</code> to confirm</label><input v-model="f.confirm" class="code" autocomplete="off"></div>
        </template>
      </template>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="submit" :disabled="busy || !ready">Start upgrade</button>
    </template>
  </modal>`,
};

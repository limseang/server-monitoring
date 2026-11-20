import { ref, reactive, computed, onMounted, watch } from '/vendor/vue.js';
import { store, http, toast, closeDialog, openDialog, go, showJob, freshness, fmtDate, bytes, HEALTH } from './lib.js';
import { Modal, RecordsPicker, HealthPill, JobLog } from './components.js';
import { BillingDialog, PaidDialog } from './billing.js';
import { LbSetupDialog, DbServerDialog, ScaleOutDialog, OsUpgradeDialog } from './lbdialogs.js';
import { TemplateProjectDialog, StagingDialog, ConnectGitDialog } from './cicd.js';
import { RunViewer } from './runview.js';
import { DeployLive } from './deployview.js';
import { ProxyDialog, ProxyLive } from './proxy.js';
import { DeployPlanDialog } from './deployplan.js';
import { PowerDialog, PasswordDialog, PortDialog, DomainDialog } from './serverctl.js';
import { RemoveDeploymentDialog, DeleteProjectDialog, ResetServerDialog, ReinstallDialog } from './wipedialogs.js';
import { CleanupDialog } from './cleanupdialog.js';
import { SshGuardDialog } from './sshguard.js';
import { CopyProjectDialog } from './copydialog.js';

/* ======================================================================= SERVER */
export const ServerDialog = {
  props: { server: Object },
  components: { Modal },
  setup(props) {
    const s = props.server;
    const f = reactive({
      name: s?.name || '',
      ip: s?.ip || '',
      ipv6: s?.ipv6 || '',
      private_ip: s?.private_ip || '',
      ssh_host: s?.ssh_host || '',
      ssh_port: s?.ssh_port || 22,
      ssh_user: s?.ssh_user || 'root',
      auth_type: s?.auth_type || 'key',
      ssh_key: '',
      ssh_key_path: s?.ssh_key_path || '',
      ssh_passphrase: '',
      ssh_password: '',
      docker_cmd: s?.docker_cmd || 'docker',
      notes: s?.notes || '',
    });
    const authTypes = [
      ['key', 'Private key'],
      ['password', 'Password'],
      ['keyfile', 'Key file'],
      ['agent', 'ssh-agent'],
    ];
    const testing = ref(false);
    const saving = ref(false);
    const test = ref(null);
    async function runTest() {
      testing.value = true;
      test.value = null;
      try {
        test.value = await http.post('/servers/test', { ...f, id: s?.id });
      } catch (e) {
        test.value = { ok: false, error: e.message };
      } finally {
        testing.value = false;
      }
    }
    async function save() {
      saving.value = true;
      try {
        if (s) await http.put(`/servers/${s.id}`, f);
        else {
          const r = await http.post('/servers', f);
          go(`/servers/${r.id}`);
        }
        toast(s ? 'Server saved' : 'Server added — collecting stats…', 'success');
        store.live++;
        closeDialog();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        saving.value = false;
      }
    }
    return { f, s, authTypes, testing, saving, test, runTest, save, closeDialog };
  },
  template: `
  <modal :title="s ? 'Edit server' : 'Add a server'" size="lg" @close="closeDialog">
    <div class="form">
      <div class="form-row">
        <div class="field"><label>Name</label><input v-model="f.name" placeholder="e.g. Server A (Vultr SG)"></div>
        <div class="field"><label>Public IPv4</label><input v-model="f.ip" placeholder="203.0.113.10" class="code"><span class="hint">Cloudflare A records will point to this IP</span></div>
      </div>
      <div class="form-row-3">
        <div class="field"><label>SSH user</label><input v-model="f.ssh_user" class="code"></div>
        <div class="field"><label>SSH port</label><input v-model.number="f.ssh_port" type="number"></div>
        <div class="field"><label>SSH host <span class="muted">(optional)</span></label><input v-model="f.ssh_host" :placeholder="f.ip || 'same as IP'" class="code"></div>
      </div>
      <div class="field"><label>Log in with</label>
        <div><div class="seg"><button v-for="o in authTypes" :key="o[0]" type="button" :class="{ on: f.auth_type === o[0] }" @click="f.auth_type = o[0]">{{ o[1] }}</button></div></div>
      </div>
      <div v-if="f.auth_type === 'key'" class="field">
        <label>Private key</label>
        <textarea v-model="f.ssh_key" class="code" rows="5" :placeholder="s && s.has_key ? '•••• saved — paste a new key only to replace it' : 'Paste the whole private key, starting with -----BEGIN OPENSSH PRIVATE KEY-----'"></textarea>
        <span class="hint">Stored encrypted. Best: make a key just for Switchboard — <code>ssh-keygen -t ed25519 -f switchboard</code> — and add <code>switchboard.pub</code> to <code>~/.ssh/authorized_keys</code> on the server.</span>
      </div>
      <div v-if="f.auth_type === 'keyfile'" class="field"><label>Key file path on the Switchboard machine</label><input v-model="f.ssh_key_path" class="code" placeholder="/keys/id_ed25519"></div>
      <div v-if="f.auth_type === 'key' || f.auth_type === 'keyfile'" class="field"><label>Key passphrase <span class="muted">(only if the key has one)</span></label><input v-model="f.ssh_passphrase" type="password" autocomplete="new-password" :placeholder="s && s.has_passphrase ? '•••• saved' : ''"></div>
      <div v-if="f.auth_type === 'password'" class="field"><label>SSH password</label><input v-model="f.ssh_password" type="password" autocomplete="new-password" :placeholder="s && s.has_password ? '•••• saved — type only to replace' : ''"><span class="hint">Keys are safer than passwords.</span></div>
      <div v-if="f.auth_type === 'agent'" class="hint">Uses the ssh-agent of the machine running Switchboard (SSH_AUTH_SOCK).</div>
      <details>
        <summary class="small muted" style="cursor:pointer">More options (sudo, IPv6, notes)</summary>
        <div class="form mt-12">
          <div class="form-row">
            <div class="field"><label>Docker command</label><input v-model="f.docker_cmd" class="code"><span class="hint">Use <code>sudo docker</code> if the SSH user is not in the docker group (needs passwordless sudo)</span></div>
            <div class="field"><label>Public IPv6 <span class="muted">(optional)</span></label><input v-model="f.ipv6" class="code" placeholder="only if you use AAAA records"></div>
            <div class="field"><label>Private IP <span class="muted">(optional)</span></label><input v-model="f.private_ip" class="code" placeholder="e.g. 10.0.0.5"><span class="hint">The provider's private network (VPC). Used for the shared database and the load balancer, so that traffic doesn't go over the internet.</span></div>
          </div>
          <div class="field"><label>Notes</label><textarea v-model="f.notes" rows="2"></textarea></div>
        </div>
      </details>
      <div v-if="test" class="result" :class="test.ok ? 'ok' : 'err'">
        <template v-if="test.ok">✔ Connected — {{ test.uname }}<br>Docker: {{ test.docker_ok ? test.docker + ' (' + test.containers + ' running containers)' : 'NOT available: ' + test.docker }}<br><span class="small mono">Host key {{ test.host_key }}</span></template>
        <template v-else>✖ {{ test.error }}</template>
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="runTest" :disabled="testing"><span v-if="testing" class="spinner"></span>Test connection</button>
      <span class="grow"></span>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="save" :disabled="saving">{{ s ? 'Save' : 'Add server' }}</button>
    </template>
  </modal>`,
};

/* ======================================================================= NEW PROJECT */
export const ProjectDialog = {
  components: { Modal, RecordsPicker },
  setup() {
    const f = reactive({ name: '', domain: '', health_scheme: 'https', health_path: '/up', dns_records: [] });
    const saving = ref(false);
    const pickDns = ref(false);
    async function save() {
      saving.value = true;
      try {
        const p = await http.post('/projects', f);
        toast('Project created — now add the servers it runs on', 'success');
        store.live++;
        closeDialog();
        go(`/projects/${p.id}`);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        saving.value = false;
      }
    }
    return { f, saving, save, pickDns, closeDialog, openDialog };
  },
  template: `
  <modal title="New project" size="lg" @close="closeDialog">
    <div class="form">
      <p class="muted">A project is one website or app (for example your Laravel shop) that runs on one or more servers. Use this for an app that already runs on your servers. <button class="link-btn" @click="openDialog('template-project')">Start a new app from a template instead →</button></p>
      <div class="form-row">
        <div class="field"><label>Project name</label><input v-model="f.name" placeholder="Home Electric Shop"></div>
        <div class="field"><label>Main domain</label><input v-model="f.domain" placeholder="shop.example.com" class="code"><span class="hint">Used as Host header for health checks</span></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Health check</label>
          <div class="row gap-8"><select v-model="f.health_scheme" style="width:100px"><option value="https">https</option><option value="http">http</option></select><input v-model="f.health_path" class="code" placeholder="/up"></div>
          <span class="hint">Laravel 11+ has <code>/up</code>. Checked on each server's IP directly, not through Cloudflare.</span>
        </div>
      </div>
      <div class="fieldset">
        <div class="row between"><div class="fieldset-title">Cloudflare DNS records</div><button v-if="!pickDns" class="btn btn-sm" @click="pickDns = true">Choose records</button></div>
        <div v-if="!pickDns" class="hint">The A records (like <code>shop.example.com</code> and <code>www</code>) that Switchboard will point to the active server. You can also do this later in the project settings.</div>
        <records-picker v-else v-model="f.dns_records" :domain="f.domain" />
      </div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="save" :disabled="saving || !f.name">Create project</button>
    </template>
  </modal>`,
};

/* ======================================================================= PROJECT ON A SERVER */
export const DeploymentDialog = {
  props: { project: Object, dep: Object },
  components: { Modal },
  setup(props) {
    const d = props.dep;
    const f = reactive({
      server_id: d?.server_id || props.project.available_servers?.[0]?.id || '',
      priority: d?.priority ?? 10,
      app_dir: d?.app_dir || '',
      app_container: d?.app_container || '',
      db_type: d?.db_type || 'mysql',
      db_container: d?.db_container || '',
      db_name: d?.db_name || '',
      db_user: d?.db_user || '',
      db_password: '',
      clear_db_password: false,
      skip_backup: !!d?.skip_backup,
    });
    const found = ref(null);
    const hostApps = ref([]);
    const discovering = ref(false);
    const testing = ref(false);
    const test = ref(null);
    const saving = ref(false);
    async function discover() {
      if (!f.server_id) return;
      discovering.value = true;
      found.value = null;
      try {
        const [c, a] = await Promise.all([
          http.get(`/servers/${f.server_id}/discover?hint=${encodeURIComponent(props.project.slug)}`).catch((e) => ({ containers: [], suggestion: null, error: e.message })),
          http.get(`/servers/${f.server_id}/apps`).catch(() => null),
        ]);
        found.value = c;
        // Apps outside Docker, as "folder" choices.
        const list = [];
        if (a?.ok) {
          for (const x of a.pm2) list.push({ key: `pm2:${x.user}:${x.name}`, kind: 'pm2', label: x.name, sub: `PM2 · user ${x.user} · ${x.status}`, dir: x.cwd });
          for (const x of a.services) if (x.cwd) list.push({ key: `svc:${x.name}`, kind: 'service', label: x.name, sub: 'systemd service', dir: x.cwd });
          for (const x of a.sites) for (const r of x.roots) list.push({ key: `site:${r}`, kind: 'static', label: x.names[0] || '(default site)', sub: 'nginx static site', dir: r });
        }
        hostApps.value = list;
        if (!d && !f.app_container && !f.db_container && c.suggestion && (c.containers.length || !list.length)) apply(c.suggestion);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        discovering.value = false;
      }
    }
    function apply(sg) {
      Object.assign(f, { app_dir: sg.app_dir, app_container: sg.app_container, db_type: sg.db_type, db_container: sg.db_container, db_name: sg.db_name, db_user: sg.db_user });
    }
    function useHostApp(x) {
      // Not in Docker: no app container, and usually no Docker database.
      Object.assign(f, { app_dir: x.dir, app_container: '' });
      if (!f.db_container) f.db_type = 'none';
    }
    function useContainer(c) {
      if (c.kind === 'db') Object.assign(f, { db_type: c.db.type, db_container: c.name, db_name: c.db.name, db_user: c.db.user });
      else {
        f.app_container = c.name;
        if (c.working_dir) f.app_dir = c.working_dir;
      }
    }
    async function testDb() {
      testing.value = true;
      test.value = null;
      try {
        test.value = await http.post(`/servers/${f.server_id}/test-db`, { ...f, deployment_id: d?.id });
      } catch (e) {
        test.value = { ok: false, error: e.message };
      } finally {
        testing.value = false;
      }
    }
    async function save() {
      saving.value = true;
      try {
        if (d) await http.put(`/deployments/${d.id}`, f);
        else await http.post(`/projects/${props.project.id}/deployments`, f);
        toast('Saved', 'success');
        store.live++;
        closeDialog();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        saving.value = false;
      }
    }
    onMounted(() => {
      if (!d && f.server_id) discover();
    });
    const kindBadge = { db: 'badge-blue', app: 'badge-accent', web: 'badge-gray', cache: 'badge-gray', other: 'badge-gray' };
    return { f, d, found, hostApps, discovering, discover, apply, useContainer, useHostApp, testing, test, testDb, saving, save, kindBadge, closeDialog };
  },
  template: `
  <modal :title="d ? 'Edit ' + d.server_name + ' in ' + project.name : 'Add a server to ' + project.name" size="lg" @close="closeDialog">
    <div class="form">
      <div class="form-row">
        <div class="field" v-if="!d"><label>Server</label>
          <select v-model="f.server_id" @change="discover">
            <option v-for="s in project.available_servers" :key="s.id" :value="s.id">{{ s.name }} — {{ s.ip }}</option>
          </select>
          <span v-if="!project.available_servers.length" class="hint text-amber">All servers are already in this project. Add a new server first.</span>
        </div>
        <div class="field"><label>Failover priority</label><input type="number" v-model.number="f.priority"><span class="hint">Lower = preferred standby for auto-failover</span></div>
      </div>

      <div class="fieldset">
        <div class="row between"><div class="fieldset-title">Containers on this server</div>
          <button class="btn btn-sm" @click="discover" :disabled="discovering || !f.server_id"><span v-if="discovering" class="spinner"></span>{{ found ? 'Scan again' : 'Scan containers' }}</button></div>
        <div v-if="found && found.containers.length" class="card table-wrap" style="max-height:220px;overflow-y:auto">
          <table class="table"><tbody>
            <tr v-for="c in found.containers" :key="c.name">
              <td><span class="badge" :class="kindBadge[c.kind]">{{ c.kind }}</span></td>
              <td><div class="container-name mono">{{ c.name }}</div><div class="tiny muted">{{ c.image }}<template v-if="c.compose_project"> · compose: {{ c.compose_project }}</template></div></td>
              <td class="actions"><button class="btn btn-xs" @click="useContainer(c)" :disabled="c.kind !== 'db' && c.kind !== 'app' && c.kind !== 'other'">{{ c.kind === 'db' ? 'Use as DB' : 'Use as app' }}</button></td>
            </tr>
          </tbody></table>
        </div>
        <div v-else-if="found && found.error" class="result err">Could not read the containers: {{ found.error }}</div>
        <div v-else-if="found" class="muted small">No running containers found.</div>
        <div v-else class="hint">Scan to auto-fill the fields below from the running Docker containers.</div>
        <template v-if="hostApps.length">
          <div class="fieldset-title" style="font-size:13px">Apps outside Docker (Vue, Nuxt, Node…)</div>
          <div class="card table-wrap" style="max-height:200px;overflow-y:auto"><table class="table"><tbody>
            <tr v-for="x in hostApps" :key="x.key">
              <td><span class="badge" :class="x.kind === 'static' ? 'badge-gray' : 'badge-accent'">{{ x.kind }}</span></td>
              <td><div class="mono">{{ x.label }}</div><div class="tiny muted">{{ x.sub }} · {{ x.dir }}</div></td>
              <td class="actions"><button class="btn btn-xs" @click="useHostApp(x)">Use this app</button></td>
            </tr>
          </tbody></table></div>
          <div class="hint">For apps outside Docker, leave "App container" empty. Deploy scripts run in the app folder (e.g. <code>git pull && npm ci && npm run build && pm2 reload my-app</code>). Clear the maintenance commands in project settings if the app has no <code>php artisan</code>.</div>
        </template>
      </div>

      <div class="form-row">
        <div class="field"><label>App folder on the server</label><input v-model="f.app_dir" class="code" placeholder="/home/deploy/shop"><span class="hint">Where docker-compose.yml or the app's package.json lives (deploy scripts run here)</span></div>
        <div class="field"><label>App container</label><input v-model="f.app_container" class="code" placeholder="shop-app-1"><span class="hint">Runs <code>php artisan</code> (maintenance mode, commands). Empty for apps outside Docker.</span></div>
      </div>
      <div class="fieldset">
        <div class="fieldset-title">Database</div>
        <div class="seg" style="align-self:flex-start">
          <button type="button" :class="{ on: f.db_type === 'mysql' }" @click="f.db_type = 'mysql'">MySQL / MariaDB</button>
          <button type="button" :class="{ on: f.db_type === 'postgres' }" @click="f.db_type = 'postgres'">PostgreSQL</button>
          <button type="button" :class="{ on: f.db_type === 'none' }" @click="f.db_type = 'none'">No database</button>
        </div>
        <template v-if="f.db_type !== 'none'">
          <div class="form-row">
            <div class="field"><label>DB container</label><input v-model="f.db_container" class="code" placeholder="shop-mysql-1"></div>
            <div class="field"><label>Database name</label><input v-model="f.db_name" class="code" placeholder="from container env if empty"></div>
          </div>
          <div class="form-row">
            <div class="field"><label>DB user <span class="muted">(optional)</span></label><input v-model="f.db_user" class="code" :placeholder="f.db_type === 'postgres' ? 'POSTGRES_USER' : 'root'"></div>
            <div class="field"><label>DB password <span class="muted">(optional)</span></label><input v-model="f.db_password" type="password" autocomplete="new-password" :placeholder="d && d.has_db_password ? '•••• saved — type to replace' : 'empty = read from container env'"></div>
          </div>
          <label v-if="d && d.has_db_password" class="check"><input type="checkbox" v-model="f.clear_db_password"><span class="check-text">Forget the saved password (use the container's env instead)</span></label>
          <label class="check"><input type="checkbox" v-model="f.skip_backup"><span class="check-text"><b>No backup needed on this server — just update</b><span class="hint">When data is copied into this server, skip the safety backup of its current database (good for standby / test servers). You can still tick it per copy.</span></span></label>
          <div class="hint">Leave user/password empty and Switchboard uses the container's own <code>MYSQL_ROOT_PASSWORD</code> / <code>POSTGRES_PASSWORD</code>. Commands run inside the container with <code>docker exec</code>, nothing is installed on the server.</div>
          <div class="row gap-8"><button class="btn btn-sm" @click="testDb" :disabled="testing || !f.db_container || !f.server_id"><span v-if="testing" class="spinner"></span>Test database</button>
            <span v-if="test" class="small" :class="test.ok ? 'text-green' : 'text-red'">{{ test.ok ? '✔ Connected — ' + test.tables + ' tables' : '✖ ' + test.error }}</span></div>
        </template>
      </div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="save" :disabled="saving || !f.server_id">{{ d ? 'Save' : 'Add to project' }}</button>
    </template>
  </modal>`,
};

/* ======================================================================= SWITCH */
export const SwitchDialog = {
  props: { project: Object, target: Number },
  components: { Modal, HealthPill },
  setup(props) {
    const p = props.project;
    const active = p.deployments.find((d) => d.is_active) || null;
    const others = p.deployments.filter((d) => !d.is_active);
    const sourceOk = !!active && active.health !== 'down' && active.server_status !== 'down';
    const hasDb = !!active && active.db_type !== 'none';
    const hasFiles = !!(p.sync_paths || '').trim();
    const f = reactive({
      target: props.target || (others.find((d) => d.health === 'up') || others[0])?.id,
      syncDb: hasDb && sourceOk,
      backupTarget: true,
      syncFiles: false,
      maintenance: true,
      keepOldDown: true,
      purgeCache: !!p.purge_cache,
      force: false,
    });
    const target = computed(() => p.deployments.find((d) => d.id === f.target));
    watch(() => f.target, () => { f.backupTarget = !target.value?.skip_backup; }, { immediate: true });
    const busy = ref(false);
    const steps = computed(() => {
      const t = target.value?.server_name || 'target';
      const a = active?.server_name;
      const s = [];
      if (a && (f.syncDb || f.syncFiles) && f.maintenance) s.push(`Maintenance mode ON at ${a} (visitors see "be right back" for a moment)`);
      if (f.syncDb) {
        s.push(`Dump the database on ${a}`);
        if (f.backupTarget) s.push(`Safety backup of the current database on ${t}`);
        s.push(`Replace the database on ${t} with ${a}'s and verify it`);
      }
      if (f.syncFiles) s.push(`Copy files (${p.sync_paths.split('\n').filter((x) => x.trim()).length} path(s)) ${a} → ${t}`);
      s.push(`Maintenance mode OFF at ${t}`);
      s.push(`Health check ${t} directly${f.force ? ' (continue even if it fails)' : ' — stop here if it fails'}`);
      s.push(`Point Cloudflare DNS (${p.dns_records.length} record${p.dns_records.length === 1 ? '' : 's'}) to ${target.value?.server_ip || '?'}`);
      if (f.purgeCache) s.push('Purge the Cloudflare cache');
      if (a && (f.syncDb || f.syncFiles) && f.maintenance) {
        s.push(f.keepOldDown ? `${a} stays in maintenance mode (so no one writes to the old database)` : `Maintenance mode OFF at ${a} (back online as a standby)`);
      }
      return s;
    });
    async function submit() {
      busy.value = true;
      try {
        const r = await http.post(`/projects/${p.id}/switch`, f);
        closeDialog();
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    return { p, f, active, others, target, sourceOk, hasDb, hasFiles, steps, busy, submit, freshness, closeDialog, HEALTH };
  },
  template: `
  <modal :title="'Switch traffic — ' + p.name" size="lg" @close="closeDialog">
    <div class="form">
      <div class="flow">
        <div class="flow-box"><div class="flow-label">Live now</div>
          <template v-if="active"><div class="strong">{{ active.server_name }}</div><div class="small mono muted">{{ active.server_ip }}</div><health-pill :dep="active" class="small" /></template>
          <div v-else class="muted">No active server</div>
        </div>
        <div class="flow-arrow">→</div>
        <div class="flow-box"><div class="flow-label">Switch to</div>
          <template v-if="target"><div class="strong">{{ target.server_name }}</div><div class="small mono muted">{{ target.server_ip }}</div><health-pill :dep="target" class="small" /></template>
        </div>
      </div>

      <div v-if="others.length > 1" class="target-list">
        <label v-for="d in others" :key="d.id" class="target" :class="{ on: f.target === d.id }">
          <input type="radio" :value="d.id" v-model="f.target">
          <div class="grow"><div class="strong">{{ d.server_name }} <span class="muted mono small">{{ d.server_ip }}</span></div><div class="small" :class="freshness(d).cls">{{ freshness(d).text }}</div></div>
          <health-pill :dep="d" />
        </label>
      </div>

      <div v-if="!p.dns_records.length" class="alert alert-error"><span class="alert-icon">✖</span><span>No Cloudflare DNS records linked to this project yet — set them in the project's Settings tab first.</span></div>

      <div class="fieldset">
        <label class="check" :class="{ disabled: !hasDb || !sourceOk }">
          <input type="checkbox" v-model="f.syncDb" :disabled="!hasDb || !sourceOk">
          <span class="check-text"><b>Copy the database from {{ active ? active.server_name : 'the live server' }} first</b>
            <span class="hint" v-if="!hasDb">This project has no database configured.</span>
            <span class="hint" v-else-if="!sourceOk">{{ active ? active.server_name + ' is down, so its data cannot be copied now.' : '' }}</span>
            <span class="hint" v-else>Recommended. {{ target ? target.server_name : 'The target' }} gets the latest data, so nothing is lost.</span></span>
        </label>
        <label v-if="f.syncDb" class="check" style="margin-left:26px"><input type="checkbox" v-model="f.backupTarget"><span class="check-text"><b>Back up {{ target ? target.server_name : 'target' }}'s current database first</b><span class="hint">If the copy fails, it is restored automatically.</span></span></label>
        <label class="check" :class="{ disabled: !hasFiles || !sourceOk }"><input type="checkbox" v-model="f.syncFiles" :disabled="!hasFiles || !sourceOk"><span class="check-text"><b>Copy uploaded files too</b><span class="hint">{{ hasFiles ? 'Paths: ' + p.sync_paths.split('\\n').filter(Boolean).join(', ') : 'No file paths set in project settings.' }}</span></span></label>
        <label v-if="f.syncDb || f.syncFiles" class="check"><input type="checkbox" v-model="f.maintenance"><span class="check-text"><b>Maintenance mode on {{ active ? active.server_name : '' }} while copying</b><span class="hint">Stops new orders/sign-ups from being written to the old server during the copy.</span></span></label>
        <label v-if="(f.syncDb || f.syncFiles) && f.maintenance" class="check" style="margin-left:26px"><input type="checkbox" v-model="f.keepOldDown"><span class="check-text"><b>Keep {{ active ? active.server_name : 'the old server' }} in maintenance after the switch</b><span class="hint">Safest: visitors whose DNS still points to the old IP can't write to the old database. It can still take over again later (auto-failover turns maintenance off first).</span></span></label>
        <label class="check"><input type="checkbox" v-model="f.purgeCache"><span class="check-text"><b>Purge Cloudflare cache after switching</b></span></label>
        <label class="check"><input type="checkbox" v-model="f.force"><span class="check-text"><b>Force</b><span class="hint">Switch even if the target fails its health check.</span></span></label>
      </div>

      <div v-if="hasDb && !f.syncDb && target" class="alert alert-warn"><span class="alert-icon">⚠</span>
        <span>The database will <b>not</b> be copied. {{ target.server_name }} will serve its own data ({{ freshness(target).text.toLowerCase() }}). Anything saved on {{ active ? active.server_name : 'the old server' }} after that will be missing on {{ target.server_name }}.</span></div>
      <div v-if="target && target.health === 'down' && !f.force" class="alert alert-warn"><span class="alert-icon">⚠</span><span>{{ target.server_name }} is failing health checks — the switch will stop before touching DNS unless it recovers.</span></div>

      <div><div class="label mb-8">What will happen</div><ol class="steps"><li v-for="s in steps" :key="s">{{ s }}</li></ol></div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="submit" :disabled="busy || !target || !p.dns_records.length">Switch to {{ target ? target.server_name : '…' }}</button>
    </template>
  </modal>`,
};

/* ======================================================================= COPY DATABASE */
export const SyncDialog = {
  props: { project: Object, source: Number, target: Number },
  components: { Modal, HealthPill },
  setup(props) {
    const p = props.project;
    const active = p.deployments.find((d) => d.is_active);
    const src0 = props.source || active?.id || p.deployments[0]?.id;
    const f = reactive({
      source: src0,
      target: props.target || p.deployments.find((d) => d.id !== src0)?.id,
      db: p.deployments.some((d) => d.db_type !== 'none'),
      files: false,
      backupTarget: true,
      maintenance: false,
      confirm: '',
    });
    const source = computed(() => p.deployments.find((d) => d.id === f.source));
    const target = computed(() => p.deployments.find((d) => d.id === f.target));
    watch(() => f.target, () => { f.backupTarget = !target.value?.skip_backup; }, { immediate: true });
    const targetActive = computed(() => !!target.value?.is_active);
    const hasFiles = !!(p.sync_paths || '').trim();
    const busy = ref(false);
    function swap() {
      [f.source, f.target] = [f.target, f.source];
    }
    async function submit() {
      busy.value = true;
      try {
        const r = await http.post(`/projects/${p.id}/sync`, f);
        closeDialog();
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    return { p, f, source, target, targetActive, hasFiles, busy, swap, submit, freshness, closeDialog };
  },
  template: `
  <modal :title="'Copy data — ' + p.name" size="lg" @close="closeDialog">
    <div class="form">
      <div class="flow">
        <div class="field"><label>From</label><select v-model.number="f.source"><option v-for="d in p.deployments" :key="d.id" :value="d.id">{{ d.server_name }}{{ d.is_active ? ' (live)' : '' }}</option></select>
          <span class="hint" v-if="source" :class="freshness(source).cls">{{ freshness(source).text }}</span></div>
        <button class="btn btn-ghost flow-arrow" title="Swap direction" @click="swap">⇄</button>
        <div class="field"><label>To (will be replaced)</label><select v-model.number="f.target"><option v-for="d in p.deployments" :key="d.id" :value="d.id">{{ d.server_name }}{{ d.is_active ? ' (live)' : '' }}</option></select>
          <span class="hint" v-if="target" :class="freshness(target).cls">{{ freshness(target).text }}</span></div>
      </div>
      <div v-if="f.source === f.target" class="result err">Pick two different servers.</div>

      <div class="fieldset">
        <label class="check"><input type="checkbox" v-model="f.db"><span class="check-text"><b>Database</b><span class="hint">The target database becomes an exact copy (tables that only exist on the target are removed).</span></span></label>
        <label v-if="f.db" class="check" style="margin-left:26px"><input type="checkbox" v-model="f.backupTarget"><span class="check-text"><b>Back up the target first</b><span class="hint">Restored automatically if the copy fails. Untick only if the target DB is new/empty.</span></span></label>
        <label class="check" :class="{ disabled: !hasFiles }"><input type="checkbox" v-model="f.files" :disabled="!hasFiles"><span class="check-text"><b>Uploaded files</b><span class="hint">{{ hasFiles ? 'New and changed files are copied; nothing is deleted on the target.' : 'No file paths set in project settings.' }}</span></span></label>
        <label v-if="source && source.is_active" class="check"><input type="checkbox" v-model="f.maintenance"><span class="check-text"><b>Maintenance mode on {{ source.server_name }} during the copy</b><span class="hint">Not needed for a normal standby refresh — the dump is a consistent snapshot either way.</span></span></label>
      </div>

      <div v-if="targetActive" class="alert alert-error"><span class="alert-icon">⚠</span>
        <div class="grow"><b>{{ target.server_name }} is the LIVE server.</b> Its current data (new orders, users…) will be replaced by {{ source ? source.server_name : '' }}'s copy.
          <div class="field mt-12"><label>Type <code>{{ p.slug }}</code> to confirm</label><input v-model="f.confirm" class="code" autocomplete="off"></div>
          <label class="check mt-8"><input type="checkbox" v-model="f.maintenance"><span class="check-text"><b>Maintenance mode on {{ target.server_name }} while replacing</b></span></label>
        </div></div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn" :class="targetActive ? 'btn-danger solid' : 'btn-primary'" @click="submit"
        :disabled="busy || f.source === f.target || (!f.db && !f.files) || (targetActive && f.confirm !== p.slug)">Copy {{ source ? source.server_name : '' }} → {{ target ? target.server_name : '' }}</button>
    </template>
  </modal>`,
};

/* ======================================================================= RESTORE */
export const RestoreDialog = {
  props: { project: Object, backup: Object },
  components: { Modal },
  setup(props) {
    const p = props.project;
    const b = props.backup;
    // Shared database: there is only one place to restore into.
    const choices = p.db_server_id ? [{ id: 'shared', server_name: 'Shared database server', is_active: true, db_type: 'shared' }] : p.deployments;
    const fallback = choices.find((d) => d.id === b.deployment_id) || choices.find((d) => d.is_active) || choices[0];
    const f = reactive({ target: fallback?.id, backupFirst: true, maintenance: true, confirm: '' });
    const target = computed(() => choices.find((d) => d.id === f.target));
    watch(() => f.target, () => { f.backupFirst = !target.value?.skip_backup; }, { immediate: true });
    const busy = ref(false);
    async function submit() {
      busy.value = true;
      try {
        const r = await http.post(`/backups/${b.id}/restore`, f);
        closeDialog();
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    return { p, b, f, target, choices, busy, submit, fmtDate, bytes, closeDialog };
  },
  template: `
  <modal :title="'Restore backup #' + b.id" @close="closeDialog">
    <div class="form">
      <div class="kv"><div><span>Taken</span><span>{{ fmtDate(b.created_at) }}</span></div><div><span>From</span><span>{{ b.server_name }} ({{ b.kind }})</span></div>
        <div><span>Size</span><span>{{ bytes(b.size) }}{{ b.tables != null ? ' · ' + b.tables + ' tables' : '' }}</span></div><div v-if="b.note"><span>Note</span><span>{{ b.note }}</span></div></div>
      <div class="field"><label>Restore into</label><select v-model="f.target"><option v-for="d in choices" :key="d.id" :value="d.id" :disabled="d.db_type === 'none'">{{ d.server_name }}{{ d.is_active ? ' (LIVE)' : '' }}</option></select></div>
      <label class="check"><input type="checkbox" v-model="f.backupFirst"><span class="check-text"><b>Back up the current database first</b><span class="hint">If the restore fails, this is put back automatically.</span></span></label>
      <div v-if="target && target.is_active" class="alert alert-error"><span class="alert-icon">⚠</span><div class="grow"><b>This is the LIVE server.</b> Everything written since {{ fmtDate(b.created_at) }} will be lost.
        <label class="check mt-8"><input type="checkbox" v-model="f.maintenance"><span class="check-text"><b>Maintenance mode during the restore</b></span></label>
        <div class="field mt-8"><label>Type <code>{{ p.slug }}</code> to confirm</label><input v-model="f.confirm" class="code" autocomplete="off"></div></div></div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn" :class="target && target.is_active ? 'btn-danger solid' : 'btn-primary'" @click="submit" :disabled="busy || !target || (target.is_active && f.confirm !== p.slug)">Restore</button>
    </template>
  </modal>`,
};

/* ======================================================================= RUN COMMAND */
const APP_PRESETS = ['php artisan optimize:clear', 'php artisan optimize', 'php artisan migrate --force', 'php artisan migrate:status', 'php artisan queue:restart', 'php artisan schedule:list', 'php artisan about'];
const HOST_PRESETS = ['docker compose ps', 'docker compose logs --tail=100', 'docker compose restart', 'docker compose pull && docker compose up -d', 'git log -5 --oneline', 'df -h && free -m', 'docker system df'];

export const CommandDialog = {
  props: { dep: Object, server: Object },
  components: { Modal },
  setup(props) {
    const f = reactive({ where: props.dep?.app_container ? 'app' : 'host', command: '', cwd: '' });
    const busy = ref(false);
    const presets = computed(() => (f.where === 'app' ? APP_PRESETS : HOST_PRESETS));
    async function submit() {
      busy.value = true;
      try {
        const r = props.dep ? await http.post(`/deployments/${props.dep.id}/command`, f) : await http.post(`/servers/${props.server.id}/command`, { command: f.command, cwd: f.cwd });
        closeDialog();
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    const title = computed(() => `Run command on ${props.dep ? props.dep.server_name : props.server.name}`);
    return { f, busy, presets, submit, title, closeDialog };
  },
  template: `
  <modal :title="title" size="lg" @close="closeDialog">
    <div class="form">
      <div v-if="dep" class="seg" style="align-self:flex-start">
        <button type="button" :class="{ on: f.where === 'app' }" :disabled="!dep.app_container" @click="f.where = 'app'">Inside app container{{ dep.app_container ? ' (' + dep.app_container + ')' : '' }}</button>
        <button type="button" class="admin-only" :class="{ on: f.where === 'host' }" @click="f.where = 'host'">Server shell{{ dep.app_dir ? ' in ' + dep.app_dir : '' }}</button>
      </div>
      <div v-else class="field"><label>Working directory <span class="muted">(optional)</span></label><input v-model="f.cwd" class="code" placeholder="/home/deploy/shop"></div>
      <div class="chips"><button v-for="p in presets" :key="p" type="button" class="chip" @click="f.command = p">{{ p }}</button></div>
      <div class="field"><label>Command</label><textarea v-model="f.command" class="code" rows="4" placeholder="php artisan cache:clear" @keydown.ctrl.enter="submit" @keydown.meta.enter="submit"></textarea>
        <span class="hint">Runs over SSH; output streams live. <span class="kbd">Ctrl/⌘ + Enter</span> to run. Interactive commands are not supported.</span></div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="submit" :disabled="busy || !f.command.trim()">Run</button>
    </template>
  </modal>`,
};

/* ======================================================================= CONTAINER LOGS */
export const LogsDialog = {
  // A container (container) or an app outside Docker (app: { type: 'pm2'|'service', user, name }).
  props: { server: Object, container: String, app: Object },
  components: { Modal },
  setup(props) {
    const tail = ref(200);
    const label = props.app ? (props.app.type === 'pm2' ? `pm2 ${props.app.name}` : props.app.name) : props.container;
    const text = ref('');
    const loading = ref(false);
    const box = ref(null);
    async function load() {
      loading.value = true;
      try {
        const a = props.app;
        const r = a
          ? await http.get(`/servers/${props.server.id}/apps/logs?type=${a.type}&user=${encodeURIComponent(a.user || '')}&name=${encodeURIComponent(a.name)}&tail=${tail.value}`)
          : await http.get(`/servers/${props.server.id}/containers/${encodeURIComponent(props.container)}/logs?tail=${tail.value}`);
        text.value = r.log || '(no output)';
        setTimeout(() => box.value && (box.value.scrollTop = box.value.scrollHeight));
      } catch (e) {
        text.value = `Error: ${e.message}`;
      } finally {
        loading.value = false;
      }
    }
    onMounted(load);
    return { tail, text, loading, load, box, label, closeDialog };
  },
  template: `
  <modal :title="'Logs — ' + label + ' @ ' + server.name" size="xl" @close="closeDialog">
    <div class="row gap-8 mb-12">
      <select v-model.number="tail" style="width:150px" @change="load"><option :value="100">Last 100 lines</option><option :value="200">Last 200 lines</option><option :value="500">Last 500 lines</option><option :value="2000">Last 2000 lines</option></select>
      <button class="btn btn-sm" @click="load" :disabled="loading"><span v-if="loading" class="spinner"></span>Refresh</button>
    </div>
    <pre ref="box" class="code-block">{{ text }}</pre>
  </modal>`,
};

/* ======================================================================= CLONE SERVER */
export const CloneDialog = {
  props: { server: Object },
  components: { Modal },
  setup(props) {
    const s = props.server;
    const others = computed(() => (store.overview?.servers || []).filter((x) => x.id !== s.id));
    const f = reactive({
      target: null,
      installDocker: true,
      host: true,
      hostApps: true,
      freeze: true,
      replace: false,
      addToProjects: true,
      extraPaths: '',
      confirm: '',
      stacks: null, // picked compose projects (null = all, until the first scan lists them)
      folders: null, // picked app folders outside Docker
    });
    const plan = ref(null);
    const scanError = ref('');
    const scanning = ref(false);
    const busy = ref(false);
    const target = computed(() => others.value.find((x) => x.id === f.target));
    const body = () => ({ ...f, confirm: undefined });
    // Any option change makes the old scan stale.
    const stamp = computed(() => JSON.stringify(body()));
    const scannedStamp = ref('');
    const stale = computed(() => !!plan.value && scannedStamp.value !== stamp.value);
    async function scan() {
      if (!f.target) return;
      scanning.value = true;
      scanError.value = '';
      plan.value = null;
      try {
        const r = await http.post(`/servers/${s.id}/clone/preview`, body());
        if (r.ok) {
          plan.value = r.plan;
          // First scan: everything is picked; the boxes start ticked.
          if (f.stacks === null) f.stacks = r.plan.stacks.filter((x) => x.selected).map((x) => x.project);
          if (f.folders === null) f.folders = (r.plan.hostApps?.folders || []).filter((x) => x.selected).map((x) => x.path);
          scannedStamp.value = JSON.stringify(body());
        } else scanError.value = r.error;
      } catch (e) {
        scanError.value = e.message;
      } finally {
        scanning.value = false;
      }
    }
    const canStart = computed(() => plan.value && !plan.value.problems.length && !stale.value && !scanning.value && target.value && f.confirm === target.value.name);
    // Picking projects: tick boxes, all / none; the plan is checked again shortly after a change.
    const toggle = (key, v) => {
      const list = f[key] || [];
      f[key] = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
    };
    const pickAll = (on) => {
      f.stacks = on ? plan.value.stacks.map((x) => x.project) : [];
      f.folders = on ? (plan.value.hostApps?.folders || []).map((x) => x.path) : [];
    };
    let again = null;
    watch(
      () => stamp.value,
      () => {
        if (!plan.value || !stale.value) return;
        clearTimeout(again);
        again = setTimeout(() => stale.value && !scanning.value && scan(), 700);
      },
    );
    const pickedCount = computed(() => (f.stacks?.length || 0) + (f.folders?.length || 0));
    const totalCount = computed(() => (plan.value?.stacks.length || 0) + (plan.value?.hostApps?.folders.length || 0));
    async function submit() {
      busy.value = true;
      try {
        const r = await http.post(`/servers/${s.id}/clone`, body());
        closeDialog();
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    return { s, others, f, plan, scanError, scanning, busy, target, stale, canStart, scan, submit, bytes, closeDialog, toggle, pickAll, pickedCount, totalCount };
  },
  template: `
  <modal :title="'Clone ' + s.name + ' to another server'" size="lg" @close="closeDialog">
    <div class="form">
      <p class="muted small" style="margin:0">Makes the other server a copy of <b>{{ s.name }}</b>: Docker, the exact images, every Docker Compose stack with its files, volumes and databases, plus host setup (packages, users, cron, configs, timezone, swap, firewall). Network settings, hostname and SSH host keys are left alone so the new server stays reachable. Traffic is <b>not</b> moved.</p>

      <div class="field"><label>Clone to</label>
        <select v-model.number="f.target"><option :value="null" disabled>Pick a server…</option><option v-for="x in others" :key="x.id" :value="x.id">{{ x.name }} ({{ x.ip }})</option></select>
        <span class="hint" v-if="!others.length">Add the new server first (Servers → Add server). It only needs SSH as root or a sudo user.</span>
        <span class="hint" v-else>Best: a brand-new server. Everything listed in the scan gets overwritten there.</span>
      </div>

      <div class="fieldset">
        <label class="check"><input type="checkbox" v-model="f.installDocker"><span class="check-text"><b>Install Docker if it's missing</b><span class="hint">Uses Docker's official get.docker.com script (Ubuntu, Debian, CentOS/Rocky, Fedora…).</span></span></label>
        <label class="check"><input type="checkbox" v-model="f.host"><span class="check-text"><b>Copy host setup</b><span class="hint">apt packages, users and groups (same IDs), SSH authorized keys, crontabs, /etc configs (nginx, letsencrypt, supervisor, sudoers.d, custom systemd units…), timezone, swap and ufw firewall.</span></span></label>
        <div v-if="f.host" class="field" style="margin-left:26px"><label>Extra paths to copy <span class="muted">(optional, one per line)</span></label><textarea v-model="f.extraPaths" rows="2" class="code" placeholder="/opt/scripts&#10;/home/deploy/.config"></textarea></div>
        <label class="check"><input type="checkbox" v-model="f.hostApps"><span class="check-text"><b>Copy apps outside Docker</b><span class="hint">Vue/Nuxt/Node apps run by PM2 or systemd, and static sites served by nginx: their folders, the same Node.js (apt/NodeSource, nvm or /usr/local) and global npm packages like pm2 — then started the same way.</span></span></label>
        <label class="check"><input type="checkbox" v-model="f.freeze"><span class="check-text"><b>Pause each stack while its data is copied</b><span class="hint">Gives an exact snapshot of the databases. Each app on {{ s.name }} is frozen for the time its files and volumes take to copy (seconds to minutes), then resumes. Untick to copy live with no pause — then refresh the databases afterwards with "Copy data" on each project.</span></span></label>
        <label class="check"><input type="checkbox" v-model="f.addToProjects"><span class="check-text"><b>Add the new server to the same projects as a standby</b><span class="hint">Ready to switch to. Same containers and database settings as {{ s.name }}. Only the projects whose files you picked below.</span></span></label>
        <label class="check"><input type="checkbox" v-model="f.replace"><span class="check-text"><b>Replace existing stacks on the target</b><span class="hint">Only needed to re-run a clone. Removes the target's containers of the same compose projects and replaces their volumes.</span></span></label>
      </div>

      <div class="row gap-8"><button class="btn" @click="scan" :disabled="!f.target || scanning"><span v-if="scanning" class="spinner"></span>{{ plan ? 'Scan again' : 'Scan both servers' }}</button><span class="muted small">Reads both servers, changes nothing.</span></div>
      <div v-if="scanError" class="result err">{{ scanError }}</div>
      <div v-if="stale" class="alert alert-warn"><span class="alert-icon">⚠</span><span>{{ plan ? 'Picks or options changed — checking again…' : 'Options changed — scan again.' }}</span></div>

      <template v-if="plan">
        <div class="flow small">
          <div class="card card-body"><div class="strong">{{ plan.source.name }}</div><div class="muted">{{ plan.source.os }} · {{ plan.source.arch }} · Docker {{ plan.source.docker }}</div></div>
          <span class="flow-arrow">→</span>
          <div class="card card-body"><div class="strong">{{ plan.target.name }}</div><div class="muted">{{ plan.target.os }} · {{ plan.target.arch }} · Docker {{ plan.target.docker === 'none' ? 'not installed' : plan.target.docker }} · {{ bytes(plan.target.free) }} free</div></div>
        </div>
        <div v-for="p in plan.problems" :key="p" class="result err">✖ {{ p }}</div>
        <div v-for="w in plan.warnings" :key="w" class="alert alert-warn"><span class="alert-icon">⚠</span><span>{{ w }}</span></div>

        <div class="row between wrap gap-8"><div class="label">What to copy — {{ pickedCount }} of {{ totalCount }} picked</div>
          <div class="row gap-8"><button class="btn btn-xs" @click="pickAll(true)">All</button><button class="btn btn-xs" @click="pickAll(false)">None</button></div></div>
        <div><div class="label mb-8">Docker projects (stacks)</div>
          <div class="card table-wrap"><table class="table"><tbody>
            <tr v-for="st in plan.stacks" :key="st.project" :style="f.stacks && !f.stacks.includes(st.project) ? 'opacity:.55' : ''">
              <td style="width:28px"><input type="checkbox" :checked="!f.stacks || f.stacks.includes(st.project)" @change="toggle('stacks', st.project)" :aria-label="'Copy ' + st.project"></td>
              <td><span class="strong">{{ st.project }}</span> <span class="badge" :class="st.running ? 'badge-green' : 'badge-gray'">{{ st.running ? 'running' : 'stopped' }}</span><div class="tiny muted mono">{{ st.dir || 'no folder' }}</div></td>
              <td class="small muted">{{ st.containers.length }} containers · {{ st.volumes.length }} volumes<span v-if="st.binds.length"> · {{ st.binds.length }} outside paths</span></td>
              <td class="small">{{ bytes(st.bytes) }}</td>
            </tr>
            <tr v-if="!plan.stacks.length"><td class="muted">No compose stacks found.</td></tr>
          </tbody></table></div>
          <div class="tiny muted mt-8" v-if="plan.looseVolumes.length">Also {{ plan.looseVolumes.length }} unused volume(s): {{ plan.looseVolumes.join(', ') }}</div>
        </div>
        <div v-if="plan.hostApps && plan.hostApps.folders.length"><div class="label mb-8">Apps outside Docker (by folder)</div>
          <div class="card table-wrap"><table class="table"><tbody>
            <tr v-for="d in plan.hostApps.folders" :key="d.path" :style="f.folders && !f.folders.includes(d.path) ? 'opacity:.55' : ''">
              <td style="width:28px"><input type="checkbox" :checked="!f.folders || f.folders.includes(d.path)" @change="toggle('folders', d.path)" :aria-label="'Copy ' + d.path"></td>
              <td class="mono small">{{ d.path }}</td>
              <td class="small muted">{{ d.apps.join(', ') || 'files only' }}</td>
              <td class="small">{{ bytes(d.bytes) }}</td>
            </tr>
          </tbody></table></div>
        </div>
        <div v-if="plan.hostApps && (plan.hostApps.pm2.length || plan.hostApps.services.length || plan.hostApps.sites.length)"><div class="label mb-8">Found outside Docker</div>
          <div class="small" style="display:flex;flex-direction:column;gap:4px">
            <div v-if="plan.hostApps.pm2.length"><b>PM2:</b> <span v-for="(a, i) in plan.hostApps.pm2" :key="a.user + a.name">{{ i ? ', ' : '' }}{{ a.name }} <span class="muted">({{ a.user }}, {{ a.status }})</span></span></div>
            <div v-if="plan.hostApps.services.length"><b>systemd:</b> {{ plan.hostApps.services.join(', ') }}</div>
            <div v-if="plan.hostApps.sites.length"><b>nginx sites:</b> {{ plan.hostApps.sites.map((x) => (x.names[0] || 'default') + ' (' + x.kind + ')').join(', ') }}</div>
            <div><b>Node.js:</b> <template v-if="plan.hostApps.node">{{ plan.hostApps.node.version }} ({{ plan.hostApps.node.kind }})</template><template v-for="n in plan.hostApps.nvm" :key="n.user"> · nvm {{ n.user }}: {{ n.versions.join(', ') }}</template><template v-if="!plan.hostApps.node && !plan.hostApps.nvm.length">none</template><template v-if="plan.hostApps.npmGlobals.length"> · npm -g: {{ plan.hostApps.npmGlobals.join(' ') }}</template></div>
          </div>
        </div>
        <div class="small"><b>Images:</b> {{ plan.images.count }} in use, {{ plan.images.toCopy }} to copy ({{ bytes(plan.bytes.images) }})</div>
        <div v-if="plan.host" class="small" style="display:flex;flex-direction:column;gap:4px">
          <div><b>Packages to install:</b> <span v-if="plan.host.packages.length" class="mono">{{ plan.host.packages.join(' ') }}</span><span v-else class="muted">none</span></div>
          <div><b>Users:</b> {{ plan.host.users.join(', ') || 'none' }} · <b>Crontabs:</b> {{ plan.host.crontabs.join(', ') || 'none' }}</div>
          <div><b>Timezone:</b> {{ plan.host.timezone || '?' }} · <b>Swap:</b> {{ plan.host.swap ? bytes(plan.host.swap) : 'none' }} · <b>Firewall (ufw):</b> {{ plan.host.ufw }}</div>
          <div><b>Host files:</b> <span class="mono">{{ plan.host.paths.join(', ') || 'none' }}</span></div>
          <div v-if="plan.host.units.length"><b>systemd units:</b> {{ plan.host.units.join(', ') }}</div>
        </div>
        <div class="strong">Total to copy: about {{ bytes(plan.bytes.total) }}</div>

        <div v-if="!plan.problems.length" class="field"><label>Type <code>{{ target && target.name }}</code> to confirm — its stacks and files listed above will be overwritten</label><input v-model="f.confirm" class="code" autocomplete="off"></div>
      </template>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="submit" :disabled="busy || !canStart">Start clone</button>
    </template>
  </modal>`,
};

/* ======================================================================= GLOBAL: job log + confirm */
export const JobModal = {
  components: { Modal, JobLog, DeployLive, ProxyLive },
  setup() {
    // A deploy (or rollback) shows its live view above the log.
    const progress = ref(null);
    const status = ref(null);
    watch(() => store.jobId, () => ((progress.value = null), (status.value = null)));
    return { store, progress, status, close: () => (store.jobId = null), open: () => { go(`/jobs/${store.jobId}`); store.jobId = null; } };
  },
  template: `
  <modal v-if="store.jobId" :title="'Job #' + store.jobId" size="xl" @close="close">
    <deploy-live v-if="progress && progress.kind === 'deploy'" :progress="progress" :status="status" />
    <proxy-live v-if="progress && progress.kind === 'proxy'" :progress="progress" :status="status" />
    <job-log :job-id="store.jobId" :key="store.jobId" @progress="(p) => (progress = p)" @status="(s) => (status = s)" />
    <template #footer><button class="btn btn-ghost" @click="open">Open as page</button><button class="btn" @click="close">Close</button></template>
  </modal>`,
};

export const ConfirmDialog = {
  components: { Modal },
  setup() {
    const typed = ref('');
    const finish = (v) => {
      store.confirm?.resolve(v);
      store.confirm = null;
      typed.value = '';
    };
    return { store, typed, finish };
  },
  template: `
  <modal v-if="store.confirm" :title="store.confirm.title" size="sm" @close="finish(false)">
    <p v-if="store.confirm.message" style="white-space:pre-line">{{ store.confirm.message }}</p>
    <div v-if="store.confirm.typeToConfirm" class="field"><label>Type <code>{{ store.confirm.typeToConfirm }}</code> to confirm</label><input v-model="typed" class="code" autocomplete="off" @keydown.enter="typed === store.confirm.typeToConfirm && finish(true)"></div>
    <template #footer>
      <button class="btn btn-ghost" @click="finish(false)">Cancel</button>
      <button class="btn" :class="store.confirm.danger ? 'btn-danger solid' : 'btn-primary'" :disabled="store.confirm.typeToConfirm && typed !== store.confirm.typeToConfirm" @click="finish(true)">{{ store.confirm.confirmText }}</button>
    </template>
  </modal>`,
};

export const DIALOGS = {
  billing: BillingDialog,
  'billing-paid': PaidDialog,
  server: ServerDialog,
  project: ProjectDialog,
  'template-project': TemplateProjectDialog,
  staging: StagingDialog,
  'connect-git': ConnectGitDialog,
  'ci-run': RunViewer,
  'deploy-plan': DeployPlanDialog,
  power: PowerDialog,
  password: PasswordDialog,
  port: PortDialog,
  domain: DomainDialog,
  proxy: ProxyDialog,
  deployment: DeploymentDialog,
  switch: SwitchDialog,
  sync: SyncDialog,
  clone: CloneDialog,
  'project-copy': CopyProjectDialog,
  'server-reset': ResetServerDialog,
  'server-reinstall': ReinstallDialog,
  'server-cleanup': CleanupDialog,
  'ssh-guard': SshGuardDialog,
  'remove-deployment': RemoveDeploymentDialog,
  'delete-project': DeleteProjectDialog,
  'lb-setup': LbSetupDialog,
  'db-server': DbServerDialog,
  'scale-out': ScaleOutDialog,
  'os-upgrade': OsUpgradeDialog,
  restore: RestoreDialog,
  command: CommandDialog,
  logs: LogsDialog,
};

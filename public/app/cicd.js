import { ref, reactive, computed, watch, onMounted } from '/vendor/vue.js';
import { store, http, toast, closeDialog, go, showJob, runJob, confirmBox, openDialog, fmtDate } from './lib.js';

/* ------------------------------------------------------------------ Cloudflare zone picker */
export const ZoneSelect = {
  props: { modelValue: Object, domain: String, optional: Boolean },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const zones = ref(null);
    const error = ref('');
    const id = ref(props.modelValue?.zone_id || '');
    onMounted(async () => {
      try {
        zones.value = await http.get('/cloudflare/zones');
        if (!id.value) guess();
      } catch (e) {
        error.value = e.message;
        zones.value = [];
      }
    });
    function guess() {
      const d = (props.domain || '').toLowerCase();
      const z = (zones.value || []).filter((x) => d === x.name || d.endsWith(`.${x.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
      if (z) id.value = z.id;
    }
    watch(() => props.domain, () => zones.value && guess());
    watch(id, (v) => {
      const z = (zones.value || []).find((x) => x.id === v);
      emit('update:modelValue', z ? { zone_id: z.id, zone_name: z.name } : null);
    });
    return { zones, error, id };
  },
  template: `
    <div>
      <select v-model="id" :disabled="!zones">
        <option value="">{{ !zones ? 'Loading zones…' : optional ? '— no DNS (I will do it myself) —' : '— choose a zone —' }}</option>
        <option v-for="z in zones || []" :key="z.id" :value="z.id">{{ z.name }}</option>
      </select>
      <div v-if="error" class="hint text-amber">{{ error }}</div>
    </div>`,
};

/* ------------------------------------------------------------------ new project from a template */
export const TemplateProjectDialog = {
  components: { ZoneSelect },
  setup() {
    const info = ref(null);
    const servers = ref([]);
    const f = reactive({ template: 'laravel', db: 'mysql', name: '', domain: '', www: true, zone: null, servers: [], code: 'new', repo: '', branch: 'main', privateRepo: true, takeoverDns: false });
    const busy = ref(false);
    onMounted(async () => {
      [info.value, servers.value] = await Promise.all([http.get('/templates'), http.get('/servers')]);
      if (!info.value.github) f.code = 'none';
      if (servers.value.length === 1) f.servers = [servers.value[0].id];
    });
    const tpl = computed(() => info.value?.templates.find((t) => t.id === f.template));
    watch(() => f.template, () => {
      if (tpl.value && !tpl.value.dbs.includes(f.db)) f.db = tpl.value.dbs[0];
    });
    watch(() => f.name, (n, old) => {
      const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!f.repo || f.repo.endsWith(`/${slug(old || '')}`)) f.repo = f.repo.includes('/') ? `${f.repo.split('/')[0]}/${slug(n)}` : slug(n) ? `your-name/${slug(n)}` : '';
    });
    const toggle = (id) => (f.servers = f.servers.includes(id) ? f.servers.filter((x) => x !== id) : [...f.servers, id]);
    async function create() {
      busy.value = true;
      try {
        const r = await http.post('/projects/from-template', f);
        closeDialog();
        store.live++;
        go(`/projects/${r.project.id}`);
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    return { info, servers, f, tpl, toggle, busy, create, closeDialog };
  },
  template: `
  <modal title="New project from a template" size="lg" @close="closeDialog">
    <div v-if="!info" class="muted">Loading…</div>
    <div v-else class="form">
      <p class="muted" style="margin:0">Switchboard sets up everything: Docker, the app and its database, a web proxy, the Cloudflare DNS record and (optionally) a new GitHub repository. Then turn on CI/CD in the project's <b>CI/CD</b> tab.</p>
      <div class="fieldset">
        <div class="fieldset-title">1. What kind of app?</div>
        <div class="seg"><button v-for="t in info.templates" :key="t.id" type="button" :class="{ on: f.template === t.id }" @click="f.template = t.id">{{ t.label }}</button></div>
        <div class="hint">{{ tpl && tpl.hint }}</div>
        <div v-if="tpl && tpl.dbs.length > 1" class="field"><label>Database</label>
          <div class="seg" style="align-self:flex-start"><button v-for="d in tpl.dbs" :key="d" type="button" :class="{ on: f.db === d }" @click="f.db = d">{{ info.dbs[d] }}</button></div></div>
      </div>
      <div class="fieldset">
        <div class="fieldset-title">2. Name and address</div>
        <div class="form-row">
          <div class="field"><label>Project name</label><input v-model="f.name" placeholder="Home Electric Shop"></div>
          <div class="field"><label>Domain</label><input v-model="f.domain" class="code" placeholder="shop.example.com"></div>
        </div>
        <div class="form-row" v-if="f.domain">
          <div class="field"><label>Cloudflare zone (creates the DNS record)</label><zone-select v-model="f.zone" :domain="f.domain" optional /></div>
          <div class="field"><label>&nbsp;</label>
            <label class="check"><input type="checkbox" v-model="f.www"><span class="check-text">Also <code>www.{{ f.domain }}</code></span></label>
            <label class="check"><input type="checkbox" v-model="f.takeoverDns"><span class="check-text">If the record already exists, point it to the new server<span class="hint">Off = the existing record is linked but not changed (switch later).</span></span></label></div>
        </div>
      </div>
      <div class="fieldset">
        <div class="fieldset-title">3. Code</div>
        <div class="seg" style="align-self:flex-start">
          <button type="button" :class="{ on: f.code === 'new' }" :disabled="!info.github" @click="f.code = 'new'">New GitHub repository</button>
          <button type="button" :class="{ on: f.code === 'repo' }" :disabled="!info.github" @click="f.code = 'repo'">My existing GitHub repository</button>
          <button type="button" :class="{ on: f.code === 'none' }" @click="f.code = 'none'">No repository (starter app)</button>
        </div>
        <div v-if="!info.github" class="hint text-amber">Add a GitHub token in Settings → GitHub to use repositories and CI/CD.</div>
        <div class="form-row" v-if="f.code !== 'none'">
          <div class="field"><label>Repository (owner/name)</label><input v-model="f.repo" class="code" placeholder="acme/shop"></div>
          <div class="field"><label>Branch</label><input v-model="f.branch" class="code" placeholder="main"></div>
        </div>
        <label v-if="f.code === 'new'" class="check"><input type="checkbox" v-model="f.privateRepo"><span class="check-text">Private repository</span></label>
        <div class="hint" v-if="f.code === 'new'">Switchboard creates the repository, starts a fresh {{ tpl && tpl.label }} app in it and pushes the first commit.</div>
        <div class="hint" v-else-if="f.code === 'repo'">Each server gets its own read-only deploy key. If the repo has no <code>compose.switchboard.yml</code>, the template's Docker files are added on the server only (not committed).</div>
        <div class="hint" v-else>A small starter app is created on the server. You can connect a repository later.</div>
      </div>
      <div class="fieldset">
        <div class="fieldset-title">4. Servers</div>
        <div v-if="!servers.length" class="hint">Add a server first (Servers → Add server).</div>
        <div class="chips"><button v-for="s in servers" :key="s.id" type="button" class="chip" :class="{ on: f.servers.includes(s.id) }" @click="toggle(s.id)">{{ s.name }} <span class="muted mono">{{ s.ip }}</span></button></div>
        <div class="hint">The first one becomes the live server, the others are standbys. Docker is installed if missing. The app goes in <code>/srv/&lt;project&gt;</code>; ports 80/443 are served by the server's nginx, or a small nginx container if there is none.</div>
      </div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="create" :disabled="busy || !f.name || !f.servers.length || (f.code !== 'none' && !f.repo)">Create and set up</button>
    </template>
  </modal>`,
};

/* ------------------------------------------------------------------ staging copy */
export const StagingDialog = {
  props: { project: Object, servers: Array },
  components: { ZoneSelect },
  setup(props) {
    const p = props.project;
    const base = (p.domain || '').replace(/^www\./, '');
    const f = reactive({ label: 'staging', server_id: props.servers[0]?.id || '', domain: base ? `staging.${base}` : '', branch: 'staging', zone: null });
    watch(() => f.label, (l, old) => {
      if (f.domain.startsWith(`${old}.`)) f.domain = `${l}.${f.domain.slice(old.length + 1)}`;
      if (f.branch === old) f.branch = l;
    });
    const busy = ref(false);
    async function create() {
      busy.value = true;
      try {
        const r = await http.post(`/projects/${p.id}/staging`, f);
        closeDialog();
        store.live++;
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    return { p, f, busy, create, closeDialog };
  },
  template: `
  <modal :title="'Add a staging copy of ' + p.name" @close="closeDialog">
    <div class="form">
      <p class="muted" style="margin:0">A separate copy of the app for testing, with its own database, address and branch. It is a project of its own (shown in the sidebar) and is deployed when you push to its branch.</p>
      <div class="form-row">
        <div class="field"><label>Name</label><input v-model="f.label" class="code" placeholder="staging"></div>
        <div class="field"><label>Branch</label><input v-model="f.branch" class="code"><span class="hint">Created from {{ p.git_branch || 'main' }} if missing</span></div>
      </div>
      <div class="field"><label>Server</label><select v-model="f.server_id"><option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name }} ({{ s.ip }})</option></select>
        <span class="hint">Can be a cheap server, or the same one as the live site.</span></div>
      <div class="form-row">
        <div class="field"><label>Address</label><input v-model="f.domain" class="code" placeholder="staging.shop.com"></div>
        <div class="field"><label>Cloudflare zone</label><zone-select v-model="f.zone" :domain="f.domain" optional /></div>
      </div>
      <div class="hint">Its server is set to <b>"No backup needed — just update"</b>, so "Copy live data" overwrites it straight away.</div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="create" :disabled="busy || !f.server_id || !f.label">Create staging</button>
    </template>
  </modal>`,
};

/* ------------------------------------------------------------------ CI/CD tab */
const RUN_BADGE = (r) =>
  r.status !== 'completed'
    ? ['badge-blue', r.status === 'queued' ? 'queued' : 'running']
    : { success: ['badge-green', 'passed'], failure: ['badge-red', 'failed'], cancelled: ['badge-gray', 'cancelled'], skipped: ['badge-gray', 'skipped'], timed_out: ['badge-red', 'timed out'] }[r.conclusion] || ['badge-gray', r.conclusion || '?'];
const PREVIEW_BADGE = { waiting: ['badge-gray', 'waiting for CI'], building: ['badge-blue', 'building'], ready: ['badge-green', 'ready'], failed: ['badge-red', 'failed'] };

export const CicdTab = {
  props: { project: Object },
  emits: ['reload'],
  components: { ZoneSelect },
  setup(props) {
    const c = ref(null);
    const f = reactive({ git_repo: '', git_branch: 'main', ci_test_on: 'github', ci_test_cmd: '', preview_server_id: '', preview_zone: null });
    const showYaml = ref(false);
    const busy = ref({});
    const runBranch = ref('');
    const isAdmin = computed(() => store.user?.role === 'admin');
    async function load(live = false) {
      try {
        c.value = await http.get(`/projects/${props.project.id}/ci${live ? '?live=1' : ''}`);
        Object.assign(f, {
          git_repo: c.value.repo || '',
          git_branch: c.value.branch || 'main',
          ci_test_on: c.value.test_on,
          ci_test_cmd: c.value.test_cmd || c.value.default_tests,
          preview_server_id: c.value.preview.server_id || '',
          preview_zone: c.value.preview.zone,
        });
        if (!runBranch.value) runBranch.value = props.project.git_branch || c.value.branch;
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    onMounted(() => load(true));
    watch(() => store.live, () => load());
    async function act(key, fn, ok) {
      busy.value[key] = true;
      try {
        await fn();
        if (ok) toast(ok, 'success');
        await load(key === 'refresh');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value[key] = false;
      }
    }
    const save = () => act('save', () => http.put(`/projects/${props.project.id}/ci`, f), 'CI/CD settings saved');
    const setup = async () => {
      await http.put(`/projects/${props.project.id}/ci`, f).catch((e) => toast(e.message, 'error'));
      runJob(http.post(`/projects/${props.project.id}/ci/setup`, { commit: true }));
    };
    const updateServers = () => runJob(http.post(`/projects/${props.project.id}/ci/servers`));
    const commit = () => act('commit', () => http.post(`/projects/${props.project.id}/ci/commit`), 'Workflow committed to GitHub');
    const refresh = () => act('refresh', () => http.post(`/projects/${props.project.id}/ci/refresh`));
    const runNow = () => act('run', () => http.post(`/projects/${props.project.id}/ci/run`, { branch: runBranch.value }), `Started on ${runBranch.value} — it shows up below in a few seconds`);
    async function removeRunner(r) {
      if (!(await confirmBox({ title: `Remove the runner from ${r.server_name}?`, message: 'Deploys to this server stop until you set up CI/CD again.', confirmText: 'Remove', danger: true }))) return;
      runJob(http.del(`/projects/${props.project.id}/ci/runners/${r.id}`));
    }
    async function removePreview(pv) {
      if (!(await confirmBox({ title: `Remove the preview of #${pv.pr}?`, message: 'Its containers, data and DNS record are deleted. Pushing to the pull request again brings it back.', confirmText: 'Remove', danger: true }))) return;
      act('pv', () => http.del(`/projects/${props.project.id}/previews/${pv.id}`), 'Preview removed');
    }
    const addStaging = () => openDialog('staging', { project: props.project, servers: c.value.all_servers });
    const stagingData = async (s) => {
      if (!(await confirmBox({ title: `Copy live data to ${s.name}?`, message: `The database of ${s.name} is replaced with the live one.`, confirmText: 'Copy data' }))) return;
      runJob(http.post(`/projects/${c.value.root.id}/staging/${s.id}/data`));
    };
    const runBadge = RUN_BADGE;
    return { c, f, showYaml, busy, isAdmin, runBranch, load, save, setup, updateServers, commit, refresh, runNow, removeRunner, removePreview, addStaging, stagingData, runBadge, PREVIEW_BADGE, fmtDate };
  },
  template: `
  <div v-if="!c" class="muted">Loading…</div>
  <div v-else class="stack">
    <div v-if="!c.is_root" class="alert alert-info"><span class="alert-icon">ℹ</span><span>This is a staging copy. CI/CD is managed on <a :href="'#/projects/' + c.root.id">{{ c.root.name }}</a>; pushes to <code>{{ project.git_branch }}</code> deploy here.</span></div>
    <div v-if="!c.token" class="alert alert-warn"><span class="alert-icon">⚠</span><span>Add a GitHub token first: <a href="#/settings">Settings → GitHub</a>.</span></div>
    <div v-if="c.error" class="alert alert-error"><span class="alert-icon">✖</span><span>GitHub: {{ c.error }}</span></div>

    <div class="card card-body form" v-if="c.is_root">
      <div class="row between wrap gap-8"><h3>GitHub CI/CD</h3>
        <span v-if="c.enabled" class="badge badge-green">ON</span><span v-else class="badge badge-gray">not set up</span></div>
      <p class="hint" style="margin:0">On every push: tests run on GitHub's machines, then a <b>self-hosted runner</b> on each of your servers deploys the exact commit — standby servers first, the live one last, one at a time, stopping at the first failure. The runner can only run Switchboard's deploy/preview commands. Switchboard reads the results from GitHub (your servers and Switchboard need no open ports).</p>
      <div class="form-row">
        <div class="field"><label>Repository</label><input v-model="f.git_repo" class="code" placeholder="acme/shop" :disabled="!isAdmin"></div>
        <div class="field"><label>Live branch</label><input v-model="f.git_branch" class="code" placeholder="main" :disabled="!isAdmin"></div>
      </div>
      <div class="field"><label>Tests before deploying</label>
        <div class="seg" style="align-self:flex-start"><button type="button" :class="{ on: f.ci_test_on === 'github' }" @click="f.ci_test_on = 'github'" :disabled="!isAdmin">Run tests on GitHub</button><button type="button" :class="{ on: f.ci_test_on === 'none' }" @click="f.ci_test_on = 'none'" :disabled="!isAdmin">No tests</button></div></div>
      <div class="field" v-if="f.ci_test_on === 'github'"><label>Test commands <span class="muted">(bash, on ubuntu-latest{{ c.root.template === 'laravel' ? ' with PHP 8.4' : c.root.template ? ' with Node 24' : '' }})</span></label>
        <textarea v-model="f.ci_test_cmd" class="code" rows="4" :disabled="!isAdmin"></textarea></div>
      <div class="row gap-8 wrap admin-only">
        <button class="btn" @click="save" :disabled="busy.save">Save</button>
        <button class="btn btn-primary" @click="setup" :disabled="!f.git_repo || !c.token">{{ c.enabled ? 'Set up again (runners + workflow)' : 'Set up CI/CD' }}</button>
        <span class="hint">Installs the runner on {{ c.servers.map(s => s.name).join(', ') || 'the servers' }} and commits <code>{{ c.workflow_path }}</code>.</span>
      </div>
    </div>

    <div class="card" v-if="c.is_root && c.repo">
      <div class="card-head"><h3>Runs</h3>
        <div class="row gap-6 wrap">
          <span class="muted small" v-if="c.polled_at">checked <ago :at="c.polled_at" /></span>
          <button class="btn btn-sm" @click="refresh" :disabled="busy.refresh"><span v-if="busy.refresh" class="spinner"></span>Check now</button>
          <span class="dev-only row gap-6"><select v-model="runBranch" style="height:30px;max-width:150px"><option v-for="x in c.projects" :key="x.id" :value="x.branch">{{ x.branch }}</option></select>
          <button class="btn btn-sm btn-primary" @click="runNow" :disabled="busy.run || !c.enabled">Run now</button></span>
          <a class="btn btn-sm" :href="c.repo_url + '/actions'" target="_blank" rel="noopener">GitHub ↗</a></div></div>
      <div class="table-wrap"><table class="table" v-if="c.runs.length">
        <thead><tr><th>#</th><th>Result</th><th>Branch / event</th><th>Commit</th><th>By</th><th>When</th><th></th></tr></thead>
        <tbody><tr v-for="r in c.runs" :key="r.id">
          <td class="mono muted">{{ r.run_number }}</td>
          <td><span class="badge" :class="runBadge(r)[0]">{{ runBadge(r)[1] }}</span></td>
          <td><span class="mono small">{{ r.branch }}</span> <span class="muted small">{{ r.event === 'pull_request' ? 'pull request' : r.event === 'workflow_dispatch' ? 'run by hand' : r.event }}</span></td>
          <td class="small"><span class="mono muted">{{ (r.sha || '').slice(0, 7) }}</span> {{ r.title }}</td>
          <td class="small muted">{{ r.actor }}</td>
          <td class="small nowrap"><ago :at="r.created_at" /></td>
          <td class="actions"><a class="btn btn-xs" :href="r.html_url" target="_blank" rel="noopener">Log ↗</a></td>
        </tr></tbody>
      </table><div v-else class="empty">No runs yet{{ c.enabled ? ' — push a commit or click Run now.' : '.' }}</div></div>
    </div>

    <div class="card" v-if="c.is_root && c.repo">
      <div class="card-head"><h3>Runners on your servers</h3>
        <div class="row gap-6"><button class="btn btn-sm" @click="load(true)">Refresh status</button><button class="btn btn-sm admin-only" @click="updateServers" title="Send the latest deploy script and settings to the servers">Update servers</button></div></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Server</th><th>Runner label</th><th>Status</th><th>Version</th><th></th></tr></thead>
        <tbody><tr v-for="s in c.servers" :key="s.id">
          <td class="strong">{{ s.name }}</td><td class="mono small">{{ s.label }}</td>
          <template v-for="r in [c.runners.find(x => x.server_id === s.id)]" :key="s.id + 'r'">
            <td><template v-if="r"><span v-if="r.live" class="badge" :class="r.live.status === 'online' ? (r.live.busy ? 'badge-blue' : 'badge-green') : 'badge-red'">{{ r.live.status === 'online' ? (r.live.busy ? 'busy' : 'online') : r.live.status }}</span><span v-else class="badge badge-gray">installed</span></template>
              <span v-else class="muted small">not installed</span></td>
            <td class="small muted">{{ r ? r.version : '' }}</td>
            <td class="actions"><button v-if="r" class="btn btn-xs btn-danger admin-only" @click="removeRunner(r)">Remove</button></td>
          </template>
        </tr></tbody>
      </table></div>
      <div class="hint" style="padding:10px 18px 14px">Runs as user <code>sb-runner</code> in <code>/opt/switchboard-runner</code>, as a systemd service. Remove one here before you delete a server.</div>
    </div>

    <div class="card card-body form" v-if="c.is_root && c.repo">
      <div class="row between wrap gap-8"><h3>Workflow file</h3>
        <span v-if="c.up_to_date" class="badge badge-green">up to date in GitHub</span><span v-else class="badge badge-amber">{{ c.committed_at ? 'changed — commit again' : 'not committed yet' }}</span></div>
      <div class="hint" style="margin:0"><code>{{ c.workflow_path }}</code> on {{ c.projects.map(x => x.branch).join(' and ') }}. It changes when you add servers, staging or previews.</div>
      <div class="row gap-8 wrap"><button class="btn btn-sm admin-only" @click="commit" :disabled="busy.commit || !c.token">Commit to GitHub</button><button class="btn btn-sm" @click="showYaml = !showYaml">{{ showYaml ? 'Hide' : 'Show' }} file</button></div>
      <pre v-if="showYaml" class="log" style="min-height:0">{{ c.workflow }}</pre>
    </div>

    <div class="card">
      <div class="card-head"><h3>Staging</h3><button v-if="c.root.template && c.is_root" class="btn btn-sm admin-only" @click="addStaging">+ Add staging</button></div>
      <div v-if="!c.staging.length" class="empty">{{ c.root.template ? 'No staging copy yet. Add one to test changes on a real server before they go live.' : 'Staging copies can be made for projects created from a template.' }}</div>
      <div class="table-wrap" v-else><table class="table">
        <thead><tr><th>Name</th><th>Address</th><th>Branch</th><th>Server</th><th>Data</th><th></th></tr></thead>
        <tbody><tr v-for="s in c.staging" :key="s.id">
          <td class="strong"><a :href="'#/projects/' + s.id">{{ s.name }}</a></td>
          <td><a v-if="s.domain" :href="'https://' + s.domain" target="_blank" rel="noopener">{{ s.domain }} ↗</a></td>
          <td class="mono small">{{ s.git_branch }}</td>
          <td class="small">{{ s.deployments.map(d => d.server_name).join(', ') || '—' }}</td>
          <td class="small muted">{{ s.deployments[0] && s.deployments[0].data_note ? s.deployments[0].data_note : 'its own' }}<template v-if="s.deployments[0] && s.deployments[0].data_at"> · <ago :at="s.deployments[0].data_at" /></template></td>
          <td class="actions"><button class="btn btn-xs dev-only" @click="stagingData(s)" :disabled="!s.deployments.length">Copy live data</button></td>
        </tr></tbody>
      </table></div>
    </div>

    <div class="card" v-if="c.is_root && c.repo">
      <div class="card-head"><h3>Pull request previews</h3><span v-if="c.preview.server_id && c.preview.zone" class="badge badge-green">ON</span></div>
      <div class="card-body form" style="padding-top:0">
        <p class="hint" style="margin:0">Every pull request gets its own copy of the app, with an empty database (Laravel: migrated and seeded), at <code>{{ c.preview.example || 'pr-12-' + c.root.slug + '.example.com' }}</code>. It is removed when the pull request is closed. Only pull requests from branches of this repository (not forks) get a preview.</p>
        <div class="form-row admin-only" v-if="c.root.template">
          <div class="field"><label>Preview server</label><select v-model="f.preview_server_id"><option value="">— off —</option><option v-for="s in c.all_servers" :key="s.id" :value="s.id">{{ s.name }} ({{ s.ip }})</option></select></div>
          <div class="field"><label>Cloudflare zone for preview addresses</label><zone-select v-model="f.preview_zone" :domain="project.domain" /></div>
        </div>
        <div v-else class="hint">Previews need a project created from a template.</div>
        <div class="row gap-8 admin-only" v-if="c.root.template"><button class="btn btn-sm" @click="save" :disabled="busy.save">Save</button><span class="hint">Then "Set up CI/CD" again so the preview server gets a runner and the workflow gets the preview jobs.</span></div>
      </div>
      <div class="table-wrap" v-if="c.previews.length"><table class="table">
        <thead><tr><th>Pull request</th><th>Status</th><th>Address</th><th>Commit</th><th></th></tr></thead>
        <tbody><tr v-for="pv in c.previews" :key="pv.id">
          <td><a :href="c.repo_url + '/pull/' + pv.pr" target="_blank" rel="noopener">#{{ pv.pr }}</a> {{ pv.title }} <span class="muted small">{{ pv.author }} · {{ pv.branch }}</span></td>
          <td><span class="badge" :class="(PREVIEW_BADGE[pv.status] || PREVIEW_BADGE.waiting)[0]">{{ (PREVIEW_BADGE[pv.status] || PREVIEW_BADGE.waiting)[1] }}</span></td>
          <td><a :href="'https://' + pv.host" target="_blank" rel="noopener">{{ pv.host }} ↗</a></td>
          <td class="mono small muted">{{ (pv.sha || '').slice(0, 7) }}</td>
          <td class="actions"><button class="btn btn-xs btn-danger dev-only" @click="removePreview(pv)">Remove</button></td>
        </tr></tbody>
      </table></div>
    </div>
  </div>`,
};

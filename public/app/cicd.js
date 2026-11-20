import { ref, reactive, computed, watch, onMounted, onUnmounted } from '/vendor/vue.js';
import { store, http, toast, closeDialog, go, showJob, runJob, confirmBox, openDialog, fmtDate, isPrivateIp } from './lib.js';
import { whenText } from './deployplan.js';
import { FlowEditor } from './flow.js';

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

/* ------------------------------------------------------------------ folder picker (where on the server) */
export const FolderPicker = {
  props: { server: Object, start: String, appName: String },
  emits: ['pick', 'close'],
  setup(props, { emit }) {
    const view = ref(null);
    const error = ref('');
    const loading = ref(false);
    const typed = ref('');
    const newName = ref('');
    const creating = ref(false);
    async function open(path) {
      loading.value = true;
      error.value = '';
      try {
        view.value = await http.get(`/servers/${props.server.id}/folders?path=${encodeURIComponent(path || '/srv')}`);
        typed.value = view.value.path;
      } catch (e) {
        error.value = e.message;
      } finally {
        loading.value = false;
      }
    }
    const join = (a, b) => `${a.replace(/\/+$/, '')}/${b}`;
    async function create() {
      const name = newName.value.trim();
      if (!/^[A-Za-z0-9._-]+$/.test(name) || /^\.+$/.test(name)) return toast('Use letters, numbers, dot, dash or underscore for the folder name', 'error');
      creating.value = true;
      try {
        const r = await http.post(`/servers/${props.server.id}/folders`, { path: join(view.value.path, name) });
        newName.value = '';
        toast(`Created ${r.path} on ${props.server.name}`);
        await open(r.path);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        creating.value = false;
      }
    }
    // Start from the parent of the current choice (e.g. /srv for /srv/shop)
    onMounted(() => open((props.start || '/srv/x').replace(/\/[^/]*$/, '') || '/'));
    watch(() => props.server?.id, () => view.value && open(view.value.path));
    return { view, error, loading, typed, newName, creating, open, create, join, emit };
  },
  template: `
  <div class="folder-picker">
    <div class="folder-head">
      <span class="muted">On <b>{{ server.name }}</b></span>
      <span class="chips" v-if="view"><button v-for="p in view.places" :key="p" type="button" class="chip" :class="{ on: view.path === p }" @click="open(p)">{{ p }}</button></span>
    </div>
    <form class="folder-go" @submit.prevent="open(typed)"><input v-model.trim="typed" class="code" placeholder="/srv"><button class="btn btn-sm" type="submit">Go</button></form>
    <div v-if="error" class="hint text-red">{{ error }}</div>
    <div v-if="loading && !view" class="muted"><span class="spinner"></span> Looking at the server…</div>
    <template v-if="view">
      <div class="folder-list" :class="{ dim: loading }">
        <button v-if="view.parent" type="button" class="folder-row" @click="open(view.parent)"><span class="folder-ico">↩</span> .. <span class="muted">(up to {{ view.parent }})</span></button>
        <div v-if="!view.exists" class="hint text-amber">{{ view.path }} does not exist yet — it will be created.</div>
        <div v-else-if="!view.dirs.length" class="hint">No folders in here{{ view.empty ? ' (empty)' : '' }}.</div>
        <button v-for="d in view.dirs" :key="d" type="button" class="folder-row" @click="open(join(view.path, d))"><span class="folder-ico">📁</span> {{ d }}</button>
      </div>
      <form class="folder-go" @submit.prevent="create"><input v-model.trim="newName" class="code" placeholder="new-folder-name"><button class="btn btn-sm" type="submit" :disabled="creating || !newName || !view.exists">{{ creating ? 'Creating…' : 'New folder here' }}</button></form>
      <div class="folder-actions">
        <button type="button" class="btn btn-sm btn-primary" @click="emit('pick', join(view.path, appName))">Put the app in {{ join(view.path, appName) }}</button>
        <button v-if="view.path.split('/').filter(Boolean).length >= 2" type="button" class="btn btn-sm" :disabled="view.exists && !view.empty" :title="view.exists && !view.empty ? 'This folder already has files — the app needs an empty folder' : ''" @click="emit('pick', view.path)">Use {{ view.path }} itself</button>
        <button type="button" class="btn btn-sm btn-ghost" @click="emit('close')">Close</button>
      </div>
    </template>
  </div>`,
};

/* ------------------------------------------------------------------ new project from a template */
export const TemplateProjectDialog = {
  props: { fromRepo: Boolean },
  components: { ZoneSelect, FolderPicker },
  setup(props) {
    const info = ref(null);
    const servers = ref([]);
    const repos = ref(null);
    const detected = ref(null);
    const detecting = ref(false);
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const f = reactive({ template: 'laravel', db: 'mysql', name: '', domain: '', www: true, zone: null, servers: [], code: props.fromRepo ? 'repo' : 'new', repo: '', branch: 'main', privateRepo: true, takeoverDns: false, app_port: '', health_path: '/', ci: 'pull', folder: '/srv/' });
    const busy = ref(false);
    // Where the app goes on the server(s): /srv/<name> until the user picks or types another folder
    const folderTouched = ref(false);
    const browsing = ref(false);
    const slugName = computed(() => slug(f.name) || 'app');
    watch(slugName, (n) => {
      if (!folderTouched.value) f.folder = `/srv/${n}`;
    }, { immediate: true });
    const pickFolder = (p) => {
      f.folder = p;
      folderTouched.value = true;
      browsing.value = false;
    };
    const browseServer = computed(() => servers.value.find((x) => x.id === f.servers[0]));
    const folderOk = computed(() => /^\/[^/\0]+\/[^\0]*[^/]$/.test(f.folder) && !/(^|\/)\.\.?(\/|$)/.test(f.folder));
    let pickedTemplate = false;
    onMounted(async () => {
      [info.value, servers.value] = await Promise.all([http.get('/templates'), http.get('/servers')]);
      if (!info.value.github) f.code = 'none';
      if (servers.value.length === 1) f.servers = [servers.value[0].id];
      if (info.value.github) repos.value = await http.get('/github/repos').catch(() => []);
    });
    const tpl = computed(() => info.value?.templates.find((t) => t.id === f.template));
    const chooseTemplate = (id) => {
      pickedTemplate = true;
      f.template = id;
    };
    watch(() => f.template, (t) => {
      if (tpl.value && !tpl.value.dbs.includes(f.db)) f.db = tpl.value.dbs[0];
      if (t === 'compose' && f.code !== 'repo') f.code = 'repo';
    });
    watch(() => f.name, (n, old) => {
      if (f.code !== 'new') return;
      if (!f.repo || f.repo.endsWith(`/${slug(old || '')}`)) f.repo = f.repo.includes('/') ? `${f.repo.split('/')[0]}/${slug(n)}` : slug(n) ? `your-name/${slug(n)}` : '';
    });
    // Existing repo picked → look at it: branches, type, port.
    let timer = null;
    async function detect() {
      if (f.code !== 'repo' || !/^[\w.-]+\/[\w.-]+$/.test(f.repo)) return;
      detecting.value = true;
      try {
        const d = await http.get(`/github/repo-info?repo=${encodeURIComponent(f.repo)}`);
        detected.value = d;
        f.branch = d.default_branch || 'main';
        if (!pickedTemplate) f.template = d.suggest;
        if (d.ports.length && !f.app_port) f.app_port = d.ports[0];
        if (!f.name) f.name = d.repo.split('/')[1].replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      } catch (e) {
        detected.value = { error: e.message };
      } finally {
        detecting.value = false;
      }
    }
    watch(() => [f.repo, f.code], () => {
      detected.value = null;
      clearTimeout(timer);
      timer = setTimeout(detect, 500);
    });
    const privateServer = computed(() => f.servers.map((id) => servers.value.find((x) => x.id === id)).filter(Boolean).some((x) => isPrivateIp(x.ip)));
    const toggle = (id) => (f.servers = f.servers.includes(id) ? f.servers.filter((x) => x !== id) : [...f.servers, id]);
    const ready = computed(() => f.name && f.servers.length && folderOk.value && (f.code === 'none' || f.repo) && (f.template !== 'compose' || f.app_port));
    async function create() {
      busy.value = true;
      try {
        const r = await http.post('/projects/from-template', { ...f, ci: f.code === 'none' ? '' : f.ci });
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
    return { info, servers, repos, detected, detecting, f, tpl, chooseTemplate, toggle, privateServer, ready, busy, create, closeDialog, folderTouched, browsing, slugName, pickFolder, browseServer, folderOk };
  },
  template: `
  <modal :title="fromRepo ? 'Deploy a repo from my GitHub' : 'New app'" size="lg" @close="closeDialog">
    <div v-if="!info" class="muted">Loading…</div>
    <div v-else class="form">
      <p class="muted" style="margin:0">Switchboard puts the app on your server(s) — in Docker, or straight on the server for front-ends and PM2 apps — with (optionally) a domain with HTTPS through Cloudflare, and deploys every new push.</p>

      <div class="fieldset">
        <div class="fieldset-title">1. Code</div>
        <div class="seg" style="align-self:flex-start">
          <button type="button" :class="{ on: f.code === 'repo' }" :disabled="!info.github" @click="f.code = 'repo'">My GitHub repository</button>
          <button type="button" :class="{ on: f.code === 'new' }" :disabled="!info.github || f.template === 'compose'" @click="f.code = 'new'">New GitHub repository</button>
          <button type="button" :class="{ on: f.code === 'none' }" :disabled="f.template === 'compose'" @click="f.code = 'none'">No repository (starter app)</button>
        </div>
        <div v-if="!info.github" class="hint text-amber">Add a GitHub token in Settings → GitHub to use your repositories and CI/CD.</div>
        <template v-if="f.code === 'repo'">
          <div class="form-row">
            <div class="field"><label>Repository</label>
              <input v-model.trim="f.repo" class="code" list="sb-my-repos" :placeholder="repos ? 'start typing… (' + repos.length + ' repos)' : 'owner/name'">
              <datalist id="sb-my-repos"><option v-for="r in repos || []" :key="r.full_name" :value="r.full_name">{{ r.private ? 'private' : 'public' }}{{ r.description ? ' — ' + r.description : '' }}</option></datalist></div>
            <div class="field"><label>Branch to deploy</label>
              <select v-if="detected && detected.branches && detected.branches.length" v-model="f.branch"><option v-for="b in detected.branches" :key="b" :value="b">{{ b }}</option></select>
              <input v-else v-model="f.branch" class="code" placeholder="main"></div>
          </div>
          <div v-if="detecting" class="hint"><span class="spinner"></span> Looking at the repository…</div>
          <div v-else-if="detected && detected.error" class="hint text-red">{{ detected.error }}</div>
          <div v-else-if="detected" class="detect-box"><icon name="check" />
            <span><b>{{ detected.repo }}</b> · {{ detected.private ? 'private' : 'public' }} ·
              <template v-if="detected.compose">has <code>{{ detected.compose }}</code>{{ detected.ports.length ? ' (ports ' + detected.ports.join(', ') + ')' : '' }}</template>
              <template v-else-if="detected.suggest === 'laravel'">Laravel app</template><template v-else-if="detected.js && detected.js.framework">{{ detected.js.framework }} {{ detected.js.kind === 'frontend' ? 'front-end' : 'app' }}</template><template v-else-if="detected.suggest === 'node'">Node.js app</template><template v-else>static files</template>
              → <b>{{ (info.templates.find(t => t.id === detected.suggest) || {}).label }}</b></span></div>
        </template>
        <div class="form-row" v-if="f.code === 'new'">
          <div class="field"><label>New repository (owner/name)</label><input v-model="f.repo" class="code" placeholder="acme/shop"></div>
          <div class="field"><label>Branch</label><input v-model="f.branch" class="code" placeholder="main"></div>
        </div>
        <label v-if="f.code === 'new'" class="check"><input type="checkbox" v-model="f.privateRepo"><span class="check-text">Private repository</span></label>
      </div>

      <div class="fieldset">
        <div class="fieldset-title">2. What kind of app?</div>
        <div class="seg"><button v-for="t in info.templates" :key="t.id" type="button" :class="{ on: f.template === t.id }" @click="chooseTemplate(t.id)">{{ t.label }}</button></div>
        <div class="hint">{{ tpl && tpl.hint }}</div>
        <div v-if="detected && detected.js && detected.js.kind === 'server' && f.template === 'node'" class="hint">Prefer no Docker? Pick <b>Node app with PM2, no Docker</b> — the app runs straight on the server.</div>
        <div v-if="tpl && tpl.dbs.length > 1" class="field"><label>Database</label>
          <div class="seg" style="align-self:flex-start"><button v-for="d in tpl.dbs" :key="d" type="button" :class="{ on: f.db === d }" @click="f.db = d">{{ info.dbs[d] }}</button></div></div>
        <div v-if="f.template === 'compose'" class="form-row">
          <div class="field"><label>Port the app listens on</label><input v-model.number="f.app_port" class="code" placeholder="8080"><span class="hint">The left side of <code>ports: ["8080:8080"]</code> in its compose file.</span></div>
          <div class="field"><label>Health check page</label><input v-model="f.health_path" class="code" placeholder="/"><span class="hint">A page that answers 200 when the app works.</span></div>
        </div>
      </div>

      <div class="fieldset">
        <div class="fieldset-title">3. Name and address</div>
        <div class="form-row">
          <div class="field"><label>Project name</label><input v-model="f.name" placeholder="My App"></div>
          <div class="field"><label>Domain <span class="muted">(optional)</span></label><input v-model="f.domain" class="code" placeholder="app.example.com"></div>
        </div>
        <div v-if="privateServer" class="hint text-amber">A chosen server is on a private network (e.g. your home): no domain needed — open the app at <code>http://SERVER-IP:{{ f.app_port || 'PORT' }}</code> on your network. Deploys still work: Switchboard reaches the server, nothing has to reach it from outside.</div>
        <div class="form-row" v-if="f.domain">
          <div class="field"><label>Cloudflare zone (creates the DNS record)</label><zone-select v-model="f.zone" :domain="f.domain" optional /></div>
          <div class="field"><label>&nbsp;</label>
            <label class="check"><input type="checkbox" v-model="f.www"><span class="check-text">Also <code>www.{{ f.domain }}</code></span></label>
            <label class="check"><input type="checkbox" v-model="f.takeoverDns"><span class="check-text">If the record already exists, point it to the new server</span></label></div>
        </div>
      </div>

      <div class="fieldset">
        <div class="fieldset-title">4. Servers</div>
        <div v-if="!servers.length" class="hint">Add a server first (Servers → Add server).</div>
        <div class="chips"><button v-for="s in servers" :key="s.id" type="button" class="chip" :class="{ on: f.servers.includes(s.id) }" @click="toggle(s.id)">{{ s.name }} <span class="muted mono">{{ s.ip }}</span></button></div>
        <div class="hint">The first one becomes the live server. {{ tpl && tpl.host ? 'Node.js (and PM2) are installed if missing; Docker only when the server has no nginx (for the small web proxy).' : 'Docker is installed if missing.' }}</div>
        <div class="field"><label>Folder on the server</label>
          <div class="folder-go">
            <input v-model.trim="f.folder" class="code" placeholder="/srv/my-app" @input="folderTouched = true">
            <button type="button" class="btn btn-sm" :disabled="!browseServer" :title="browseServer ? '' : 'Choose a server first'" @click="browsing = !browsing">{{ browsing ? 'Hide' : 'Browse…' }}</button>
          </div>
          <span v-if="f.folder && !folderOk" class="hint text-red">Use a full path at least two levels deep, like /srv/shop or /home/deploy/shop.</span>
          <span v-else class="hint">The app goes in <code>{{ f.folder }}</code>{{ f.servers.length > 1 ? ' on every chosen server' : '' }}. It is created if missing; it must be empty.</span>
        </div>
        <folder-picker v-if="browsing && browseServer" :server="browseServer" :start="f.folder" :app-name="slugName" @pick="pickFolder" @close="browsing = false" />
      </div>

      <div class="fieldset" v-if="f.code !== 'none'">
        <div class="fieldset-title">5. Deploy on every push</div>
        <div class="seg" style="align-self:flex-start">
          <button type="button" :class="{ on: f.ci === 'pull' }" @click="f.ci = 'pull'">Switchboard deploys (recommended)</button>
          <button type="button" :class="{ on: f.ci === 'runner' }" @click="f.ci = 'runner'">GitHub runner on the server</button>
          <button type="button" :class="{ on: f.ci === '' }" @click="f.ci = ''">Not now</button>
        </div>
        <div class="hint" v-if="f.ci === 'pull'">Switchboard checks GitHub every minute and deploys each new commit on <code>{{ f.branch }}</code> to your servers. Nothing to install on the servers; works for home servers and public repos.</div>
        <div class="hint" v-else-if="f.ci === 'runner'">A GitHub Actions runner on each server deploys right after the tests. <span v-if="detected && !detected.private" class="text-amber">This repo is public — strangers' pull requests could target a self-hosted runner. Prefer "Switchboard deploys".</span></div>
        <div class="hint" v-else>You can turn it on later in the project's CI/CD tab.</div>
      </div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="create" :disabled="busy || !ready">Create and deploy</button>
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

/* ------------------------------------------------------------------ connect a server to Git */
export const ConnectGitDialog = {
  props: { project: Object, ci: Object, serverId: Number, runner: Boolean },
  components: { FolderPicker },
  setup(props) {
    const c = props.ci;
    const inProject = (id) => c.servers.find((s) => s.id === id);
    const others = c.all_servers.filter((s) => !inProject(s.id));
    const live = c.servers.flatMap((s) => s.deps).find((d) => d.active) || c.servers.flatMap((s) => s.deps)[0];
    const f = reactive({ server_id: props.serverId || others[0]?.id || c.servers[0]?.id || '', app_dir: live?.dir || '', deploy: !props.runner, runner: props.runner || (c.enabled && c.mode !== 'pull'), access: c.runner_access || 'restricted' });
    const label = computed(() => (srv.value ? srv.value.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'server'));
    const browsing = ref(false);
    const srv = computed(() => c.all_servers.find((s) => s.id === f.server_id));
    const member = computed(() => inProject(f.server_id));
    const needDir = computed(() => !member.value || member.value.deps.some((d) => !d.dir));
    const anyScript = computed(() => (member.value ? member.value.deps.some((d) => d.deploy_script) : c.projects[0] && live?.deploy_script));
    const dirOk = computed(() => !needDir.value || /^\/[^\0]+$/.test(f.app_dir));
    const busy = ref(false);
    async function go() {
      busy.value = true;
      try {
        const r = await http.post(`/projects/${c.root.id}/ci/connect`, { server_id: f.server_id, app_dir: needDir.value ? f.app_dir : undefined, deploy: f.deploy && !!anyScript.value, runner: f.runner, runner_access: f.runner ? f.access : undefined });
        closeDialog();
        store.live++;
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    const pick = (path) => {
      f.app_dir = path;
      browsing.value = false;
    };
    return { c, f, others, live, srv, label, member, needDir, anyScript, dirOk, busy, browsing, go, pick, closeDialog };
  },
  template: `
  <modal :title="(runner ? 'Self-hosted runner + Git: ' : 'Connect a server to ') + c.repo" @close="closeDialog">
    <div class="form">
      <p class="muted" style="margin:0" v-if="runner">Puts a <b>GitHub self-hosted runner</b> on a server — the "New self-hosted runner" steps from GitHub, done for you — and gives the server Git access to the repo.</p>
      <p class="muted" style="margin:0" v-else>Use this when a server (for example your <b>backup server</b>) can't pull from GitHub or doesn't get new commits.</p>
      <div class="field"><label>Server</label>
        <select v-model.number="f.server_id">
          <optgroup v-if="c.servers.length" label="Already in this project"><option v-for="s in c.servers" :key="s.id" :value="s.id">{{ s.name }} ({{ s.ip }})</option></optgroup>
          <optgroup v-if="others.length" label="Not in this project yet (added as a standby)"><option v-for="s in others" :key="s.id" :value="s.id">{{ s.name }} ({{ s.ip }})</option></optgroup>
        </select>
        <span v-if="!member && live" class="hint">It is added to {{ c.root.name }} as a standby server, with the same container and database settings as the live one.</span></div>
      <div class="field" v-if="needDir"><label>App folder on {{ srv ? srv.name : 'the server' }}</label>
        <div class="folder-go"><input v-model.trim="f.app_dir" class="code" placeholder="/srv/shop"><button type="button" class="btn btn-sm" :disabled="!srv" @click="browsing = !browsing">{{ browsing ? 'Hide' : 'Browse…' }}</button></div>
        <span v-if="!dirOk" class="hint text-red">Use a full path, like /srv/shop.</span></div>
      <folder-picker v-if="browsing && srv" :server="srv" :start="f.app_dir || '/srv/x'" :app-name="c.root.slug" @pick="pick" @close="browsing = false" />
      <div class="fieldset">
        <div class="fieldset-title">What happens</div>
        <ol class="small" style="margin:0;padding-left:18px;line-height:1.7">
          <li>git is installed if missing, and the server gets its own <b>read-only deploy key</b> on {{ c.repo }}.</li>
          <li>The app folder becomes a Git checkout of <code>{{ c.branch }}</code>:
            <span class="muted">empty folder → cloned · folder with files but no Git → connected <b>without changing any file</b> · already a checkout that works → left alone.</span></li>
          <li v-if="f.runner">A <b>GitHub self-hosted runner</b> is downloaded, registered with {{ c.repo }} and started as a service — what GitHub's "New self-hosted runner" page tells you to do by hand.</li>
          <li v-else-if="c.enabled">Switchboard deploys every new commit here too (standby first, live last).</li>
          <li v-else>CI/CD is not on yet — after this you can deploy here, and "Set up CI/CD" makes it automatic.</li>
        </ol>
      </div>
      <div class="fieldset">
        <label class="check"><input type="checkbox" v-model="f.runner" :disabled="!c.token"><span class="check-text"><b>Install a GitHub self-hosted runner on this server</b><span class="hint">{{ c.token ? 'GitHub then runs your workflow jobs on this server.' : 'Needs a GitHub token (Settings → GitHub).' }}</span></span></label>
        <template v-if="f.runner">
          <div class="seg" style="align-self:flex-start"><button type="button" :class="{ on: f.access === 'restricted' }" @click="f.access = 'restricted'">Only Switchboard's deploy</button><button type="button" :class="{ on: f.access === 'full' }" @click="f.access = 'full'">Full — for my own workflow</button></div>
          <span class="hint" v-if="f.access === 'full'">Runs as the server's SSH user, so your workflow can use Docker, git and the app files. Applies to all runners of this project.</span>
          <span class="hint" v-else>Runs as <code>sb-runner</code>, which may only run Switchboard's deploy commands.</span>
          <div class="hint">In a workflow, send a job to this server with <code>runs-on: [self-hosted, {{ label }}]</code>.</div>
          <div v-if="c.mode === 'pull'" class="hint text-amber">CI/CD is on "Switchboard deploys": Switchboard also deploys new commits itself. If your workflow deploys, choose "GitHub runner on each server" above.</div>
        </template>
      </div>
      <label class="check" v-if="anyScript"><input type="checkbox" v-model="f.deploy"><span class="check-text">Then deploy the newest commit on it (runs the project's deploy script)</span></label>
      <div v-else class="hint">No deploy script set for this project, so nothing is deployed — only the folder is connected.</div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="go" :disabled="busy || !f.server_id || !dirOk">Connect to Git</button>
    </template>
  </modal>`,
};

/* ------------------------------------------------------------------ CI/CD tab */
const RUN_BADGE = (r) =>
  r.status !== 'completed'
    ? ['badge-blue', r.status === 'queued' ? 'queued' : 'running']
    : { success: ['badge-green', 'passed'], failure: ['badge-red', 'failed'], cancelled: ['badge-gray', 'cancelled'], skipped: ['badge-gray', 'skipped'], timed_out: ['badge-red', 'timed out'] }[r.conclusion] || ['badge-gray', r.conclusion || '?'];
const GIT_BADGE = {
  ok: ['badge-green', 'connected'],
  other_repo: ['badge-amber', 'other repository'],
  no_access: ['badge-red', "can't pull"],
  unsafe_owner: ['badge-red', "can't pull (folder owner)"],
  not_git: ['badge-amber', 'not a Git folder'],
  missing: ['badge-amber', 'folder missing'],
  no_dir: ['badge-amber', 'no app folder set'],
  no_git_tool: ['badge-amber', 'git not installed'],
  unreachable: ['badge-red', 'server unreachable'],
  error: ['badge-red', 'error'],
};
const PREVIEW_BADGE = { waiting: ['badge-gray', 'waiting for CI'], building: ['badge-blue', 'building'], ready: ['badge-green', 'ready'], failed: ['badge-red', 'failed'] };

export const CicdTab = {
  props: { project: Object },
  emits: ['reload'],
  components: { ZoneSelect, FlowEditor },
  setup(props) {
    const c = ref(null);
    const f = reactive({ ci_live_policy: 'now', ci_quiet_time: '02:00', git_repo: '', git_branch: 'main', ci_mode: 'runner', ci_runner_access: 'restricted', ci_test_on: 'github', ci_test_cmd: '', preview_server_id: '', preview_zone: null });
    // Your own workflow file (edited here, committed to GitHub; Switchboard never rewrites it)
    const wf = reactive({ mode: 'switchboard', path: '.github/workflows/deploy.yml', content: '', files: [], example: '', loaded: false, loading: false, missing: false });
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
          ci_mode: c.value.mode || 'runner',
          ci_test_on: c.value.test_on,
          ci_test_cmd: c.value.test_cmd || c.value.default_tests,
          preview_server_id: c.value.preview.server_id || '',
          preview_zone: c.value.preview.zone,
          ci_runner_access: c.value.runner_access,
          ci_live_policy: c.value.live_policy,
          ci_quiet_time: c.value.quiet_time || '02:00',
        });
        if (!runBranch.value) runBranch.value = props.project.git_branch || c.value.branch;
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    onMounted(async () => {
      await load(true);
      loadActive();
      if (c.value?.own_workflow && c.value.is_root) ownMode();
      if (c.value?.is_root && c.value.repo && c.value.servers.length) checkGit();
    });
    watch(() => store.live, () => load());
    // Runs still going on GitHub (any workflow of the repo): checked every 5 s while one runs, else every 20 s.
    const active = ref([]);
    let activeT = null;
    let mounted = true;
    async function loadActive() {
      clearTimeout(activeT);
      if (c.value?.repo && c.value.token) {
        try {
          const had = active.value.length;
          active.value = (await http.get(`/projects/${props.project.id}/ci/active`)).runs;
          if (had > active.value.length) load(); // one finished: refresh the runs list
        } catch {}
      }
      if (mounted) activeT = setTimeout(loadActive, active.value.length ? 5000 : 20000);
    }
    onUnmounted(() => {
      mounted = false;
      clearTimeout(activeT);
    });
    async function cancelRun(r, force = false) {
      const where = r.servers.length ? ` It is running on ${r.servers.map((s) => s.name).join(', ')}.` : '';
      const ok = await confirmBox({
        title: `${force ? 'Force-stop' : 'Cancel'} run #${r.run_number}?`,
        message: force
          ? `GitHub stops it right away and also skips its clean-up steps.${where}`
          : `GitHub stops the jobs that are running now and does not start the others.${where} A deploy cut off halfway can leave a server between two versions — check it, or deploy again.`,
        confirmText: force ? 'Force-stop' : 'Cancel run',
        danger: true,
      });
      if (!ok) return;
      busy.value['cancel' + r.run_id] = true;
      try {
        await http.post(`/projects/${props.project.id}/ci/runs/${r.run_id}/cancel`, { force });
        toast(`Run #${r.run_number}: ${force ? 'force-stop' : 'cancel'} sent to GitHub`, 'success');
        r.cancelled_at = Date.now();
        setTimeout(loadActive, 3000);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value['cancel' + r.run_id] = false;
      }
    }
    const watchActive = (r) => openDialog('ci-run', { projectId: c.value.root.id, runId: r.run_id });
    // The newest run that passed (not a pull request) and the live server: "Deploy <commit> to <live>" from here.
    const newestOk = computed(() => (c.value ? c.value.runs.find((r) => r.status === 'completed' && r.conclusion === 'success' && r.event !== 'pull_request') : null));
    const liveDep = computed(() => (c.value ? c.value.servers.flatMap((s) => s.deps.map((d) => ({ ...d, server: s.name }))).find((d) => d.active && d.project_id === c.value.root.id) : null));
    async function deployNewestToLive() {
      const r = newestOk.value;
      const d = liveDep.value;
      if (!r || !d) return;
      if (!(await confirmBox({ title: `Deploy ${(r.sha || '').slice(0, 7)} to ${d.server} (live)?`, message: `The code of run #${r.run_number} (“${r.title}”). Visitors may see errors for a few seconds while the app restarts.`, confirmText: `Deploy to ${d.server}`, danger: true }))) return;
      busy.value.live = true;
      try {
        const x = await http.post(`/projects/${c.value.root.id}/ci/runs/${r.run_id}/deploy`, { deployment: d.id });
        toast(x.message || `Deploy to ${d.server} started`, 'success');
        if (x.job) showJob(x.job.id);
        load();
        setTimeout(loadActive, 4000);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value.live = false;
      }
    }
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
    const body = () => ({ ...f, tz_offset: -new Date().getTimezoneOffset() });
    const save = () => act('save', () => http.put(`/projects/${props.project.id}/ci`, body()), 'CI/CD settings saved');
    const setup = async () => {
      await http.put(`/projects/${props.project.id}/ci`, body()).catch((e) => toast(e.message, 'error'));
      runJob(http.post(`/projects/${props.project.id}/ci/setup`, { commit: true }));
    };
    const updateServers = () => runJob(http.post(`/projects/${props.project.id}/ci/servers`));
    const gitOf = (d) => (c.value.git || {})[d.id] || null;
    const gitBadge = (d) => (gitOf(d) ? GIT_BADGE[gitOf(d).state] || ['badge-gray', gitOf(d).state] : ['badge-gray', 'not checked']);
    const notConnected = computed(() => (c.value ? c.value.servers.filter((s) => s.deps.some((d) => gitOf(d) && gitOf(d).state !== 'ok')) : []));
    const checkGit = () => act('git', () => http.post(`/projects/${c.value.root.id}/ci/git-check`));
    const connect = (s, runner = false) => openDialog('connect-git', { project: props.project, ci: c.value, serverId: s ? s.id : undefined, runner });
    const viewRun = (r) => openDialog('ci-run', { projectId: c.value.root.id, runId: r.run_id });
    const liveRun = computed(() => (c.value ? c.value.runs.find((r) => r.status !== 'completed') : null));
    async function loadWf(path) {
      wf.loading = true;
      try {
        const r = await http.get(`/projects/${c.value.root.id}/ci/workflows${path ? `?path=${encodeURIComponent(path)}` : ''}`);
        wf.files = r.files;
        wf.example = r.example;
        if (path) {
          wf.path = path;
          wf.missing = r.content === null;
          wf.content = r.content ?? r.example;
        }
        wf.loaded = true;
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        wf.loading = false;
      }
    }
    async function ownMode() {
      wf.mode = 'own';
      await loadWf();
      await loadWf(c.value.own_workflow ? c.value.workflow_path : wf.files[0] || '.github/workflows/deploy.yml');
    }
    const switchboardMode = () =>
      act('wf', async () => {
        if (c.value.own_workflow) await http.put(`/projects/${c.value.root.id}/ci`, { ci_workflow_path: null });
        wf.mode = 'switchboard';
      }, c.value.own_workflow ? "Switchboard's workflow is used again — click Commit to GitHub (or Set up again) to put it in the repo" : '');
    const useWf = () => act('wf', () => http.put(`/projects/${c.value.root.id}/ci`, { ci_workflow_path: wf.path }), `Switchboard now follows ${wf.path}`);
    const commitWf = () => act('wf', () => http.put(`/projects/${c.value.root.id}/ci/workflow`, { path: wf.path, content: wf.content }).then((r) => { wf.missing = false; return r; }), `${wf.path} committed to GitHub`);
    const useExample = async () => {
      if (wf.content && wf.content !== wf.example && !(await confirmBox({ title: 'Replace the editor text with the example?', message: 'Nothing is saved to GitHub until you click Commit.', confirmText: 'Use the example' }))) return;
      wf.content = wf.example;
    };
    const ownScript = computed(() => (c.value ? c.value.servers.some((s) => s.deps.some((d) => d.project_id === c.value.root.id && d.deploy_script)) : false));
    const pullAll = () => openDialog('deploy-plan', { projectId: c.value.root.id });
    const rollBack = () => openDialog('deploy-plan', { projectId: c.value.root.id, rollback: true });
    const heldFor = (d) => (c.value.held || []).find((h) => h.deployment_id === d.id);
    const deployHeld = async (h) => {
      const r = await runJob(http.post(`/held-deploys/${h.id}/deploy`));
      if (r?.message) toast(r.message, 'success');
      if (r) {
        load();
        setTimeout(loadActive, 4000);
      }
    };
    async function cancelHeldDeploy(h) {
      if (!(await confirmBox({ title: `Cancel the waiting deploy on ${h.server_name}?`, message: 'The server keeps the code it has now. The next deploy brings it up to date.', confirmText: 'Cancel it' }))) return;
      act('held', () => http.del(`/held-deploys/${h.id}`), 'Waiting deploy cancelled');
    }
    const pullOne = (d) => runJob(http.post(`/deployments/${d.id}/deploy`, {}));
    async function dockerScript() {
      if (!(await confirmBox({ title: 'Use the Docker deploy script?', message: 'Deploy then runs in the app folder: git pull (the exact commit when CI/CD starts it), docker compose up -d --build, and removes old images. You can change it later in Settings → Deploy script.', confirmText: 'Use it' }))) return;
      act('script', () => http.post(`/projects/${c.value.root.id}/docker-deploy-script`), 'Deploy script set: pull from Git and rebuild with Docker');
    }
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
    return { c, f, wf, viewRun, liveRun, active, cancelRun, watchActive, newestOk, liveDep, deployNewestToLive, rollBack, heldFor, deployHeld, cancelHeldDeploy, whenText, loadWf, ownMode, switchboardMode, useWf, commitWf, useExample, ownScript, pullAll, pullOne, dockerScript, showYaml, busy, isAdmin, runBranch, load, save, setup, updateServers, gitOf, gitBadge, notConnected, checkGit, connect, commit, refresh, runNow, removeRunner, removePreview, addStaging, stagingData, runBadge, PREVIEW_BADGE, fmtDate };
  },
  template: `
  <div v-if="!c" class="muted">Loading…</div>
  <div v-else class="stack">
    <div v-if="!c.is_root" class="alert alert-info"><span class="alert-icon">ℹ</span><span>This is a staging copy. CI/CD is managed on <a :href="'#/projects/' + c.root.id">{{ c.root.name }}</a>; pushes to <code>{{ project.git_branch }}</code> deploy here.</span></div>
    <div v-if="!c.token" class="alert alert-warn"><span class="alert-icon">⚠</span><span>Add a GitHub token first: <a href="#/settings">Settings → GitHub</a>.</span></div>
    <div v-if="c.error" class="alert alert-error"><span class="alert-icon">✖</span><span>GitHub: {{ c.error }}</span></div>
    <div v-if="c.held && c.held.length" class="alert alert-info"><span class="alert-icon">⏸</span><div style="flex:1;min-width:0">
      <div v-for="h in c.held" :key="h.id" class="held-row"><span><b>{{ h.server_name }}</b><span v-if="h.live" class="badge badge-green" style="margin:0 6px">LIVE</span> waits for <code>{{ h.commit_sha ? h.commit_sha.slice(0, 7) : 'the newest commit' }}</code> — {{ whenText(h.run_at) }}<span v-if="h.project_id !== c.root.id" class="muted"> ({{ h.project_name }})</span></span>
        <span class="row gap-6"><button class="btn btn-xs btn-primary dev-only" @click="deployHeld(h)">Deploy now</button><button class="btn btn-xs dev-only" @click="cancelHeldDeploy(h)">Cancel</button></span></div></div></div>
    <div v-if="c.is_root && c.repo && newestOk && liveDep && !(c.held || []).some(h => h.live)" class="live-deploy">
      <div class="live-deploy-text"><span class="live-deploy-ico">🚀</span><span><b>Deploy to the live server</b><span class="small muted">{{ liveDep.server }} <span class="badge badge-green">LIVE</span> — newest commit that passed: <code>{{ (newestOk.sha || '').slice(0, 7) }}</code> {{ newestOk.title }} (run #{{ newestOk.run_number }}, <ago :at="newestOk.created_at" />)</span></span></div>
      <div class="row gap-6"><button class="btn btn-sm" @click="viewRun(newestOk)">Open run</button><button class="btn btn-sm btn-primary dev-only" @click="deployNewestToLive" :disabled="busy.live"><span v-if="busy.live" class="spinner"></span>Deploy {{ (newestOk.sha || '').slice(0, 7) }} to {{ liveDep.server }}</button></div>
    </div>
    <div v-if="c.is_root && notConnected.length" class="alert alert-warn"><span class="alert-icon">⚠</span><span><b>{{ notConnected.map(s => s.name).join(', ') }}</b> can't get updates from GitHub yet. <button class="btn btn-xs admin-only" @click="connect(notConnected[0])">Connect to Git</button></span></div>

    <div class="card card-body form" v-if="c.is_root">
      <div class="row between wrap gap-8"><h3>GitHub CI/CD</h3>
        <span v-if="c.enabled" class="badge badge-green">ON</span><span v-else class="badge badge-gray">not set up</span></div>
      <div class="field"><label>How new commits get to your servers</label>
        <div class="seg" style="align-self:flex-start"><button type="button" :class="{ on: f.ci_mode === 'pull' }" @click="f.ci_mode = 'pull'" :disabled="!isAdmin">Switchboard deploys</button><button type="button" :class="{ on: f.ci_mode === 'runner' }" @click="f.ci_mode = 'runner'" :disabled="!isAdmin">GitHub runner on each server</button></div>
        <span class="hint" v-if="f.ci_mode === 'pull'">Every minute Switchboard checks the branch; a new commit is deployed over SSH (after its tests pass on GitHub, if you have tests) — standby servers first, the live one last. Nothing is installed on the servers and nothing has to reach them: ideal for <b>home servers</b> and <b>public repos</b>.</span>
        <span class="hint" v-else>Tests run on GitHub's machines, then a <b>self-hosted runner</b> on each server deploys the exact commit right away — standby first, live last. Pull-request previews need this mode.</span></div>
      <div class="field" v-if="f.ci_mode === 'runner'"><label>What the runner may do on the server</label>
        <div class="seg" style="align-self:flex-start"><button type="button" :class="{ on: f.ci_runner_access === 'restricted' }" @click="f.ci_runner_access = 'restricted'" :disabled="!isAdmin">Only Switchboard's deploy</button><button type="button" :class="{ on: f.ci_runner_access === 'full' }" @click="f.ci_runner_access = 'full'" :disabled="!isAdmin">Full — for my own workflow</button></div>
        <span class="hint" v-if="f.ci_runner_access === 'restricted'">Runs as user <code>sb-runner</code>, which may only run Switchboard's deploy/preview commands. Safest; enough for Switchboard's workflow.</span>
        <span class="hint" v-else>Runs as the server's SSH user (<code>{{ (c.servers[0] && c.servers[0].runner_user) || 'root' }}</code>), like a runner you install by hand from GitHub's instructions: your workflow can run <b>docker</b>, <b>git</b> and change the app files. Click "Set up again" after changing this.</span></div>
      <div v-if="f.ci_mode === 'runner' && c.repo_private === false" class="alert alert-warn"><span class="alert-icon">⚠</span><span><b>Public repository + self-hosted runner:</b> a stranger's pull request can try to run code on your server. Use "Switchboard deploys", or in GitHub → Settings → Actions → General choose <i>Require approval for all outside collaborators</i>.</span></div>
      <div class="form-row">
        <div class="field"><label>Repository</label><input v-model="f.git_repo" class="code" placeholder="acme/shop" :disabled="!isAdmin"></div>
        <div class="field"><label>Live branch</label><input v-model="f.git_branch" class="code" placeholder="main" :disabled="!isAdmin"></div>
      </div>
      <div class="field"><label>Tests before deploying</label>
        <div class="seg" style="align-self:flex-start"><button type="button" :class="{ on: f.ci_test_on === 'github' }" @click="f.ci_test_on = 'github'" :disabled="!isAdmin">Run tests on GitHub</button><button type="button" :class="{ on: f.ci_test_on === 'none' }" @click="f.ci_test_on = 'none'" :disabled="!isAdmin">No tests</button></div></div>
      <div class="field" v-if="f.ci_test_on === 'github'"><label>Test commands <span class="muted">(bash, on ubuntu-latest{{ c.root.template === 'laravel' ? ' with PHP 8.4' : c.root.template ? ' with Node 24' : '' }})</span></label>
        <textarea v-model="f.ci_test_cmd" class="code" rows="4" :disabled="!isAdmin"></textarea></div>
      <div class="field"><label>When a new commit comes, the <b>live</b> server…</label>
        <div class="seg" style="align-self:flex-start"><button type="button" :class="{ on: f.ci_live_policy === 'now' }" @click="f.ci_live_policy = 'now'" :disabled="!isAdmin">Updates with the others</button><button type="button" :class="{ on: f.ci_live_policy === 'hold' }" @click="f.ci_live_policy = 'hold'" :disabled="!isAdmin">Waits for me</button><button type="button" :class="{ on: f.ci_live_policy === 'quiet' }" @click="f.ci_live_policy = 'quiet'" :disabled="!isAdmin">Updates at a quiet time</button></div>
        <div v-if="f.ci_live_policy === 'quiet'" class="row gap-8" style="align-items:center"><input type="time" v-model="f.ci_quiet_time" class="dp-time" :disabled="!isAdmin"><span class="hint" style="margin:0">every day, your time{{ c.next_quiet && c.live_policy === 'quiet' ? ' — next: ' + whenText(c.next_quiet) : '' }}</span></div>
        <span class="hint" v-if="f.ci_live_policy === 'now'">Standby servers first, then the live one — it can show errors for a few seconds while it rebuilds.</span>
        <span class="hint" v-else>Standby servers get the new commit right away; the live server keeps serving visitors and gets the <b>same commit</b> {{ f.ci_live_policy === 'quiet' ? 'at the quiet time' : 'when you click "Deploy now" (shown at the top of this tab)' }}.{{ f.ci_mode === 'runner' && !c.own_workflow ? ' The workflow file changes: commit it again after saving.' : '' }}</span>
        <span class="hint" v-if="c.own_workflow && f.ci_mode === 'runner'">Your own workflow can follow this: Switchboard saves the project's servers in the repository variable <code>SWITCHBOARD_SERVERS</code> (see "Where your workflow deploys" below). A workflow that reads it deploys the other servers after you approve; the live one waits here for "Deploy now".</span>
      </div>
      <div class="row gap-8 wrap admin-only">
        <button class="btn" @click="save" :disabled="busy.save">Save</button>
        <button class="btn btn-primary" @click="setup" :disabled="!f.git_repo || !c.token">{{ c.enabled ? 'Set up again (runners + workflow)' : 'Set up CI/CD' }}</button>
        <span class="hint" v-if="f.ci_mode === 'pull'">Gives each server read access to the repo{{ f.ci_test_on !== 'none' && f.ci_test_cmd ? ' and commits a tests-only workflow' : '' }}. Last deployed: <template v-for="(sha, slug) in c.deployed" :key="slug"><code>{{ slug }}@{{ (sha || '').slice(0, 7) }}</code> </template></span>
        <span class="hint" v-else-if="c.own_workflow">Installs the runner on {{ c.servers.map(s => s.name).join(', ') || 'the servers' }}. Your own <code>{{ c.workflow_path }}</code> is used as it is.</span>
        <span class="hint" v-else>Installs the runner on {{ c.servers.map(s => s.name).join(', ') || 'the servers' }} and commits <code>{{ c.workflow_path }}</code>.</span>
      </div>
    </div>

    <div class="card" v-if="c.is_root && c.repo && active.length">
      <div class="card-head"><h3><span class="live-pill live-live" style="margin-right:8px"><i></i>LIVE</span>Running now on GitHub</h3>
        <a class="btn btn-sm" :href="c.repo_url + '/actions'" target="_blank" rel="noopener">GitHub ↗</a></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Workflow</th><th>State</th><th>Commit</th><th>Servers</th><th>Now</th><th></th></tr></thead>
        <tbody><tr v-for="r in active" :key="r.run_id" class="row-link" @click="watchActive(r)" title="Open the live view of this run">
          <td><b>{{ r.workflow }}</b> <span class="mono muted small">#{{ r.run_number }}</span><div class="small muted"><span class="mono">{{ r.branch }}</span> · {{ r.event === 'pull_request' ? 'pull request' : r.event === 'workflow_dispatch' ? 'run by hand' : r.event }}<template v-if="r.actor"> · {{ r.actor }}</template></div></td>
          <td class="nowrap"><span class="badge" :class="r.cancelled_at ? 'badge-amber' : r.status === 'in_progress' ? 'badge-blue' : 'badge-gray'">{{ r.cancelled_at ? 'stopping…' : r.status === 'in_progress' ? 'running' : r.status === 'waiting' ? 'waiting for approval' : 'queued' }}</span><div class="small muted">{{ r.jobs.done }}/{{ r.jobs.total }} jobs · <ago :at="r.started_at" /></div></td>
          <td class="small"><span class="mono muted">{{ (r.sha || '').slice(0, 7) }}</span> {{ r.title }}</td>
          <td class="small"><span v-for="s in r.servers" :key="s.id" class="badge" :class="s.status === 'in_progress' ? 'badge-blue' : s.status === 'completed' ? (s.conclusion === 'success' ? 'badge-green' : 'badge-red') : 'badge-gray'" style="margin:0 4px 2px 0">{{ s.name }}</span><span v-if="!r.servers.length" class="muted">GitHub only (so far)</span></td>
          <td class="small">{{ r.step || '—' }}</td>
          <td class="actions nowrap" @click.stop><button class="btn btn-xs btn-primary" @click="watchActive(r)">Watch</button> <button class="btn btn-xs btn-danger dev-only" @click="cancelRun(r, !!r.cancelled_at)" :disabled="busy['cancel' + r.run_id]">{{ r.cancelled_at ? 'Force-stop' : 'Cancel' }}</button></td>
        </tr></tbody>
      </table></div>
    </div>

    <div class="card" v-if="c.is_root && c.repo">
      <div class="card-head"><h3>Runs</h3>
        <div class="row gap-6 wrap">
          <span class="muted small" v-if="c.polled_at">checked <ago :at="c.polled_at" /></span>
          <button v-if="liveRun" class="btn btn-sm btn-primary" @click="viewRun(liveRun)"><span class="live-pill live-live" style="margin-right:6px"><i></i>LIVE</span>Watch #{{ liveRun.run_number }}</button>
          <button class="btn btn-sm" @click="refresh" :disabled="busy.refresh"><span v-if="busy.refresh" class="spinner"></span>Check now</button>
          <span class="dev-only row gap-6"><select v-model="runBranch" style="height:30px;max-width:150px"><option v-for="x in c.projects" :key="x.id" :value="x.branch">{{ x.branch }}</option></select>
          <button class="btn btn-sm btn-primary" @click="runNow" :disabled="busy.run || !c.enabled">Run now</button></span>
          <a class="btn btn-sm" :href="c.repo_url + '/actions'" target="_blank" rel="noopener">GitHub ↗</a></div></div>
      <div class="table-wrap"><table class="table" v-if="c.runs.length">
        <thead><tr><th>#</th><th>Result</th><th>Branch / event</th><th>Commit</th><th>By</th><th>When</th><th></th></tr></thead>
        <tbody><tr v-for="r in c.runs" :key="r.id" class="row-link" @click="viewRun(r)" title="Open the live view of this run">
          <td class="mono muted">{{ r.run_number }}</td>
          <td><span class="badge" :class="runBadge(r)[0]">{{ runBadge(r)[1] }}</span></td>
          <td><span class="mono small">{{ r.branch }}</span> <span class="muted small">{{ r.event === 'pull_request' ? 'pull request' : r.event === 'workflow_dispatch' ? 'run by hand' : r.event }}</span></td>
          <td class="small"><span class="mono muted">{{ (r.sha || '').slice(0, 7) }}</span> {{ r.title }}</td>
          <td class="small muted">{{ r.actor }}</td>
          <td class="small nowrap"><ago :at="r.created_at" /></td>
          <td class="actions" @click.stop><button class="btn btn-xs" :class="{ 'btn-primary': r.status !== 'completed' }" @click="viewRun(r)">{{ r.status !== 'completed' ? 'Watch' : 'View' }}</button> <a class="btn btn-xs" :href="r.html_url" target="_blank" rel="noopener">Log ↗</a></td>
        </tr></tbody>
      </table><div v-else class="empty">No runs yet{{ c.enabled ? ' — push a commit or click Run now.' : '.' }}</div></div>
    </div>

    <div class="card" v-if="c.is_root && c.repo">
      <div class="card-head"><h3>Servers and Git</h3>
        <div class="row gap-6 wrap"><button class="btn btn-sm" @click="checkGit(); load(true)" :disabled="busy.git"><span v-if="busy.git" class="spinner"></span>Check servers</button><button class="btn btn-sm dev-only" @click="pullAll" :disabled="!ownScript" :title="ownScript ? 'Choose which servers update now and which later' : 'Set a deploy script first'">Pull & rebuild…</button><button class="btn btn-sm dev-only" @click="rollBack" :disabled="!ownScript || !c.token" title="Deploy an older commit of the branch again (errors after a deploy?)">↩ Roll back…</button><button class="btn btn-sm admin-only" @click="updateServers" title="Send the latest deploy script and project settings to the servers (no deploy)">Send settings</button><button class="btn btn-sm admin-only" @click="connect(null, true)" :disabled="!c.token" title="Install a GitHub self-hosted runner on a server">+ Self-hosted runner</button><button class="btn btn-sm btn-primary admin-only" @click="connect()">+ Connect a server</button></div></div>
      <div v-if="!ownScript && c.servers.length" class="alert alert-info" style="margin:0 18px 12px"><span class="alert-icon">ℹ</span><span>No deploy script yet, so Switchboard can't update the servers itself. App runs with Docker Compose? <button class="btn btn-xs admin-only" @click="dockerScript" :disabled="busy.script">Use "pull from Git + rebuild"</button> <span class="muted">(Vue / React front-end or a PM2 app? Settings → Deploy script has ready scripts for those)</span></span></div>
      <div class="table-wrap"><table class="table" v-if="c.servers.length">
        <thead><tr><th>Server</th><th>App folder</th><th>Git</th><th v-if="c.mode !== 'pull' || c.runners.length">Runner</th><th></th></tr></thead>
        <tbody><tr v-for="s in c.servers" :key="s.id">
          <td class="strong">{{ s.name }}<div v-if="s.deps.some(d => d.active)" class="muted small">live</div><div v-else-if="s.deps.length" class="muted small">standby</div><div v-else class="muted small">previews</div></td>
          <td class="small"><div v-for="d in s.deps" :key="d.id"><code>{{ d.dir || '—' }}</code><span v-if="s.deps.length > 1 || d.project_id !== c.root.id" class="muted"> {{ d.project }}</span></div></td>
          <td class="small"><div v-for="d in s.deps" :key="d.id">
            <span class="badge" :class="gitBadge(d)[0]">{{ gitBadge(d)[1] }}</span>
            <template v-if="gitOf(d)">
              <span v-if="gitOf(d).commit" class="mono muted" style="margin-left:6px">{{ gitOf(d).branch }}@{{ gitOf(d).commit.slice(0, 7) }}</span>
              <span v-if="gitOf(d).behind" class="text-amber"> · {{ gitOf(d).behind }} behind</span>
              <span v-if="gitOf(d).changed" class="muted" title="Tracked files edited on the server (git status)"> · {{ gitOf(d).changed }} local change{{ gitOf(d).changed > 1 ? 's' : '' }}</span>
              <div v-if="gitOf(d).error && gitOf(d).state !== 'ok'" class="muted small" style="max-width:360px;white-space:normal">{{ gitOf(d).error }}</div>
            </template>
            <div v-if="heldFor(d)" class="small"><span class="badge badge-amber">⏸ waiting</span> <span class="muted">{{ whenText(heldFor(d).run_at) }}</span></div></div></td>
          <td v-if="c.mode !== 'pull' || c.runners.length"><template v-for="r in [c.runners.find(x => x.server_id === s.id)]" :key="s.id + 'r'">
            <template v-if="r"><span v-if="r.live" class="badge" :class="r.live.status === 'online' ? (r.live.busy ? 'badge-blue' : 'badge-green') : 'badge-red'">{{ r.live.status === 'online' ? (r.live.busy ? 'busy' : 'online') : r.live.status }}</span><span v-else class="badge badge-gray">installed</span> <span class="small muted">{{ r.version }}</span></template>
            <span v-else class="muted small">not installed <button class="btn btn-xs admin-only" @click="connect(s, true)" :disabled="!c.token">Install</button></span>
            <div class="small muted">as <code>{{ s.runner_user }}</code> · label <code>{{ s.labels[s.labels.length - 1] }}</code></div></template></td>
          <td class="actions">
            <button v-for="d in s.deps.filter(x => x.project_id === c.root.id)" :key="'p' + d.id" class="btn btn-xs dev-only" @click="pullOne(d)" :disabled="!d.deploy_script" :title="d.deploy_script ? 'Run the deploy script here (pull from Git, rebuild)' : 'Set a deploy script first'">Pull & rebuild</button>
            <button v-if="s.deps.length" class="btn btn-xs admin-only" :class="{ 'btn-primary': s.deps.some(d => !gitOf(d) || gitOf(d).state !== 'ok') || (c.enabled && c.mode !== 'pull' && !s.installed) }" @click="connect(s)">{{ s.deps.every(d => gitOf(d) && gitOf(d).state === 'ok') && (!c.enabled || c.mode === 'pull' || s.installed) ? 'Reconnect' : 'Connect to Git' }}</button>
            <template v-for="r in [c.runners.find(x => x.server_id === s.id)]" :key="s.id + 'x'"><button v-if="r" class="btn btn-xs btn-danger admin-only" @click="removeRunner(r)">Remove runner</button></template>
          </td>
        </tr></tbody>
      </table><div v-else class="empty">No servers in this project yet — "Connect a server" adds one.</div></div>
      <div class="hint" style="padding:10px 18px 14px">"Connect to Git" gives the server a read-only deploy key and makes its app folder a Git checkout of <code>{{ c.branch }}</code> (a folder that already has files is connected without changing them){{ c.enabled && c.mode !== 'pull' ? ', then installs the runner in /opt/switchboard-runner' : '' }}. "Pull & rebuild" runs the project's deploy script on that server. In your own workflow, pick a server with <code>runs-on: [self-hosted, &lt;its label&gt;]</code>. Remove a runner here before you delete a server.</div>
    </div>

    <div class="card card-body form" v-if="c.is_root && c.repo">
      <div class="row between wrap gap-8"><h3>Workflow file</h3>
        <template v-if="wf.mode === 'switchboard'"><span v-if="c.up_to_date && !c.own_workflow" class="badge badge-green">up to date in GitHub</span><span v-else class="badge badge-amber">{{ c.committed_at ? 'changed — commit again' : 'not committed yet' }}</span></template>
        <span v-else-if="c.own_workflow" class="badge badge-green">your own: {{ c.workflow_path.split('/').pop() }}</span><span v-else class="badge badge-amber">not chosen yet</span></div>
      <div class="seg admin-only" style="align-self:flex-start"><button type="button" :class="{ on: wf.mode === 'switchboard' }" @click="switchboardMode" :disabled="busy.wf">Made by Switchboard</button><button type="button" :class="{ on: wf.mode === 'own' }" @click="ownMode" :disabled="busy.wf">My own workflow</button></div>
      <template v-if="wf.mode === 'switchboard'">
        <div class="hint" style="margin:0"><code>{{ c.workflow_path }}</code> on {{ c.projects.map(x => x.branch).join(' and ') }}. Switchboard writes it (and rewrites it when you add servers, staging or previews) — edits in GitHub are overwritten. Want to write it yourself? Choose "My own workflow".</div>
        <div class="row gap-8 wrap"><button class="btn btn-sm admin-only" @click="commit" :disabled="busy.commit || !c.token">Commit to GitHub</button><button class="btn btn-sm" @click="showYaml = !showYaml">{{ showYaml ? 'Hide' : 'Show' }} file</button></div>
        <flow-editor v-if="c.workflow" :project-id="c.root.id" :content="c.workflow" readonly compact :branch="c.branch" :path="c.workflow_path" />
        <pre v-if="showYaml" class="log" style="min-height:0">{{ c.workflow }}</pre>
      </template>
      <template v-else>
        <div v-if="c.servers_var" class="sv-plan">
          <div class="row between wrap gap-8"><b>Where your workflow deploys</b><span class="small muted">repository variable <code>{{ c.servers_var.name }}</code><template v-if="c.servers_var.saved_at"> · saved <ago :at="c.servers_var.saved_at" /></template></span></div>
          <div class="sv-flow">
            <span class="sv-step">✅ You approve</span><span class="sv-arrow">→</span>
            <span class="sv-step" v-if="c.servers_var.plan.now.length">🚀 Deploy now: <b v-for="(s, i) in c.servers_var.plan.now" :key="s.label">{{ i ? ', ' : '' }}{{ s.name }}<span v-if="s.live" class="badge badge-green" style="margin-left:4px">LIVE</span></b></span>
            <span class="sv-step muted" v-else>No servers in this project</span>
            <template v-if="c.servers_var.plan.live"><span class="sv-arrow">→</span><span class="sv-step sv-wait">⏸ <b>{{ c.servers_var.plan.live.name }}</b> <span class="badge badge-green">LIVE</span> waits for you {{ c.live_policy === 'quiet' ? '(or the quiet time)' : '' }}</span></template>
          </div>
          <div class="hint" style="margin:0">Runner labels: <code v-for="s in c.servers_var.plan.servers" :key="s.label" style="margin-right:6px">{{ s.label }}</code> — each server needs a runner with that label. {{ c.servers_var.plan.live ? '' : c.servers_var.plan.servers.length > 1 ? 'Choose "Waits for me" above to keep the live server back.' : '' }}</div>
          <div v-if="c.servers_var.error" class="alert alert-error" style="margin:0"><span class="alert-icon">✖</span><span>{{ c.servers_var.error }}</span></div>
        </div>
        <div class="hint" style="margin:0">Your file decides what GitHub does on a push; Switchboard <b>never rewrites it</b>. Switchboard still sets up the servers (Git access, runners), shows this file's runs, and "Run now" starts it (it needs <code>workflow_dispatch:</code>). Edit it here or in GitHub.</div>
        <div v-if="c.mode !== 'pull' && c.runner_access !== 'full'" class="alert alert-warn"><span class="alert-icon">⚠</span><span>Runners only run Switchboard's deploy commands now. If your workflow runs <code>docker</code>, <code>git</code> or changes files, choose <b>Full — for my own workflow</b> above, Save, then "Set up again".</span></div>
        <div v-if="c.committed_at" class="hint text-amber" style="margin:0">Switchboard's own <code>.github/workflows/switchboard.yml</code> may still be in the repo — delete it in GitHub, or both workflows run on a push.</div>
        <div class="form-row">
          <div class="field"><label>File in the repo</label>
            <div class="folder-go"><input v-model.trim="wf.path" class="code" list="sb-wf-files" placeholder=".github/workflows/deploy.yml"><button type="button" class="btn btn-sm" @click="loadWf(wf.path)" :disabled="wf.loading">{{ wf.loading ? 'Loading…' : 'Open' }}</button></div>
            <datalist id="sb-wf-files"><option v-for="x in wf.files" :key="x" :value="x" /></datalist>
            <span class="hint" v-if="wf.files.length">In the repo: <template v-for="x in wf.files" :key="x"><a href="" @click.prevent="loadWf(x)"><code>{{ x.split('/').pop() }}</code></a> </template></span>
            <span class="hint" v-if="wf.missing">Not in the repo yet — the example is shown; Commit creates it.</span></div>
        </div>
        <flow-editor v-if="wf.loaded" v-model:content="wf.content" :project-id="c.root.id" :readonly="!isAdmin" :branch="c.branch" :path="wf.path" :start-open="wf.missing" @commit="commitWf" />
        <div class="row gap-8 wrap admin-only">
          <button class="btn btn-sm btn-primary" @click="commitWf" :disabled="busy.wf || !wf.content || !c.token">Commit to GitHub</button>
          <button class="btn btn-sm" @click="useWf" :disabled="busy.wf || wf.missing" v-if="!c.own_workflow || c.workflow_path !== wf.path" title="Follow this file without changing it">Use this file as it is</button>
          <button class="btn btn-sm btn-ghost" @click="useExample">Start from the example</button>
          <span class="hint">The example: on a push, each server's runner does <code>git pull</code> in the app folder and <code>docker compose up -d --build</code> — standby first, live last.</span>
        </div>
      </template>
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


// Server tools: the "marketplace" tab on a server (Node.js, PM2, Docker… with one-click install),
// and the project-page warning when a server lacks a tool the project's deploy script needs.
import { ref, computed, onMounted, watch } from '/vendor/vue.js';
import { store, http, toast, runJob, ago } from './lib.js';

/** Servers → a server → Tools */
export const ToolsTab = {
  props: { server: Object },
  setup(props) {
    const data = ref(null);
    const loading = ref(false);
    const picked = ref([]);
    async function load(refresh = false) {
      loading.value = true;
      try {
        data.value = await http.get(`/servers/${props.server.id}/tools${refresh ? '?refresh=1' : ''}`);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        loading.value = false;
      }
    }
    onMounted(() => load());
    // A finished install job changes the server: show the new state.
    watch(() => props.server.tools?.at, () => load());
    const list = computed(() => data.value?.state?.list || {});
    const has = (k) => !!list.value[k];
    const toggle = (k) => {
      picked.value = picked.value.includes(k) ? picked.value.filter((x) => x !== k) : [...picked.value, k];
    };
    async function install(keys) {
      const r = await runJob(http.post(`/servers/${props.server.id}/tools/install`, { tools: keys }));
      if (r) picked.value = [];
    }
    const nameOf = (k) => data.value?.catalog.find((t) => t.key === k)?.name || k;
    return { data, loading, load, list, has, picked, toggle, install, nameOf, ago, store };
  },
  template: `
  <section>
    <div class="section-head">
      <h2>Tools</h2>
      <div class="row gap-8">
        <span v-if="data && data.state" class="tiny muted">checked {{ ago(data.state.at) }}</span>
        <button class="btn btn-sm" @click="load(true)" :disabled="loading"><span v-if="loading" class="spinner"></span>Check again</button>
        <button v-if="picked.length" class="admin-only btn btn-sm btn-primary" @click="install(picked)">Install {{ picked.length }} selected</button>
      </div>
    </div>
    <p class="muted small" style="margin-top:-4px">Useful programs for this server. Projects tell you when one of their servers is missing a tool they need, so a deploy doesn't fail halfway.</p>
    <div v-if="data && data.error" class="alert alert-warn mb-12"><span class="alert-icon">⚠</span><span>Could not check the server: {{ data.error }}</span></div>
    <div v-if="data && data.running_job" class="alert alert-info mb-12"><span class="alert-icon">ℹ</span><span>Installing now — <a :href="'#/jobs/' + data.running_job">see the job</a>.</span></div>
    <div v-if="!data" class="muted small">Checking what is installed…</div>
    <div v-else style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">
      <div v-for="t in data.catalog" :key="t.key" class="card card-body" style="display:flex;flex-direction:column;gap:8px">
        <div class="row between gap-8">
          <div class="row gap-8"><span style="font-size:20px">{{ t.icon }}</span><b>{{ t.name }}</b></div>
          <span v-if="has(t.key)" class="badge badge-green">Installed</span>
          <span v-else-if="data.state" class="badge badge-gray">Not installed</span>
        </div>
        <div class="small muted" style="flex:1">{{ t.desc }}</div>
        <div v-if="has(t.key)" class="tiny mono muted" style="word-break:break-all">{{ list[t.key] }}</div>
        <div v-else-if="t.needs.length && t.needs.some((n) => !has(n))" class="tiny muted">Also installs {{ t.needs.filter((n) => !has(n)).map(nameOf).join(', ') }}</div>
        <div v-if="!has(t.key) && data.state" class="admin-only row gap-8">
          <button class="btn btn-sm btn-primary" @click="install([t.key])" :disabled="!!data.running_job">Install</button>
          <label class="row gap-6 small"><input type="checkbox" :checked="picked.includes(t.key)" @change="toggle(t.key)"> select</label>
        </div>
      </div>
    </div>
  </section>`,
};

/** Project page: "Backup 2 has no Node.js — this project needs it" with an Install button. */
export const ToolCheckBanner = {
  props: { project: Object },
  emits: ['changed'],
  setup(props, { emit }) {
    const checking = ref(false);
    const result = ref(null);
    const tc = computed(() => result.value || props.project.tool_check || { needs: [], servers: [] });
    const missing = computed(() => tc.value.servers.filter((s) => s.missing.length));
    const unchecked = computed(() => tc.value.needs.length && tc.value.servers.some((s) => !s.checked_at));
    const NAMES = { node: 'Node.js', pm2: 'PM2', docker: 'Docker', git: 'Git', pnpm: 'pnpm & Yarn', nginx: 'Nginx', certbot: 'Certbot' };
    const names = (keys) => keys.map((k) => NAMES[k] || k).join(' and ');
    async function check() {
      checking.value = true;
      try {
        result.value = await http.post(`/projects/${props.project.id}/tool-check`);
        if (result.value.errors?.length) toast(result.value.errors.join(' · '), 'error');
        else if (!result.value.servers.some((s) => s.missing.length)) toast('Every server has the tools this project needs', 'success');
        emit('changed');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        checking.value = false;
      }
    }
    // Servers never checked yet: check them once, quietly, when the project opens.
    onMounted(async () => {
      if (!unchecked.value) return;
      try {
        result.value = await http.post(`/projects/${props.project.id}/tool-check`);
      } catch {
        /* the button still works */
      }
    });
    watch(() => props.project.tool_check, () => (result.value = null));
    const install = (s) => runJob(http.post(`/servers/${s.server_id}/tools/install`, { tools: s.missing }));
    return { tc, missing, names, check, checking, install, store };
  },
  template: `
  <div v-if="missing.length" class="alert alert-warn mb-12" style="align-items:flex-start">
    <span class="alert-icon">⚠</span>
    <div class="grow">
      <div v-for="s in missing" :key="s.deployment_id" class="row between gap-8 wrap" style="padding:2px 0">
        <span><b>{{ s.server_name }}</b> has no <b>{{ names(s.missing) }}</b> — this project's deploy script needs {{ s.missing.length > 1 ? 'them' : 'it' }}, so a deploy there would fail.</span>
        <span class="row gap-6">
          <button class="admin-only btn btn-sm btn-primary" @click="install(s)">Install {{ names(s.missing) }}</button>
          <a class="btn btn-sm" :href="'#/servers/' + s.server_id + '?tools=1'">Tools</a>
        </span>
      </div>
      <div class="tiny muted mt-8">Installed it another way? <button class="link-btn" @click="check" :disabled="checking">Check again</button></div>
    </div>
  </div>`,
};

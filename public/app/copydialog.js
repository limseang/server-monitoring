import { ref, reactive, computed, onMounted, watch } from '/vendor/vue.js';
import { store, http, toast, closeDialog, showJob, bytes } from './lib.js';
import { Modal } from './components.js';

/* ------------------------------------------------------------------ copy one project to another server */
// Opened from a project's server card ({ project, deployment }) or from a server page ({ server }).
export const CopyProjectDialog = {
  props: { project: Object, deployment: Object, server: Object, onDone: Function },
  components: { Modal },
  setup(props) {
    const projects = ref(props.project ? [props.project] : []);
    const f = reactive({
      project: props.project?.id || null,
      deployment: props.deployment?.id || null,
      target: null,
      installDocker: true,
      freeze: true,
      replace: false,
      confirm: '',
    });
    const ports = reactive({}); // "8080" → "8085" (empty = keep)
    const plan = ref(null);
    const scanError = ref('');
    const scanning = ref(false);
    const busy = ref(false);

    // From a server page: the projects that run on that server.
    onMounted(async () => {
      if (props.project) return;
      try {
        const all = await http.get('/projects');
        projects.value = all.filter((p) => (p.deployments || []).some((d) => d.server_id === props.server.id));
        if (projects.value.length === 1) pickProject(projects.value[0].id);
      } catch (e) {
        scanError.value = e.message;
      }
    });
    const project = computed(() => projects.value.find((p) => p.id === f.project) || null);
    const deps = computed(() => project.value?.deployments || []);
    const source = computed(() => deps.value.find((d) => d.id === f.deployment) || null);
    function pickProject(id) {
      f.project = id;
      const p = projects.value.find((x) => x.id === id);
      const d = props.server ? p?.deployments.find((x) => x.server_id === props.server.id) : p?.deployments.find((x) => x.is_active) || p?.deployments[0];
      f.deployment = d?.id || null;
    }
    const targets = computed(() => {
      const used = new Set(deps.value.map((d) => d.server_id));
      return (store.overview?.servers || []).filter((s) => !used.has(s.id));
    });
    const target = computed(() => targets.value.find((x) => x.id === f.target));

    const body = () => ({
      deployment: f.deployment,
      target: f.target,
      installDocker: f.installDocker,
      freeze: f.freeze,
      replace: f.replace,
      ports: Object.fromEntries(Object.entries(ports).filter(([, v]) => String(v ?? '').trim() !== '')),
    });
    const stamp = computed(() => JSON.stringify({ ...body(), project: f.project }));
    let scannedStamp = '';
    const stale = computed(() => !!plan.value && scannedStamp !== stamp.value);
    watch(() => f.project, (id) => id && !props.project && pickProject(id));
    // New project/source/target → old port choices no longer apply.
    watch(() => [f.project, f.deployment, f.target], () => {
      for (const k of Object.keys(ports)) delete ports[k];
      plan.value = null;
      scanError.value = '';
    });

    async function scan() {
      if (!f.project || !f.deployment || !f.target) return;
      scanning.value = true;
      scanError.value = '';
      try {
        const r = await http.post(`/projects/${f.project}/copy/preview`, body());
        if (r.ok) {
          plan.value = r.plan;
          scannedStamp = stamp.value;
        } else {
          plan.value = null;
          scanError.value = r.error;
        }
      } catch (e) {
        scanError.value = e.message;
      } finally {
        scanning.value = false;
      }
    }
    const portState = (p) => {
      const typed = String(ports[p.port] ?? '').trim();
      if (stale.value && typed && Number(typed) !== p.to) return { cls: 'badge-gray', text: 'scan again' };
      if (p.to === 22 || p.inUse) return { cls: 'badge-red', text: `in use on ${plan.value.target.name}` };
      return { cls: 'badge-green', text: 'free' };
    };
    const kindLabel = { docker: 'Docker', pm2: 'PM2', service: 'systemd', nginx: 'nginx', switchboard: 'Switchboard', record: 'saved port' };
    const canStart = computed(() => plan.value && !plan.value.problems.length && !stale.value && target.value && (!f.replace || f.confirm === target.value.name));
    async function submit() {
      busy.value = true;
      try {
        const r = await http.post(`/projects/${f.project}/copy`, { ...body(), confirm: f.confirm });
        closeDialog();
        showJob(r.job.id);
        props.onDone?.();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    const title = computed(() => (project.value ? `Copy ${project.value.name} to another server` : 'Copy a project to another server'));
    return { props, projects, project, deps, source, targets, target, f, ports, plan, scanError, scanning, busy, stale, canStart, scan, submit, pickProject, portState, kindLabel, bytes, title, closeDialog };
  },
  template: `
  <modal :title="title" size="lg" @close="closeDialog">
    <div class="form">
      <p class="muted small" style="margin:0">Copies <b>only this project</b> to another server: its Docker stack (folder, images, volumes with the database data) or its apps outside Docker (PM2, systemd, nginx site and app folder), then starts it there and adds that server to the project as a standby. You can run it on other ports there. Traffic is <b>not</b> moved.</p>

      <div v-if="!props.project" class="field"><label>Project</label>
        <select v-model.number="f.project"><option :value="null" disabled>Pick a project…</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option></select>
        <span class="hint" v-if="!projects.length">No project uses {{ props.server && props.server.name }} yet.</span>
      </div>
      <div v-if="project && deps.length > 1 && !props.server" class="field"><label>Copy from</label>
        <select v-model.number="f.deployment"><option v-for="d in deps" :key="d.id" :value="d.id">{{ d.server_name }}{{ d.is_active ? ' (live)' : '' }}</option></select>
      </div>
      <div v-else-if="source" class="small muted">From <b>{{ source.server_name }}</b><span v-if="source.app_dir" class="mono"> · {{ source.app_dir }}</span></div>
      <div class="field"><label>Copy to</label>
        <select v-model.number="f.target" :disabled="!f.deployment"><option :value="null" disabled>Pick a server…</option><option v-for="x in targets" :key="x.id" :value="x.id">{{ x.name }} ({{ x.ip }})</option></select>
        <span class="hint" v-if="f.deployment && !targets.length">Every server is already part of this project. Add a server first (Servers → Add server).</span>
      </div>

      <div class="fieldset">
        <label class="check"><input type="checkbox" v-model="f.installDocker"><span class="check-text"><b>Install Docker if it's missing</b><span class="hint">Only needed when the project runs in Docker.</span></span></label>
        <label class="check"><input type="checkbox" v-model="f.freeze"><span class="check-text"><b>Pause the project's containers while their data is copied</b><span class="hint">Exact snapshot of the database. The app on the source is frozen for the seconds/minutes the copy takes, then resumes.</span></span></label>
        <label class="check"><input type="checkbox" v-model="f.replace"><span class="check-text"><b>Replace what exists on the target</b><span class="hint">Only to re-run a copy: the same Docker stack, PM2 app, service or folder on the target is overwritten.</span></span></label>
      </div>

      <div class="row gap-8"><button class="btn" @click="scan" :disabled="!f.deployment || !f.target || scanning"><span v-if="scanning" class="spinner"></span>{{ plan ? 'Check again' : 'Check both servers' }}</button><span class="muted small">Reads both servers, changes nothing.</span></div>
      <div v-if="scanError" class="result err">{{ scanError }}</div>
      <div v-if="stale" class="alert alert-warn"><span class="alert-icon">⚠</span><span>Options or ports changed — check again.</span></div>

      <template v-if="plan">
        <div class="flow small">
          <div class="card card-body"><div class="strong">{{ plan.source.name }}</div><div class="muted">{{ plan.source.os }} · {{ plan.source.arch }}</div></div>
          <span class="flow-arrow">→</span>
          <div class="card card-body"><div class="strong">{{ plan.target.name }}</div><div class="muted">{{ plan.target.os }} · {{ plan.target.arch }} · Docker {{ plan.target.docker === 'none' ? 'not installed' : plan.target.docker }} · {{ bytes(plan.target.free) }} free</div></div>
        </div>

        <div><div class="label mb-8">Ports on {{ plan.target.name }}</div>
          <div class="card table-wrap"><table class="table"><tbody>
            <tr v-for="p in plan.ports" :key="p.port">
              <td><span class="mono strong">{{ p.port }}</span> <span class="badge badge-gray">{{ kindLabel[p.kind] || p.kind }}</span><div class="tiny muted">{{ p.what.join(' · ') }}</div></td>
              <td style="width:150px"><input v-model="ports[p.port]" class="code" inputmode="numeric" :placeholder="'same (' + p.port + ')'" style="width:130px"></td>
              <td style="width:150px"><span class="badge" :class="portState(p).cls">{{ portState(p).text }}</span></td>
            </tr>
            <tr v-if="!plan.ports.length"><td class="muted">The project doesn't listen on a port of its own (e.g. a static site on port 80).</td></tr>
          </tbody></table></div>
          <div class="tiny muted mt-8">Leave empty to keep the same port. A new port is written into the copied docker-compose file / .env, the PM2 or systemd settings, the nginx proxy and Switchboard's web proxy.</div>
        </div>

        <div v-for="p in plan.problems" :key="p" class="result err">✖ {{ p }}</div>
        <div v-for="w in plan.warnings" :key="w" class="alert alert-warn"><span class="alert-icon">⚠</span><span>{{ w }}</span></div>

        <div v-if="plan.stacks.length"><div class="label mb-8">Docker</div>
          <div class="card table-wrap"><table class="table"><tbody>
            <tr v-for="st in plan.stacks" :key="st.project">
              <td><span class="strong">{{ st.project }}</span> <span class="badge" :class="st.running ? 'badge-green' : 'badge-gray'">{{ st.running ? 'running' : 'stopped' }}</span><div class="tiny muted mono">{{ st.dir || 'no folder' }}</div></td>
              <td class="small muted">{{ st.containers.join(', ') }}<div class="tiny">{{ st.volumes.length }} volume(s)<span v-if="st.binds.length"> · outside: {{ st.binds.join(', ') }}</span></div></td>
              <td class="small">{{ bytes(st.bytes) }}</td>
            </tr>
          </tbody></table></div>
          <div class="tiny muted mt-8">Images: {{ plan.images.count }} in use, {{ plan.images.toCopy }} to copy ({{ bytes(plan.images.bytes) }})</div>
        </div>
        <div v-if="plan.pm2.length || plan.services.length || plan.sites.length || plan.folders.length" class="small" style="display:flex;flex-direction:column;gap:4px">
          <div class="label">Outside Docker</div>
          <div v-if="plan.pm2.length"><b>PM2:</b> <span v-for="(a, i) in plan.pm2" :key="a.user + a.name">{{ i ? ', ' : '' }}{{ a.name }} <span class="muted">({{ a.user }}, {{ a.status }})</span></span></div>
          <div v-if="plan.services.length"><b>systemd:</b> {{ plan.services.join(', ') }}</div>
          <div v-if="plan.sites.length"><b>nginx:</b> {{ plan.sites.map((x) => x.names.join(' ') || 'default').join(', ') }}</div>
          <div v-if="plan.folders.length"><b>Folders:</b> <span class="mono">{{ plan.folders.map((x) => x.path).join(', ') }}</span> ({{ bytes(plan.folders.reduce((n, x) => n + x.bytes, 0)) }})</div>
          <div v-if="plan.users.length"><b>Users created:</b> {{ plan.users.join(', ') }}</div>
          <div v-if="plan.node.paths.length || plan.node.npmGlobals.length"><b>Node.js:</b> <span class="mono">{{ plan.node.paths.join(', ') }}</span><template v-if="plan.node.npmGlobals.length"> · npm -g {{ plan.node.npmGlobals.join(' ') }}</template></div>
          <div v-if="plan.packages.length"><b>Packages installed:</b> <span class="mono">{{ plan.packages.join(' ') }}</span></div>
        </div>
        <div v-if="plan.edgeSites.length" class="small"><b>Switchboard web proxy:</b> {{ plan.edgeSites.map((e) => e.hosts.join(' ') + ' → :' + e.port).join(', ') }}</div>
        <div class="strong">Total to copy: about {{ bytes(plan.bytes.total) }}</div>

        <div v-if="!plan.problems.length && f.replace" class="field"><label>Type <code>{{ target && target.name }}</code> to confirm — what exists there is overwritten</label><input v-model="f.confirm" class="code" autocomplete="off"></div>
      </template>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="submit" :disabled="busy || !canStart">Start copy</button>
    </template>
  </modal>`,
};

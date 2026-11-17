import { ref, reactive, computed } from '/vendor/vue.js';
import { store, http, toast, closeDialog, showJob, go, bytes } from './lib.js';
import { Modal } from './components.js';

/* ------------------------------------------------------------------ remove a project from one server */
export const RemoveDeploymentDialog = {
  props: { project: Object, deployment: Object, onDone: Function },
  components: { Modal },
  setup(props) {
    const p = props.project;
    const d = props.deployment;
    const f = reactive({ remove_files: false, backup: d.db_type !== 'none', confirm: '' });
    const busy = ref(false);
    const hasDb = d.db_type !== 'none' && !p.db_server_id;
    const ok = computed(() => !f.remove_files || f.confirm === d.server_name);
    async function submit() {
      busy.value = true;
      try {
        const r = await http.del(`/deployments/${d.id}`, { remove_files: f.remove_files, backup: f.backup });
        closeDialog();
        if (r.job) showJob(r.job.id);
        else toast('Removed', 'success');
        props.onDone?.();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    return { p, d, f, busy, hasDb, ok, submit, closeDialog };
  },
  template: `
  <modal :title="'Remove ' + d.server_name + ' from ' + p.name" size="sm" @close="closeDialog">
    <div class="form">
      <div class="fieldset">
        <label class="check"><input type="radio" :value="false" v-model="f.remove_files"><span class="check-text"><b>Only in Switchboard</b><span class="hint">The project stays on the server, untouched. Switchboard just stops watching it there.</span></span></label>
        <label class="check"><input type="radio" :value="true" v-model="f.remove_files"><span class="check-text"><b>Also delete it from the server</b><span class="hint">Its Docker containers, volumes (database data!) and networks, PM2/systemd apps in its folder, its web proxy site, and the folder <code>{{ d.app_dir || '(none set)' }}</code>. Other projects on {{ d.server_name }} are not touched.</span></span></label>
      </div>
      <template v-if="f.remove_files">
        <label v-if="hasDb" class="check"><input type="checkbox" v-model="f.backup"><span class="check-text"><b>Back up the database first</b><span class="hint">Saved in the Backups tab. If the backup fails, nothing is deleted.</span></span></label>
        <div v-if="hasDb && !f.backup" class="alert alert-error"><span class="alert-icon">✖</span><span>The database on {{ d.server_name }} will be gone for good.</span></div>
        <div class="field"><label>Type <code>{{ d.server_name }}</code> to confirm</label><input v-model="f.confirm" class="code" autocomplete="off"></div>
      </template>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-danger solid" @click="submit" :disabled="busy || !ok">{{ f.remove_files ? 'Delete from server' : 'Remove' }}</button>
    </template>
  </modal>`,
};

/* ------------------------------------------------------------------ delete a whole project */
export const DeleteProjectDialog = {
  props: { project: Object },
  components: { Modal },
  setup(props) {
    const p = props.project;
    const deps = p.deployments || [];
    const lb = p.traffic_mode === 'lb';
    const f = reactive({ remove_files: false, backup: true, confirm: '' });
    const busy = ref(false);
    async function submit() {
      busy.value = true;
      try {
        const r = await http.del(`/projects/${p.id}`, { confirm: f.confirm, remove_files: f.remove_files, backup: f.backup });
        closeDialog();
        store.live++;
        go('/');
        if (r.job) showJob(r.job.id);
        else toast('Project deleted', 'success');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    return { p, deps, lb, f, busy, submit, closeDialog };
  },
  template: `
  <modal :title="'Delete ' + p.name" size="sm" @close="closeDialog">
    <div class="form">
      <div class="fieldset">
        <label class="check"><input type="radio" :value="false" v-model="f.remove_files"><span class="check-text"><b>Only from Switchboard</b><span class="hint">Deletes the project and its backups stored here. Servers, containers and Cloudflare records stay as they are.</span></span></label>
        <label class="check" :class="{ disabled: lb || !deps.length }"><input type="radio" :value="true" v-model="f.remove_files" :disabled="lb || !deps.length"><span class="check-text"><b>Also delete it from {{ deps.length === 1 ? 'its server' : 'all ' + deps.length + ' servers' }}</b>
          <span class="hint" v-if="lb">Turn off load balancing first.</span>
          <span class="hint" v-else>On {{ deps.map((d) => d.server_name).join(', ') || 'no servers' }}: containers, volumes (database data!), apps and folders of this project — the live server too, so the site goes offline. Staging copies are removed as well. Cloudflare DNS is not touched.</span></span></label>
      </div>
      <template v-if="f.remove_files">
        <label class="check"><input type="checkbox" v-model="f.backup"><span class="check-text"><b>Keep a final database backup</b><span class="hint">Saved on the Switchboard machine in <code>backups/_deleted/</code>. If a backup fails, nothing more is deleted.</span></span></label>
      </template>
      <div class="field"><label>Type <code>{{ p.slug }}</code> to confirm</label><input v-model="f.confirm" class="code" autocomplete="off"></div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-danger solid" @click="submit" :disabled="busy || f.confirm !== p.slug">{{ f.remove_files ? 'Delete everywhere' : 'Delete project' }}</button>
    </template>
  </modal>`,
};

/* ------------------------------------------------------------------ reset a server */
export const ResetServerDialog = {
  props: { server: Object },
  components: { Modal },
  setup(props) {
    const s = props.server;
    const f = reactive({ hostApps: true, crontabs: true, projects: true, confirm: '' });
    const plan = ref(null);
    const scanError = ref('');
    const scanning = ref(false);
    const busy = ref(false);
    const body = () => ({ hostApps: f.hostApps, crontabs: f.crontabs, projects: f.projects });
    const stamp = computed(() => JSON.stringify(body()));
    let scannedStamp = '';
    const stale = computed(() => !!plan.value && scannedStamp !== stamp.value);
    async function scan() {
      scanning.value = true;
      scanError.value = '';
      plan.value = null;
      try {
        const r = await http.post(`/servers/${s.id}/reset/preview`, body());
        if (r.ok) {
          plan.value = r.plan;
          scannedStamp = stamp.value;
        } else scanError.value = r.error;
      } catch (e) {
        scanError.value = e.message;
      } finally {
        scanning.value = false;
      }
    }
    const canStart = computed(() => plan.value && !plan.value.problems.length && !stale.value && f.confirm === s.name);
    async function submit() {
      busy.value = true;
      try {
        const r = await http.post(`/servers/${s.id}/reset`, { ...body(), confirm: f.confirm });
        closeDialog();
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    return { s, f, plan, scanError, scanning, busy, stale, canStart, scan, submit, bytes, closeDialog };
  },
  template: `
  <modal :title="'Reset ' + s.name" size="lg" @close="closeDialog">
    <div class="form">
      <div class="alert alert-error"><span class="alert-icon">✖</span><span>Makes <b>{{ s.name }}</b> like a freshly installed server: <b>every</b> Docker container, volume (all databases), image and compose folder is deleted — not only the projects Switchboard knows about. This can't be undone. Take backups first.</span></div>
      <p class="muted small" style="margin:0">Kept: the operating system, users, SSH access and Docker itself, so you can clone to it or create projects on it right away. Changed config files (nginx, systemd units, crontabs) are saved to <code>/root/switchboard-reset-&lt;date&gt;.tar.gz</code> on the server.</p>

      <div class="fieldset">
        <label class="check"><input type="checkbox" checked disabled><span class="check-text"><b>All Docker containers, volumes, networks and images</b><span class="hint">Plus the compose folders, their data folders, and Switchboard's helper, settings and GitHub runners on the server.</span></span></label>
        <label class="check"><input type="checkbox" v-model="f.hostApps"><span class="check-text"><b>Apps outside Docker</b><span class="hint">PM2 apps, custom systemd services, nginx sites (the stock "default" site stays) and their folders.</span></span></label>
        <label class="check"><input type="checkbox" v-model="f.crontabs"><span class="check-text"><b>Crontabs</b><span class="hint">Scheduled jobs of root and the other users.</span></span></label>
        <label class="check"><input type="checkbox" v-model="f.projects"><span class="check-text"><b>Remove {{ s.name }} from its projects in Switchboard</b><span class="hint">Their copies on this server are gone anyway. The server itself stays in Switchboard.</span></span></label>
      </div>

      <div class="row gap-8"><button class="btn" @click="scan" :disabled="scanning"><span v-if="scanning" class="spinner"></span>{{ plan ? 'Scan again' : 'Scan the server' }}</button><span class="muted small">Shows what will be deleted. Changes nothing.</span></div>
      <div v-if="scanError" class="result err">{{ scanError }}</div>
      <div v-if="stale" class="alert alert-warn"><span class="alert-icon">⚠</span><span>Options changed — scan again.</span></div>

      <template v-if="plan">
        <div class="muted small">{{ plan.server.os }} · Docker {{ plan.server.docker === 'none' ? 'not installed' : plan.server.docker }}</div>
        <div v-for="p in plan.problems" :key="p" class="result err">✖ {{ p }}</div>
        <div v-for="w in plan.warnings" :key="w" class="alert alert-warn"><span class="alert-icon">⚠</span><span>{{ w }}</span></div>
        <div><div class="label mb-8">Docker stacks to delete ({{ plan.stacks.length }})</div>
          <div class="card table-wrap"><table class="table"><tbody>
            <tr v-for="st in plan.stacks" :key="st.project">
              <td><span class="strong">{{ st.project }}</span> <span class="badge" :class="st.running ? 'badge-green' : 'badge-gray'">{{ st.running ? 'running' : 'stopped' }}</span><div class="tiny muted mono">{{ st.dir || 'no folder' }}</div></td>
              <td class="small muted">{{ st.containers }} containers · {{ st.volumes }} volumes</td>
            </tr>
            <tr v-if="!plan.stacks.length"><td class="muted">No compose stacks.</td></tr>
          </tbody></table></div>
        </div>
        <div class="small" style="display:flex;flex-direction:column;gap:4px">
          <div v-if="plan.standalone.length"><b>Other containers:</b> {{ plan.standalone.join(', ') }}</div>
          <div><b>Docker total:</b> {{ plan.volumes }} volume(s), {{ plan.images }} image(s)<template v-for="x in plan.dockerDisk" :key="x.type"> · {{ x.type }} {{ x.size }}</template></div>
          <div v-if="plan.folders.length"><b>Folders:</b> <span class="mono">{{ plan.folders.join(', ') }}</span></div>
          <div v-if="plan.kept.length" class="muted"><b>Kept (system/home folders):</b> <span class="mono">{{ plan.kept.join(', ') }}</span></div>
          <div v-if="plan.pm2.length"><b>PM2:</b> {{ plan.pm2.join(', ') }}</div>
          <div v-if="plan.services.length"><b>systemd:</b> {{ plan.services.join(', ') }}</div>
          <div v-if="plan.sites.length"><b>nginx sites:</b> {{ plan.sites.join(', ') }}</div>
          <div v-if="plan.crontabs.length"><b>Crontabs:</b> {{ plan.crontabs.join(', ') }}</div>
          <div v-if="plan.runners.length"><b>GitHub runners:</b> {{ plan.runners.join(', ') }}</div>
          <div v-if="plan.deployments.length"><b>Removed from projects:</b> {{ plan.deployments.join(', ') }}</div>
          <div class="muted"><b>Users kept:</b> {{ plan.users.join(', ') || 'root only' }}</div>
        </div>
        <div v-if="!plan.problems.length" class="field"><label>Type <code>{{ s.name }}</code> to confirm — everything above is deleted</label><input v-model="f.confirm" class="code" autocomplete="off"></div>
      </template>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-danger solid" @click="submit" :disabled="busy || !canStart">Reset server</button>
    </template>
  </modal>`,
};

/* ------------------------------------------------------------------ reinstall the OS */
export const ReinstallDialog = {
  props: { server: Object },
  components: { Modal },
  setup(props) {
    const s = props.server;
    const osList = ref([]);
    http.get('/reinstall/os').then((x) => (osList.value = x)).catch(() => {});
    const f = reactive({ os: 'debian-12', installDocker: true, confirm: '' });
    const plan = ref(null);
    const scanError = ref('');
    const scanning = ref(false);
    const busy = ref(false);
    let scannedOs = '';
    const stale = computed(() => !!plan.value && scannedOs !== f.os);
    async function scan() {
      scanning.value = true;
      scanError.value = '';
      plan.value = null;
      try {
        const r = await http.post(`/servers/${s.id}/reinstall/preview`, { os: f.os });
        if (r.ok) {
          plan.value = r.plan;
          scannedOs = f.os;
        } else scanError.value = r.error;
      } catch (e) {
        scanError.value = e.message;
      } finally {
        scanning.value = false;
      }
    }
    const canStart = computed(() => plan.value && !plan.value.problems.length && !stale.value && f.confirm === s.name);
    async function submit() {
      busy.value = true;
      try {
        const r = await http.post(`/servers/${s.id}/reinstall`, { os: f.os, installDocker: f.installDocker, confirm: f.confirm });
        closeDialog();
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    return { s, osList, f, plan, scanError, scanning, busy, stale, canStart, scan, submit, bytes, closeDialog };
  },
  template: `
  <modal :title="'Reinstall ' + s.name + ' from zero'" size="lg" @close="closeDialog">
    <div class="form">
      <div class="alert alert-error"><span class="alert-icon">✖</span><span><b>The whole disk of {{ s.name }} is erased</b> and a fresh operating system is installed — every file, database, user and setting is gone. Same IP. This can't be undone: download what you need first.</span></div>
      <p class="muted small" style="margin:0">Takes about 5–20 minutes. Afterwards you log in as <b>root</b> with the same SSH key or password Switchboard uses now. Works on DigitalOcean, AWS and home servers (uses the open-source <code>bin456789/reinstall</code> tool, pinned to a fixed version).</p>
      <div class="field"><label>New operating system</label>
        <select v-model="f.os"><option v-for="o in osList" :key="o.id" :value="o.id">{{ o.label }}</option></select></div>
      <label class="check"><input type="checkbox" v-model="f.installDocker"><span class="check-text"><b>Install Docker afterwards</b><span class="hint">So you can clone to it or create projects on it right away.</span></span></label>

      <div class="row gap-8"><button class="btn" @click="scan" :disabled="scanning"><span v-if="scanning" class="spinner"></span>{{ plan ? 'Check again' : 'Check the server' }}</button><span class="muted small">Reads the server, changes nothing.</span></div>
      <div v-if="scanError" class="result err">{{ scanError }}</div>
      <div v-if="stale" class="alert alert-warn"><span class="alert-icon">⚠</span><span>OS changed — check again.</span></div>

      <template v-if="plan">
        <div class="small" style="display:flex;flex-direction:column;gap:4px">
          <div><b>Now:</b> {{ plan.facts.os }} · {{ plan.facts.arch }} · {{ plan.facts.memMb }} MB RAM · {{ plan.facts.boot }} · {{ plan.facts.virt }}</div>
          <div><b>Disk{{ plan.facts.disks.length === 1 ? '' : 's' }}:</b> {{ plan.facts.disks.map((d) => d.name + ' ' + bytes(d.bytes)).join(', ') || '?' }}</div>
          <div><b>After:</b> {{ plan.facts.target }} · login {{ plan.facts.login }}</div>
          <div v-if="plan.facts.deployments.length"><b>Removed from projects:</b> {{ plan.facts.deployments.join(', ') }}</div>
          <div v-if="plan.facts.runners.length"><b>GitHub runners unregistered:</b> {{ plan.facts.runners.join(', ') }}</div>
          <div class="muted"><b>Installer:</b> {{ plan.facts.tool }}</div>
        </div>
        <div v-for="p in plan.problems" :key="p" class="result err">✖ {{ p }}</div>
        <div v-for="w in plan.warnings" :key="w" class="alert alert-warn"><span class="alert-icon">⚠</span><span>{{ w }}</span></div>
        <div v-if="!plan.problems.length" class="field"><label>Type <code>{{ s.name }}</code> to confirm — the whole disk is erased</label><input v-model="f.confirm" class="code" autocomplete="off"></div>
      </template>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-danger solid" @click="submit" :disabled="busy || !canStart">Erase disk and reinstall</button>
    </template>
  </modal>`,
};

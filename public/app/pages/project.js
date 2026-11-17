import { ref, reactive, computed, watch, onMounted } from '/vendor/vue.js';
import { store, http, toast, openDialog, confirmBox, runJob, go, freshness, fmtDate, bytes, HEALTH, isPrivateIp } from '../lib.js';
import { UptimeBar, HealthPill, MenuBtn, JobsTable, EventsList, Ago, RecordsPicker, CronField } from '../components.js';
import { TrafficTab } from './traffic.js';
import { CicdTab } from '../cicd.js';

const BACKUP_PRESETS = [
  ['Daily 3:00', '0 3 * * *'],
  ['Every 6 hours', '0 */6 * * *'],
  ['Every hour', '0 * * * *'],
];
const SYNC_PRESETS = [
  ['Every hour', '0 * * * *'],
  ['Every 6 hours', '0 */6 * * *'],
  ['Daily 4:00', '0 4 * * *'],
];
const DEPLOY_EXAMPLE = `git pull --ff-only
docker compose up -d --build --remove-orphans
docker compose exec -T app php artisan migrate --force
docker compose exec -T app php artisan optimize`;

/* ------------------------------------------------------------------ settings tab */
const ProjectSettings = {
  props: { project: Object },
  emits: ['saved'],
  components: { RecordsPicker, CronField },
  setup(props, { emit }) {
    const p = props.project;
    const f = reactive({
      name: p.name,
      domain: p.domain || '',
      notes: p.notes || '',
      dns_records: [...p.dns_records],
      health_scheme: p.health_scheme,
      health_path: p.health_path,
      health_port: p.health_port || '',
      health_expect: p.health_expect,
      health_keyword: p.health_keyword || '',
      auto_failover: !!p.auto_failover,
      failover_threshold: p.failover_threshold,
      failover_cooldown: p.failover_cooldown,
      maintenance_on_cmd: p.maintenance_on_cmd || '',
      maintenance_off_cmd: p.maintenance_off_cmd || '',
      deploy_script: p.deploy_script || '',
      sync_paths: p.sync_paths || '',
      sync_schedule: p.sync_schedule || '',
      sync_files_scheduled: !!p.sync_files_scheduled,
      backup_schedule: p.backup_schedule || '',
      backup_keep: p.backup_keep,
      purge_cache: !!p.purge_cache,
    });
    const editDns = ref(!p.dns_records.length);
    const saving = ref(false);
    const healthUrl = computed(() => `${f.health_scheme}://<server IP>${f.health_port ? `:${f.health_port}` : ''}${f.health_path || '/'}   Host: ${f.domain || '<server IP>'}`);
    const checkEvery = computed(() => store.settings?.check_interval || 60);
    async function save() {
      saving.value = true;
      try {
        await http.put(`/projects/${p.id}`, f);
        toast('Settings saved', 'success');
        editDns.value = false;
        emit('saved');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        saving.value = false;
      }
    }
    const del = () => openDialog('delete-project', { project: p });
    return { p, f, editDns, saving, save, del, healthUrl, checkEvery, BACKUP_PRESETS, SYNC_PRESETS, DEPLOY_EXAMPLE };
  },
  template: `
  <div class="stack">
    <div class="card card-body form">
      <h3>General</h3>
      <div class="form-row">
        <div class="field"><label>Name</label><input v-model="f.name"></div>
        <div class="field"><label>Main domain</label><input v-model="f.domain" class="code" placeholder="shop.example.com"></div>
      </div>
      <div class="field"><label>Notes</label><textarea v-model="f.notes" rows="2" placeholder="Anything worth remembering about this project"></textarea></div>
    </div>

    <div class="card card-body form">
      <div class="row between"><h3>Cloudflare DNS records</h3><button v-if="!editDns" class="btn btn-sm" @click="editDns = true">Change</button></div>
      <p class="hint" style="margin:0">These records are pointed to the live server's IP when you switch. Usually the main domain and <code>www</code>. Proxied (orange cloud) records switch within seconds.</p>
      <records-picker v-if="editDns" v-model="f.dns_records" :domain="f.domain" />
      <div v-else class="chips"><span v-for="r in f.dns_records" :key="r.id" class="chip on">{{ r.type }} {{ r.name }}</span><span v-if="!f.dns_records.length" class="muted small">None linked yet.</span></div>
    </div>

    <div class="card card-body form">
      <h3>Health check</h3>
      <div class="form-row-3">
        <div class="field"><label>Scheme</label><select v-model="f.health_scheme"><option value="https">https</option><option value="http">http</option></select></div>
        <div class="field"><label>Path</label><input v-model="f.health_path" class="code" placeholder="/up"></div>
        <div class="field"><label>Port <span class="muted">(optional)</span></label><input v-model="f.health_port" class="code" :placeholder="f.health_scheme === 'https' ? '443' : '80'"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>OK status codes</label><input v-model="f.health_expect" class="code" placeholder="200-399"></div>
        <div class="field"><label>Page must contain <span class="muted">(optional)</span></label><input v-model="f.health_keyword" placeholder="e.g. a word from your homepage"></div>
      </div>
      <div class="hint">Every {{ checkEvery }}s Switchboard calls <code>{{ healthUrl }}</code> on each server directly (bypassing Cloudflare), so you see each server's real health. TLS certificate errors are ignored (Cloudflare origin certificates are fine).</div>
    </div>

    <div class="card card-body form">
      <h3>Automatic failover</h3>
      <label class="check"><input type="checkbox" v-model="f.auto_failover"><span class="check-text"><b>Switch automatically when the live server goes down</b>
        <span class="hint">After the failed checks below, DNS is pointed to the healthiest standby (by priority). The database is <b>not</b> copied (the live server is down), so the standby serves its last copy. Turn on "Copy data automatically" below to keep standbys fresh.</span></span></label>
      <div class="form-row" v-if="f.auto_failover">
        <div class="field"><label>Failed checks in a row before it counts as down</label><input type="number" v-model.number="f.failover_threshold" min="1"><span class="hint">≈ {{ f.failover_threshold * checkEvery }}s of downtime before switching</span></div>
        <div class="field"><label>Wait at least (minutes) between automatic switches</label><input type="number" v-model.number="f.failover_cooldown" min="0"></div>
      </div>
    </div>

    <div class="card card-body form">
      <h3>Copy data & backups</h3>
      <div class="field"><label>Files to copy with the database <span class="muted">(one per line, optional)</span></label>
        <textarea v-model="f.sync_paths" class="code" rows="3" placeholder="storage/app/public&#10;app:/var/www/html/storage/app/public"></textarea>
        <span class="hint"><code>storage/app/public</code> = relative to the app folder · <code>/srv/uploads</code> = absolute path on the server · <code>app:/var/www/html/storage/app/public</code> = inside the app container. Files are added/updated, never deleted on the target.</span></div>
      <div class="form-row">
        <div class="field"><label>Copy data from live → standby servers automatically</label><cron-field v-model="f.sync_schedule" :presets="SYNC_PRESETS" :next="project.next_runs && project.next_runs.sync" />
          <label class="check mt-8" v-if="f.sync_schedule"><input type="checkbox" v-model="f.sync_files_scheduled"><span class="check-text">Include files</span></label>
          <span class="hint">Keeps standbys "warm" so a failover loses at most this much data.</span></div>
        <div class="field"><label>Back up the live database automatically</label><cron-field v-model="f.backup_schedule" :presets="BACKUP_PRESETS" :next="project.next_runs && project.next_runs.backup" />
          <div class="row gap-8 mt-8"><span class="small muted">Keep the newest</span><input type="number" v-model.number="f.backup_keep" style="width:80px" min="1"><span class="small muted">automatic backups of each kind</span></div></div>
      </div>
    </div>

    <div class="card card-body form">
      <h3>Maintenance mode & deploy</h3>
      <div class="form-row">
        <div class="field"><label>Maintenance ON command</label><input v-model="f.maintenance_on_cmd" class="code"></div>
        <div class="field"><label>Maintenance OFF command</label><input v-model="f.maintenance_off_cmd" class="code"></div>
      </div>
      <div class="hint" style="margin-top:-6px">Run inside the app container (or in the app folder if no container is set). Laravel: <code>php artisan down --retry=60</code> / <code>php artisan up</code>.</div>
      <div class="field"><label>Deploy script</label><textarea v-model="f.deploy_script" class="code" rows="5" :placeholder="DEPLOY_EXAMPLE"></textarea>
        <span class="hint">Runs in the app folder with bash, stops at the first error. "Deploy to all" runs standby servers first, the live one last.</span></div>
      <label class="check"><input type="checkbox" v-model="f.purge_cache"><span class="check-text"><b>Purge Cloudflare cache after switching</b><span class="hint">Your token needs the "Cache Purge" permission.</span></span></label>
    </div>

    <div class="row gap-8"><button class="btn btn-primary" @click="save" :disabled="saving">Save settings</button></div>

    <div class="card card-body danger-zone">
      <div class="row between wrap gap-12"><div><h3>Delete project</h3><div class="hint">From Switchboard only, or also from its servers (containers, volumes, files). DNS stays as it is.</div></div><button class="btn btn-danger" @click="del">Delete project</button></div>
    </div>
  </div>`,
};

/* ------------------------------------------------------------------ page */
export default {
  props: { id: Number },
  components: { UptimeBar, HealthPill, MenuBtn, JobsTable, EventsList, Ago, ProjectSettings, TrafficTab, CicdTab },
  setup(props) {
    const p = ref(null);
    const notFound = ref(false);
    const tab = ref('dns');
    const backups = ref(null);
    const jobs = ref(null);
    const events = ref(null);
    const busy = ref({});

    async function load() {
      try {
        p.value = await http.get(`/projects/${props.id}`);
        notFound.value = false;
        if (tab.value === 'backups') loadBackups();
      } catch (e) {
        if (/not found/i.test(e.message)) notFound.value = true;
        else toast(e.message, 'error');
      }
    }
    const loadBackups = async () => (backups.value = await http.get(`/projects/${props.id}/backups`).catch(() => []));
    const loadJobs = async () => (jobs.value = await http.get(`/jobs?project=${props.id}&limit=50`).catch(() => []));
    const loadEvents = async () => (events.value = await http.get(`/events?project=${props.id}&limit=100`).catch(() => []));
    function openTab(t) {
      tab.value = t;
      if (t === 'backups') loadBackups();
      if (t === 'jobs') loadJobs();
      if (t === 'activity') loadEvents();
    }
    onMounted(load);
    watch(() => props.id, () => {
      p.value = null;
      tab.value = 'dns';
      load();
    });
    watch(() => store.live, load);
    watch(() => store.jobsLive, () => {
      if (tab.value === 'jobs') loadJobs();
      if (tab.value === 'backups') loadBackups();
      if (tab.value === 'activity') loadEvents();
    });

    const active = computed(() => p.value?.deployments.find((d) => d.is_active) || null);
    const staleHours = computed(() => store.settings?.stale_alert_hours || 24);
    const dns = computed(() => p.value?.dns_state);
    const dnsRows = computed(() => dns.value?.records || p.value?.dns_records.map((r) => ({ ...r, content: '?' })) || []);
    const ssl = computed(() => p.value?.ssl_state);
    const dbLabel = (d) => (p.value?.db_server_id ? 'Shared database server' : d.db_type === 'none' ? 'None' : `${d.db_type === 'postgres' ? 'PostgreSQL' : 'MySQL'} · ${d.db_name || '(from env)'} @ ${d.db_container}`);

    const openSwitch = (d) => openDialog('switch', { project: p.value, target: d?.id });
    const openSync = (source, target) => openDialog('sync', { project: p.value, source: source?.id, target: target?.id });
    const addDep = () => (p.value.available_servers.length ? openDialog('deployment', { project: p.value }) : (toast('All servers are already in this project — add a new server first', 'warn'), openDialog('server')));
    const editDep = (d) => openDialog('deployment', { project: p.value, dep: d });
    const openCommand = (d) => openDialog('command', { dep: d });

    async function checkNow() {
      busy.value.check = true;
      try {
        await http.post(`/projects/${props.id}/check`);
        await load();
        toast('Health checked', 'success');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value.check = false;
      }
    }
    async function refreshDns() {
      busy.value.dns = true;
      try {
        await http.post(`/projects/${props.id}/dns/refresh`);
        await load();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value.dns = false;
      }
    }
    const fixDns = () => runJob(http.post(`/projects/${props.id}/dns/fix`));
    async function adopt(d) {
      const down = d.health !== 'up';
      const ok = await confirmBox({
        title: `Mark ${d.server_name} as live?`,
        message:
          `Only use this when DNS ALREADY points to ${d.server_name} (for example you changed it by hand in Cloudflare). DNS is not changed by this button.\n\n` +
          (down
            ? `⚠ ${d.server_name} is ${HEALTH[d.health]?.label || d.health} right now. To move visitors to another server use "Switch traffic here" instead — it checks the server first and rolls back on failure.`
            : `To move visitors to ${d.server_name}, use "Switch traffic here" instead.`),
        confirmText: 'Mark as live',
        danger: down,
      });
      if (!ok) return;
      await http.post(`/projects/${props.id}/adopt`, { deployment: d.id }).catch((e) => toast(e.message, 'error'));
      load();
    }
    async function toggleMaint(d) {
      const on = !d.maintenance;
      if (on && d.is_active) {
        const ok = await confirmBox({ title: `Maintenance mode on the LIVE server?`, message: `Visitors of ${p.value.name} will see the maintenance page until you turn it off.`, confirmText: 'Turn on', danger: true });
        if (!ok) return;
      }
      runJob(http.post(`/deployments/${d.id}/maintenance`, { on }));
    }
    const backup = (d) => runJob(http.post(`/deployments/${d.id}/backup`, {}));
    const backupLive = () => (p.value.db_server_id ? runJob(http.post(`/projects/${props.id}/backup-shared`)) : active.value && backup(active.value));
    const lb = computed(() => p.value?.traffic_mode === 'lb');
    const privateOk = computed(() => !!store.settings?.info?.allow_private_dns);
    const lbCount = computed(() => p.value?.deployments.filter((d) => d.lb_state === 'active').length || 0);
    const LB_BADGE = { active: ['badge-green', 'Gets visitors'], draining: ['badge-amber', 'Draining'], off: ['badge-gray', 'Out of LB'] };
    const scaleOut = () => openDialog('scale-out', { project: p.value });
    async function moveHere(d) {
      const ok = await confirmBox({ title: `Move all traffic to ${d.server_name}?`, message: `${d.server_name} is added to the load balancer (after a health check), then every other server is drained. No downtime, no DNS change.`, confirmText: 'Move traffic' });
      if (ok) runJob(http.post(`/projects/${props.id}/switch`, { target: d.id }));
    }
    const lbMember = (d, action) => runJob(http.post(`/projects/${props.id}/lb/member`, { deployment: d.id, action }));
    async function deploy(d) {
      if (!(await confirmBox({ title: `Deploy on ${d.server_name}?`, message: 'Runs the deploy script of this project on that server.', confirmText: 'Deploy' }))) return;
      runJob(http.post(`/deployments/${d.id}/deploy`));
    }
    async function deployAll() {
      if (!(await confirmBox({ title: 'Deploy on all servers?', message: 'Standby servers first, the live server last. Stops at the first failure.', confirmText: 'Deploy all' }))) return;
      runJob(http.post(`/projects/${props.id}/deploy`));
    }
    const removeDep = (d) => openDialog('remove-deployment', { project: p.value, deployment: d, onDone: load });
    const restore = (b) => openDialog('restore', { project: p.value, backup: b });
    async function reprovision() {
      if (!(await confirmBox({ title: 'Run the template setup again?', message: 'Safe to repeat: finished steps are skipped, existing .env files and data are kept. Use it after fixing a problem that stopped the first setup.', confirmText: 'Run setup' }))) return;
      runJob(http.post(`/projects/${props.id}/provision`, {}));
    }
    async function delBackup(b) {
      if (!(await confirmBox({ title: `Delete backup #${b.id}?`, message: 'The file is deleted permanently.', confirmText: 'Delete', danger: true }))) return;
      await http.del(`/backups/${b.id}`).catch((e) => toast(e.message, 'error'));
      loadBackups();
    }
    async function keepBackup(b) {
      await http.patch(`/backups/${b.id}`, { keep: true }).catch((e) => toast(e.message, 'error'));
      toast('This backup will be kept until you delete it', 'success');
      loadBackups();
    }
    const kindBadge = { manual: 'badge-accent', scheduled: 'badge-blue', sync: 'badge-gray', 'pre-sync': 'badge-amber', 'pre-restore': 'badge-amber' };
    const kindLabel = { manual: 'manual', scheduled: 'scheduled', sync: 'copy source', 'pre-sync': 'before copy', 'pre-restore': 'before restore' };
    const sslFor = (d) => ssl.value?.origins?.[d.id];

    return {
      store, isPrivateIp, privateOk, p, notFound, tab, backups, jobs, events, busy, active, staleHours, dns, dnsRows, ssl, dbLabel, freshness, fmtDate, bytes, HEALTH,
      openTab, load, openSwitch, openSync, addDep, editDep, openCommand, checkNow, refreshDns, fixDns, adopt, toggleMaint, backup, backupLive,
      deploy, deployAll, removeDep, restore, reprovision, delBackup, keepBackup, kindBadge, kindLabel, sslFor, lb, lbCount, LB_BADGE, scaleOut, moveHere, lbMember,
    };
  },
  template: `
  <div v-if="notFound" class="empty-card"><div class="empty-title">Project not found</div><a href="#/">Back to overview</a></div>
  <div v-else-if="!p" class="muted">Loading…</div>
  <div v-else>
    <div class="page-head">
      <div>
        <div class="crumbs"><a href="#/">Overview</a> / Project</div>
        <h1>{{ p.name }}</h1>
        <div class="sub row gap-12 wrap">
          <a v-if="p.domain" :href="'https://' + p.domain" target="_blank" rel="noopener">{{ p.domain }} ↗</a>
          <span v-if="lb">Load balanced over <b style="color:var(--text)">{{ lbCount }} server{{ lbCount === 1 ? '' : 's' }}</b> · {{ p.lb_provider === 'cloudflare' ? 'Cloudflare' : 'own nginx' }}</span>
          <span v-else-if="active">Live on <b style="color:var(--text)">{{ active.server_name }}</b> <span class="mono">{{ active.server_ip }}</span></span>
          <span v-else class="text-amber">No live server set</span>
          <span v-if="p.db_server_id" class="badge badge-blue">Shared database</span>
          <span v-if="p.auto_failover" class="badge badge-accent">Auto-failover ON</span>
          <span v-if="p.parent_id" class="badge badge-amber">{{ p.env }} copy of <a :href="'#/projects/' + p.parent_id" style="color:inherit;text-decoration:underline">{{ p.parent_name || 'main project' }}</a></span>
          <span v-if="p.template" class="badge badge-gray" :title="'Made from the ' + p.template + ' template'">{{ p.template }}</span>
          <span v-if="p.git_repo" class="mono small">{{ p.git_repo }}@{{ p.git_branch }}</span>
        </div>
      </div>
      <div class="actions">
        <button v-if="lb" class="admin-only btn btn-primary" @click="scaleOut">+ Add server</button>
        <button v-else class="admin-only btn btn-primary" :disabled="p.deployments.length < 2" @click="openSwitch()">⇄ Switch server</button>
        <button v-if="!p.db_server_id" class="admin-only btn" :disabled="p.deployments.length < 2" @click="openSync(active)">Copy data</button>
        <menu-btn label="More ▾">
          <button class="menu-item" @click="checkNow" :disabled="busy.check">Run health check now</button>
          <button class="menu-item" @click="backupLive" :disabled="!p.db_server_id && (!active || active.db_type === 'none')">Back up the live database</button>
          <button class="admin-only menu-item" @click="openTab('traffic')">Load balancing & database server</button>
          <button class="menu-item" @click="deployAll" :disabled="!p.deploy_script">Deploy to all servers</button>
          <div class="menu-sep"></div>
          <button class="menu-item" @click="openTab('cicd')">CI/CD, staging & previews</button>
          <button v-if="p.template" class="admin-only menu-item" @click="reprovision">Run the template setup again</button>
          <button class="admin-only menu-item" @click="openTab('settings')">Project settings</button>
        </menu-btn>
      </div>
    </div>

    <div v-if="dns && dns.drift" class="alert alert-error mb-12"><span class="alert-icon">✖</span>
      <span class="grow">Cloudflare does not point to {{ lb ? 'the load balancer' : 'the live server' }} <b>{{ lb ? '' : active && active.server_name }}</b>. Someone may have changed DNS by hand.</span>
      <span class="admin-only alert-actions"><button class="btn btn-sm" @click="fixDns">Point DNS to {{ lb ? 'the load balancer' : active && active.server_name }}</button>
        <button v-if="dns.points_to && !lb" class="btn btn-sm" @click="adopt(p.deployments.find(d => d.id === dns.points_to))">Keep DNS, mark {{ (p.deployments.find(d => d.id === dns.points_to) || {}).server_name }} as live</button></span>
    </div>

    <div class="dep-grid">
      <div v-for="d in p.deployments" :key="d.id" class="card dep-card" :class="{ 'dep-live': d.is_active }">
        <div class="dep-head">
          <div style="min-width:0">
            <div class="row gap-8 wrap"><b class="dep-name">{{ d.server_name }}</b>
              <span v-if="lb" class="badge" :class="LB_BADGE[d.lb_state][0]">{{ LB_BADGE[d.lb_state][1] }}</span>
              <template v-else><span v-if="d.is_active" class="badge badge-green">LIVE</span><span v-else class="badge badge-gray">Standby</span></template>
              <span v-if="d.maintenance" class="badge badge-blue">Maintenance</span></div>
            <div class="muted mono small">{{ d.server_ip }}<template v-if="d.server_ipv6"> · {{ d.server_ipv6 }}</template></div>
          </div>
          <menu-btn small>
            <button class="admin-only menu-item" @click="editDep(d)">Edit containers / database</button>
            <button class="dev-only menu-item" :disabled="store.user.role !== 'admin' && !d.app_container" @click="openCommand(d)">Run a command…</button>
            <a class="menu-item" :href="'#/servers/' + d.server_id">Open server page</a>
            <div class="menu-sep"></div>
            <button v-if="!d.is_active" class="admin-only menu-item" @click="adopt(d)">Mark as live (no DNS change)</button>
            <button class="admin-only menu-item danger" :disabled="d.is_active" @click="removeDep(d)">Remove from project…</button>
          </menu-btn>
        </div>
        <div class="row between wrap gap-8">
          <health-pill :dep="d" />
          <span class="muted small" v-if="d.health_detail">{{ d.health_detail.code ? 'HTTP ' + d.health_detail.code : '' }}{{ d.health_detail.ms != null ? ' · ' + d.health_detail.ms + ' ms' : '' }} · <ago :at="d.checked_at" /></span>
        </div>
        <div v-if="d.health_detail && !d.health_detail.ok && d.health !== 'maintenance'" class="dep-error"><template v-if="d.server_status === 'up'"><b>The server is online</b> (SSH works), <b>but the website doesn't answer</b> at {{ p.health_scheme }}://{{ d.server_ip }}{{ p.health_port ? ':' + p.health_port : '' }}{{ p.health_path }} — </template>{{ d.health_detail.error }}</div>
        <div v-if="isPrivateIp(d.server_ip) && !lb && !privateOk" class="dep-warn">⚠ <b>Private IP</b> — visitors and Cloudflare can't reach {{ d.server_ip }}, so switching traffic here is blocked. Set the server's public IP (keep this one as "SSH host") and forward ports 80/443 to it.</div>
        <div>
          <uptime-bar :bars="d.bars" />
          <div class="row between tiny muted mt-8"><span>24h ago</span><span>{{ d.uptime != null ? d.uptime + '% up' : 'no data yet' }}{{ d.ms_avg ? ' · avg ' + d.ms_avg + ' ms' : '' }}</span><span>now</span></div>
        </div>
        <div class="kv">
          <div><span>Data</span><span :class="freshness(d, staleHours).cls" :title="d.data_note || ''">{{ freshness(d, staleHours).text }}<template v-if="d.data_note && !d.is_active"><br><span class="tiny muted">{{ d.data_note }}</span></template></span></div>
          <div v-if="p.traffic && p.traffic[d.server_id]"><span>Traffic</span><span class="small"><a :href="'#/servers/' + d.server_id" :class="p.traffic[d.server_id].err >= 5 ? 'text-red' : ''">{{ p.traffic[d.server_id].rpm }} req/min · {{ p.traffic[d.server_id].err }}% errors</a></span></div>
          <div><span>Database</span><span class="small">{{ dbLabel(d) }}<span v-if="d.skip_backup && d.db_type !== 'none'" class="tiny muted"> · no backup before copy</span></span></div>
          <div><span>App</span><span class="mono small">{{ d.app_container || '—' }}</span></div>
          <div><span>Folder</span><span class="mono small">{{ d.app_dir || '—' }}</span></div>
          <div v-if="sslFor(d) && sslFor(d).ok"><span>SSL</span><span class="small" :class="sslFor(d).days_left < 15 ? 'text-amber' : ''">{{ sslFor(d).days_left }} days left · {{ sslFor(d).issuer }}</span></div>
        </div>
        <div class="dep-actions">
          <template v-if="lb">
            <button v-if="d.lb_state === 'off'" class="admin-only btn btn-primary btn-sm" @click="lbMember(d, 'add')">Add to load balancer</button>
            <button v-else class="admin-only btn btn-sm" @click="lbMember(d, 'drain')">Drain</button>
            <button class="admin-only btn btn-sm" @click="moveHere(d)">Move all traffic here</button>
          </template>
          <template v-else>
            <button v-if="!d.is_active" class="admin-only btn btn-primary btn-sm" @click="openSwitch(d)" :disabled="!p.dns_records.length || (isPrivateIp(d.server_ip) && !privateOk)">Switch traffic here</button>
            <button v-if="!d.is_active && active && !p.db_server_id" class="admin-only btn btn-sm" @click="openSync(active, d)" :disabled="d.db_type === 'none'">Copy data from live</button>
          </template>
          <button v-if="!p.db_server_id" class="dev-only btn btn-sm" @click="backup(d)" :disabled="d.db_type === 'none'">Backup</button>
          <button class="dev-only btn btn-sm" @click="toggleMaint(d)">{{ d.maintenance ? 'Maintenance off' : 'Maintenance' }}</button>
          <button class="dev-only btn btn-sm" @click="deploy(d)" :disabled="!p.deploy_script" :title="p.deploy_script ? '' : 'Set a deploy script in Settings'">Deploy</button>
        </div>
      </div>
      <button class="admin-only dep-add" @click="addDep">+ Add a server to this project</button>
    </div>

    <div class="tabs">
      <button class="tab" :class="{ on: tab === 'dns' }" @click="openTab('dns')">DNS & SSL</button>
      <button class="tab" :class="{ on: tab === 'cicd' }" @click="openTab('cicd')">CI/CD<span v-if="p.ci_enabled" class="muted"> · on</span></button>
      <button class="admin-only tab" :class="{ on: tab === 'traffic' }" @click="openTab('traffic')">Traffic{{ lb ? ' · LB' : '' }}</button>
      <button class="tab" :class="{ on: tab === 'backups' }" @click="openTab('backups')">Backups <span class="muted">{{ p.backups_count }}</span></button>
      <button class="tab" :class="{ on: tab === 'jobs' }" @click="openTab('jobs')">Jobs</button>
      <button class="tab" :class="{ on: tab === 'activity' }" @click="openTab('activity')">Activity</button>
      <button class="admin-only tab" :class="{ on: tab === 'settings' }" @click="openTab('settings')">Settings</button>
    </div>

    <div v-if="tab === 'dns'" class="stack">
      <div class="card">
        <div class="card-head"><h3>Cloudflare DNS</h3>
          <div class="row gap-6"><span class="muted small" v-if="dns">checked <ago :at="dns.checked_at" /></span>
            <button class="btn btn-sm" @click="refreshDns" :disabled="busy.dns"><span v-if="busy.dns" class="spinner"></span>Check now</button>
            <button class="admin-only btn btn-sm" @click="openTab('settings')">Change records</button></div></div>
        <div v-if="!p.dns_records.length" class="empty">No Cloudflare records linked yet. <button class="link-btn" @click="openTab('settings')">Choose them in Settings</button> — that's what lets Switchboard switch traffic.</div>
        <template v-else>
          <div v-if="dns && dns.error" class="alert alert-warn" style="margin:12px 18px 0"><span class="alert-icon">⚠</span><span>{{ dns.error }}</span></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Record</th><th>Type</th><th>Points to</th><th>Server</th><th>Mode</th><th>TTL</th><th></th></tr></thead>
            <tbody><tr v-for="r in dnsRows" :key="r.id">
              <td class="strong">{{ r.name }}</td><td><span class="badge">{{ r.type }}</span></td><td class="mono small">{{ r.content }}</td>
              <td>{{ r.owner_name || (r.content && r.content !== '?' ? 'unknown server' : '') }}</td>
              <td><span v-if="r.proxied !== undefined" class="badge" :class="r.proxied ? 'badge-amber' : 'badge-gray'">{{ r.proxied ? 'Proxied' : 'DNS only' }}</span></td>
              <td class="small muted">{{ r.ttl === 1 ? 'auto' : r.ttl ? r.ttl + 's' : '' }}</td>
              <td class="right"><span v-if="r.ok === true" class="text-green">✔ live server</span><span v-else-if="r.ok === false" class="text-red">✖ not live server</span></td>
            </tr></tbody>
          </table></div>
          <div v-if="dnsRows.some(r => r.proxied === false && r.ttl > 300)" class="hint" style="padding:0 18px 14px">Tip: DNS-only records with a long TTL make switching slow (visitors keep the old IP until the TTL expires). Use proxied mode or TTL 60.</div>
        </template>
      </div>
      <div class="card" v-if="ssl">
        <div class="card-head"><h3>SSL certificates</h3><span class="muted small">checked <ago :at="ssl.checked_at" /></span></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Where</th><th>Issuer</th><th>Expires</th><th>Days left</th></tr></thead>
          <tbody>
            <tr><td>Public (what visitors see)</td><template v-if="ssl.edge.ok"><td>{{ ssl.edge.issuer }}</td><td>{{ fmtDate(ssl.edge.valid_to) }}</td><td :class="ssl.edge.days_left < 15 ? 'text-amber' : 'text-green'">{{ ssl.edge.days_left }}</td></template><td v-else colspan="3" class="text-red small">{{ ssl.edge.error }}</td></tr>
            <tr v-for="(o, id) in ssl.origins" :key="id"><td>{{ o.server }} (origin)</td><template v-if="o.ok"><td>{{ o.issuer }}</td><td>{{ fmtDate(o.valid_to) }}</td><td :class="o.days_left < 15 ? 'text-amber' : 'text-green'">{{ o.days_left }}</td></template><td v-else colspan="3" class="text-red small">{{ o.error }}</td></tr>
          </tbody>
        </table></div>
      </div>
    </div>

    <div v-if="tab === 'backups'">
      <div class="row between mb-12"><div class="hint">Stored on the Switchboard machine. Manual backups are kept until you delete them; automatic ones keep the newest {{ p.backup_keep }} of each kind.</div>
        <button class="btn btn-sm" @click="backupLive" :disabled="!p.db_server_id && (!active || active.db_type === 'none')">Back up {{ p.db_server_id ? 'the shared' : 'live' }} database now</button></div>
      <div class="card table-wrap">
        <table class="table" v-if="backups && backups.length">
          <thead><tr><th>#</th><th>When</th><th>Server</th><th>Kind</th><th>Size</th><th>Tables</th><th>Note</th><th></th></tr></thead>
          <tbody><tr v-for="b in backups" :key="b.id">
            <td class="mono muted">{{ b.id }}</td><td class="nowrap">{{ fmtDate(b.created_at) }}</td><td>{{ b.server_name }}</td>
            <td><span class="badge" :class="kindBadge[b.kind]">{{ kindLabel[b.kind] || b.kind }}</span></td>
            <td class="nowrap">{{ bytes(b.size) }}</td><td>{{ b.tables ?? '—' }}</td><td class="small muted">{{ b.note }}<span v-if="!b.exists" class="text-red"> (file missing)</span>
              <div><span v-if="b.s3_key" class="badge badge-blue" title="Stored in your S3 bucket">S3</span> <span v-if="b.local" class="badge badge-gray" title="On the Switchboard machine">local</span> <span v-if="b.s3_error && !b.s3_key" class="badge badge-red" :title="b.s3_error">S3 upload failed</span></div></td>
            <td class="actions">
              <a class="admin-only btn btn-xs" :href="'/api/backups/' + b.id + '/download'" download>Download</a>
              <button class="admin-only btn btn-xs" @click="restore(b)" :disabled="!b.exists">Restore…</button>
              <menu-btn small class="admin-only"><button class="menu-item" v-if="b.kind !== 'manual'" @click="keepBackup(b)">Keep forever</button><button class="menu-item danger" @click="delBackup(b)">Delete</button></menu-btn>
            </td>
          </tr></tbody>
        </table>
        <div v-else class="empty">{{ backups ? 'No backups yet.' : 'Loading…' }}</div>
      </div>
    </div>

    <traffic-tab v-if="tab === 'traffic'" :project="p" @reload="load" />
    <cicd-tab v-if="tab === 'cicd'" :project="p" :key="'ci' + p.id" @reload="load" />
    <jobs-table v-if="tab === 'jobs'" :jobs="jobs || []" />
    <events-list v-if="tab === 'activity'" :events="events || []" />
    <project-settings v-if="tab === 'settings'" :project="p" :key="p.id" @saved="load" />
  </div>`,
};

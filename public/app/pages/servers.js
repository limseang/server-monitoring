import { ref, computed, watch, onMounted } from '/vendor/vue.js';
import { store, http, toast, openDialog, confirmBox, runJob, go, bytes, uptimeStr, fmtDate, HEALTH } from '../lib.js';
import { MeterBar, MenuBtn, JobsTable, Ago, HealthPill } from '../components.js';
import { PortsTab, PowerTab } from '../serverctl.js';
import { TrafficTab, LogsTab } from '../trafficview.js';
import { ServerCard } from './overview.js';

export const ServersPage = {
  components: { ServerCard },
  setup() {
    const servers = computed(() => store.overview?.servers);
    return { servers, add: () => openDialog('server') };
  },
  template: `
  <div>
    <div class="page-head">
      <div><h1>Servers</h1><div class="sub">Machines Switchboard can reach over SSH. Each runs your Docker stacks.</div></div>
      <div class="actions"><button class="admin-only btn btn-primary" @click="add">+ Add server</button></div>
    </div>
    <div v-if="!servers" class="muted">Loading…</div>
    <div v-else-if="!servers.length" class="empty-card"><div class="empty-title">No servers yet</div><p class="muted">Add a server with its public IP and SSH login. Switchboard only needs SSH and Docker — nothing gets installed on it.</p><button class="admin-only btn btn-primary" @click="add">+ Add server</button></div>
    <div v-else class="grid grid-servers"><server-card v-for="s in servers" :key="s.id" :server="s" /></div>
  </div>`,
};

export const ServerPage = {
  props: { id: Number },
  components: { MeterBar, MenuBtn, JobsTable, Ago, HealthPill, PortsTab, PowerTab, TrafficTab, LogsTab },
  setup(props) {
    const s = ref(null);
    const tab = ref('overview');
    const notFound = ref(false);
    const jobs = ref([]);
    const refreshing = ref(false);
    const filter = ref('');
    async function load() {
      try {
        s.value = await http.get(`/servers/${props.id}`);
        notFound.value = false;
        jobs.value = await http.get(`/jobs?server=${props.id}&limit=15`);
      } catch (e) {
        if (/not found/i.test(e.message)) notFound.value = true;
        else toast(e.message, 'error');
      }
    }
    async function refresh() {
      refreshing.value = true;
      try {
        const r = await http.post(`/servers/${props.id}/refresh`);
        if (!r.ok) toast(r.error, 'error');
        await load();
      } finally {
        refreshing.value = false;
      }
    }
    // Apps that run outside Docker (PM2, systemd services, nginx sites) — read over SSH on demand.
    const apps = ref(null);
    const appsLoading = ref(false);
    async function loadApps() {
      appsLoading.value = true;
      try {
        apps.value = await http.get(`/servers/${props.id}/apps`);
      } catch (e) {
        apps.value = { ok: false, error: e.message };
      } finally {
        appsLoading.value = false;
      }
    }
    const hasApps = computed(() => apps.value?.ok && (apps.value.pm2.length || apps.value.services.length || apps.value.sites.length));
    const appLogs = (a) => openDialog('logs', { server: s.value, app: a });
    async function appAction(a, act) {
      if (act !== 'start') {
        const ok = await confirmBox({ title: `${act === 'stop' ? 'Stop' : 'Restart'} ${a.name}?`, message: a.type === 'pm2' ? `PM2 app of user ${a.user}.` : 'systemd service.', confirmText: act === 'stop' ? 'Stop' : 'Restart', danger: act === 'stop' });
        if (!ok) return;
      }
      await runJob(http.post(`/servers/${props.id}/apps/action`, { type: a.type, user: a.user, name: a.name, action: act }));
      setTimeout(loadApps, 2500);
    }
    const nodeText = computed(() => {
      const a = apps.value;
      if (!a?.ok) return '';
      const parts = [];
      if (a.node) parts.push(`${a.node.version} (${a.node.kind === 'apt' ? `apt · ${a.node.pkg}` : a.node.kind === 'manual' ? '/usr/local' : a.node.path})`);
      for (const n of a.nvm) parts.push(`nvm (${n.user}): ${n.versions.join(', ')}`);
      if (a.npmGlobals.length) parts.push(`global npm: ${a.npmGlobals.map((g) => `${g.name}@${g.version}`).join(', ')}`);
      return parts.join(' · ') || 'not installed';
    });
    const pm2Badge = (st) => (st === 'online' ? 'badge-green' : st === 'errored' ? 'badge-red' : st === 'launching' ? 'badge-amber' : 'badge-gray');

    onMounted(() => {
      load();
      loadApps();
    });
    watch(() => props.id, () => {
      load();
      loadApps();
    });
    watch(() => store.live, load);
    watch(() => store.jobsLive, () => http.get(`/jobs?server=${props.id}&limit=15`).then((j) => (jobs.value = j)).catch(() => {}));

    const m = computed(() => s.value?.metrics);
    const containers = computed(() => {
      const q = filter.value.toLowerCase();
      return (m.value?.containers || []).filter((c) => !q || `${c.name} ${c.image} ${c.project || ''}`.toLowerCase().includes(q));
    });
    const stateBadge = (c) => (c.state === 'running' ? (c.health === 'unhealthy' ? 'badge-red' : c.health === 'starting' ? 'badge-amber' : 'badge-green') : c.state === 'restarting' ? 'badge-amber' : 'badge-gray');
    const edit = () => openDialog('server', { server: s.value });
    const command = () => openDialog('command', { server: s.value });
    const clone = () => openDialog('clone', { server: s.value });
    const copyProject = () => openDialog('project-copy', { server: s.value });
    const osUpgrade = () => openDialog('os-upgrade', { server: s.value });
    const logs = (c) => openDialog('logs', { server: s.value, container: c.name });
    async function action(c, act) {
      if (act === 'rm') {
        const ok = await confirmBox({
          title: `Delete container ${c.name}?`,
          message:
            'The container is removed (docker rm -f), also when it is restarting or running. Its data volumes are kept.' +
            (c.project ? `\n\nIt is part of the compose project "${c.project}": "docker compose up" or a Deploy creates it again. To remove it for good, take the service out of docker-compose.yml.` : ''),
          confirmText: 'Delete container',
          danger: true,
          typeToConfirm: c.name,
        });
        if (ok) runJob(http.post(`/servers/${props.id}/containers/${encodeURIComponent(c.name)}/rm`, { confirm: c.name }));
        return;
      }
      if (act !== 'start') {
        const ok = await confirmBox({ title: `${act === 'stop' ? 'Stop' : 'Restart'} ${c.name}?`, message: c.project ? `Part of compose project "${c.project}".` : '', confirmText: act === 'stop' ? 'Stop' : 'Restart', danger: act === 'stop' });
        if (!ok) return;
      }
      runJob(http.post(`/servers/${props.id}/containers/${encodeURIComponent(c.name)}/${act}`));
    }
    async function resetKey() {
      const ok = await confirmBox({ title: 'Reset the pinned host key?', message: 'Do this only if you rebuilt or re-installed this server. Switchboard will trust whatever key the server shows next time.', confirmText: 'Reset', danger: true });
      if (!ok) return;
      await http.post(`/servers/${props.id}/reset-host-key`).catch((e) => toast(e.message, 'error'));
      toast('Host key reset', 'success');
      load();
    }
    async function remove() {
      const ok = await confirmBox({ title: `Remove ${s.value.name}?`, message: 'Removes it from Switchboard (and from any project where it is a standby). Nothing on the server itself changes — use "Reset server" to wipe it.', confirmText: 'Remove server', danger: true, typeToConfirm: s.value.name });
      if (!ok) return;
      try {
        await http.del(`/servers/${props.id}`);
        toast('Server removed', 'success');
        store.live++;
        go('/servers');
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    const power = (action) => openDialog('power', { server: s.value, action });
    const reset = () => openDialog('server-reset', { server: s.value });
    const reinstall = () => openDialog('server-reinstall', { server: s.value });
    const cleanup = () => openDialog('server-cleanup', { server: s.value });
    // Link from a "disk full" alert: #/servers/<id>?cleanup=1 opens the cleanup dialog once.
    watch(s, (v) => {
      if (v && store.user?.role === 'admin' && /[?&]cleanup=1/.test(location.hash)) {
        history.replaceState(null, '', `#/servers/${v.id}`);
        cleanup();
      }
    });
    const password = () => openDialog('password', { server: s.value });
    const connectDomain = () => openDialog('domain', { server: s.value });
    const running = computed(() => (m.value?.containers || []).filter((c) => c.state === 'running').length);
    return { tab, cleanup, power, password, connectDomain, running, nodeText, apps, appsLoading, loadApps, hasApps, appLogs, appAction, pm2Badge, s, notFound, jobs, m, containers, filter, refreshing, refresh, edit, command, clone, copyProject, osUpgrade, logs, action, resetKey, remove, reset, reinstall, stateBadge, bytes, uptimeStr, fmtDate };
  },
  template: `
  <div v-if="notFound" class="empty-card"><div class="empty-title">Server not found</div><a href="#/servers">Back to servers</a></div>
  <div v-else-if="!s" class="muted">Loading…</div>
  <div v-else>
    <div class="hero">
      <div class="hero-main">
        <div class="crumbs"><a href="#/servers">Servers</a> / {{ s.name }}</div>
        <h1 class="row gap-12"><span class="status-ring" :class="s.status === 'up' ? 'up' : s.status === 'down' ? 'down' : ''"></span>{{ s.name }}</h1>
        <div class="hero-meta">
          <span class="chip-meta"><icon name="globe" :size="13" />{{ s.ip }}</span>
          <span class="chip-meta mono"><icon name="terminal" :size="13" />{{ s.ssh_user }}@{{ s.ssh_host || s.ip }}:{{ s.ssh_port }}</span>
          <span v-if="m" class="chip-meta"><icon name="layers" :size="13" />{{ m.os || 'Linux' }}</span>
          <span v-if="m" class="chip-meta"><icon name="box" :size="13" />{{ running }}/{{ m.containers.length }} containers</span>
          <span v-if="m" class="chip-meta">up {{ uptimeStr(m.uptime_s) }}</span>
          <span v-for="r in s.roles" :key="r" class="badge badge-green">{{ r }}</span>
        </div>
      </div>
      <div class="actions">
        <button class="btn" @click="refresh" :disabled="refreshing"><span v-if="refreshing" class="spinner"></span><icon v-else name="refresh" />Refresh</button>
        <button class="admin-only btn" @click="command"><icon name="terminal" />Command</button>
        <button class="admin-only btn btn-primary" @click="connectDomain"><icon name="plug" />Connect domain</button>
        <menu-btn label="Power ▾" class="admin-only">
          <button class="menu-item" @click="power('reboot')">Restart</button>
          <button class="menu-item" @click="power('force-reboot')">Force restart</button>
          <button class="menu-item danger" @click="power('shutdown')">Turn off</button>
          <div class="menu-sep"></div>
          <button class="menu-item" @click="password">Change a password…</button>
        </menu-btn>
        <menu-btn label="More ▾">
          <button class="admin-only menu-item" @click="edit">Edit server</button>
          <button class="admin-only menu-item" @click="clone">Clone to another server…</button>
          <button class="admin-only menu-item" @click="copyProject">Copy a project to another server…</button>
          <button class="admin-only menu-item" @click="cleanup">Clean up / free memory…</button>
          <button class="admin-only menu-item" @click="osUpgrade">Upgrade OS (Ubuntu / Debian)…</button>
          <button class="admin-only menu-item" @click="resetKey">Reset SSH host key</button>
          <div class="menu-sep"></div>
          <button class="admin-only menu-item danger" @click="reset">Reset server (delete everything)…</button>
          <button class="admin-only menu-item danger" @click="reinstall">Reinstall OS (erase whole disk)…</button>
          <button class="admin-only menu-item danger" @click="remove">Remove server</button>
        </menu-btn>
      </div>
    </div>

    <div v-if="s.status === 'down'" class="alert alert-error mb-12"><span class="alert-icon">✖</span><span>SSH unreachable: {{ s.status_error }}</span></div>
    <div v-if="s.private_ip_warning" class="alert alert-warn mb-12"><span class="alert-icon">⚠</span><span><b>{{ s.ip }} is a private address</b> — visitors and Cloudflare can't reach it, so traffic can't be switched here and domains can't point here. Edit the server: put its public IP in "IP" and keep {{ s.ip }} as "SSH host".</span></div>

    <div class="tabs">
      <button class="tab" :class="{ on: tab === 'overview' }" @click="tab = 'overview'"><icon name="overview" :size="14" />Overview</button>
      <button class="tab" :class="{ on: tab === 'traffic' }" @click="tab = 'traffic'"><icon name="activity" :size="14" />Traffic</button>
      <button class="tab dev-only" :class="{ on: tab === 'logs' }" @click="tab = 'logs'"><icon name="terminal" :size="14" />Logs</button>
      <button class="tab" :class="{ on: tab === 'ports' }" @click="tab = 'ports'"><icon name="port" :size="14" />Ports & domains</button>
      <button class="tab" :class="{ on: tab === 'containers' }" @click="tab = 'containers'"><icon name="box" :size="14" />Containers <span class="muted" v-if="m">{{ m.containers.length }}</span></button>
      <button class="tab" :class="{ on: tab === 'apps' }" @click="tab = 'apps'"><icon name="layers" :size="14" />Apps outside Docker</button>
      <button class="tab admin-only" :class="{ on: tab === 'power' }" @click="tab = 'power'"><icon name="power" :size="14" />Power & access</button>
      <button class="tab" :class="{ on: tab === 'jobs' }" @click="tab = 'jobs'"><icon name="jobs" :size="14" />Jobs</button>
    </div>

    <template v-if="tab === 'overview'">
    <div class="tiles" v-if="m">
      <div class="tile"><meter-bar label="CPU" :value="m.cpu_pct" :text="(m.cpu_pct ?? '—') + '%'" /><div class="tile-sub mt-8">load {{ (m.load || []).join(' · ') }} · {{ m.cpus }} cores</div></div>
      <div class="tile"><meter-bar label="Memory" :value="m.mem_pct" :text="(m.mem_pct ?? '—') + '%'" /><div class="tile-sub mt-8">{{ bytes(m.mem_used) }} of {{ bytes(m.mem_total) }}<template v-if="m.swap_total"> · swap {{ bytes(m.swap_used) }}</template></div></div>
      <div class="tile"><meter-bar label="Disk /" :value="m.disk_pct" :text="(m.disk_pct ?? '—') + '%'" /><div class="tile-sub mt-8">{{ bytes(m.disk_avail) }} free of {{ bytes(m.disk_total) }}</div></div>
      <div class="tile"><div class="tile-label">System</div><div class="strong mt-8">{{ m.os || '—' }}</div><div class="tile-sub">up {{ uptimeStr(m.uptime_s) }} · kernel {{ m.kernel }}</div></div>
    </div>
    <div v-else class="empty-card">No stats yet — <button class="link-btn" @click="refresh">collect now</button>.</div>
    <div class="muted small mt-8" v-if="m">Stats from <ago :at="m.collected_at" /> · host key <span class="mono">{{ s.host_key || 'not pinned yet' }}</span></div>

    <section class="section" v-if="s.deployments.length">
      <div class="section-head"><h2>Projects on this server</h2></div>
      <div class="card table-wrap"><table class="table"><tbody>
        <tr v-for="d in s.deployments" :key="d.id">
          <td><a :href="'#/projects/' + d.project_id" class="strong">{{ d.project_name }}</a><div class="tiny muted">{{ d.project_domain }}</div></td>
          <td><span v-if="d.is_active" class="badge badge-green">LIVE</span><span v-else class="badge badge-gray">Standby</span></td>
          <td><health-pill :dep="d" /></td>
          <td class="mono small muted">{{ d.app_container || '' }} {{ d.db_container ? '· ' + d.db_container : '' }}</td>
        </tr>
      </tbody></table></div>
    </section>

    <section class="section" v-if="s.notes"><div class="section-head"><h2>Notes</h2></div><div class="card card-body" style="white-space:pre-wrap">{{ s.notes }}</div></section>
    </template>

    <traffic-tab v-if="tab === 'traffic'" :server="s" :key="'t' + s.id" />
    <logs-tab v-if="tab === 'logs'" :server="s" :key="'l' + s.id" />
    <ports-tab v-if="tab === 'ports'" :server="s" />
    <power-tab v-if="tab === 'power'" :server="s" />

    <section v-if="tab === 'containers'">
      <div class="section-head"><h2>Containers <span class="muted" v-if="m">{{ m.containers.length }}</span></h2><input v-model="filter" placeholder="Filter…" style="max-width:220px;height:30px"></div>
      <div v-if="m && m.docker_error" class="alert alert-warn mb-12"><span class="alert-icon">⚠</span><span>Docker: {{ m.docker_error }}</span></div>
      <div class="card table-wrap">
        <table class="table" v-if="containers.length">
          <thead><tr><th>Name</th><th>Image</th><th>Status</th><th>Compose project</th><th></th></tr></thead>
          <tbody><tr v-for="c in containers" :key="c.id">
            <td class="mono strong">{{ c.name }}</td><td class="small muted">{{ c.image }}</td>
            <td><span class="badge" :class="stateBadge(c)">{{ c.state }}{{ c.health ? ' · ' + c.health : '' }}</span><div class="tiny muted">{{ c.status }}</div></td>
            <td class="small">{{ c.project || '—' }}<span class="muted" v-if="c.service"> / {{ c.service }}</span></td>
            <td class="actions"><button class="btn btn-xs" @click="logs(c)">Logs</button>
              <button class="admin-only btn btn-xs" @click="action(c, 'restart')">Restart</button>
              <button v-if="c.state === 'running'" class="admin-only btn btn-xs btn-danger" @click="action(c, 'stop')">Stop</button>
              <button v-else class="admin-only btn btn-xs" @click="action(c, 'start')">Start</button>
              <button class="admin-only btn btn-xs btn-danger" @click="action(c, 'rm')">Delete</button></td>
          </tr></tbody>
        </table>
        <div v-else class="empty">{{ m ? 'No containers.' : 'No data yet.' }}</div>
      </div>
    </section>

    <section v-if="tab === 'apps'">
      <div class="section-head"><h2>Apps outside Docker</h2><button class="btn btn-sm" @click="loadApps" :disabled="appsLoading"><span v-if="appsLoading" class="spinner"></span>Scan</button></div>
      <div v-if="apps && !apps.ok" class="alert alert-warn mb-12"><span class="alert-icon">⚠</span><span>{{ apps.error }}</span></div>
      <div v-else-if="!apps" class="muted small">Looking for PM2 apps, systemd services and nginx sites…</div>
      <template v-else>
        <div class="muted small mb-8">
          Node.js: {{ nodeText }}
        </div>
        <div v-if="!hasApps" class="empty-card">No PM2 apps, custom services or nginx sites found.</div>

        <div v-if="apps.pm2.length" class="card table-wrap mb-12">
          <table class="table">
            <thead><tr><th>PM2 app</th><th>Status</th><th>CPU / Memory</th><th>Folder</th><th></th></tr></thead>
            <tbody><tr v-for="a in apps.pm2" :key="a.user + a.id">
              <td><span class="mono strong">{{ a.name }}</span><div class="tiny muted">user {{ a.user }} · {{ a.mode }} · {{ a.restarts }} restarts</div></td>
              <td><span class="badge" :class="pm2Badge(a.status)">{{ a.status }}</span><div class="tiny muted" v-if="a.uptime_ms">up {{ uptimeStr(Math.round(a.uptime_ms / 1000)) }}</div></td>
              <td class="small">{{ a.cpu ?? '—' }}% · {{ bytes(a.memory) }}</td>
              <td class="tiny mono muted">{{ a.cwd }}</td>
              <td class="actions"><button class="btn btn-xs" @click="appLogs({ type: 'pm2', user: a.user, name: a.name })">Logs</button>
                <button class="admin-only btn btn-xs" @click="appAction({ type: 'pm2', user: a.user, name: a.name }, 'restart')">Restart</button>
                <button v-if="a.status === 'online'" class="admin-only btn btn-xs btn-danger" @click="appAction({ type: 'pm2', user: a.user, name: a.name }, 'stop')">Stop</button>
                <button v-else class="admin-only btn btn-xs" @click="appAction({ type: 'pm2', user: a.user, name: a.name }, 'start')">Start</button></td>
            </tr></tbody>
          </table>
        </div>

        <div v-if="apps.services.length" class="card table-wrap mb-12">
          <table class="table">
            <thead><tr><th>systemd service</th><th>Status</th><th>Runs</th><th></th></tr></thead>
            <tbody><tr v-for="sv in apps.services" :key="sv.name">
              <td><span class="mono strong">{{ sv.name }}</span><div class="tiny muted">user {{ sv.user }}<template v-if="sv.cwd"> · {{ sv.cwd }}</template></div></td>
              <td><span class="badge" :class="sv.active === 'active' ? 'badge-green' : sv.active === 'failed' ? 'badge-red' : 'badge-gray'">{{ sv.active }}</span></td>
              <td class="tiny mono muted" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ sv.exec }}</td>
              <td class="actions"><button class="btn btn-xs" @click="appLogs({ type: 'service', name: sv.name })">Logs</button>
                <button class="admin-only btn btn-xs" @click="appAction({ type: 'service', name: sv.name }, 'restart')">Restart</button>
                <button v-if="sv.active === 'active'" class="admin-only btn btn-xs btn-danger" @click="appAction({ type: 'service', name: sv.name }, 'stop')">Stop</button>
                <button v-else class="admin-only btn btn-xs" @click="appAction({ type: 'service', name: sv.name }, 'start')">Start</button></td>
            </tr></tbody>
          </table>
        </div>

        <div v-if="apps.sites.length" class="card table-wrap">
          <table class="table">
            <thead><tr><th>nginx site</th><th>Type</th><th>Serves</th></tr></thead>
            <tbody><tr v-for="(st, i) in apps.sites" :key="i">
              <td class="strong">{{ st.names.join(', ') || '(default)' }}<div class="tiny muted">listen {{ st.listen.join(', ') }}</div></td>
              <td><span class="badge" :class="st.kind === 'proxy' ? 'badge-blue' : 'badge-gray'">{{ st.kind === 'proxy' ? 'proxy (Node app)' : 'static files' }}</span></td>
              <td class="tiny mono muted">{{ [...st.proxies, ...st.roots].join(' · ') }}</td>
            </tr></tbody>
          </table>
        </div>
      </template>
    </section>

    <section v-if="tab === 'jobs'">
      <jobs-table :jobs="jobs" />
    </section>
  </div>`,
};

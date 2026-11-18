import { computed } from '/vendor/vue.js';
import { store, openDialog, bytes, uptimeStr, freshness, HEALTH, ago, tick } from '../lib.js';
import { UptimeBar, MeterBar, JobsTable, HealthPill } from '../components.js';
import { DueBadge, money, dateText, totalsText, dueLabel, dueClass } from '../billing.js';

export const ProjectCard = {
  props: { project: Object },
  components: { UptimeBar, HealthPill },
  setup(props) {
    const p = computed(() => props.project);
    const label = (d) => {
      if (d.health === 'up' && d.health_detail?.ms != null) return `${d.health_detail.ms} ms`;
      return (HEALTH[d.health] || HEALTH.unknown).label;
    };
    const lastSwitch = computed(() => (tick.value, p.value.last_switch_at ? `Last switch ${ago(p.value.last_switch_at)}` : 'Never switched'));
    return {
      p,
      label,
      lastSwitch,
      freshness,
      HEALTH,
      switchTo: (d) => openDialog('switch', { project: p.value, target: d.id }),
      copy: () => openDialog('sync', { project: p.value }),
    };
  },
  template: `
  <div class="card proj-card">
    <div class="proj-head">
      <div class="grow">
        <a :href="'#/projects/' + p.id" class="proj-name">{{ p.name }}</a>
        <a v-if="p.domain" :href="'https://' + p.domain" target="_blank" rel="noopener" class="proj-domain">{{ p.domain }} ↗</a>
      </div>
      <div class="row gap-6 wrap" style="justify-content:flex-end">
        <span v-if="p.dns_state && p.dns_state.drift" class="badge badge-red" title="Cloudflare does not point to the active server">DNS drift</span>
        <span v-if="p.auto_failover" class="badge badge-accent" title="Switches automatically when the live server goes down">Auto-failover</span>
      </div>
    </div>
    <div class="proj-deps">
      <div v-for="d in p.deployments" :key="d.id" class="proj-dep" :class="{ active: d.is_active }">
        <span class="dot" :class="'dot-' + (HEALTH[d.health] || HEALTH.unknown).cls" :title="(HEALTH[d.health] || HEALTH.unknown).label"></span>
        <div style="min-width:0">
          <div class="proj-dep-name"><span class="ellipsis">{{ d.server_name }}</span><span v-if="d.is_active" class="badge badge-green">LIVE</span><span v-if="d.maintenance" class="badge badge-blue">MAINT</span></div>
          <div class="tiny muted mono">{{ d.server_ip }}</div>
        </div>
        <uptime-bar :bars="d.bars" />
        <div class="proj-dep-stats">
          <div :class="d.health === 'down' ? 'text-red' : ''">{{ label(d) }}</div>
          <div class="tiny" :class="freshness(d).cls">{{ freshness(d).text }}</div>
        </div>
        <button v-if="!d.is_active" class="admin-only btn btn-sm" @click="switchTo(d)" :disabled="!p.dns_records.length" :title="p.dns_records.length ? 'Move traffic to this server' : 'Link Cloudflare records first'">Switch here</button>
        <span v-else class="btn-spacer"></span>
      </div>
      <div v-if="!p.deployments.length" class="muted small" style="padding:8px">No servers yet — open the project to add them.</div>
    </div>
    <div class="proj-foot">
      <span class="muted small">{{ lastSwitch }}</span>
      <div class="row gap-6">
        <button class="admin-only btn btn-ghost btn-sm" :disabled="p.deployments.length < 2" @click="copy">Copy data</button>
        <a class="btn btn-ghost btn-sm" :href="'#/projects/' + p.id">Open →</a>
      </div>
    </div>
  </div>`,
};

export const ServerCard = {
  props: { server: Object },
  components: { MeterBar, DueBadge },
  setup(props) {
    const m = computed(() => props.server.metrics);
    const running = computed(() => (m.value?.containers || []).filter((c) => c.state === 'running').length);
    const status = computed(() => ({ up: 'green', down: 'red' })[props.server.status] || 'gray');
    return { m, running, status, bytes, uptimeStr };
  },
  template: `
  <a class="card server-card" :href="'#/servers/' + server.id">
    <div class="row between gap-8">
      <div class="row gap-8" style="min-width:0"><span class="dot" :class="'dot-' + status"></span><b class="ellipsis">{{ server.name }}</b><span v-if="m && m.busy" class="badge badge-red" title="CPU or memory has been high for a while">BUSY</span><due-badge v-if="server.billing && server.billing.days_left !== null && server.billing.days_left <= 7" :billing="server.billing" /></div>
      <span class="muted mono small">{{ server.ip }}</span>
    </div>
    <template v-if="m">
      <meter-bar label="CPU" :value="m.cpu_pct" :text="(m.cpu_pct ?? '—') + '%' + (m.cpus ? ' of ' + m.cpus + ' cores' : '')" />
      <meter-bar label="Memory" :value="m.mem_pct" :text="bytes(m.mem_used) + ' / ' + bytes(m.mem_total)" />
      <meter-bar label="Disk" :value="m.disk_pct" :text="bytes(m.disk_used) + ' / ' + bytes(m.disk_total)" />
      <div class="row between small muted"><span>{{ running }}/{{ m.containers.length }} containers up</span><span>up {{ uptimeStr(m.uptime_s) }}</span></div>
    </template>
    <div v-else class="small" :class="server.status === 'down' ? 'text-red' : 'muted'">{{ server.status === 'down' ? server.status_error : 'Collecting stats…' }}</div>
  </a>`,
};

export default {
  components: { ProjectCard, ServerCard, JobsTable },
  setup() {
    const data = computed(() => store.overview);
    const errors = computed(() => (data.value?.alerts || []).filter((a) => a.level === 'error').length);
    const problems = computed(() => (data.value?.alerts || []).filter((a) => a.level !== 'info').length);
    const serversUp = computed(() => (data.value?.servers || []).filter((s) => s.status === 'up').length);
    const healthy = computed(() => (data.value?.projects || []).filter((p) => p.deployments.find((d) => d.is_active)?.health === 'up').length);
    const icon = { error: '✖', warn: '⚠', info: 'ℹ' };
    return { money, dateText, totalsText, dueLabel, dueClass, data, errors, problems, serversUp, healthy, icon, addServer: () => openDialog('server'), addProject: () => openDialog('project'), newApp: () => openDialog('template-project'), fromGithub: () => openDialog('template-project', { fromRepo: true }) };
  },
  template: `
  <div>
    <div class="page-head">
      <div><h1>Overview</h1><div class="sub">Your projects, the servers they run on, and what Switchboard is doing.</div></div>
      <div class="actions admin-only"><button class="btn" @click="addServer">+ Server</button><button class="btn" @click="addProject">+ Existing app</button><button class="btn" @click="newApp">+ New app</button><button class="btn btn-primary" @click="fromGithub">+ Deploy from my GitHub</button></div>
    </div>
    <div v-if="!data" class="muted">Loading…</div>
    <template v-else>
      <div class="tiles">
        <div class="tile"><div class="tile-label">Projects live & healthy</div><div class="tile-value">{{ healthy }}<span class="muted">/{{ data.projects.length }}</span></div></div>
        <div class="tile"><div class="tile-label">Servers reachable</div><div class="tile-value">{{ serversUp }}<span class="muted">/{{ data.servers.length }}</span></div></div>
        <div class="tile" :class="{ 'tile-bad': errors }"><div class="tile-label">Problems</div><div class="tile-value">{{ problems }}</div><div class="tile-sub">{{ errors }} critical</div></div>
        <div class="tile"><div class="tile-label">Jobs running</div><div class="tile-value">{{ data.running }}</div></div>
      </div>

      <div v-if="data.alerts.length" class="alerts">
        <a v-for="(a, i) in data.alerts" :key="i" :href="a.link" class="alert" :class="'alert-' + a.level"><span class="alert-icon">{{ icon[a.level] }}</span><span>{{ a.message }}</span></a>
      </div>

      <section class="section">
        <div class="section-head"><h2>Projects</h2></div>
        <div v-if="!data.projects.length" class="empty-card">
          <div class="empty-title">Let's set things up</div>
          <p class="muted">1) Add each server (SSH access). 2) Create a project for your app and link its Cloudflare DNS records. 3) Tell the project which servers it runs on. Then you can switch traffic and copy databases with one click.</p>
          <div class="row gap-8"><button class="btn" @click="addServer">1. Add a server</button><button class="btn btn-primary" @click="addProject">2. Create a project</button></div>
        </div>
        <div class="grid grid-projects"><project-card v-for="p in data.projects" :key="p.id" :project="p" /></div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Servers</h2><a href="#/servers" class="small">All servers →</a></div>
        <div v-if="!data.servers.length" class="empty-card"><p class="muted">No servers yet.</p><button class="btn" @click="addServer">+ Add a server</button></div>
        <div class="grid grid-servers"><server-card v-for="s in data.servers" :key="s.id" :server="s" /></div>
      </section>

      <section class="section" v-if="data.billing && data.billing.count">
        <div class="section-head"><h2>Upcoming payments</h2><a href="#/billing" class="small">Billing →</a></div>
        <div class="card table-wrap"><table class="table"><tbody>
          <tr v-for="b in data.billing.upcoming" :key="b.server_id">
            <td><a :href="'#/servers/' + b.server_id" class="strong">{{ b.server_name }}</a><div class="tiny muted">{{ b.provider || '' }}</div></td>
            <td>{{ dateText(b.due_date) }}</td>
            <td><span class="badge" :class="dueClass(b.days_left, b.auto_renew)">{{ dueLabel(b.days_left) }}</span><span v-if="b.auto_renew" class="tiny muted"> auto-renew</span></td>
            <td class="strong">{{ money(b.price, b.currency) }}</td>
            <td class="actions"><a v-if="b.provider_url" class="btn btn-xs" :href="b.provider_url" target="_blank" rel="noopener noreferrer">Open ↗</a></td>
          </tr>
        </tbody></table>
        <div class="card-body small muted" style="border-top:1px solid var(--border)">Total per month: <b>{{ totalsText(data.billing.totals) }}</b></div></div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Recent jobs</h2><a href="#/jobs" class="small">All jobs →</a></div>
        <jobs-table :jobs="data.jobs" />
      </section>
    </template>
  </div>`,
};

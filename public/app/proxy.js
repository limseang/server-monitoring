import { ref, reactive, computed, onMounted } from '/vendor/vue.js';
import { http, toast, closeDialog, openDialog, showJob, confirmBox, runJob } from './lib.js';
import { reducedMotion } from './live.js';

/*
 * Web proxy (nginx) for a project, for people who don't know nginx:
 *   "Visitors type shop.example.com → nginx on your server → your app on port 8080"
 * Set up on every server of the project at once (live and standby), so switching servers keeps the site working.
 *
 *   ProxyFlow    small neon picture, one slim row per server: 🌐 → ⬡ nginx → ▭ app :port
 *                phases: check (radar on the app) → write (config typed into nginx) → test (ring spins, a ping
 *                goes through) → done (packets stream through) · failed: red glitch
 *   ProxyDialog  the guided setup: domains, then each server's app port (picked from what runs there)
 *   ProxyTab     the project tab: what is set up, check again, change, remove
 *   ProxyLive    the job window's live view (job progress kind "proxy")
 */

const PHASE_TEXT = { check: 'Looking for your app or files…', write: 'Writing the nginx config…', test: 'Testing it…', done: 'Working', '': 'Waiting' };

export const ProxyFlow = {
  props: { rows: Array, hosts: Array, remove: Boolean },
  setup(props) {
    const still = reducedMotion();
    const RH = 70;
    const H = computed(() => Math.max(1, props.rows.length) * RH + 14);
    const view = computed(() =>
      props.rows.map((r, i) => {
        const y = 20 + i * RH + 18;
        const st = r.state || 'off';
        const flowing = !props.remove && (st === 'success' || st === 'preview');
        return { ...r, y, st, flowing, path: `M58,${y} L402,${y}`, label: `${r.name}${r.live ? ' · live' : ''}` };
      }),
    );
    const hostText = computed(() => {
      const h = props.hosts || [];
      return h.length ? h[0] + (h.length > 1 ? ` +${h.length - 1}` : '') : 'your domain';
    });
    const hex = (cx, cy, r) => Array.from({ length: 6 }, (_, k) => {
      const a = (Math.PI / 3) * k + Math.PI / 6;
      return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
    // the last part of a folder, short enough for the box: /var/www/shop/dist → dist
    const leaf = (f) => {
      const x = String(f || '').split('/').filter(Boolean).pop() || '/';
      return x.length > 7 ? `${x.slice(0, 6)}…` : x;
    };
    return { still, H, view, hostText, hex, leaf, PHASE_TEXT };
  },
  template: `
  <svg class="pf" :class="{ 'pf-still': still }" :viewBox="'0 0 480 ' + H" role="img" :aria-label="'Visitors of ' + hostText + ' go through nginx to your app'">
    <defs>
      <filter id="pf-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2.2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      <linearGradient id="pf-beam" x1="0" x2="1"><stop offset="0" stop-color="currentColor" stop-opacity="0" /><stop offset="0.5" stop-color="currentColor" stop-opacity="0.9" /><stop offset="1" stop-color="currentColor" stop-opacity="0" /></linearGradient>
    </defs>
    <text x="40" y="12" text-anchor="middle" class="pf-cap">visitors</text>
    <text x="240" y="12" text-anchor="middle" class="pf-cap">nginx</text>
    <text x="440" y="12" text-anchor="middle" class="pf-cap">your app / site</text>

    <g v-for="r in view" :key="r.id" class="pf-row" :class="['pf-' + r.st, 'ph-' + (r.phase || 'none')]">
      <!-- wires -->
      <line x1="58" :y1="r.y" x2="212" :y2="r.y" class="pf-wire" />
      <line x1="268" :y1="r.y" x2="402" :y2="r.y" class="pf-wire" />
      <!-- a beam sweeps along the wires while it works -->
      <rect v-if="r.st === 'running' && !still" x="58" :y="r.y - 1.5" width="70" height="3" fill="url(#pf-beam)" class="pf-beam" />
      <!-- packets: a comet of three dots; they slip behind nginx on the way through -->
      <template v-if="(r.flowing || (r.st === 'running' && r.phase === 'test')) && !still">
        <g v-for="k in (r.flowing ? 3 : 1)" :key="k">
          <circle v-for="t in 3" :key="t" :r="3.4 - t * 0.8" class="pf-pkt" :style="{ opacity: 1 - (t - 1) * 0.3 }" filter="url(#pf-glow)">
            <animateMotion :path="r.path" :dur="r.flowing ? '1.6s' : '0.9s'" :begin="((k - 1) * 0.53 + (t - 1) * 0.05) + 's'" repeatCount="indefinite" />
          </circle>
        </g>
      </template>

      <!-- visitors -->
      <g :transform="'translate(40,' + r.y + ')'" class="pf-globe">
        <circle r="13" /><ellipse rx="5.5" ry="13" /><line x1="-13" x2="13" />
        <g v-if="!still && r.st !== 'off'" class="pf-orbit"><circle r="2" cx="17" /></g>
      </g>

      <!-- nginx -->
      <g class="pf-ng">
        <circle v-if="r.st === 'running' && r.phase === 'test'" cx="240" :cy="r.y" r="30" class="pf-ring" />
        <polygon :points="hex(240, r.y, 24)" class="pf-hex" filter="url(#pf-glow)" />
        <template v-if="r.st === 'running' && r.phase === 'write' && !still">
          <rect v-for="k in 3" :key="k" :x="228" :y="r.y - 9 + (k - 1) * 7" width="24" height="2.4" rx="1.2" class="pf-type" :style="{ animationDelay: (k - 1) * 0.35 + 's' }" />
        </template>
        <text v-else x="240" :y="r.y + 3.5" text-anchor="middle" class="pf-ng-t">{{ r.st === 'failure' ? '✕' : r.st === 'success' && remove ? '✓' : 'N' }}</text>
      </g>

      <!-- the app -->
      <g :transform="'translate(408,' + (r.y - 15) + ')'" class="pf-app">
        <rect width="64" height="30" rx="7" />
        <template v-if="r.folder">
          <path d="M7 9.5 h6 l2 2.2 h9 v9.8 h-17 z" class="pf-folder" />
          <text x="44" y="19.5" text-anchor="middle" class="pf-port">{{ leaf(r.folder) }}</text>
        </template>
        <template v-else>
          <circle cx="10" cy="10" r="2" class="pf-led" /><circle cx="10" cy="20" r="2" class="pf-led l2" />
          <text x="38" y="19.5" text-anchor="middle" class="pf-port">{{ r.port ? ':' + r.port : ':?' }}</text>
        </template>
        <circle v-if="r.st === 'running' && r.phase === 'check' && !still" cx="32" cy="15" r="16" class="pf-radar" />
      </g>

      <text x="240" :y="r.y + 38" text-anchor="middle" class="pf-lbl">{{ r.label }}<tspan class="pf-sub"> — {{ r.error ? 'failed' : r.st === 'running' ? PHASE_TEXT[r.phase || ''] : r.st === 'success' ? (remove ? 'removed' : r.code ? 'answers ' + r.code : 'working') : r.st === 'preview' ? 'will be set up' : r.st === 'queued' ? 'waiting' : 'not set up' }}</tspan></text>
    </g>
  </svg>`,
};

/* ------------------------------------------------------------------ the guided setup */
export const ProxyDialog = {
  props: { project: Object },
  components: { ProxyFlow },
  setup(props) {
    const p = props.project;
    const hosts = ref((p.proxy?.hosts || [p.domain].filter(Boolean)).join(' '));
    const scans = reactive({});
    const folders = reactive({});
    const rows = reactive(
      p.deployments.map((d) => {
        const st = d.proxy_state || {};
        return {
          id: d.id, server_id: d.server_id, name: d.server_name, live: d.is_active, on: true,
          // "port": an app that runs (Docker, PM2, Node…) · "folder": built website files (Vue/React dist)
          kind: st.kind === 'folder' ? 'folder' : st.kind === 'port' ? 'port' : d.app_container ? 'port' : '',
          port: st.port || d.app_port || '', folder: st.folder || '', spa: st.spa !== false,
        };
      }),
    );
    onMounted(() => {
      http.get(`/projects/${p.id}/proxy/folders`).then((x) => {
        for (const r of rows) {
          folders[r.id] = x[r.id]?.folders || [];
          if (!r.folder && folders[r.id][0]) r.folder = folders[r.id][0];
          // no container and built files found → most likely a front-end: start with "Website files"
          if (!r.kind) r.kind = folders[r.id].length && !(scans[r.id] || []).some((q) => q.project?.id === p.id) ? 'folder' : 'port';
        }
      }).catch(() => rows.forEach((r) => ((folders[r.id] = []), r.kind || (r.kind = 'port'))));
      for (const r of rows) {
        http.get(`/servers/${r.server_id}/ports`).then((x) => {
          // what an app can be: not SSH, DNS or the web proxy itself; this project's containers first
          const ports = (x.ports || []).filter((q) => q.proto === 'tcp' && q.kind !== 'ssh' && q.port !== 53 && ![80, 443].includes(q.port))
            .sort((a, b) => (b.project?.id === p.id) - (a.project?.id === p.id) || (a.container ? 0 : 1) - (b.container ? 0 : 1) || a.port - b.port);
          scans[r.id] = ports;
          if (!r.port && ports[0]) r.port = ports[0].port;
        }).catch(() => (scans[r.id] = []));
      }
    });
    const list = computed(() => String(hosts.value).toLowerCase().split(/[\s,]+/).filter(Boolean));
    const hostOk = computed(() => list.value.length > 0 && list.value.every((h) => /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(h)));
    const chosen = computed(() => rows.filter((r) => r.on));
    const preview = computed(() => rows.map((r) => ({ ...r, port: r.kind === 'folder' ? null : r.port, folder: r.kind === 'folder' ? r.folder : null, state: r.on ? 'preview' : 'off' })));
    const portOk = (r) => /^\d{1,5}$/.test(String(r.port)) && ![22, 80, 443].includes(Number(r.port));
    const folderOk = (r) => /^\/[A-Za-z0-9._/@+-]+$/.test(String(r.folder).trim()) && !/(^|\/)\.\.?(\/|$)/.test(r.folder);
    const rowOk = (r) => (r.kind === 'folder' ? folderOk(r) : portOk(r));
    const ready = computed(() => hostOk.value && chosen.value.length && chosen.value.every(rowOk));
    const addWww = computed(() => list.value.length === 1 && list.value[0].split('.').length === 2 ? `www.${list.value[0]}` : '');
    const busy = ref(false);
    async function go() {
      busy.value = true;
      try {
        const r = await http.post(`/projects/${p.id}/proxy`, { hosts: hosts.value, servers: chosen.value.map((x) => (x.kind === 'folder' ? { deployment: x.id, folder: x.folder.trim(), spa: x.spa } : { deployment: x.id, port: Number(x.port) })) });
        closeDialog();
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    const pname = (q) => `${q.port} — ${q.container || q.process || 'program'}${q.project ? ' · ' + q.project.name : ''}`;
    return { p, hosts, list, hostOk, rows, scans, folders, preview, portOk, folderOk, ready, addWww, busy, go, pname, closeDialog };
  },
  template: `
  <modal :title="(p.proxy ? 'Change' : 'Set up') + ' the web proxy — ' + p.name" @close="closeDialog">
    <div class="form px-form">
      <div class="px-hero">
        <proxy-flow :rows="preview.filter(r => r.on).length ? preview.filter(r => r.on) : preview" :hosts="list" />
        <p class="small muted" style="margin:6px 0 0">Visitors type <b>{{ list[0] || 'your domain' }}</b> → <b>nginx</b> on your server receives them → it passes them to <b>your app</b>, or shows your <b>website files</b> (a built Vue / React / Angular site). HTTPS behind Cloudflare is set up for you.</p>
      </div>

      <div class="px-step"><span class="px-num">1</span><div class="grow">
        <label class="px-label">Which address do visitors type?</label>
        <input v-model="hosts" class="code" placeholder="shop.example.com www.shop.example.com" :class="{ bad: hosts && !hostOk }">
        <div class="hint">One or more, separated by spaces.<template v-if="addWww"> <a href="#" @click.prevent="hosts = hosts.trim() + ' ' + addWww">+ add {{ addWww }}</a></template></div>
      </div></div>

      <div class="px-step"><span class="px-num">2</span><div class="grow">
        <label class="px-label">What should visitors get on each server?</label>
        <div class="px-servers">
          <div v-for="r in rows" :key="r.id" class="px-srv-card" :class="{ off: !r.on }">
            <div class="px-srv-top">
              <label class="px-srv-name"><input type="checkbox" v-model="r.on"><b>{{ r.name }}</b><span v-if="r.live" class="badge badge-green">LIVE</span></label>
              <div class="seg px-kind" role="tablist">
                <button type="button" :class="{ on: r.kind === 'port' }" :disabled="!r.on" @click="r.kind = 'port'" title="Docker, PM2, Node, PHP… anything that answers on a port">⚙ App on a port</button>
                <button type="button" :class="{ on: r.kind === 'folder' }" :disabled="!r.on" @click="r.kind = 'folder'" title="A built front-end: Vue, React, Angular, plain HTML">📁 Website files</button>
              </div>
            </div>
            <div v-if="r.kind === 'folder'" class="px-srv-row">
              <select v-if="folders[r.id] && folders[r.id].length" v-model="r.folder" :disabled="!r.on">
                <option v-for="f in folders[r.id]" :key="f" :value="f">{{ f }}</option>
                <option v-if="r.folder && !folders[r.id].includes(r.folder)" :value="r.folder">{{ r.folder }} — typed</option>
              </select>
              <span v-else-if="!folders[r.id]" class="tiny muted"><span class="spinner"></span> looking for built sites…</span>
              <input v-model="r.folder" class="code" :class="{ bad: r.on && r.folder && !folderOk(r) }" placeholder="/var/www/my-site/dist" :disabled="!r.on">
              <label class="check small px-spa"><input type="checkbox" v-model="r.spa" :disabled="!r.on"><span>Single-page app (Vue / React router) — refreshing a page does not give 404</span></label>
            </div>
            <div v-else class="px-srv-row">
              <select v-if="scans[r.id] && scans[r.id].length" v-model="r.port" :disabled="!r.on">
                <option v-for="q in scans[r.id]" :key="q.port" :value="q.port">{{ pname(q) }}</option>
                <option v-if="r.port && !scans[r.id].some(q => q.port === Number(r.port))" :value="r.port">{{ r.port }} — typed</option>
              </select>
              <span v-else-if="!scans[r.id]" class="tiny muted"><span class="spinner"></span> looking…</span>
              <input v-model="r.port" class="code px-port" :class="{ bad: r.on && r.port && !portOk(r) }" placeholder="port" :disabled="!r.on" inputmode="numeric">
            </div>
          </div>
        </div>
        <div class="hint">Keep every server ticked: then switching servers keeps the site working. Website files: the folder with <code>index.html</code> after the build (<code>npm run build</code> → usually <code>dist</code>).</div>
      </div></div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="go" :disabled="busy || !ready"><span v-if="busy" class="spinner"></span>{{ p.proxy ? 'Update' : 'Set it up' }} on {{ rows.filter(r => r.on).length }} server{{ rows.filter(r => r.on).length === 1 ? '' : 's' }}</button>
    </template>
  </modal>`,
};

/* ------------------------------------------------------------------ the project tab */
export const ProxyTab = {
  props: { project: Object },
  components: { ProxyFlow },
  setup(props) {
    const p = computed(() => props.project);
    const rows = computed(() =>
      p.value.deployments.map((d) => {
        const s = d.proxy_state;
        return { id: d.id, name: d.server_name, live: d.is_active, port: s?.folder ? null : s?.port || d.app_port || null, folder: s?.folder || null, spa: s?.spa, code: s?.code || null, error: s?.error || null, note: s?.note || null, at: s?.at, state: !s ? 'off' : s.ok ? 'success' : 'failure' };
      }),
    );
    const any = computed(() => rows.value.some((r) => r.state !== 'off'));
    const open = () => openDialog('proxy', { project: p.value });
    const again = () => runJob(http.post(`/projects/${p.value.id}/proxy`, {
      hosts: p.value.proxy.hosts.join(' '),
      servers: rows.value.filter((r) => r.state !== 'off' && (r.port || r.folder)).map((r) => (r.folder ? { deployment: r.id, folder: r.folder, spa: r.spa !== false } : { deployment: r.id, port: r.port })),
    }));
    async function remove() {
      const ok = await confirmBox({ title: 'Remove the web proxy?', message: `nginx stops sending ${p.value.proxy?.hosts?.join(', ') || 'the domain'} to the app on every server. Your app keeps running; visitors can't reach it through the domain until you set it up again.`, confirmText: 'Remove', danger: true });
      if (ok) runJob(http.del(`/projects/${p.value.id}/proxy`));
    }
    return { p, rows, any, open, again, remove };
  },
  template: `
  <div class="card px-card">
    <div class="card-head">
      <div><h3>Web proxy (nginx)</h3><div class="hint">Sends visitors of your domain to your app's port, on every server of this project.</div></div>
      <div class="row gap-6 wrap admin-only">
        <button v-if="any" class="btn btn-sm" @click="again">Check again</button>
        <button v-if="any" class="btn btn-sm btn-danger" @click="remove">Remove</button>
        <button class="btn btn-sm btn-primary" @click="open">{{ any ? 'Change…' : 'Set up web proxy' }}</button>
      </div>
    </div>
    <div class="card-body">
      <proxy-flow :rows="rows" :hosts="p.proxy ? p.proxy.hosts : (p.domain ? [p.domain] : [])" />
      <div v-if="any && p.proxy" class="px-hosts"><a v-for="h in p.proxy.hosts" :key="h" :href="'https://' + h" target="_blank" rel="noopener" class="mono small">{{ h }} ↗</a></div>
      <div v-for="r in rows.filter(r => r.error || r.note)" :key="r.id" class="small" :class="r.error ? 'text-red' : 'muted'">{{ r.name }}: {{ r.error || r.note }}</div>
      <p v-if="!any" class="small muted" style="margin:8px 0 0">Not set up yet. Does your app answer on a port like 8080 or 3000 but not on your domain — or is it a built Vue / React site in a folder? Click <b>Set up web proxy</b> — Switchboard puts nginx in front of it on each server. Works even if nginx is not installed.</p>
    </div>
  </div>`,
};

/* ------------------------------------------------------------------ live view in the job window */
export const ProxyLive = {
  props: { progress: Object, status: String },
  components: { ProxyFlow },
  setup(props) {
    const done = computed(() => props.progress.servers.filter((s) => s.state === 'success').length);
    const failed = computed(() => props.progress.servers.find((s) => s.state === 'failure'));
    const running = computed(() => props.progress.servers.find((s) => s.state === 'running'));
    const headline = computed(() => {
      const verb = props.progress.remove ? 'Removing the web proxy' : 'Setting up the web proxy';
      if (running.value) return `${verb} on ${running.value.name} — ${PHASE_TEXT[running.value.phase || ''].replace('…', '')}`;
      if (failed.value) return `${failed.value.name}: ${failed.value.error}`;
      if (done.value === props.progress.servers.length) return props.progress.remove ? 'Web proxy removed' : `Done — ${props.progress.hosts[0]} goes to your app`;
      return `${verb}…`;
    });
    const cls = computed(() => (failed.value ? 'bad' : running.value || !['success', 'failure'].includes(props.status) ? 'run' : 'ok'));
    return { headline, cls, done };
  },
  template: `
  <div class="px-live" :class="'px-' + cls">
    <div class="px-live-head"><span class="px-dot"></span><b>{{ headline }}</b><span class="muted small mono">{{ done }}/{{ progress.servers.length }}</span></div>
    <proxy-flow :rows="progress.servers" :hosts="progress.hosts" :remove="progress.remove" />
  </div>`,
};

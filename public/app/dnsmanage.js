import { ref, reactive, computed, onMounted } from '/vendor/vue.js';
import { http, toast, confirmBox, store, isPrivateIp } from './lib.js';

const MODES = [
  ['off', 'Off'],
  ['flexible', 'Flexible'],
  ['full', 'Full'],
  ['strict', 'Full (strict)'],
];
const MODE_HINT = {
  off: 'No HTTPS at all — visitors get plain http. Not recommended.',
  flexible: 'Visitor → Cloudflare is HTTPS, but Cloudflare → your server is plain http. If the server or Laravel redirects http → https, the site breaks with an endless redirect loop (ERR_TOO_MANY_REDIRECTS). Avoid.',
  full: 'Recommended. HTTPS all the way; Cloudflare accepts any certificate on the server (Switchboard\'s web proxy has a self-signed one, so this works out of the box).',
  strict: 'Safest, but every server must have a trusted certificate or a Cloudflare Origin Certificate — a self-signed one makes Cloudflare show error 526.',
};

/**
 * Manage the project's linked Cloudflare records (point at another IP, proxy on/off) and the zone's SSL mode.
 * Admin only (the page's Settings tab).
 */
export const DnsManage = {
  props: { project: Object },
  emits: ['changed'],
  setup(props, { emit }) {
    const p = props.project;
    const state = ref(p.dns_state);
    const loading = ref(false);
    const busy = reactive({});
    const edit = reactive({}); // record id → { target: 'dep:<id>' | 'custom', ip }
    const privateOk = computed(() => !!store.settings?.info?.allow_private_dns);
    const deps = computed(() => p.deployments || []);
    const rows = computed(() => state.value?.records || []);

    async function refresh() {
      loading.value = true;
      try {
        state.value = await http.post(`/projects/${p.id}/dns/refresh`);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        loading.value = false;
      }
    }
    const ipOf = (r, d) => (r.type === 'AAAA' ? d.server_ipv6 : d.server_ip);
    const depFor = (r) => deps.value.find((d) => ipOf(r, d) && ipOf(r, d) === r.content);
    function startEdit(r) {
      const other = deps.value.find((d) => ipOf(r, d) && ipOf(r, d) !== r.content);
      edit[r.id] = other ? { target: `dep:${other.id}`, ip: '' } : { target: 'custom', ip: '' };
    }
    function wantedIp(r) {
      const e = edit[r.id];
      if (!e) return '';
      if (e.target === 'custom') return e.ip.trim();
      const d = deps.value.find((x) => `dep:${x.id}` === e.target);
      return d ? ipOf(r, d) || '' : '';
    }
    async function change(r, body, what) {
      busy[r.id] = true;
      try {
        const out = await http.post(`/projects/${p.id}/dns/records/${r.id}`, body);
        if (out.dns_state) state.value = out.dns_state;
        toast(out.changed ? `${r.name}: ${what}` : `${r.name} was already like that`, out.changed ? 'success' : 'info');
        delete edit[r.id];
        if (out.changed) loadSsl(); // the HTTPS checks depend on where the records point
        emit('changed');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy[r.id] = false;
      }
    }
    const cancel = (r) => delete edit[r.id];
    async function applyIp(r) {
      const ip = wantedIp(r);
      if (!ip) return toast('Pick a server or type an IP', 'warn');
      const d = deps.value.find((x) => ipOf(r, x) === ip);
      const active = deps.value.find((x) => x.is_active);
      const notes = [];
      if (active && d && d.id !== active.id) notes.push(`${active.server_name} is the live server in Switchboard — after this, Switchboard will report DNS drift. To move the whole project (database copy, maintenance mode, rollback), use "Switch traffic here" on the server card instead. If you only want this one hostname moved, that's fine.`);
      if (!d) notes.push(`${ip} is not one of this project's servers.`);
      if (!r.proxied) notes.push(`This record is DNS only (TTL ${r.ttl === 1 ? 'auto' : `${r.ttl}s`}) — some visitors keep the old IP until the TTL runs out.`);
      const ok = await confirmBox({
        title: `Point ${r.name} to ${d ? d.server_name : ip}?`,
        message: `${r.content} → ${ip}${d ? ` (${d.server_name})` : ''}\n\n${notes.join('\n\n')}`.trim(),
        confirmText: 'Change DNS',
        danger: true,
      });
      if (ok) change(r, { content: ip }, `now points to ${d ? d.server_name : ip}`);
    }
    async function toggleProxy(r) {
      const on = !r.proxied;
      const ok = await confirmBox({
        title: `${on ? 'Turn on' : 'Turn off'} the Cloudflare proxy for ${r.name}?`,
        message: on
          ? 'Visitors will go through Cloudflare (orange cloud): the server IP is hidden, caching and DDoS protection work, and switching servers takes seconds. Make sure the SSL mode below is "Full" so HTTPS works.'
          : 'Visitors will connect straight to the server (grey cloud): its IP becomes public, Cloudflare caching/protection stop, and the server itself must have a valid certificate for HTTPS.',
        confirmText: on ? 'Turn on proxy' : 'Turn off proxy',
        danger: !on,
      });
      if (ok) change(r, { proxied: on }, on ? 'proxy on (orange cloud)' : 'proxy off (DNS only)');
    }

    /* ---------- SSL ---------- */
    const ssl = ref(null);
    const sslLoading = ref(false);
    const sslForm = reactive({ mode: 'full', always_https: true });
    const problems = ref([]);
    async function loadSsl() {
      sslLoading.value = true;
      try {
        ssl.value = await http.get(`/projects/${p.id}/ssl`);
        const z = ssl.value.zones[0];
        sslForm.mode = z?.ssl && z.ssl !== 'off' && z.ssl !== 'flexible' ? z.ssl : ssl.value.default_mode;
        sslForm.always_https = !z || z.always_use_https === 'on' || (z.ssl !== 'full' && z.ssl !== 'strict');
        problems.value = [];
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        sslLoading.value = false;
      }
    }
    async function applySsl(force = false) {
      if (sslForm.mode === 'flexible' || sslForm.mode === 'off') {
        const ok = await confirmBox({ title: `Set SSL to "${sslForm.mode}"?`, message: MODE_HINT[sslForm.mode], confirmText: `Use ${sslForm.mode}`, danger: true });
        if (!ok) return;
      }
      if (force) {
        const ok = await confirmBox({ title: 'Change SSL anyway?', message: `These hostnames will probably stop working:\n\n${problems.value.join('\n')}`, confirmText: 'Change anyway', danger: true });
        if (!ok) return;
      }
      busy.ssl = true;
      try {
        const out = await http.post(`/projects/${p.id}/ssl`, { mode: sslForm.mode, always_https: sslForm.always_https, force });
        ssl.value = out.status;
        problems.value = [];
        toast(`Cloudflare SSL is now "${sslForm.mode}"${sslForm.always_https && sslForm.mode !== 'off' ? ' + Always Use HTTPS' : ''}`, 'success');
      } catch (e) {
        if (e.status === 409 && e.data?.problems) problems.value = e.data.problems;
        else toast(e.message, 'error');
      } finally {
        busy.ssl = false;
      }
    }
    const zonesLabel = computed(() => (ssl.value?.zones || []).map((z) => z.zone_name).join(', '));
    const otherHosts = computed(() => (ssl.value?.zones || []).reduce((n, z) => n + z.other_hosts, 0));

    onMounted(() => {
      if (p.dns_records.length) {
        refresh();
        loadSsl();
      }
    });
    return { p, state, rows, loading, busy, edit, deps, privateOk, isPrivateIp, refresh, depFor, startEdit, cancel, wantedIp, applyIp, toggleProxy, ipOf,
      ssl, sslLoading, sslForm, problems, loadSsl, applySsl, MODES, MODE_HINT, zonesLabel, otherHosts };
  },
  template: `
  <div class="stack" style="gap:14px">
    <div class="row between wrap gap-8"><b class="small">Point records &amp; proxy</b>
      <button class="btn btn-xs" @click="refresh" :disabled="loading"><span v-if="loading" class="spinner"></span>Reload from Cloudflare</button></div>
    <div v-if="state && state.error" class="result err">{{ state.error }}</div>
    <div class="card table-wrap" v-if="rows.length">
      <table class="table">
        <thead><tr><th>Record</th><th>Points to</th><th>Proxy</th><th>Change to</th></tr></thead>
        <tbody><tr v-for="r in rows" :key="r.id">
          <td class="strong">{{ r.name }} <span class="badge">{{ r.type }}</span></td>
          <td><span class="mono small">{{ r.content }}</span><div class="small" :class="depFor(r) ? 'muted' : 'text-amber'">{{ depFor(r) ? depFor(r).server_name + (depFor(r).is_active ? ' (live)' : '') : 'not a server of this project' }}</div></td>
          <td><button class="badge" style="border:0;cursor:pointer" :class="r.proxied ? 'badge-amber' : 'badge-gray'" :disabled="busy[r.id] || p.traffic_mode === 'lb' && p.lb_provider === 'cloudflare'" @click="toggleProxy(r)" :title="r.proxied ? 'Click to turn the proxy off' : 'Click to turn the proxy on'">{{ r.proxied ? 'Proxied' : 'DNS only' }}</button></td>
          <td>
            <div v-if="p.traffic_mode === 'lb'" class="muted small">Load balanced — see the Traffic tab</div>
            <button v-else-if="!edit[r.id]" class="btn btn-xs" @click="startEdit(r)">Point to…</button>
            <div v-else class="row gap-6 wrap">
              <select v-model="edit[r.id].target" style="max-width:220px">
                <option v-for="d in deps" :key="d.id" :value="'dep:' + d.id" :disabled="!ipOf(r, d)">{{ d.server_name }} — {{ ipOf(r, d) || 'no ' + (r.type === 'AAAA' ? 'IPv6' : 'IPv4') }}{{ d.is_active ? ' (live)' : '' }}</option>
                <option value="custom">Another IP…</option>
              </select>
              <input v-if="edit[r.id].target === 'custom'" v-model="edit[r.id].ip" class="code" style="width:150px" :placeholder="r.type === 'AAAA' ? '2001:db8::1' : '203.0.113.10'">
              <button class="btn btn-primary btn-xs" @click="applyIp(r)" :disabled="busy[r.id] || !wantedIp(r) || wantedIp(r) === r.content"><span v-if="busy[r.id]" class="spinner"></span>Apply</button>
              <button class="btn btn-xs" @click="cancel(r)">Cancel</button>
              <div v-if="isPrivateIp(wantedIp(r)) && !privateOk" class="text-red small" style="flex-basis:100%">Private IP — visitors and Cloudflare can't reach it.</div>
            </div>
          </td>
        </tr></tbody>
      </table>
    </div>
    <div v-else-if="!loading" class="muted small">Save the linked records first, then you can change them here.</div>

    <div class="stack" style="gap:10px" v-if="rows.length">
      <div class="row between wrap gap-8"><b class="small">SSL (HTTPS) <span class="muted" v-if="zonesLabel">· zone {{ zonesLabel }}</span></b>
        <button class="btn btn-xs" @click="loadSsl" :disabled="sslLoading"><span v-if="sslLoading" class="spinner"></span>Check servers</button></div>
      <div v-if="ssl && ssl.zones.some(z => z.error)" class="result err"><div v-for="z in ssl.zones.filter(z => z.error)" :key="z.zone_id">{{ z.zone_name }}: {{ z.error }}</div></div>
      <div v-if="ssl" class="small">Now: <span v-for="z in ssl.zones" :key="z.zone_id"><b>{{ z.ssl || '?' }}</b><span v-if="z.always_use_https"> · Always Use HTTPS {{ z.always_use_https }}</span></span></div>
      <div v-if="ssl && ssl.zones.some(z => z.ssl === 'flexible')" class="alert alert-warn"><span class="alert-icon">⚠</span><span>The zone is on <b>Flexible</b>: Cloudflare talks plain http to your servers. If a server or Laravel redirects to https, visitors get an endless redirect loop. Switch to <b>Full</b>.</span></div>
      <div class="seg"><button v-for="[m, label] in MODES" :key="m" :class="{ on: sslForm.mode === m }" @click="sslForm.mode = m; problems = []">{{ label }}<span v-if="m === 'full'" class="muted"> ✓</span></button></div>
      <div class="hint" :class="{ 'text-amber': sslForm.mode === 'flexible' || sslForm.mode === 'off' }">{{ MODE_HINT[sslForm.mode] }}</div>
      <label class="check" v-if="sslForm.mode !== 'off'"><input type="checkbox" v-model="sslForm.always_https"><span class="check-text"><b>Always Use HTTPS</b><span class="hint">Cloudflare redirects http:// visitors to https://.</span></span></label>
      <div class="hint" v-if="otherHosts">⚠ The SSL mode is for the whole zone: it also affects {{ otherHosts }} other proxied hostname{{ otherHosts === 1 ? '' : 's' }} that aren't part of this project. They are checked below too.</div>
      <div class="card table-wrap" v-if="ssl && ssl.checks.length">
        <table class="table">
          <thead><tr><th>Hostname</th><th>Server</th><th>HTTPS on :443</th><th>Certificate</th></tr></thead>
          <tbody><tr v-for="c in ssl.checks" :key="c.ip + c.name">
            <td>{{ c.name }}<span v-if="!c.linked" class="muted small"> (other)</span><span v-if="c.proxied === false" class="muted small"> (DNS only)</span></td>
            <td class="small"><span class="mono">{{ c.ip }}</span><div class="muted">{{ c.server || 'unknown server' }}{{ c.standby ? ' · project server' : '' }}</div></td>
            <td><span v-if="c.https" class="text-green">✔ yes</span><span v-else class="text-red small">✖ {{ c.error || 'no' }}</span><div v-if="c.redirects_to_https" class="small muted">http → https redirect</div></td>
            <td class="small"><template v-if="c.https">{{ c.issuer || 'self-signed' }}<div :class="c.strict_ok ? 'text-green' : 'muted'">{{ c.strict_ok ? 'OK for strict' : 'Full only (not strict)' }}</div></template></td>
          </tr></tbody>
        </table>
      </div>
      <div v-if="problems.length" class="alert alert-error"><span class="alert-icon">✖</span><span class="grow">
        <b>Not changed — this would break:</b><ul style="margin:6px 0 0 18px;padding:0"><li v-for="x in problems" :key="x">{{ x }}</li></ul>
        <div class="hint" style="margin-top:6px">Fix the servers first (they must serve HTTPS on port 443 — Switchboard's web proxy does, with a self-signed certificate), or pick another mode.</div></span>
        <button class="btn btn-sm btn-danger" @click="applySsl(true)" :disabled="busy.ssl">Change anyway</button></div>
      <div class="row gap-8"><button class="btn btn-primary btn-sm" @click="applySsl(false)" :disabled="busy.ssl || !ssl"><span v-if="busy.ssl" class="spinner"></span>Apply SSL setting</button></div>

      <div class="hint" v-if="ssl">Certificates on the servers (Cloudflare Origin, your own, or Let's Encrypt) are set up in the <b>SSL certificates on the servers</b> card below.</div>
    </div>
  </div>`,
};

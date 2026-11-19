import { ref, reactive, computed, onMounted } from '/vendor/vue.js';
import { http, toast, confirmBox } from './lib.js';
import { buildSite, siteFileName, streamBlock, parseUpstream } from './nginxtemplate.js';

/* Nginx sites tab: the server's own nginx sites (sites-available / sites-enabled and conf.d). Admins only. */
export const NginxTab = {
  props: { server: Object },
  setup(props) {
    const sid = props.server.id;
    const data = ref(null);
    const loading = ref(false);
    const busy = ref(false);
    const ed = ref(null); // { dir, name, text, isNew, enable, original }
    const wiz = reactive({ open: false, hosts: '', target: 'app', port: '', root: '/var/www/html', stream: true, path: '/stream-proxy/', upstream: '127.0.0.1:9000', signedHost: '' });
    const snip = reactive({ open: false, path: '/stream-proxy/', upstream: '127.0.0.1:9000', signedHost: '' });

    async function load() {
      loading.value = true;
      try {
        data.value = await http.get(`/servers/${sid}/nginx`);
      } catch (e) {
        data.value = { ok: false, error: e.message };
      } finally {
        loading.value = false;
      }
    }
    onMounted(load);

    const sites = computed(() => (data.value?.sites || []).filter((s) => s.dir === 'sites'));
    const confd = computed(() => (data.value?.sites || []).filter((s) => s.dir === 'confd'));

    async function act(promise, okText) {
      busy.value = true;
      try {
        const r = await promise;
        if (r.ok) {
          toast(okText, 'success');
          await load();
          return true;
        }
        toast(`nginx said no — nothing was changed: ${r.error}`, 'error', 12000);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
      return false;
    }

    const setup = () => act(http.post(`/servers/${sid}/nginx/setup`), 'sites-available is ready');

    async function open(s) {
      busy.value = true;
      try {
        const r = await http.get(`/servers/${sid}/nginx/file?dir=${encodeURIComponent(s.dir)}&name=${encodeURIComponent(s.name)}`);
        ed.value = { dir: s.dir, name: s.name, text: r.text, original: r.text, isNew: false, enable: s.enabled, managed: s.managed };
        snip.open = false;
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }

    const wizText = computed(() => buildSite({
      hosts: wiz.hosts,
      target: wiz.target,
      port: wiz.port,
      root: wiz.root,
      ssl: !!data.value?.cert,
      stream: wiz.stream ? { path: wiz.path, upstream: wiz.upstream, signedHost: wiz.signedHost } : null,
    }));
    const wizOk = computed(() => wiz.hosts.trim() && (wiz.target === 'root' ? wiz.root.trim() : Number(wiz.port) > 0) && (!wiz.stream || parseUpstream(wiz.upstream)));
    function fromWizard() {
      const layout = data.value?.layout;
      const base = siteFileName(wiz.hosts);
      ed.value = { dir: layout === 'sites' ? 'sites' : 'confd', name: layout === 'sites' ? base : `${base}.conf`, text: wizText.value, original: '', isNew: true, enable: true };
      wiz.open = false;
    }

    const snipText = computed(() => (parseUpstream(snip.upstream) ? streamBlock({ path: snip.path, upstream: snip.upstream, signedHost: snip.signedHost }) : ''));
    function insertSnippet() {
      const e = ed.value;
      if (!e || !snipText.value) return;
      // Put it before the first "location /" so it wins for its path; else before the last "}".
      const block = snipText.value.replace(/^/gm, '    ').replace(/^ {4}$/gm, '');
      const at = e.text.search(/\n[ \t]*location\s+\/\s*\{/);
      if (at >= 0) e.text = `${e.text.slice(0, at)}\n${block}${e.text.slice(at)}`;
      else {
        const end = e.text.lastIndexOf('}');
        e.text = end >= 0 ? `${e.text.slice(0, end)}${block}${e.text.slice(end)}` : `${e.text}\n${block}`;
      }
      snip.open = false;
    }

    async function save() {
      const e = ed.value;
      const ok = await act(http.put(`/servers/${sid}/nginx/file`, { dir: e.dir, name: e.name, text: e.text, enable: e.enable }), `${e.name} saved — nginx reloaded`);
      if (ok) ed.value = null;
    }
    async function close() {
      if (ed.value && ed.value.text !== ed.value.original && !(await confirmBox({ title: 'Close without saving?', message: 'Your changes to this file are lost.', confirmText: 'Close', danger: true }))) return;
      ed.value = null;
    }
    const toggle = (s) => act(http.post(`/servers/${sid}/nginx/enable`, { name: s.name, on: !s.enabled }), `${s.name} turned ${s.enabled ? 'off' : 'on'}`);
    async function remove(s) {
      const ok = await confirmBox({ title: `Delete ${s.name}?`, message: `The file is removed from ${s.dir === 'sites' ? '/etc/nginx/sites-available (and sites-enabled)' : '/etc/nginx/conf.d'} and nginx reloads.${s.hosts.length ? `\n${s.hosts.join(', ')} will no longer be served by it.` : ''}`, confirmText: 'Delete', danger: true });
      if (ok) act(http.del(`/servers/${sid}/nginx/file`, { dir: s.dir, name: s.name }), `${s.name} deleted`);
    }
    const dirPath = (d) => (d === 'sites' ? '/etc/nginx/sites-available/' : '/etc/nginx/conf.d/');

    return { data, loading, busy, load, sites, confd, setup, open, ed, wiz, wizText, wizOk, fromWizard, snip, snipText, insertSnippet, save, close, toggle, remove, dirPath };
  },
  template: `
  <div class="stack">
    <div v-if="data && !data.ok" class="alert alert-warn"><span class="alert-icon">⚠</span><span>{{ data.error }}</span></div>
    <div v-else-if="!data" class="empty-card">Reading nginx…</div>

    <template v-else>
      <div v-if="!data.nginx" class="alert alert-warn"><span class="alert-icon">⚠</span><span><b>nginx is not installed on this server.</b> Switchboard's own web proxy runs in the switchboard-edge container here (use Ports &amp; domains → Connect a domain). To use sites-available, install nginx on the server first (<span class="mono">apt install nginx</span>) — ports 80/443 must be free.</span></div>

      <div v-else-if="data.layout !== 'sites'" class="card card-body">
        <h3>sites-available is not set up</h3>
        <p class="hint mt-8">nginx {{ data.version }} only reads <span class="mono">/etc/nginx/conf.d</span> on this server. Set it up to keep one file per site in <span class="mono">/etc/nginx/sites-available</span> and turn each on or off with a link in <span class="mono">sites-enabled</span>.</p>
        <p class="hint">Switchboard creates both folders, adds <span class="mono">include /etc/nginx/sites-enabled/*;</span> to nginx.conf, and makes a self-signed certificate for port 443 (behind Cloudflare, SSL mode "Full"). If nginx rejects the change, nginx.conf is put back.</p>
        <div class="mt-8"><button class="btn btn-primary" @click="setup" :disabled="busy"><span v-if="busy" class="spinner"></span><icon v-else name="settings" />Set up sites-available</button></div>
      </div>

      <!-- editor -->
      <div v-if="ed" class="card">
        <div class="card-head"><div><h3>{{ ed.isNew ? 'New site' : 'Edit' }} <span class="mono">{{ dirPath(ed.dir) }}{{ ed.isNew ? '' : ed.name }}</span></h3>
          <div class="hint">Saved only if <span class="mono">nginx -t</span> passes — otherwise the old file stays.</div></div>
          <div class="row gap-8"><button class="btn btn-sm" @click="snip.open = !snip.open"><icon name="plug" />Add video stream proxy</button></div></div>
        <div class="card-body form">
          <div v-if="ed.managed" class="alert alert-warn"><span class="alert-icon">⚠</span><span>Switchboard writes this file itself (Connect a domain / new app) and rewrites it when that site changes — your edits can be lost. For lasting changes, make your own site file instead.</span></div>
          <div v-if="ed.isNew" class="form-row">
            <div class="field"><label>File name</label><input v-model="ed.name" class="code" placeholder="example.com"></div>
            <div class="field" v-if="ed.dir === 'sites'"><label>&nbsp;</label><label class="check"><input type="checkbox" v-model="ed.enable"><span class="check-text"><b>Turn on now</b><span class="hint">Links it into sites-enabled.</span></span></label></div>
          </div>
          <div v-if="snip.open" class="card card-body" style="background:var(--bg-soft, transparent)">
            <b>Video stream proxy</b>
            <div class="hint">Serves <span class="mono">https://your-site{{ snip.path }}&lt;bucket&gt;/&lt;file&gt;?X-Amz-…</span> from your S3 / MinIO storage, for signed (pre-signed) links.</div>
            <div class="form-row mt-8">
              <div class="field"><label>Path on the site</label><input v-model="snip.path" class="code"></div>
              <div class="field"><label>S3 / MinIO address</label><input v-model="snip.upstream" class="code" placeholder="127.0.0.1:9000 or https://s3.example.com"></div>
            </div>
            <div class="field"><label>Host the links are signed for <span class="muted">(empty = same as the address)</span></label><input v-model="snip.signedHost" class="code" placeholder="e.g. minio:9000 — the host in the S3 endpoint your app uses"></div>
            <pre v-if="snipText" class="code small" style="white-space:pre;overflow:auto;max-height:220px">{{ snipText }}</pre>
            <div v-else class="hint">Enter an address like 127.0.0.1:9000.</div>
            <div class="row gap-8 mt-8"><button class="btn btn-sm btn-primary" @click="insertSnippet" :disabled="!snipText">Insert into the file</button><button class="btn btn-sm btn-ghost" @click="snip.open = false">Cancel</button></div>
          </div>
          <textarea v-model="ed.text" class="code" rows="24" spellcheck="false" style="font-size:12px;white-space:pre"></textarea>
          <div class="row gap-8"><button class="btn btn-primary" @click="save" :disabled="busy || !ed.name || !ed.text.trim()"><span v-if="busy" class="spinner"></span><icon v-else name="check" />Test &amp; save</button>
            <button class="btn btn-ghost" @click="close">Cancel</button></div>
        </div>
      </div>

      <!-- new-site wizard -->
      <div v-if="wiz.open && !ed" class="card">
        <div class="card-head"><div><h3>New site</h3><div class="hint">Answer a few questions; you can still edit the file before saving.</div></div></div>
        <div class="card-body form">
          <div class="field"><label>Domains <span class="muted">(space between)</span></label><input v-model="wiz.hosts" class="code" placeholder="example.com www.example.com"></div>
          <div class="form-row">
            <div class="field"><label>Sends visitors to</label><select v-model="wiz.target"><option value="app">An app on a port (Docker, Node…)</option><option value="root">A folder of files</option></select></div>
            <div class="field" v-if="wiz.target === 'app'"><label>App port</label><input v-model.number="wiz.port" class="code" placeholder="8000"></div>
            <div class="field" v-else><label>Folder</label><input v-model="wiz.root" class="code"></div>
          </div>
          <label class="check"><input type="checkbox" v-model="wiz.stream"><span class="check-text"><b>Video stream proxy</b><span class="hint">Adds a path (like /stream-proxy/) that serves videos from S3 / MinIO with signed links (X-Amz-…).</span></span></label>
          <template v-if="wiz.stream">
            <div class="form-row">
              <div class="field"><label>Path on the site</label><input v-model="wiz.path" class="code"></div>
              <div class="field"><label>S3 / MinIO address</label><input v-model="wiz.upstream" class="code" placeholder="127.0.0.1:9000"></div>
            </div>
            <div class="field"><label>Host the links are signed for <span class="muted">(empty = same as the address)</span></label><input v-model="wiz.signedHost" class="code" placeholder="the host in the S3 endpoint your app signs links with"></div>
          </template>
          <div v-if="!data.cert" class="hint">No certificate yet: the site listens on port 80 only (Cloudflare SSL mode "Flexible"). Run "Set up sites-available" to add port 443.</div>
          <pre class="code small" style="white-space:pre;overflow:auto;max-height:260px">{{ wizText }}</pre>
          <div class="row gap-8"><button class="btn btn-primary" @click="fromWizard" :disabled="!wizOk">Continue</button><button class="btn btn-ghost" @click="wiz.open = false">Cancel</button></div>
        </div>
      </div>

      <div class="card" v-if="data.nginx">
        <div class="card-head"><div><h3>Sites <span class="muted small">/etc/nginx/sites-available</span></h3><div class="hint">nginx {{ data.version }} · a site is on when it is linked in sites-enabled.</div></div>
          <div class="row gap-8"><button class="btn btn-sm" @click="load" :disabled="loading"><span v-if="loading" class="spinner"></span><icon v-else name="refresh" />Refresh</button>
            <button class="btn btn-sm btn-primary" @click="wiz.open = true; ed = null" :disabled="busy"><icon name="globe" />New site</button></div></div>
        <div class="table-wrap" v-if="sites.length"><table class="table">
          <thead><tr><th>File</th><th>Domains</th><th>Paths</th><th>Status</th><th></th></tr></thead>
          <tbody><tr v-for="s in sites" :key="s.name">
            <td class="mono strong">{{ s.name }}</td>
            <td class="small"><div v-for="h in s.hosts" :key="h">{{ h }}</div><span v-if="!s.hosts.length" class="muted">—</span></td>
            <td class="mono tiny">{{ s.locations.join('  ') || '—' }}</td>
            <td><span class="badge" :class="s.enabled ? 'badge-green' : 'badge-gray'">{{ s.enabled ? 'On' : 'Off' }}</span></td>
            <td class="actions"><button class="btn btn-xs" @click="open(s)" :disabled="busy"><icon name="edit" :size="13" />Edit</button>
              <button class="btn btn-xs" @click="toggle(s)" :disabled="busy">{{ s.enabled ? 'Turn off' : 'Turn on' }}</button>
              <button class="btn btn-xs btn-danger" @click="remove(s)" :disabled="busy">Delete</button></td>
          </tr></tbody>
        </table></div>
        <div v-else class="empty">{{ data.layout === 'sites' ? 'No sites yet — click New site.' : 'Set up sites-available first, or add a file in conf.d below.' }}</div>
      </div>

      <div class="card" v-if="data.nginx && confd.length">
        <div class="card-head"><div><h3>conf.d <span class="muted small">/etc/nginx/conf.d</span></h3><div class="hint">Always on. sb-*.conf files are Switchboard's own web proxy sites.</div></div></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>File</th><th>Domains</th><th>Paths</th><th></th></tr></thead>
          <tbody><tr v-for="s in confd" :key="s.name">
            <td class="mono strong">{{ s.name }} <span v-if="s.managed" class="badge badge-blue">Switchboard</span></td>
            <td class="small"><div v-for="h in s.hosts" :key="h">{{ h }}</div><span v-if="!s.hosts.length" class="muted">—</span></td>
            <td class="mono tiny">{{ s.locations.join('  ') || '—' }}</td>
            <td class="actions"><button class="btn btn-xs" @click="open(s)" :disabled="busy"><icon name="edit" :size="13" />Edit</button>
              <button v-if="!s.managed" class="btn btn-xs btn-danger" @click="remove(s)" :disabled="busy">Delete</button></td>
          </tr></tbody>
        </table></div>
      </div>
    </template>
  </div>`,
};

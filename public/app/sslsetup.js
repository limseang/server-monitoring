import { ref, reactive, computed, onMounted } from '/vendor/vue.js';
import { http, confirmBox, runJob } from './lib.js';

const STATUS = {
  ok: ['badge-green', 'SSL OK'],
  'self-signed': ['badge-amber', 'Self-signed'],
  missing: ['badge-red', 'File missing'],
  'no-ssl': ['badge-red', 'No SSL'],
  'no-site': ['badge-gray', 'No nginx site'],
  'no-nginx': ['badge-gray', 'No nginx'],
  expired: ['badge-red', 'Expired'],
  'wrong-host': ['badge-amber', 'Wrong names'],
  'bad-key': ['badge-red', 'Key mismatch'],
  unknown: ['badge-gray', 'Unknown'],
  error: ['badge-red', 'Could not check'],
};
const GOOD = ['ok'];
const METHODS = [
  ['cloudflare', 'Cloudflare (automatic)'],
  ['own', 'My own certificate'],
  ['acme', "Let's Encrypt / ZeroSSL"],
];

/**
 * SSL on the project's servers: scan first (which nginx sites serve the project, which certificate,
 * missing files, expiry), then set it up with a Cloudflare Origin Certificate, your own certificate,
 * or Let's Encrypt / ZeroSSL. Admin only (the page's Settings tab).
 */
export const SslSetup = {
  props: { project: Object },
  setup(props) {
    const p = props.project;
    const scan = ref(null);
    const loading = ref(false);
    const error = ref('');
    const open = reactive({});
    const f = reactive({ method: 'cloudflare', pick: {}, strict: true, cert: '', key: '', ca: 'letsencrypt', email: '', challenge: 'dns', token: '' });

    async function load() {
      loading.value = true;
      error.value = '';
      try {
        scan.value = await http.get(`/projects/${p.id}/ssl/scan`);
        for (const s of scan.value.servers) if (!(s.deployment_id in f.pick)) f.pick[s.deployment_id] = !GOOD.includes(s.status);
        if (!scan.value.cloudflare && f.method === 'cloudflare') f.method = 'acme';
        if (!scan.value.cloudflare) f.challenge = 'http';
      } catch (e) {
        error.value = e.message;
      } finally {
        loading.value = false;
      }
    }
    onMounted(() => (p.deployments || []).length && load());

    const servers = computed(() => scan.value?.servers || []);
    const allGood = computed(() => servers.value.length && servers.value.every((s) => GOOD.includes(s.status)));
    const picked = computed(() => servers.value.filter((s) => f.pick[s.deployment_id]));
    const broken = computed(() => servers.value.flatMap((s) => (s.broken || []).map((b) => ({ ...b, server: s.server }))));
    const ready = computed(() => {
      if (!picked.value.length) return false;
      if (f.method === 'cloudflare') return !!scan.value?.cloudflare;
      if (f.method === 'own') return f.cert.includes('BEGIN CERTIFICATE') && /BEGIN [A-Z ]*PRIVATE KEY/.test(f.key);
      if (f.method === 'acme') return f.ca !== 'zerossl' || !!f.email.trim();
      return false;
    });
    const fmt = (iso) => (iso ? iso.slice(0, 10) : '');

    async function start() {
      const names = picked.value.map((s) => s.server).join(', ');
      const what = {
        cloudflare: `Each server makes a new private key and Cloudflare signs a certificate for ${(scan.value.cert_hostnames || []).join(', ')} (valid 15 years).`,
        own: 'Your certificate and key are copied to each server (the key goes over SSH only, it is not stored by Switchboard).',
        acme: `${scan.value.cas[f.ca]} gives each server a free certificate for ${scan.value.hosts.join(', ')} (90 days, renewed automatically by acme.sh).`,
      }[f.method];
      const ok = await confirmBox({
        title: `Set up SSL on ${names}?`,
        message:
          `${what}\n\nThen the nginx sites for ${scan.value.hosts.join(', ')} are pointed at the new files (http-only sites get port 443). ` +
          'Every change is tested with "nginx -t" — if nginx says no, everything is put back as it was.' +
          (f.strict && scan.value.cloudflare && f.method !== 'own' ? '\n\nAfterwards Cloudflare SSL is switched to "Full (strict)" — only if every proxied hostname passes the check.' : ''),
        confirmText: 'Set up SSL',
      });
      if (!ok) return;
      const body = { method: f.method, deployments: picked.value.map((s) => s.deployment_id), strict: f.strict && !!scan.value.cloudflare };
      if (f.method === 'own') Object.assign(body, { cert: f.cert, key: f.key });
      if (f.method === 'acme') Object.assign(body, { ca: f.ca, email: f.email.trim(), challenge: f.challenge, token: f.token.trim() });
      const r = await runJob(http.post(`/projects/${p.id}/ssl/setup`, body));
      if (r?.job) {
        f.key = '';
        f.token = '';
      }
    }

    return { p, scan, loading, error, open, f, load, servers, allGood, picked, broken, ready, start, fmt, STATUS, METHODS };
  },
  template: `
  <div class="card card-body form">
    <div class="row between wrap gap-8"><h3>SSL certificates on the servers</h3>
      <button class="btn btn-sm" @click="load" :disabled="loading || !(p.deployments || []).length"><span v-if="loading" class="spinner"></span>{{ scan ? 'Scan again' : 'Scan servers' }}</button></div>
    <p class="hint" style="margin:0">Checks each server's nginx for the sites of <b>{{ (scan && scan.hosts.join(', ')) || p.domain || 'this project' }}</b>: is there a certificate, is the file really there, who made it, when it expires.</p>
    <div v-if="!(p.deployments || []).length" class="muted small">Add a server to this project first.</div>
    <div v-if="error" class="result err">{{ error }}</div>
    <div v-if="loading && !scan" class="muted small"><span class="spinner"></span> Reading nginx on each server…</div>

    <div v-if="scan" class="card table-wrap">
      <table class="table">
        <thead><tr><th>Server</th><th>SSL</th><th>Details</th></tr></thead>
        <tbody>
          <template v-for="s in servers" :key="s.deployment_id">
            <tr>
              <td class="strong">{{ s.server }}<span v-if="s.is_active" class="badge badge-green" style="margin-left:6px">live</span></td>
              <td><span class="badge" :class="(STATUS[s.status] || STATUS.unknown)[0]">{{ (STATUS[s.status] || STATUS.unknown)[1] }}</span></td>
              <td class="small">{{ s.message }}
                <div v-if="s.sites && s.sites.length"><button class="btn btn-xs" style="margin-top:4px" @click="open[s.deployment_id] = !open[s.deployment_id]">{{ open[s.deployment_id] ? 'Hide' : 'Show' }} {{ s.sites.length }} nginx block{{ s.sites.length === 1 ? '' : 's' }}</button></div>
              </td>
            </tr>
            <tr v-if="open[s.deployment_id]"><td colspan="3">
              <div v-for="(x, i) in s.sites" :key="i" class="small" style="padding:4px 0;border-bottom:1px solid var(--border)">
                <div><span class="mono">{{ x.file }}</span><span v-if="x.managed" class="muted"> (Switchboard's web proxy)</span> · {{ x.names.join(' ') }} · port {{ x.ports.join(', ') || 80 }}<span v-if="x.redirect" class="muted"> · redirects to https</span></div>
                <div v-if="x.cert">Certificate <span class="mono">{{ x.cert }}</span> <span v-if="x.cert_missing" class="text-red">✖ not on the server</span>
                  <span v-else-if="x.cert_info && x.cert_info.ok">— {{ x.cert_info.issuer }}, until {{ fmt(x.cert_info.not_after) }} ({{ x.cert_info.days_left }} days)<span v-if="x.cert_info.missing_hosts.length" class="text-amber"> · does not cover {{ x.cert_info.missing_hosts.join(', ') }}</span></span></div>
                <div v-if="x.key">Key <span class="mono">{{ x.key }}</span> <span v-if="x.key_missing" class="text-red">✖ not on the server</span><span v-else-if="x.key_match === true" class="text-green">✔ matches</span><span v-else-if="x.key_match === false" class="text-red">✖ does not match the certificate</span></div>
              </div>
            </td></tr>
          </template>
        </tbody>
      </table>
    </div>
    <div v-if="broken.length" class="alert alert-warn"><span class="alert-icon">⚠</span><span>Other nginx sites point to files that are missing, so nginx can't reload until they are fixed or turned off (Nginx sites tab of the server):
      <ul style="margin:6px 0 0 18px;padding:0"><li v-for="b in broken" :key="b.server + b.file + b.path">{{ b.server }}: <span class="mono">{{ b.file }}</span> → <span class="mono">{{ b.path }}</span></li></ul></span></div>
    <div v-if="allGood" class="alert alert-success"><span class="alert-icon">✔</span><span>Every server of this project has a working certificate. You can still replace it below.</span></div>

    <div v-if="scan && servers.length" class="stack" style="gap:10px">
      <b class="small">{{ allGood ? 'Replace the certificate' : 'Set up SSL' }}</b>
      <div class="row wrap gap-8"><label v-for="s in servers" :key="s.deployment_id" class="check" style="margin:0"><input type="checkbox" v-model="f.pick[s.deployment_id]"><span class="check-text">{{ s.server }}</span></label></div>
      <div class="seg"><button v-for="[m, label] in METHODS" :key="m" :class="{ on: f.method === m }" @click="f.method = m">{{ label }}</button></div>

      <template v-if="f.method === 'cloudflare'">
        <div v-if="!scan.cloudflare" class="hint text-amber">Link this project's Cloudflare DNS records (above) and add your Cloudflare token in Settings to use this.</div>
        <div class="hint">Free, valid 15 years, made and installed for you. Cloudflare trusts it (so "Full (strict)" works); browsers only trust it behind Cloudflare's orange cloud. Covers <code>{{ (scan.cert_hostnames || []).join(' ') }}</code>. Your Cloudflare token needs "Zone · SSL and Certificates · Edit".</div>
      </template>

      <template v-if="f.method === 'own'">
        <div class="hint">A certificate you already have (bought, or from another provider). Paste the full chain and the private key — the key is sent to the servers over SSH and not kept by Switchboard.</div>
        <div class="field"><label>Certificate (full chain, PEM)</label><textarea v-model="f.cert" rows="5" class="code" placeholder="-----BEGIN CERTIFICATE-----"></textarea></div>
        <div class="field"><label>Private key (PEM, no password)</label><textarea v-model="f.key" rows="4" class="code" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></div>
      </template>

      <template v-if="f.method === 'acme'">
        <div class="hint">Free certificate trusted by every browser (90 days, renewed automatically by acme.sh on the server).</div>
        <div class="form-row-3">
          <div class="field"><label>Provider</label><select v-model="f.ca"><option v-for="(name, k) in scan.cas" :key="k" :value="k">{{ name }}</option></select></div>
          <div class="field"><label>Email <span class="muted">{{ f.ca === 'zerossl' ? '(needed)' : '(optional)' }}</span></label><input v-model="f.email" placeholder="you@example.com"><span class="hint">Expiry warnings from the provider</span></div>
          <div class="field"><label>Check</label><select v-model="f.challenge"><option value="dns" :disabled="!scan.cloudflare && !f.token">DNS (Cloudflare)</option><option value="http">http (nginx)</option></select></div>
        </div>
        <div v-if="f.challenge === 'dns'" class="field"><label>Cloudflare API token for renewals <span class="muted">(optional)</span></label><input v-model="f.token" type="password" class="code" autocomplete="off" placeholder="Leave empty to use Switchboard's Cloudflare token">
          <span class="hint">Saved on each server (/root/.acme.sh) so it can renew. Safest: a token with only "Zone · DNS · Edit". Works on standby servers too.</span></div>
        <div v-else class="hint text-amber">The http check only works on the server the domain points to right now (the live one) and needs port 80 open. Standby servers: use the DNS check.</div>
      </template>

      <label v-if="scan.cloudflare && f.method !== 'own'" class="check"><input type="checkbox" v-model="f.strict"><span class="check-text"><b>Then switch Cloudflare SSL to Full (strict)</b><span class="hint">Only if every proxied hostname of the zone passes the check — otherwise it stays as it is.</span></span></label>
      <div class="row gap-8"><button class="btn btn-primary btn-sm" @click="start" :disabled="!ready">Set up SSL on {{ picked.length }} server{{ picked.length === 1 ? '' : 's' }}</button>
        <span class="muted small">Then press "Scan again" to see the result.</span></div>
    </div>
  </div>`,
};

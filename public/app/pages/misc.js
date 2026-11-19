import { ref, reactive, computed, watch, onMounted } from '/vendor/vue.js';
import { store, http, toast, confirmBox, runJob, fmtDate, JOB_TYPES } from '../lib.js';
import { JobsTable, EventsList, JobLog } from '../components.js';
import { DeployLive } from '../deployview.js';

/* ------------------------------------------------------------------ jobs */
export const JobsPage = {
  components: { JobsTable },
  setup() {
    const jobs = ref(null);
    const status = ref('');
    const load = async () => (jobs.value = await http.get(`/jobs?limit=200${status.value ? `&status=${status.value}` : ''}`).catch(() => []));
    onMounted(load);
    watch(status, load);
    watch(() => store.jobsLive, load);
    return { jobs, status };
  },
  template: `
  <div>
    <div class="page-head"><div><h1>Jobs</h1><div class="sub">Everything Switchboard ran on your servers, with full logs.</div></div>
      <div class="actions"><div class="seg"><button v-for="s in ['', 'running', 'failed', 'success']" :key="s" :class="{ on: status === s }" @click="status = s">{{ s || 'All' }}</button></div></div></div>
    <jobs-table :jobs="jobs || []" />
  </div>`,
};

export const JobPage = {
  props: { id: Number },
  components: { JobLog, DeployLive },
  setup(props) {
    const progress = ref(null);
    const status = ref(null);
    watch(() => props.id, () => ((progress.value = null), (status.value = null)));
    return { progress, status };
  },
  template: `
  <div>
    <div class="page-head"><div><div class="crumbs"><a href="#/jobs">Jobs</a> / #{{ id }}</div><h1>Job #{{ id }}</h1></div></div>
    <deploy-live v-if="progress && progress.kind === 'deploy'" :progress="progress" :status="status" />
    <job-log :job-id="id" :key="id" tall @progress="(p) => (progress = p)" @status="(s) => (status = s)" />
  </div>`,
};

/* ------------------------------------------------------------------ activity */
export const ActivityPage = {
  components: { EventsList },
  setup() {
    const events = ref([]);
    const level = ref('');
    const more = ref(true);
    async function load(reset = true) {
      const before = !reset && events.value.length ? `&before=${events.value[events.value.length - 1].id}` : '';
      const rows = await http.get(`/events?limit=100${level.value ? `&level=${level.value}` : ''}${before}`).catch(() => []);
      events.value = reset ? rows : [...events.value, ...rows];
      more.value = rows.length === 100;
    }
    onMounted(load);
    watch(level, () => load());
    watch(() => store.jobsLive, () => load());
    return { events, level, more, load };
  },
  template: `
  <div>
    <div class="page-head"><div><h1>Activity</h1><div class="sub">Audit log: who did what, alerts, failovers.</div></div>
      <div class="actions"><div class="seg"><button v-for="l in ['', 'error', 'warn', 'success', 'info']" :key="l" :class="{ on: level === l }" @click="level = l">{{ l || 'All' }}</button></div></div></div>
    <events-list :events="events" />
    <div class="mt-12" v-if="more && events.length"><button class="btn btn-sm" @click="load(false)">Load more</button></div>
  </div>`,
};

/* ------------------------------------------------------------------ settings */
export const SettingsPage = {
  setup() {
    const s = ref(null);
    const f = reactive({});
    const saving = ref(false);
    const cfTest = ref(null);
    const nTest = ref(null);
    const users = ref([]);
    const roles = ref([]);
    const isAdmin = computed(() => store.user?.role === 'admin');
    const newUser = reactive({ username: '', password: '', role: 'developer' });
    const pw = reactive({ current: '', password: '', confirm: '' });
    const totp = ref(null);
    const totpCode = ref('');
    const totpOffPw = ref('');
    async function load() {
      s.value = await http.get('/settings');
      Object.assign(f, s.value, { cf_token: '', telegram_token: '', webhook_url: '', github_token: '', s3_access_key: '', s3_secret_key: '' });
      http.get('/settings/s3/status').then((x) => (s3Stat.value = x)).catch(() => {});
      store.settings = s.value;
      if (isAdmin.value) {
        const u = await http.get('/users').catch(() => ({ users: [], roles: [] }));
        users.value = u.users;
        roles.value = u.roles;
      }
    }
    onMounted(load);
    async function save() {
      saving.value = true;
      try {
        s.value = await http.put('/settings', f);
        Object.assign(f, { cf_token: '', telegram_token: '', webhook_url: '', github_token: '', s3_access_key: '', s3_secret_key: '' });
        await load();
        toast('Settings saved', 'success');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        saving.value = false;
      }
    }
    async function clearSecret(key) {
      if (!(await confirmBox({ title: 'Remove this secret?', confirmText: 'Remove', danger: true }))) return;
      await http.put('/settings', { [`clear_${key}`]: true }).catch((e) => toast(e.message, 'error'));
      load();
    }
    async function testCf() {
      cfTest.value = { loading: true };
      cfTest.value = await http.post('/settings/cloudflare/test', { token: f.cf_token }).catch((e) => ({ ok: false, error: e.message }));
    }
    const s3Test = ref(null);
    const s3Stat = ref(null);
    async function testS3() {
      s3Test.value = { loading: true };
      s3Test.value = await http.post('/settings/s3/test', f).catch((e) => ({ ok: false, error: e.message }));
    }
    const uploadAll = () => runJob(http.post('/settings/s3/upload-all'));
    const ghTest = ref(null);
    async function testGh() {
      ghTest.value = { loading: true };
      ghTest.value = await http.post('/settings/github/test', { token: f.github_token }).catch((e) => ({ ok: false, error: e.message }));
    }
    const tgChats = ref(null);
    async function findChats() {
      tgChats.value = { loading: true };
      tgChats.value = await http.post('/settings/telegram/chats', { telegram_token: f.telegram_token }).catch((e) => ({ ok: false, error: e.message }));
      if (tgChats.value.ok && tgChats.value.chats.length === 1) f.telegram_chat_id = tgChats.value.chats[0].id;
    }
    const JOB_CHOICES = [
      ['deploy', 'Deploy (also auto-deploy from GitHub)'], ['switch', 'Switch server'], ['sync', 'Copy data'], ['backup', 'Backup'], ['restore', 'Restore'],
      ['clone', 'Clone server'], ['project-copy', 'Copy project'], ['os-upgrade', 'Upgrade OS'], ['server-reset', 'Reset server'], ['server-reinstall', 'Reinstall OS'], ['server-cleanup', 'Clean up server'],
      ['provision', 'Template setup'], ['staging-data', 'Copy to staging'], ['remove-deployment', 'Remove from server'], ['project-delete', 'Delete project'],
      ['container', 'Container start/stop/delete'], ['command', 'Command'], ['maintenance', 'Maintenance on/off'], ['port-change', 'Port change'], ['domain-connect', 'Connect domain'], ['power', 'Restart / turn off server'],
    ];
    async function testNotify() {
      nTest.value = { loading: true };
      nTest.value = await http.post('/settings/notify/test', { telegram_token: f.telegram_token, telegram_chat_id: f.telegram_chat_id, webhook_url: f.webhook_url }).catch((e) => ({ ok: false, error: e.message }));
    }
    async function addUser() {
      try {
        await http.post('/users', newUser);
        Object.assign(newUser, { username: '', password: '', role: 'developer' });
        toast('User added', 'success');
        load();
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    async function setRole(u, role) {
      try {
        await http.put(`/users/${u.id}`, { role });
        toast(`${u.username} is now ${role}`, 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      load();
    }
    async function delUser(u) {
      if (!(await confirmBox({ title: `Delete user ${u.username}?`, confirmText: 'Delete', danger: true }))) return;
      await http.del(`/users/${u.id}`).catch((e) => toast(e.message, 'error'));
      load();
    }
    async function changePw() {
      if (pw.password !== pw.confirm) return toast('New passwords do not match', 'error');
      try {
        await http.post('/account/password', pw);
        Object.assign(pw, { current: '', password: '', confirm: '' });
        toast('Password changed — other sessions were logged out', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    async function startTotp() {
      totp.value = await http.post('/account/totp/setup').catch((e) => toast(e.message, 'error'));
    }
    async function enableTotp() {
      try {
        await http.post('/account/totp/enable', { secret: totp.value.secret, code: totpCode.value });
        totp.value = null;
        totpCode.value = '';
        store.user.totp = true;
        toast('Two-factor login is on', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    async function disableTotp() {
      try {
        await http.post('/account/totp/disable', { password: totpOffPw.value });
        totpOffPw.value = '';
        store.user.totp = false;
        toast('Two-factor login is off', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    return { s, f, saving, save, clearSecret, cfTest, testCf, ghTest, testGh, s3Test, s3Stat, testS3, uploadAll, nTest, testNotify, tgChats, findChats, JOB_CHOICES, users, roles, isAdmin, setRole, newUser, addUser, delUser, pw, changePw, totp, totpCode, startTotp, enableTotp, totpOffPw, disableTotp, store, fmtDate };
  },
  template: `
  <div v-if="!s" class="muted">Loading…</div>
  <div v-else>
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Cloudflare, alerts, monitoring and your account.</div></div></div>
    <div class="settings-grid">
      <nav class="settings-nav">
        <a v-if="isAdmin" class="nav-link" href="#cf" @click.prevent="$refs.cf.scrollIntoView({ behavior: 'smooth' })">Cloudflare</a>
        <a v-if="isAdmin" class="nav-link" href="#github" @click.prevent="$refs.github.scrollIntoView({ behavior: 'smooth' })">GitHub</a>
        <a v-if="isAdmin" class="nav-link" href="#s3" @click.prevent="$refs.s3.scrollIntoView({ behavior: 'smooth' })">Backup storage</a>
        <a v-if="isAdmin" class="nav-link" href="#notify" @click.prevent="$refs.notify.scrollIntoView({ behavior: 'smooth' })">Alerts</a>
        <a v-if="isAdmin" class="nav-link" href="#mon" @click.prevent="$refs.mon.scrollIntoView({ behavior: 'smooth' })">Monitoring</a>
        <a class="nav-link" href="#acct" @click.prevent="$refs.acct.scrollIntoView({ behavior: 'smooth' })">Account & users</a>
      </nav>
      <div class="stack">
        <div v-if="!isAdmin" class="alert alert-info"><span class="alert-icon">ℹ</span><span>You are logged in as <b>{{ store.user.role }}</b>. Only admins can change these settings.</span></div>
        <template v-if="isAdmin">
        <div class="card card-body form" ref="cf">
          <h3>Cloudflare</h3>
          <p class="hint" style="margin:0">Create a token at <b>Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit zone DNS"</b> template. Permissions: <b>Zone · DNS · Edit</b> and <b>Zone · Zone · Read</b> (add <b>Zone · Cache Purge · Purge</b> if you want cache purging). Limit it to the zones you use.</p>
          <div class="field"><label>API token</label>
            <div class="row gap-8"><input v-model="f.cf_token" type="password" autocomplete="off" class="code" :placeholder="s.has_cf_token ? 'saved (' + s.cf_token_hint + ') — paste a new one to replace' : 'paste token'">
              <button class="btn" @click="testCf">Test</button><button v-if="s.has_cf_token" class="btn btn-ghost" @click="clearSecret('cf_token')">Remove</button></div></div>
          <div v-if="cfTest && !cfTest.loading" class="result" :class="cfTest.ok ? 'ok' : 'err'">{{ cfTest.ok ? '✔ Token works — ' + cfTest.zones + ' zone(s): ' + cfTest.names.join(', ') : '✖ ' + cfTest.error }}</div>
        </div>

        <div class="card card-body form" ref="github">
          <h3>GitHub (CI/CD)</h3>
          <p class="hint" style="margin:0">Used to create repositories, add deploy keys, register the self-hosted runners, commit the workflow file and read the results. Create a token at <b>GitHub → Settings → Developer settings → Personal access tokens</b>: a <b>classic</b> token with the <code>repo</code> and <code>workflow</code> scopes (add <code>admin:org</code> → <code>write:org</code> only to create repos in an organization), or a <b>fine-grained</b> token with <b>Administration, Contents, Workflows, Actions</b> (read and write) and <b>Pull requests</b> (read) on your repositories.</p>
          <div class="field"><label>Token</label>
            <div class="row gap-8"><input v-model="f.github_token" type="password" autocomplete="off" class="code" :placeholder="s.has_github_token ? 'saved (' + s.github_token_hint + ') — paste a new one to replace' : 'ghp_… or github_pat_…'">
              <button class="btn" @click="testGh">Test</button><button v-if="s.has_github_token" class="btn btn-ghost" @click="clearSecret('github_token')">Remove</button></div></div>
          <div v-if="ghTest && !ghTest.loading" class="result" :class="ghTest.ok ? 'ok' : 'err'">{{ ghTest.ok ? '✔ Token works — signed in as ' + ghTest.login : '✖ ' + ghTest.error }}</div>
          <div><button class="btn btn-primary" @click="save" :disabled="saving">Save</button></div>
        </div>

        <div class="card card-body form" ref="s3">
          <div class="row between wrap gap-8"><h3>Backup storage (S3)</h3><span v-if="s.s3_enabled" class="badge badge-green">ON</span><span v-else class="badge badge-gray">off — backups stay on this machine</span></div>
          <p class="hint" style="margin:0">Every backup (manual, scheduled, and the safety copies made before a copy or restore) is uploaded to your bucket right after it is made. Restore and Download fetch it back automatically. Works with any S3-compatible storage (AWS, MinIO, Wasabi, R2, DigitalOcean Spaces…).</p>
          <label class="check"><input type="checkbox" :checked="!!f.s3_enabled" @change="f.s3_enabled = $event.target.checked ? 1 : 0"><span class="check-text"><b>Store backups in S3</b></span></label>
          <div class="form-row">
            <div class="field"><label>Endpoint</label><input v-model="f.s3_endpoint" class="code" placeholder="https://storage.example.com"></div>
            <div class="field"><label>Bucket</label><input v-model="f.s3_bucket" class="code" placeholder="my-bucket"></div>
          </div>
          <div class="form-row">
            <div class="field"><label>Access key</label><input v-model="f.s3_access_key" type="password" autocomplete="off" class="code" :placeholder="s.has_s3_access_key ? 'saved (' + s.s3_access_key_hint + ')' : 'S3_ACCESS_KEY'"></div>
            <div class="field"><label>Secret key</label><input v-model="f.s3_secret_key" type="password" autocomplete="off" class="code" :placeholder="s.has_s3_secret_key ? 'saved — paste a new one to replace' : 'S3_SECRET_KEY'"></div>
          </div>
          <div class="form-row-3">
            <div class="field"><label>Region</label><input v-model="f.s3_region" class="code" placeholder="us-east-1"></div>
            <div class="field"><label>Folder in the bucket</label><input v-model="f.s3_prefix" class="code" placeholder="switchboard-backups"></div>
            <div class="field"><label>Address style</label><select v-model.number="f.s3_path_style"><option :value="1">Path style (endpoint/bucket) — MinIO & most</option><option :value="0">Virtual host (bucket.endpoint) — AWS</option></select></div>
          </div>
          <label class="check"><input type="checkbox" :checked="!!f.s3_keep_local" @change="f.s3_keep_local = $event.target.checked ? 1 : 0"><span class="check-text"><b>Also keep a copy on this machine</b><span class="hint">Off = the local file is removed ~30 minutes after it is safely in S3.</span></span></label>
          <div class="row gap-8 wrap"><button class="btn" @click="testS3">Test</button><button class="btn btn-primary" @click="save" :disabled="saving">Save</button>
            <button class="btn btn-ghost" v-if="s.s3_enabled" @click="uploadAll">Upload existing backups</button>
            <button v-if="s.has_s3_secret_key" class="btn btn-ghost" @click="clearSecret('s3_secret_key')">Remove keys</button></div>
          <div v-if="s3Test && !s3Test.loading" class="result" :class="s3Test.ok ? 'ok' : 'err'">{{ s3Test.ok ? '✔ Wrote, read and deleted a test file in ' + s3Test.where : '✖ ' + s3Test.error }}</div>
          <div v-if="s3Stat && s3Stat.total" class="hint">{{ s3Stat.in_s3 || 0 }} of {{ s3Stat.total }} backups are in S3<template v-if="s3Stat.failed"> · <span class="text-red">{{ s3Stat.failed }} failed to upload (retried every 10 minutes)</span></template></div>
        </div>

        <div class="card card-body form" ref="notify">
          <h3>Alerts (Telegram / webhook)</h3>
          <p class="hint" style="margin:0">Get a message when a server goes down or comes back, after every switch, failover, failed backup, full disk, expiring SSL… Telegram: 1) talk to <b>@BotFather</b> → <code>/newbot</code> to get a token; 2) open your new bot and press <b>Start</b> (a bot can only message people who wrote to it first — for a group, add the bot to the group); 3) paste the token and click <b>Find my chat id</b>.</p>
          <div class="form-row">
            <div class="field"><label>Telegram bot token</label><input v-model="f.telegram_token" type="password" autocomplete="off" class="code" :placeholder="s.has_telegram_token ? 'saved (' + s.telegram_token_hint + ')' : '123456:ABC-DEF…'"></div>
            <div class="field"><label>Telegram chat id</label><div class="row gap-8"><input v-model="f.telegram_chat_id" class="code" placeholder="123456789"><button class="btn" @click="findChats" :disabled="tgChats && tgChats.loading"><span v-if="tgChats && tgChats.loading" class="spinner"></span>Find my chat id</button></div></div>
          </div>
          <div v-if="tgChats && !tgChats.loading">
            <div v-if="!tgChats.ok" class="result err">✖ {{ tgChats.error }}</div>
            <div v-else-if="!tgChats.chats.length" class="alert alert-warn"><span class="alert-icon">⚠</span><span>No one has written to <b>@{{ tgChats.bot }}</b> in the last 24 hours. Open <a :href="'https://t.me/' + tgChats.bot" target="_blank" rel="noopener">t.me/{{ tgChats.bot }}</a>, press <b>Start</b> (or send any message; for a group, add the bot and send a message there), then click <b>Find my chat id</b> again.</span></div>
            <div v-else class="small">Chats that wrote to <b>@{{ tgChats.bot }}</b> — click one to use it:
              <div class="row gap-8 wrap mt-8"><button v-for="c in tgChats.chats" :key="c.id" class="btn btn-sm" :class="f.telegram_chat_id === c.id ? 'btn-primary' : ''" @click="f.telegram_chat_id = c.id">{{ c.name }} <span class="muted mono">{{ c.id }}</span> <span class="muted">({{ c.type }})</span></button></div>
            </div>
          </div>
          <div class="field"><label>Webhook URL <span class="muted">(Discord, Slack or any URL that accepts JSON)</span></label>
            <div class="row gap-8"><input v-model="f.webhook_url" type="password" autocomplete="off" class="code" :placeholder="s.has_webhook_url ? 'saved (' + s.webhook_url_hint + ')' : 'https://discord.com/api/webhooks/…'"><button v-if="s.has_webhook_url" class="btn btn-ghost" @click="clearSecret('webhook_url')">Remove</button></div></div>
          <div class="field"><label>Dashboard address <span class="muted">(optional, adds a link to alerts)</span></label><input v-model="f.dashboard_url" class="code" placeholder="https://ops.example.com"></div>
          <div class="field"><label>Message me when these jobs finish <span class="muted">(with the result and how long it took; save to apply)</span></label>
            <div class="row gap-8 wrap"><label v-for="j in JOB_CHOICES" :key="j[0]" class="check" style="min-width:210px"><input type="checkbox" :value="j[0]" v-model="f.notify_jobs"><span class="check-text">{{ j[1] }}</span></label></div>
            <label class="check mt-8"><input type="checkbox" v-model="f.notify_jobs_failed_only" :true-value="1" :false-value="0"><span class="check-text">Only when the job fails or is cancelled</span></label>
            <span class="hint">Failed deploys, clones, backups… already send an alert; you get one message per job, never two.</span>
          </div>
          <div class="field"><label>Payment reminders <span class="muted">(servers with billing info — see <a href="#/billing">Billing</a>)</span></label>
            <label class="check"><input type="checkbox" :checked="!!f.billing_reminders" @change="f.billing_reminders = $event.target.checked ? 1 : 0"><span class="check-text"><b>Message me before a server payment is due</b></span></label>
            <div class="form-row-3 mt-8">
              <div class="field"><label>Days before the due date</label><input v-model="f.billing_remind_days" class="code" placeholder="7,3,1,0"><span class="hint">One message on each of these days (0 = the due day).</span></div>
              <div class="field"><label>Not before (hour, 0–23)</label><input type="number" min="0" max="23" v-model.number="f.billing_remind_hour"><span class="hint">So reminders don't arrive at night.</span></div>
              <div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" :checked="!!f.billing_overdue_daily" @change="f.billing_overdue_daily = $event.target.checked ? 1 : 0"><span class="check-text">Remind every day while overdue</span></label></div>
            </div>
          </div>
          <div class="row gap-8"><button class="btn btn-primary" @click="save" :disabled="saving">Save</button><button class="btn" @click="testNotify">Send test message</button><button v-if="s.has_telegram_token" class="btn btn-ghost" @click="clearSecret('telegram_token')">Remove Telegram token</button></div>
          <div v-if="nTest && !nTest.loading" class="result" :class="nTest.ok ? 'ok' : 'err'">{{ nTest.ok ? '✔ Sent via ' + nTest.sent.join(' + ') : '✖ ' + (nTest.error || nTest.errors.join('; ')) }}</div>
        </div>

        <div class="card card-body form" ref="mon">
          <h3>Monitoring</h3>
          <div class="form-row-3">
            <div class="field"><label>Health check every (s)</label><input type="number" v-model.number="f.check_interval"></div>
            <div class="field"><label>Health check timeout (s)</label><input type="number" v-model.number="f.check_timeout"></div>
            <div class="field"><label>Server stats every (s)</label><input type="number" v-model.number="f.metrics_interval"></div>
          </div>
          <div class="form-row-3">
            <div class="field"><label>DNS drift check every (s)</label><input type="number" v-model.number="f.dns_interval"></div>
            <div class="field"><label>Disk alert at (%)</label><input type="number" v-model.number="f.disk_alert_pct"></div>
            <div class="field"><label>SSL alert (days before expiry)</label><input type="number" v-model.number="f.ssl_alert_days"></div>
          </div>
          <div class="form-row-3">
            <div class="field"><label>Busy server: CPU at (%)</label><input type="number" v-model.number="f.busy_cpu_pct"></div>
            <div class="field"><label>…or memory at (%)</label><input type="number" v-model.number="f.busy_mem_pct"></div>
            <div class="field"><label>…for at least (minutes)</label><input type="number" v-model.number="f.busy_minutes"><span class="hint">Then you get an alert to add a server to the load balancer.</span></div>
          </div>
          <div class="fieldset-title mt-8">Traffic &amp; unusual activity <span class="muted small">(read from nginx access logs every minute)</span></div>
          <label class="check"><input type="checkbox" :checked="!!f.traffic_enabled" @change="f.traffic_enabled = $event.target.checked ? 1 : 0"><span class="check-text"><b>Collect traffic and alert on unusual activity</b></span></label>
          <div class="form-row-3">
            <div class="field"><label>Spike: × usual requests/min</label><input type="number" v-model.number="f.traffic_spike_x"></div>
            <div class="field"><label>…and at least (req/min)</label><input type="number" v-model.number="f.traffic_min_rpm"></div>
            <div class="field"><label>Server errors (5xx) above (%)</label><input type="number" v-model.number="f.traffic_5xx_pct"></div>
          </div>
          <div class="form-row-3">
            <div class="field"><label>One IP makes more than (%)</label><input type="number" v-model.number="f.traffic_ip_pct"></div>
            <div class="field"><label>Failed SSH logins in 5 min</label><input type="number" v-model.number="f.traffic_ssh_fails"></div>
          </div>
          <div class="form-row-3">
            <div class="field"><label>Warn when standby data is older than (h)</label><input type="number" v-model.number="f.stale_alert_hours"></div>
            <div class="field"><label>Keep health history (days)</label><input type="number" v-model.number="f.history_days"></div>
          </div>
        </div>
        <div><button class="btn btn-primary" @click="save" :disabled="saving">Save settings</button></div>
        </template>

        <div class="card card-body form" ref="acct">
          <h3>Your account — {{ store.user.username }}</h3>
          <div class="form-row-3">
            <div class="field"><label>Current password</label><input v-model="pw.current" type="password" autocomplete="current-password"></div>
            <div class="field"><label>New password</label><input v-model="pw.password" type="password" autocomplete="new-password"></div>
            <div class="field"><label>Repeat new password</label><input v-model="pw.confirm" type="password" autocomplete="new-password"></div>
          </div>
          <div><button class="btn" @click="changePw" :disabled="!pw.current || !pw.password">Change password</button></div>
          <hr>
          <div class="fieldset-title">Two-factor login (authenticator app)</div>
          <template v-if="store.user.totp">
            <div class="result ok">✔ On. You need a code from your authenticator app to log in.</div>
            <div class="row gap-8"><input v-model="totpOffPw" type="password" placeholder="your password" style="max-width:240px"><button class="btn btn-danger" @click="disableTotp" :disabled="!totpOffPw">Turn off</button></div>
          </template>
          <template v-else-if="totp">
            <div class="row gap-16 wrap" style="align-items:flex-start">
              <img :src="totp.qr" class="qr" alt="QR code">
              <div class="stack" style="gap:8px;max-width:360px">
                <div class="hint">Scan with Google Authenticator, Authy, 1Password… or type this key:</div>
                <code style="word-break:break-all">{{ totp.secret }}</code>
                <div class="field"><label>6-digit code from the app</label><input v-model="totpCode" class="code" inputmode="numeric" maxlength="6" @keydown.enter="enableTotp"></div>
                <div><button class="btn btn-primary" @click="enableTotp" :disabled="totpCode.length !== 6">Turn on</button></div>
              </div>
            </div>
          </template>
          <div v-else class="row between wrap gap-8"><span class="hint">Strongly recommended: this dashboard can control all your servers.</span><button class="btn" @click="startTotp">Set up 2FA</button></div>
        </div>

        <div class="card" v-if="isAdmin">
          <div class="card-head"><h3>Users</h3></div>
          <div class="hint" style="padding:0 18px 10px"><template v-for="r in roles" :key="r.id"><b>{{ r.id }}</b>: {{ r.info }}<br></template></div>
          <div class="table-wrap"><table class="table"><tbody>
            <tr v-for="u in users" :key="u.id"><td class="strong">{{ u.username }} <span v-if="u.me" class="badge">you</span></td>
              <td><select :value="u.role" @change="setRole(u, $event.target.value)" :disabled="u.me" style="max-width:140px"><option v-for="r in roles" :key="r.id" :value="r.id">{{ r.id }}</option></select></td>
              <td><span class="badge" :class="u.totp ? 'badge-green' : 'badge-gray'">2FA {{ u.totp ? 'on' : 'off' }}</span></td>
              <td class="small muted">last login {{ u.last_login_at ? fmtDate(u.last_login_at) : 'never' }}</td><td class="actions"><button v-if="!u.me" class="btn btn-xs btn-danger" @click="delUser(u)">Delete</button></td></tr>
          </tbody></table></div>
          <div class="card-body row gap-8 wrap" style="border-top:1px solid var(--border)">
            <input v-model="newUser.username" placeholder="username" style="max-width:200px"><input v-model="newUser.password" type="password" placeholder="password (10+ chars)" autocomplete="new-password" style="max-width:220px">
            <select v-model="newUser.role" style="max-width:140px"><option v-for="r in roles" :key="r.id" :value="r.id">{{ r.id }}</option></select>
            <button class="btn" @click="addUser" :disabled="!newUser.username || !newUser.password">Add user</button>
          </div>
        </div>
        <div class="muted small">Switchboard {{ s.info.version }} · data in <span class="mono">{{ s.info.data_dir }}</span></div>
      </div>
    </div>
  </div>`,
};

/* ------------------------------------------------------------------ login & first-time setup */
export const AuthPage = {
  setup() {
    const f = reactive({ username: '', password: '', totp: '', code: '', confirm: '' });
    const needTotp = ref(false);
    const busy = ref(false);
    const error = ref('');
    async function submit() {
      error.value = '';
      busy.value = true;
      try {
        if (store.setupRequired) {
          if (f.password !== f.confirm) throw new Error('Passwords do not match');
          await http.post('/auth/setup', { code: f.code, username: f.username, password: f.password });
        } else {
          const r = await http.post('/auth/login', { username: f.username, password: f.password, totp: f.totp });
          if (r.needTotp) {
            needTotp.value = true;
            busy.value = false;
            return;
          }
        }
        location.reload();
      } catch (e) {
        error.value = e.message;
      } finally {
        busy.value = false;
      }
    }
    return { f, needTotp, busy, error, submit, store };
  },
  template: `
  <div class="auth-wrap">
    <form class="card auth-card form" @submit.prevent="submit">
      <div class="brand"><span class="brand-logo">⇄</span><span>Switchboard<small>server switch & failover</small></span></div>
      <template v-if="store.setupRequired">
        <h2>First-time setup</h2>
        <p class="hint" style="margin:0">Enter the setup code printed in the Switchboard logs (<code>docker logs switchboard</code>), then create your admin account.</p>
        <div class="field"><label>Setup code</label><input v-model="f.code" class="code" placeholder="XXXX-XXXX" autocomplete="off"></div>
        <div class="field"><label>Username</label><input v-model="f.username" autocomplete="username"></div>
        <div class="field"><label>Password <span class="muted">(10+ characters)</span></label><input v-model="f.password" type="password" autocomplete="new-password"></div>
        <div class="field"><label>Repeat password</label><input v-model="f.confirm" type="password" autocomplete="new-password"></div>
      </template>
      <template v-else>
        <h2>Log in</h2>
        <div class="field"><label>Username</label><input v-model="f.username" autocomplete="username" :disabled="needTotp"></div>
        <div class="field"><label>Password</label><input v-model="f.password" type="password" autocomplete="current-password" :disabled="needTotp"></div>
        <div class="field" v-if="needTotp"><label>6-digit code from your authenticator app</label><input v-model="f.totp" class="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" autofocus></div>
      </template>
      <div v-if="error" class="result err">{{ error }}</div>
      <button class="btn btn-primary" type="submit" :disabled="busy">{{ store.setupRequired ? 'Create admin account' : needTotp ? 'Verify' : 'Log in' }}</button>
    </form>
  </div>`,
};

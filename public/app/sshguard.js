import { ref, reactive, computed, onMounted } from '/vendor/vue.js';
import { http, toast, closeDialog, showJob, confirmBox } from './lib.js';
import { Modal } from './components.js';

/* ------------------------------------------------------------------ protect SSH (fail2ban, password login off) */
export const SshGuardDialog = {
  props: { server: Object },
  components: { Modal },
  setup(props) {
    const s = props.server;
    const plan = ref(null);
    const scanError = ref('');
    const busy = ref(false);
    const f = reactive({ fail2ban: true, maxretry: 5, bantime: 60, passwords_off: false, confirm_keys: false, ignore: '' });
    async function scan() {
      scanError.value = '';
      try {
        const r = await http.post(`/servers/${s.id}/ssh-guard/preview`, {});
        if (!r.ok) return (scanError.value = r.error);
        plan.value = r.plan;
        const st = r.plan.state || {};
        if (st.maxretry) f.maxretry = st.maxretry;
        if (st.bantime) f.bantime = st.bantime;
      } catch (e) {
        scanError.value = e.message;
      }
    }
    onMounted(scan);
    const p = computed(() => plan.value);
    const protectedAlready = computed(() => p.value && (p.value.guard.jail || p.value.guard.passwords));
    async function run(remove = false) {
      if (remove && !(await confirmBox({ title: 'Remove SSH protection?', message: 'Switchboard\'s fail2ban rule is removed and password login goes back to the server\'s own setting.', confirmText: 'Remove', danger: true }))) return;
      busy.value = true;
      try {
        const body = remove ? { remove: true } : { ...f, ignore: f.ignore.split(/[\s,]+/).filter(Boolean) };
        const r = await http.post(`/servers/${s.id}/ssh-guard`, body);
        closeDialog();
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    async function unban(ip) {
      try {
        await http.post(`/servers/${s.id}/ssh-guard/unban`, { ip });
        toast(`${ip} unblocked`, 'success');
        scan();
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    const ok = computed(() => (f.fail2ban || f.passwords_off) && (!f.passwords_off || f.confirm_keys));
    return { s, p, f, scanError, busy, ok, protectedAlready, run, unban, closeDialog };
  },
  template: `
  <modal :title="'Protect SSH — ' + s.name" size="md" @close="closeDialog">
    <div v-if="scanError" class="result err">✖ {{ scanError }}</div>
    <div v-else-if="!p" class="muted"><span class="spinner"></span> Checking SSH on {{ s.name }}…</div>
    <div v-else class="form">
      <div class="kv">
        <div><span>Password login</span><span :class="p.sshd.password ? 'text-amber' : 'text-green'">{{ p.sshd.password === null ? 'unknown' : p.sshd.password ? 'ON — passwords can be guessed' : 'OFF — keys only ✓' }}</span></div>
        <div><span>fail2ban</span><span :class="p.fail2ban.running ? 'text-green' : 'text-amber'">{{ p.fail2ban.running ? 'on — ' + p.fail2ban.currently + ' IP' + (p.fail2ban.currently === 1 ? '' : 's') + ' blocked now, ' + p.fail2ban.total + ' in total' : p.fail2ban.installed ? 'installed, no SSH rule' : 'not installed' }}</span></div>
        <div><span>Failed logins (recent)</span><span>{{ p.fails.count }} from {{ p.fails.ips }} IP{{ p.fails.ips === 1 ? '' : 's' }}<template v-if="p.fails.top.length"> · most: <span class="mono">{{ p.fails.top.slice(0, 3).map((x) => x.ip + ' (' + x.n + ')').join(', ') }}</span></template></span></div>
        <div><span>SSH keys on the server</span><span>{{ p.keys.reduce((a, k) => a + k.n, 0) || 'none' }}<span class="muted" v-if="p.keys.length"> ({{ p.keys.map((k) => k.file.replace('/.ssh/authorized_keys', '') + ': ' + k.n).join(', ') }})</span></span></div>
        <div><span>Switchboard logs in with</span><span>{{ p.switchboard_auth === 'password' ? 'a password' : 'an SSH key' }}<span class="muted" v-if="p.switchboard_ip"> from {{ p.switchboard_ip }}</span></span></div>
      </div>

      <div v-if="p.fail2ban.banned.length" class="small">Blocked now:
        <span v-for="ip in p.fail2ban.banned.slice(0, 30)" :key="ip" class="badge badge-gray" style="margin:2px">{{ ip }} <button class="link-btn tiny" title="Unblock" @click="unban(ip)">✕</button></span>
      </div>

      <label class="check"><input type="checkbox" v-model="f.fail2ban"><span class="check-text"><b>Block IPs that keep guessing (fail2ban)</b><span class="hint">After {{ f.maxretry }} wrong tries in 10 minutes an IP is blocked for {{ f.bantime }} minutes — longer each time it comes back (up to a week). Installed for you if missing.</span></span></label>
      <div v-if="f.fail2ban" class="form-row-3" style="margin-left:26px">
        <div class="field"><label>Wrong tries allowed</label><input type="number" min="2" max="20" v-model.number="f.maxretry"></div>
        <div class="field"><label>Block for (minutes)</label><input type="number" min="5" v-model.number="f.bantime"></div>
      </div>
      <div v-if="f.fail2ban" class="field" style="margin-left:26px"><label>Never block these IPs <span class="muted">(optional — e.g. your office or home IP)</span></label>
        <input v-model="f.ignore" class="code" placeholder="203.0.113.5 198.51.100.0/24">
        <span class="hint">Switchboard ({{ p.switchboard_ip || 'its own IP' }}) and all your servers in Switchboard are never blocked anyway. Your own IP: run <code>curl -4 ifconfig.me</code> on your computer.</span></div>

      <label class="check" :class="{ disabled: !p.can_disable_passwords }"><input type="checkbox" v-model="f.passwords_off" :disabled="!p.can_disable_passwords || p.sshd.password === false"><span class="check-text"><b>Turn off password login (SSH keys only)</b>
        <span class="hint" v-if="p.sshd.password === false">Already off.</span>
        <span class="hint" v-else-if="!p.can_disable_passwords">Switchboard logs in to this server with a password — switch it to an SSH key first (Edit server).</span>
        <span class="hint" v-else>The real fix: guessing passwords becomes useless. Switchboard checks it can still log in afterwards and puts the old setting back if not.</span></span></label>
      <div v-if="f.passwords_off" class="alert alert-warn" style="margin-left:26px"><span class="alert-icon">⚠</span><span>After this, <b>you</b> can only log in with an SSH key too — and so can anyone else (e.g. the provider's web console still works).
        <label class="check mt-8"><input type="checkbox" v-model="f.confirm_keys"><span class="check-text">I can log in to {{ s.name }} with an SSH key</span></label></span></div>
    </div>
    <template #footer>
      <button v-if="protectedAlready" class="btn btn-ghost btn-danger" :disabled="busy" @click="run(true)">Remove protection</button>
      <span class="grow"></span>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || !p || !ok" @click="run(false)">Protect SSH</button>
    </template>
  </modal>`,
};

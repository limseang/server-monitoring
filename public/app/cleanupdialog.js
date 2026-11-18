import { ref, reactive, computed, onMounted } from '/vendor/vue.js';
import { http, toast, closeDialog, showJob, bytes, fmtDate } from './lib.js';
import { Modal } from './components.js';

/* ------------------------------------------------------------------ clean up / free memory on a server */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SAFE = { buildCache: true, images: true, allImages: false, containers: true, networks: true, journal: true, apt: true, logs: true, laravel: false, dropCaches: false, swap: false };
const KEYS = Object.keys(SAFE);

/** "M H * * D" → { day, time } (only the simple weekly form the dialog writes). */
function parseWeekly(cron) {
  const m = String(cron || '').match(/^(\d{1,2}) (\d{1,2}) \* \* (\d)$/);
  return m ? { day: Number(m[3]), time: `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}` } : null;
}

export const CleanupDialog = {
  props: { server: Object },
  components: { Modal },
  setup(props) {
    const s = props.server;
    const f = reactive({ ...SAFE });
    const restart = reactive({});
    const plan = ref(null);
    const scanError = ref('');
    const scanning = ref(false);
    const busy = ref(false);
    const showLogs = ref(false);
    const sched = reactive({ on: false, day: 0, time: '04:00', cron: '', next: null, saving: false });

    async function scan() {
      scanning.value = true;
      scanError.value = '';
      try {
        const r = await http.post(`/servers/${s.id}/cleanup/preview`, {});
        if (!r.ok) return (scanError.value = r.error);
        plan.value = r.plan;
        // Nothing to clean → leave the box empty, so "Clean up now" only does what makes a difference.
        if (!r.plan.docker) Object.assign(f, { buildCache: false, images: false, allImages: false, containers: false, networks: false });
        if (r.plan.journal === null) f.journal = false;
        if (r.plan.apt === null) f.apt = false;
        if (!r.plan.canDropCaches) f.dropCaches = false;
        const sc = r.plan.schedule;
        sched.on = !!sc;
        sched.next = r.plan.next_run;
        if (sc) {
          const w = parseWeekly(sc.cron);
          if (w) Object.assign(sched, w);
          else sched.cron = sc.cron;
          for (const k of KEYS) f[k] = !!sc.options?.[k];
        }
      } catch (e) {
        scanError.value = e.message;
      } finally {
        scanning.value = false;
      }
    }
    onMounted(scan);

    const p = computed(() => plan.value);
    const removable = computed(() => (p.value?.stopped || []).filter((c) => !c.kept));
    const keptStopped = computed(() => (p.value?.stopped || []).filter((c) => c.kept));
    const picked = computed(() => Object.keys(restart).filter((k) => restart[k]));
    const body = () => ({ ...Object.fromEntries(KEYS.map((k) => [k, f[k]])), restart: picked.value });
    const anything = computed(() => KEYS.some((k) => f[k]) || picked.value.length > 0);
    /** Rough guess of what the ticked disk parts free (Docker numbers are its own estimates). */
    const estimate = computed(() => {
      const x = p.value;
      if (!x) return 0;
      let n = 0;
      if (f.buildCache) n += x.buildCache || 0;
      if (f.allImages) n += x.images.unused || 0;
      else if (f.images) n += x.images.danglingBytes || 0;
      if (f.apt) n += x.apt || 0;
      if (f.logs) n += x.logsTotal || 0;
      return n;
    });

    async function submit() {
      busy.value = true;
      try {
        const r = await http.post(`/servers/${s.id}/cleanup`, body());
        closeDialog();
        showJob(r.job.id);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }

    const cronText = computed(() => {
      if (sched.cron) return sched.cron;
      const [h, m] = String(sched.time || '04:00').split(':').map((v) => Number(v) || 0);
      return `${m} ${h} * * ${sched.day}`;
    });
    async function saveSchedule(on) {
      sched.saving = true;
      try {
        const opts = Object.fromEntries(KEYS.map((k) => [k, f[k]]));
        const r = await http.put(`/servers/${s.id}/cleanup/schedule`, on ? { cron: cronText.value, options: opts } : { cron: '' });
        sched.on = !!r.schedule;
        sched.next = r.next_run;
        if (!on) sched.cron = '';
        toast(on ? `Weekly cleanup saved — next run ${fmtDate(r.next_run)}` : 'Weekly cleanup turned off', 'success');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        sched.saving = false;
      }
    }

    return { s, f, p, restart, scan, scanError, scanning, busy, showLogs, removable, keptStopped, picked, anything, estimate, submit, sched, saveSchedule, DAYS, bytes, fmtDate, closeDialog };
  },
  template: `
  <modal :title="'Clean up ' + s.name" size="lg" @close="closeDialog">
    <div class="form">
      <p class="muted small" style="margin:0">Frees disk space and memory without touching your data: Docker <b>volumes</b> (databases) are never removed, and running containers keep running. Nothing happens until you press <b>Clean up now</b>.</p>
      <div class="row gap-8"><button class="btn" @click="scan" :disabled="scanning"><span v-if="scanning" class="spinner"></span>{{ p ? 'Look again' : 'Looking at the server…' }}</button><span class="muted small">Reads what can be freed. Changes nothing.</span></div>
      <div v-if="scanError" class="result err">{{ scanError }}</div>

      <template v-if="p">
        <div class="tiles" style="grid-template-columns:repeat(2,minmax(0,1fr))">
          <div class="tile"><div class="tile-label">Disk /</div><div class="strong mt-8">{{ p.disk ? p.disk.pct + '% full' : '—' }}</div><div class="tile-sub">{{ bytes(p.disk && p.disk.avail) }} free of {{ bytes(p.disk && p.disk.total) }}</div></div>
          <div class="tile"><div class="tile-label">Memory</div><div class="strong mt-8">{{ bytes(p.mem && p.mem.available) }} available</div><div class="tile-sub">of {{ bytes(p.mem && p.mem.total) }} · page cache {{ bytes(p.mem && p.mem.cached) }}<template v-if="p.mem && p.mem.swap_total"> · swap used {{ bytes(p.mem.swap_used) }} of {{ bytes(p.mem.swap_total) }}</template></div></div>
        </div>

        <div class="fieldset">
          <div class="fieldset-title">Docker <span v-if="!p.docker" class="muted small">— not installed</span></div>
          <template v-if="p.docker">
            <label class="check"><input type="checkbox" v-model="f.buildCache"><span class="check-text"><b>Build cache — {{ bytes(p.buildCache) }}</b><span class="hint">Left over from "docker build". Only makes the next build a bit slower.</span></span></label>
            <label class="check"><input type="checkbox" v-model="f.images" :disabled="f.allImages"><span class="check-text"><b>Dangling images — {{ p.images.dangling }} ({{ bytes(p.images.danglingBytes) }})</b><span class="hint">Old image layers without a name (replaced by a newer build or pull). Nothing uses them.</span></span></label>
            <label class="check"><input type="checkbox" v-model="f.containers"><span class="check-text"><b>Stopped containers — {{ removable.length }}</b>
              <span class="hint" v-if="removable.length">{{ removable.map((c) => c.name).join(', ') }}</span>
              <span class="hint" v-if="keptStopped.length">Kept (they belong to a Switchboard project): {{ keptStopped.map((c) => c.name).join(', ') }}</span>
              <span class="hint" v-if="!p.stopped.length">None.</span></span></label>
            <label class="check"><input type="checkbox" v-model="f.networks"><span class="check-text"><b>Unused networks — {{ p.networks }}</b><span class="hint">Docker networks no container uses. "docker compose up" makes them again when needed.</span></span></label>
            <label class="check"><input type="checkbox" v-model="f.allImages"><span class="check-text"><b>Extra: ALL unused images — {{ bytes(p.images.unused) }} ({{ p.images.total - p.images.active }} images)</b><span class="hint">Every image no container uses right now, also ones with a name. Frees the most, but older versions you might roll back to, and images of stopped apps, have to be downloaded or built again.</span></span></label>
            <div v-if="f.allImages" class="alert alert-warn"><span class="alert-icon">⚠</span><span>All unused images go, not only the dangling ones. A rollback to an older image or starting a stopped app will need to download or build it again.</span></div>
            <div class="muted small">Docker volumes (database data) are never removed.</div>
          </template>
        </div>

        <div class="fieldset">
          <div class="fieldset-title">System</div>
          <label class="check" :class="{ disabled: p.journal === null }"><input type="checkbox" v-model="f.journal" :disabled="p.journal === null"><span class="check-text"><b>Old system logs (journal) — {{ p.journal === null ? 'no journalctl' : bytes(p.journal) }}</b><span class="hint">Keeps the last 7 days (journalctl --vacuum-time=7d).</span></span></label>
          <label class="check" :class="{ disabled: p.apt === null }"><input type="checkbox" v-model="f.apt" :disabled="p.apt === null"><span class="check-text"><b>Downloaded packages (apt cache) — {{ p.apt === null ? 'no apt' : bytes(p.apt) }}</b><span class="hint">Installers kept after updates (apt-get clean). Installed software is not touched.</span></span></label>
          <label class="check"><input type="checkbox" v-model="f.logs"><span class="check-text"><b>Big log files — {{ p.logs.length }} file(s), {{ bytes(p.logsTotal) }}</b>
            <span class="hint">Files of {{ p.bigLogMb }} MB or more in /var/log, Docker container logs and your Laravel apps' storage/logs. They are <b>emptied, not deleted</b>, so the programs writing them keep working. <button v-if="p.logs.length" class="link-btn" @click.prevent="showLogs = !showLogs">{{ showLogs ? 'Hide' : 'Show' }} files</button></span></span></label>
          <div v-if="showLogs" class="card table-wrap"><table class="table"><tbody>
            <tr v-for="l in p.logs" :key="l.path"><td class="mono tiny">{{ l.path }}</td><td class="small" style="text-align:right">{{ bytes(l.size) }}</td></tr>
          </tbody></table></div>
        </div>

        <div class="fieldset">
          <div class="fieldset-title">Laravel apps on this server</div>
          <label class="check" :class="{ disabled: !p.laravel.length }"><input type="checkbox" v-model="f.laravel" :disabled="!p.laravel.length"><span class="check-text"><b>Clear Laravel caches</b>
            <span class="hint" v-if="p.laravel.length">php artisan optimize:clear in {{ p.laravel.map((a) => a.project + ' (' + a.where + ')').join(', ') }}. Apps that were optimized get "php artisan optimize" again right after, so they stay fast. Clears the app cache too (cache:clear).</span>
            <span class="hint" v-else>No Laravel app of a Switchboard project found here.</span></span></label>
        </div>

        <div class="fieldset">
          <div class="fieldset-title">Memory</div>
          <label class="check" :class="{ disabled: !p.canDropCaches }"><input type="checkbox" v-model="f.dropCaches" :disabled="!p.canDropCaches"><span class="check-text"><b>Drop the page cache — {{ bytes(p.mem && p.mem.cached) }}</b>
            <span class="hint">Honest note: this is Linux keeping recently read files in spare memory. It is given back by itself the moment an app needs it, and it fills up again soon. Dropping it rarely makes a server faster (the first requests after are a bit slower) — it only helps in special cases, e.g. to measure real memory use.<template v-if="!p.canDropCaches"> Not possible on this server.</template></span></span></label>
          <label v-if="p.mem && p.mem.swap_total" class="check"><input type="checkbox" v-model="f.swap"><span class="check-text"><b>Move swap back into memory — {{ bytes(p.mem.swap_used) }} in swap</b><span class="hint">Apps that were swapped out react slowly. Runs swapoff + swapon, only when enough memory is free.</span></span></label>
          <div v-if="p.top.length">
            <div class="label mb-8">Restart a container that uses too much memory (optional)</div>
            <div class="card table-wrap"><table class="table"><tbody>
              <tr v-for="c in p.top" :key="c.name">
                <td style="width:28px"><input type="checkbox" v-model="restart[c.name]" :disabled="c.self"></td>
                <td class="mono small">{{ c.name }} <span v-if="c.self" class="badge badge-gray">this dashboard</span></td>
                <td class="small" style="text-align:right">{{ bytes(c.mem) }} · {{ c.mem_pct }}%</td>
              </tr>
            </tbody></table></div>
            <div class="hint mt-8">A restart frees memory a program leaked. The app is offline for a few seconds while it restarts.</div>
          </div>
        </div>

        <div class="fieldset">
          <div class="fieldset-title">Weekly cleanup <span class="badge" :class="sched.on ? 'badge-green' : 'badge-gray'">{{ sched.on ? 'on' : 'off' }}</span></div>
          <div class="muted small">Runs the parts ticked above (never a container restart) by itself once a week.<template v-if="sched.on && sched.next"> Next run: {{ fmtDate(sched.next) }}.</template></div>
          <div v-if="sched.cron" class="field"><label>Schedule (cron)</label><input v-model="sched.cron" class="code"></div>
          <div v-else class="form-row">
            <div class="field"><label>Day</label><select v-model.number="sched.day"><option v-for="(d, i) in DAYS" :key="i" :value="i">{{ d }}</option></select></div>
            <div class="field"><label>Time (Switchboard's clock)</label><input type="time" v-model="sched.time"></div>
          </div>
          <div class="row gap-8">
            <button class="btn" @click="saveSchedule(true)" :disabled="sched.saving || !anything">{{ sched.on ? 'Save schedule' : 'Turn on weekly cleanup' }}</button>
            <button v-if="sched.on" class="btn btn-ghost" @click="saveSchedule(false)" :disabled="sched.saving">Turn off</button>
          </div>
        </div>
      </template>
    </div>
    <template #footer>
      <span v-if="p && estimate" class="muted small" style="margin-right:auto">About {{ bytes(estimate) }} of disk to free</span>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" @click="submit" :disabled="busy || !p || !anything">Clean up now</button>
    </template>
  </modal>`,
};

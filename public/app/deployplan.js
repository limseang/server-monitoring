import { ref, reactive, computed, watch, onMounted, nextTick } from '/vendor/vue.js';
import { http, toast, closeDialog, showJob, store } from './lib.js';

/*
 * Deploy plan: choose for each server whether it gets the new code now, later or not at all — so the live
 * server is not rebuilt while visitors use it. "Later" waits for a click (CI/CD tab → Deploy now) or a time.
 */

/** The next time it is HH:MM here (in this browser's time zone). */
export function nextAt(hhmm, from = new Date()) {
  const [h, m] = String(hhmm || '02:00').split(':').map(Number);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= from.getTime() + 30000) d.setDate(d.getDate() + 1);
  return d;
}
export function whenText(iso) {
  if (!iso) return 'when you click "Deploy now"';
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `today at ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} at ${time}`;
}

const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

export const DeployPlanDialog = {
  // commit: preselect one · rollback: preselect the commit before the one the live server has
  props: { projectId: Number, commit: String, rollback: Boolean },
  setup(props) {
    const p = ref(null);
    const quiet = ref('02:00');
    const code = ref(null); // { branch, commits, servers } — null while loading or without GitHub
    const codeError = ref('');
    const chosen = ref(''); // a commit sha; '' = the newest
    const liveFirst = ref(true);
    let defaults = {};
    const rows = reactive({}); // deployment id → { mode: now | later | skip, when: click | time, time: 'HH:MM' }
    const busy = ref(false);
    onMounted(async () => {
      try {
        const [proj, ci] = await Promise.all([http.get(`/projects/${props.projectId}`), http.get(`/projects/${props.projectId}/ci`).catch(() => null)]);
        if (ci?.quiet_time) quiet.value = ci.quiet_time;
        const several = proj.deployments.length > 1;
        for (const d of proj.deployments) {
          const live = d.id === proj.active_deployment_id;
          // The live server waits by default when another server can take the new code first.
          rows[d.id] = { mode: live && several ? 'later' : 'now', when: ci?.live_policy === 'quiet' ? 'time' : 'click', time: quiet.value };
        }
        defaults = JSON.parse(JSON.stringify(rows));
        p.value = proj;
        loadCode();
      } catch (e) {
        toast(e.message, 'error');
        closeDialog();
      }
    });
    async function loadCode() {
      try {
        code.value = await http.get(`/projects/${props.projectId}/commits`);
        const list = code.value.commits;
        if (props.commit && list.some((c) => c.sha.startsWith(props.commit))) chosen.value = list.find((c) => c.sha.startsWith(props.commit)).sha;
        else if (props.rollback) {
          // The commit before the one the live server runs (or the one before the newest).
          const liveSha = code.value.servers.find((x) => x.live)?.commit;
          const i = list.findIndex((c) => c.sha === liveSha);
          chosen.value = (list[(i >= 0 ? i : 0) + 1] || list[list.length - 1])?.sha || '';
        }
      } catch (e) {
        codeError.value = e.message;
      }
      // Start at the top of the list: the newest commit (and which servers run it) stays in sight.
      await nextTick();
      const box = document.querySelector('.dp-commits');
      if (box) box.scrollTop = 0;
    }
    const newest = computed(() => code.value?.commits[0]?.sha || '');
    const chosenCommit = computed(() => code.value?.commits.find((c) => c.sha === chosen.value) || null);
    // An older commit than the newest: a rollback — every server now, the live one first.
    const isRollback = computed(() => !!chosen.value && chosen.value !== newest.value);
    watch(isRollback, (rb) => {
      for (const d of p.value?.deployments || []) Object.assign(rows[d.id], rb ? { mode: 'now' } : { mode: defaults[d.id].mode });
    });
    const isLive = (d) => p.value && d.id === p.value.active_deployment_id;
    // Standby servers first, the live one last — the order deploys run in.
    const deps = computed(() => (p.value ? [...p.value.deployments].sort((a, b) => (isRollback.value && liveFirst.value ? isLive(b) - isLive(a) : isLive(a) - isLive(b))) : []));
    const pick = (mode) => deps.value.filter((d) => rows[d.id]?.mode === mode);
    const liveNow = computed(() => deps.value.some((d) => isLive(d) && rows[d.id].mode === 'now'));
    const nothing = computed(() => !pick('now').length && !pick('later').length);
    const atOf = (d) => (rows[d.id].when === 'time' ? nextAt(rows[d.id].time) : null);
    async function go() {
      busy.value = true;
      try {
        const r = await http.post(`/projects/${p.value.id}/deploy-plan`, {
          now: pick('now').map((d) => d.id),
          later: pick('later').map((d) => ({ deployment: d.id, at: atOf(d)?.toISOString() || null })),
          ...(chosen.value ? { commit: chosen.value } : {}),
          ...(isRollback.value ? { rollback: true, live_first: liveFirst.value } : {}),
        });
        closeDialog();
        store.live++;
        if (r.job) showJob(r.job.id);
        else toast('Saved — the servers wait (CI/CD tab shows them)', 'success');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    const short = (sha) => (sha || '').slice(0, 7);
    return { p, rows, deps, isLive, pick, liveNow, nothing, atOf, nextAt, whenText, busy, go, closeDialog, code, codeError, chosen, chosenCommit, newest, isRollback, liveFirst, ago, short };
  },
  template: `
  <modal :title="p ? (isRollback ? 'Roll back ' : 'Deploy ') + p.name : 'Deploy'" size="lg" @close="closeDialog">
    <div v-if="!p" class="muted"><span class="spinner"></span> Loading…</div>
    <div v-else class="form">
      <p class="muted" style="margin:0" v-if="isRollback">Errors after a deploy? Put an older commit of the branch back on the servers — choose the commit and the servers.</p>
      <p class="muted" style="margin:0" v-else>Choose which servers get the new code <b>now</b> and which <b>later</b>. Rebuilding a server can make it answer errors for a few seconds — let the <b>live</b> server (where your visitors are) wait for a quiet moment.</p>
      <div class="field"><label>Which code</label>
        <div v-if="codeError" class="hint">The newest commit is deployed. ({{ codeError }})</div>
        <div v-else-if="!code" class="muted small"><span class="spinner"></span> Reading the commits of the branch…</div>
        <div v-else class="dp-commits" role="radiogroup" aria-label="Commit to deploy">
          <label v-for="(c, i) in code.commits" :key="c.sha" class="dp-commit" :class="{ on: (chosen || newest) === c.sha, older: i > 0 }">
            <input type="radio" :value="i === 0 ? '' : c.sha" v-model="chosen">
            <span class="mono dp-sha">{{ short(c.sha) }}</span>
            <span class="dp-title">{{ c.title }}<span class="muted small"> · {{ c.author }} · {{ ago(c.date) }}</span></span>
            <span class="dp-tags">
              <span v-if="i === 0" class="badge badge-blue">newest</span>
              <span v-if="c.run" class="badge" :class="c.run.status !== 'completed' ? 'badge-blue' : c.run.conclusion === 'success' ? 'badge-green' : 'badge-red'">{{ c.run.status !== 'completed' ? 'CI running' : c.run.conclusion === 'success' ? 'CI passed' : 'CI ' + c.run.conclusion }}</span>
              <span v-for="n in c.on" :key="n" class="badge badge-gray">on {{ n }}</span>
            </span>
          </label>
        </div>
      </div>
      <div v-if="isRollback && chosenCommit" class="alert alert-warn"><span class="alert-icon">↩</span><div>
        <b>Roll back to {{ short(chosenCommit.sha) }}</b> — "{{ chosenCommit.title }}". The servers you choose go back to this commit (edits made on a server are kept; the deploy stops if one would be overwritten). The next new commit on {{ code.branch }} deploys as usual.
        <label class="check" style="margin-top:6px"><input type="checkbox" v-model="liveFirst"><span class="check-text">Live server first — fix what visitors see first</span></label></div></div>
      <div class="dp-list">
        <div v-for="d in deps" :key="d.id" class="dp-row" :class="['dp-' + rows[d.id].mode, { 'dp-live': isLive(d) }]">
          <div class="dp-server">
            <b>{{ d.server_name }}</b>
            <span v-if="isLive(d)" class="badge badge-green">LIVE · visitors here</span><span v-else class="badge badge-gray">standby</span>
            <div class="muted small">{{ d.app_dir || 'no app folder set' }}</div>
          </div>
          <div class="dp-choice">
            <div class="seg">
              <button type="button" :class="{ on: rows[d.id].mode === 'now' }" @click="rows[d.id].mode = 'now'">Now</button>
              <button type="button" :class="{ on: rows[d.id].mode === 'later' }" @click="rows[d.id].mode = 'later'">Later</button>
              <button type="button" :class="{ on: rows[d.id].mode === 'skip' }" @click="rows[d.id].mode = 'skip'">Skip</button>
            </div>
            <div v-if="rows[d.id].mode === 'later'" class="dp-when">
              <label class="check"><input type="radio" value="click" v-model="rows[d.id].when"><span class="check-text">When I click "Deploy now"</span></label>
              <div class="dp-at"><label class="check"><input type="radio" value="time" v-model="rows[d.id].when"><span class="check-text">At</span></label>
                <input type="time" v-model="rows[d.id].time" class="dp-time" @focus="rows[d.id].when = 'time'" aria-label="Time">
                <span class="muted small">{{ whenText(nextAt(rows[d.id].time).toISOString()) }}</span></div>
            </div>
          </div>
        </div>
      </div>
      <div v-if="liveNow && !isRollback" class="alert alert-warn"><span class="alert-icon">⚠</span><span>The <b>live</b> server is rebuilt now: visitors may see errors for a few seconds. Choose "Later" for it to wait.</span></div>
      <div class="dp-summary small">
        <div v-if="pick('now').length"><b>Now:</b> {{ pick('now').map(d => d.server_name).join(' → ') }} <span class="muted">(one at a time{{ chosen ? ', commit ' + short(chosen) : ', newest commit' }})</span></div>
        <div v-for="d in pick('later')" :key="'l' + d.id"><b>Later:</b> {{ d.server_name }} — {{ whenText(atOf(d)) }} <span class="muted">(same commit)</span></div>
        <div v-if="pick('skip').length" class="muted">Not deployed: {{ pick('skip').map(d => d.server_name).join(', ') }}</div>
      </div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="closeDialog">Cancel</button>
      <button class="btn btn-primary" :class="{ 'btn-danger': isRollback }" @click="go" :disabled="busy || !p || nothing">{{ isRollback && pick('now').length ? 'Roll back ' + pick('now').length + ' server' + (pick('now').length > 1 ? 's' : '') + ' to ' + short(chosen) : pick('now').length ? 'Deploy ' + pick('now').length + ' now' + (pick('later').length ? ', ' + pick('later').length + ' later' : '') : 'Save — deploy later' }}</button>
    </template>
  </modal>`,
};

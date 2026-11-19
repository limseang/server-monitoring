import { ref, computed, watch, onMounted, onUnmounted } from '/vendor/vue.js';
import { dur } from './runview.js';

/*
 * Live view of a Switchboard deploy job (also a rollback): each server's phase and the commits it moves between.
 * Same two views as the CI run view, and the same remembered choice:
 *   professional — a table: server, from → to, phases, time, result
 *   animated     — each server travels along its own track from the old commit to the new one;
 *                  a rollback runs right-to-left like a rewind
 */

const VIEW_KEY = 'sb-run-view';
const PHASES = [
  ['connect', 'Connect'],
  ['code', 'Code'],
  ['script', 'Deploy script'],
  ['health', 'Health'],
];
const PHASE_AT = { '': 0, connect: 0.12, code: 0.5, script: 0.78, health: 0.93, done: 1 };
const short = (sha) => (sha || '').slice(0, 7);
const ms = (t) => (t ? Date.parse(t) : null);
const LABEL = { queued: 'Waiting', running: 'Running', success: 'Done', failure: 'Failed', skipped: 'Not run' };
const BADGE = { queued: 'badge-gray', running: 'badge-blue', success: 'badge-green', failure: 'badge-red', skipped: 'badge-gray' };
const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** 'done' | 'now' | 'todo' | 'fail' for one phase of one server */
function phaseState(s, key) {
  const order = PHASES.map((x) => x[0]);
  const i = order.indexOf(key);
  if (s.state === 'success') return 'done';
  if (s.state === 'queued' || s.state === 'skipped') return 'todo';
  const cur = order.indexOf(s.phase);
  if (i < cur) return 'done';
  if (i === cur) return s.state === 'failure' ? 'fail' : 'now';
  return 'todo';
}

/* ------------------------------------------------------------------ professional */
const DeployPro = {
  props: { progress: Object, now: Number },
  setup(props) {
    const time = (s) => (s.started_at ? dur((ms(s.finished_at) || props.now) - ms(s.started_at)) : '—');
    const arrow = (s) => (s.dir === 'back' ? '↩' : s.dir === 'same' ? '=' : '→');
    return { PHASES, phaseState, time, arrow, short, LABEL, BADGE };
  },
  template: `
  <div class="rv-pro dv-pro">
    <div class="dv-head"><span>Server</span><span>Code</span><span>Progress</span><span class="ta-r">Time</span></div>
    <div v-for="s in progress.servers" :key="s.id" class="dv-row" :class="'st-' + s.state">
      <div class="dv-srv"><span class="rv-ico" :class="'st-' + (s.state === 'skipped' ? 'queued' : s.state)">{{ s.state === 'success' ? '✓' : s.state === 'failure' ? '✕' : s.state === 'running' ? '●' : '◌' }}</span>
        <b>{{ s.name }}</b><span v-if="s.live" class="badge badge-green">LIVE</span></div>
      <div class="dv-code mono small">
        <template v-if="s.from || s.to"><span class="muted">{{ short(s.from) || '?' }}</span> <span :class="{ 'text-amber': s.dir === 'back' }">{{ arrow(s) }}</span> <b>{{ short(s.to) || short(progress.commit) || '…' }}</b></template>
        <span v-else class="muted">{{ progress.commit ? short(progress.commit) : 'newest' }}</span>
        <span v-if="s.dir === 'back'" class="badge badge-amber dv-back">back</span>
      </div>
      <div class="dv-phases">
        <span v-for="ph in PHASES" :key="ph[0]" class="dv-ph" :class="'ph-' + phaseState(s, ph[0])"><i></i>{{ ph[1] }}</span>
      </div>
      <div class="ta-r mono small">{{ time(s) }}</div>
      <div v-if="s.error || s.health" class="dv-note small" :class="s.error ? 'text-red' : 'muted'">{{ s.error || s.health }}</div>
    </div>
  </div>`,
};

/* ------------------------------------------------------------------ animated */
const W = 980;
const XA = 170;
const XB = 810;
const DeployAnim = {
  props: { progress: Object, now: Number, status: String },
  setup(props) {
    const motion = !reducedMotion();
    const back = computed(() => props.progress.rollback || props.progress.servers.some((s) => s.dir === 'back'));
    // Rollback: from the right (newer) to the left (older). Deploy: left to right.
    const xFrom = computed(() => (back.value ? XB : XA));
    const xTo = computed(() => (back.value ? XA : XB));
    const laneY = (i) => 92 + i * 92;
    const H = computed(() => 92 + props.progress.servers.length * 92 + 10);
    const frac = (s) => (s.state === 'success' ? 1 : s.state === 'queued' || s.state === 'skipped' ? 0 : PHASE_AT[s.phase] ?? 0.05);
    const x = (s) => xFrom.value + (xTo.value - xFrom.value) * frac(s);
    const running = computed(() => props.progress.servers.find((s) => s.state === 'running'));
    const failed = computed(() => props.progress.servers.find((s) => s.state === 'failure'));
    const done = computed(() => props.progress.servers.filter((s) => s.state === 'success').length);
    const total = computed(() => props.progress.servers.length);
    const finished = computed(() => !['queued', 'running'].includes(props.status));
    const headline = computed(() => {
      const word = back.value ? 'Rolling back' : 'Deploying';
      if (failed.value) return `Stopped on ${failed.value.name}`;
      if (finished.value && done.value === total.value) return back.value ? `Rolled back to ${short(props.progress.commit || props.progress.servers[0]?.to)}` : 'Deployed';
      if (finished.value) return props.status === 'cancelled' ? 'Cancelled' : 'Finished';
      const r = running.value;
      const ph = r ? PHASES.find((p) => p[0] === r.phase)?.[1] : '';
      return r ? `${word} ${r.name}${ph ? ` — ${ph}` : ''}` : `${word}…`;
    });
    const state = computed(() => (failed.value ? 'failure' : finished.value ? (done.value === total.value ? 'success' : 'cancelled') : 'running'));
    const pct = computed(() => Math.round((props.progress.servers.reduce((n, s) => n + frac(s), 0) / Math.max(1, total.value)) * 100));
    const elapsed = computed(() => dur((finished.value ? Math.max(...props.progress.servers.map((s) => ms(s.finished_at) || 0)) || props.now : props.now) - ms(props.progress.started_at)));
    const fromLabel = computed(() => short(props.progress.servers.find((s) => s.from)?.from) || (back.value ? 'now' : 'old'));
    const toLabel = computed(() => short(props.progress.commit) || short(props.progress.servers.find((s) => s.to)?.to) || 'newest');
    return { W, H, XA, XB, motion, back, xFrom, xTo, laneY, x, frac, headline, state, pct, elapsed, fromLabel, toLabel, short, PHASES, phaseState };
  },
  template: `
  <div class="rv-anim dv-anim" :class="['run-' + state, { 'dv-rewind': back && state === 'running' && motion }]">
    <div class="rv-hero">
      <div class="rv-hero-text">
        <svg v-if="back" class="dv-rw-ico" :class="{ spin: state === 'running' && motion }" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 5a7 7 0 1 1-6.6 4.7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M3 4v5.5h5.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span v-else class="rv-hero-dot" :class="'st-' + state"></span>
        <b>{{ headline }}</b>
      </div>
      <span class="mono muted">{{ elapsed }}</span>
    </div>
    <div class="rv-progress" :class="'st-' + state"><span :style="{ width: pct + '%' }"></span></div>
    <svg class="rv-scene" :viewBox="'0 0 ' + W + ' ' + H" role="img" :aria-label="headline">
      <!-- the two ends: the code the servers had, and the code they get -->
      <g class="dv-end" :transform="'translate(' + xFrom + ',40)'">
        <rect x="-52" y="-17" width="104" height="30" rx="15" class="dv-pill from" /><text y="3" text-anchor="middle" class="mono rv-t-small">{{ fromLabel }}</text>
        <text y="-24" text-anchor="middle" class="rv-t-tiny">{{ back ? 'had (newer)' : 'had' }}</text>
      </g>
      <g class="dv-end" :transform="'translate(' + xTo + ',40)'">
        <rect x="-52" y="-17" width="104" height="30" rx="15" class="dv-pill to" :class="{ back }" /><text y="3" text-anchor="middle" class="mono rv-t-strong">{{ toLabel }}</text>
        <text y="-24" text-anchor="middle" class="rv-t-tiny">{{ back ? 'roll back to (older)' : 'deploy' }}</text>
      </g>
      <text v-if="back && state === 'running'" :x="(XA + XB) / 2" y="44" text-anchor="middle" class="dv-rw-text">◀◀ REWIND</text>

      <g v-for="(s, i) in progress.servers" :key="s.id" class="dv-lane" :class="'st-' + s.state">
        <!-- track -->
        <line :x1="XA" :x2="XB" :y1="laneY(i)" :y2="laneY(i)" class="dv-track" />
        <line :x1="xFrom" :x2="x(s)" :y1="laneY(i)" :y2="laneY(i)" class="dv-trail" />
        <line v-if="s.state === 'running' && motion" :x1="x(s)" :x2="xTo" :y1="laneY(i)" :y2="laneY(i)" class="dv-ahead" :class="{ back }" />
        <circle :cx="xFrom" :cy="laneY(i)" r="5" class="dv-node from" />
        <circle :cx="xTo" :cy="laneY(i)" r="7" class="dv-node to" />
        <!-- the server, travelling along its track -->
        <g class="dv-mover" :style="{ transform: 'translate(' + x(s) + 'px,' + laneY(i) + 'px)' }">
          <template v-if="s.state === 'running' && motion">
            <rect v-for="k in 3" :key="k" :x="-66 + (back ? 1 : -1) * k * 16" y="-21" width="132" height="42" rx="11" class="dv-ghost" :style="{ opacity: 0.22 - k * 0.06 }" />
          </template>
          <rect x="-66" y="-21" width="132" height="42" rx="11" class="dv-chip" />
          <circle cx="-50" cy="-6" r="2.6" class="rv-led l1" /><circle cx="-50" cy="2" r="2.6" class="rv-led l2" /><circle cx="-50" cy="10" r="2.6" class="rv-led l3" />
          <text x="-40" y="-3" class="rv-t-small">{{ s.name.length > 13 ? s.name.slice(0, 12) + '…' : s.name }}</text>
          <text x="-40" y="12" class="rv-t-tiny">{{ s.state === 'running' ? (PHASES.find(p => p[0] === s.phase) || ['', 'Starting'])[1] : s.state === 'success' ? (back ? 'Rolled back ✓' : 'Deployed ✓') : s.state === 'failure' ? 'Failed' : s.state === 'skipped' ? 'Not run' : 'Waiting' }}</text>
          <g v-if="s.live" transform="translate(48,-21)"><rect x="-17" y="-8" width="34" height="15" rx="7.5" class="dv-live" /><text y="3" text-anchor="middle" class="dv-live-t">LIVE</text></g>
          <g v-if="s.state === 'success' || s.state === 'failure'" transform="translate(66,0)"><g class="rv-stamp"><circle r="11" /><text y="4.5" text-anchor="middle">{{ s.state === 'success' ? '✓' : '✕' }}</text></g></g>
        </g>
        <!-- phases under the track -->
        <g :transform="'translate(' + XA + ',' + (laneY(i) + 32) + ')'">
          <g v-for="(ph, k) in PHASES" :key="ph[0]" :transform="'translate(' + (k * ((XB - XA) / 4)) + ',0)'" class="dv-phg" :class="'ph-' + phaseState(s, ph[0])">
            <circle r="4" /><text x="9" y="4" class="rv-t-tiny">{{ ph[1] }}</text>
          </g>
        </g>
      </g>
    </svg>
  </div>`,
};

/** The deploy view with its Professional / Animated switch (used in the job window). */
export const DeployLive = {
  props: { progress: Object, status: String },
  components: { DeployPro, DeployAnim },
  setup(props) {
    let saved = 'pro';
    try {
      saved = localStorage.getItem(VIEW_KEY) || 'pro';
    } catch {}
    const view = ref(saved === 'anim' ? 'anim' : 'pro');
    watch(view, (v) => {
      try {
        localStorage.setItem(VIEW_KEY, v);
      } catch {}
    });
    const now = ref(Date.now());
    let t = null;
    onMounted(() => (t = setInterval(() => (now.value = Date.now()), 1000)));
    onUnmounted(() => clearInterval(t));
    const title = computed(() => (props.progress.rollback ? `Roll back to ${short(props.progress.commit)}` : props.progress.commit ? `Deploy ${short(props.progress.commit)}` : 'Deploy the newest code'));
    return { view, now, title };
  },
  template: `
  <div class="rv dv">
    <div class="rv-top">
      <div class="rv-meta"><b>{{ title }}</b><span class="muted small">{{ progress.project }} · {{ progress.servers.length }} server{{ progress.servers.length > 1 ? 's' : '' }}</span></div>
      <div class="seg rv-switch" role="tablist" aria-label="View">
        <button type="button" role="tab" :aria-selected="view === 'pro'" :class="{ on: view === 'pro' }" @click="view = 'pro'">Professional</button>
        <button type="button" role="tab" :aria-selected="view === 'anim'" :class="{ on: view === 'anim' }" @click="view = 'anim'">Animated</button>
      </div>
    </div>
    <deploy-pro v-if="view === 'pro'" :progress="progress" :now="now" />
    <deploy-anim v-else :progress="progress" :now="now" :status="status" />
  </div>`,
};

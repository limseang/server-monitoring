import { ref, computed, watch, onMounted, onUnmounted } from '/vendor/vue.js';
import { http, toast, confirmBox, closeDialog, openDialog, showJob } from './lib.js';

/*
 * Live view of one CI/CD run (GitHub Actions): its jobs and steps, read through Switchboard every few seconds
 * while it runs. Two views of the same data:
 *   professional — summary + a timeline of jobs (bars on a time axis), steps under each job
 *   animated     — commit → GitHub's machines → your servers, with code flowing to the server that deploys now
 */

const POLL_MS = 5000;
const VIEW_KEY = 'sb-run-view';

/** queued | running | success | failure | cancelled | skipped */
export const stateOf = (x) => {
  if (!x) return 'queued';
  if (x.status === 'completed') return { success: 'success', neutral: 'success', failure: 'failure', timed_out: 'failure', startup_failure: 'failure', cancelled: 'cancelled', skipped: 'skipped' }[x.conclusion] || 'cancelled';
  return x.status === 'in_progress' ? 'running' : 'queued';
};
const LABEL = { queued: 'Waiting', running: 'Running', success: 'Passed', failure: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped' };
const BADGE = { queued: 'badge-gray', running: 'badge-blue', success: 'badge-green', failure: 'badge-red', cancelled: 'badge-gray', skipped: 'badge-gray' };
const ICON = { queued: '◌', running: '●', success: '✓', failure: '✕', cancelled: '⊘', skipped: '↷' };
const ms = (t) => (t ? Date.parse(t) : null);
export function dur(msec) {
  if (msec == null) return '';
  // A step that just started can be a moment ahead of this clock.
  const s = Math.max(0, Math.round(msec / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
const stepsDone = (j) => j.steps.filter((s) => s.status === 'completed').length;
/** 0…1 for a job: finished steps, half a step for the one running. */
const jobProgress = (j) => {
  const st = stateOf(j);
  if (st !== 'running' && st !== 'queued') return 1;
  if (!j.steps.length) return st === 'running' ? 0.15 : 0;
  return Math.min(0.98, (stepsDone(j) + (j.steps.some((s) => s.status === 'in_progress') ? 0.5 : 0)) / j.steps.length);
};
const currentStep = (j) => j.steps.find((s) => s.status === 'in_progress') || null;
const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------------ professional view */
const ProView = {
  props: { data: Object, now: Number },
  setup(props) {
    const open = ref({});
    const span = computed(() => {
      const r = props.data.run;
      const start = Math.min(ms(r.started_at) || Infinity, ...props.data.jobs.map((j) => ms(j.started_at) || Infinity));
      const ends = props.data.jobs.map((j) => ms(j.completed_at) || (stateOf(j) === 'running' ? props.now : 0));
      const end = r.status === 'completed' ? Math.max(ms(r.updated_at) || 0, ...ends) : Math.max(props.now, ...ends);
      return { start: Number.isFinite(start) ? start : props.now, end: Math.max(end, (Number.isFinite(start) ? start : props.now) + 1000) };
    });
    const bar = (j) => {
      const { start, end } = span.value;
      const a = ms(j.started_at);
      if (!a) return null;
      const b = ms(j.completed_at) || props.now;
      const total = end - start;
      return { left: `${((a - start) / total) * 100}%`, width: `${Math.max(0.8, ((b - a) / total) * 100)}%` };
    };
    const jobDur = (j) => (ms(j.started_at) ? dur((ms(j.completed_at) || props.now) - ms(j.started_at)) : '');
    const stepDur = (s) => (ms(s.started_at) ? dur((ms(s.completed_at) || props.now) - ms(s.started_at)) : '');
    const toggle = (j) => (open.value = { ...open.value, [j.id]: !open.value[j.id] });
    // Running and failed jobs start opened.
    watch(
      () => props.data.jobs.map((j) => `${j.id}:${stateOf(j)}`).join(),
      () => {
        for (const j of props.data.jobs) if (open.value[j.id] === undefined && ['running', 'failure'].includes(stateOf(j))) open.value[j.id] = true;
      },
      { immediate: true },
    );
    const ticks = computed(() => {
      const { start, end } = span.value;
      return [0, 0.25, 0.5, 0.75, 1].map((f) => ({ left: `${f * 100}%`, text: f === 0 ? '0s' : dur((end - start) * f) }));
    });
    return { open, bar, jobDur, stepDur, toggle, ticks, stateOf, LABEL, BADGE, ICON, stepsDone };
  },
  template: `
  <div class="rv-pro">
    <div class="rv-axis"><span class="rv-axis-name">Job</span><div class="rv-axis-track"><span v-for="t in ticks" :key="t.left" :style="{ left: t.left }">{{ t.text }}</span></div><span class="rv-axis-dur">Time</span></div>
    <div v-if="!data.jobs.length" class="empty">No jobs yet — GitHub is still starting the run.</div>
    <div v-for="j in data.jobs" :key="j.id" class="rv-job" :class="'st-' + stateOf(j)">
      <button type="button" class="rv-job-row" @click="toggle(j)" :aria-expanded="!!open[j.id]">
        <span class="rv-job-name"><span class="rv-ico" :class="'st-' + stateOf(j)">{{ ICON[stateOf(j)] }}</span>
          <span class="rv-job-title">{{ j.name }}</span>
          <span class="rv-where" :class="'w-' + j.where">{{ j.server ? j.server.name : j.where === 'github' ? 'GitHub' : 'self-hosted' }}</span></span>
        <span class="rv-track"><span v-if="bar(j)" class="rv-bar" :class="'st-' + stateOf(j)" :style="bar(j)"></span></span>
        <span class="rv-job-dur mono">{{ jobDur(j) || '—' }}</span>
      </button>
      <div v-if="open[j.id]" class="rv-steps">
        <div v-if="!j.steps.length" class="muted small">No steps yet.</div>
        <div v-for="s in j.steps" :key="s.number" class="rv-step" :class="'st-' + stateOf(s)">
          <span class="rv-ico sm" :class="'st-' + stateOf(s)">{{ ICON[stateOf(s)] }}</span><span class="rv-step-name">{{ s.name }}</span><span class="mono muted small">{{ stepDur(s) }}</span>
        </div>
        <div class="rv-steps-foot"><span class="muted small">{{ stepsDone(j) }} of {{ j.steps.length }} steps<template v-if="j.runner"> · runner <code>{{ j.runner }}</code></template></span><a v-if="j.html_url" class="btn btn-xs" :href="j.html_url" target="_blank" rel="noopener">Log ↗</a></div>
      </div>
    </div>
  </div>`,
};

/* ------------------------------------------------------------------ animated view */
const W = 980;
const AnimView = {
  props: { data: Object, now: Number },
  emits: ['deploy'],
  setup(props) {
    const motion = !reducedMotion();
    const hosted = computed(() => props.data.jobs.filter((j) => j.where !== 'server'));
    // Servers: those with a job in this run first, then the project's other servers (idle).
    const servers = computed(() => {
      const withJobs = [];
      for (const j of props.data.jobs) if (j.server && !withJobs.some((s) => s.id === j.server.id)) withJobs.push(j.server);
      const rest = props.data.servers.filter((s) => !withJobs.some((x) => x.id === s.id));
      return [...withJobs, ...rest].map((s) => {
        // "Live server waits…" only marks the server: it is not a deploy.
        const holdJob = props.data.jobs.find((j) => j.hold && j.server?.id === s.id) || null;
        const held = (props.data.held || []).find((h) => h.server_id === s.id) || null;
        const jobs = props.data.jobs.filter((j) => j.server?.id === s.id && !j.hold);
        if (held) return { ...s, jobs, job: null, held, state: 'held' };
        if (holdJob && !jobs.length) return { ...s, jobs, job: null, held: null, state: ['running', 'queued'].includes(stateOf(holdJob)) ? 'queued' : 'idle', released: stateOf(holdJob) === 'success' };
        // The job to show: the one running, else a failed one, else the next one waiting (the run goes on), else the last one that ran.
        const done = [...jobs].reverse().find((j) => j.started_at && !['queued', 'running'].includes(stateOf(j)));
        const failed = jobs.find((j) => stateOf(j) === 'failure');
        const job = jobs.find((j) => stateOf(j) === 'running') || failed || (props.data.run.status !== 'completed' && jobs.find((j) => stateOf(j) === 'queued')) || done || jobs[0] || null;
        return { ...s, jobs, job, state: job ? stateOf(job) : 'idle' };
      });
    });
    const rowsH = (n, h) => Math.max(1, n) * h;
    const H = computed(() => Math.max(300, 70 + Math.max(rowsH(servers.value.length, 104), hosted.value.length ? 70 + rowsH(hosted.value.length, 46) : 0)));
    const mid = computed(() => H.value / 2 + 14);
    const commit = computed(() => ({ x: 92, y: mid.value }));
    const panel = computed(() => {
      if (!hosted.value.length) return null;
      const h = 54 + hosted.value.length * 46;
      return { x: 300, y: mid.value - h / 2, w: 290, h };
    });
    const sx = 690;
    const sw = 250;
    const serverBoxes = computed(() => {
      const n = servers.value.length;
      const top = mid.value - (n * 104 - 18) / 2;
      return servers.value.map((s, i) => ({ ...s, x: sx, y: top + i * 104, w: sw, h: 86 }));
    });
    const curve = (x1, y1, x2, y2) => {
      const dx = (x2 - x1) * 0.5;
      return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    };
    const hostedState = computed(() => {
      const st = hosted.value.map(stateOf);
      if (!st.length) return 'idle';
      if (st.includes('failure')) return 'failure';
      if (st.includes('running')) return 'running';
      if (st.every((x) => x === 'success' || x === 'skipped')) return 'success';
      if (st.includes('queued')) return 'queued';
      return 'cancelled';
    });
    const edges = computed(() => {
      const c = commit.value;
      const out = [];
      const p = panel.value;
      if (p) out.push({ id: 'c-p', d: curve(c.x + 30, c.y, p.x, p.y + p.h / 2), state: hostedState.value });
      for (const s of serverBoxes.value) {
        const from = p ? { x: p.x + p.w, y: p.y + p.h / 2 } : { x: c.x + 30, y: c.y };
        out.push({ id: `s-${s.id}`, d: curve(from.x, from.y, s.x, s.y + s.h / 2), state: s.state });
      }
      return out;
    });
    const all = computed(() => props.data.jobs);
    const overall = computed(() => (all.value.length ? all.value.reduce((n, j) => n + jobProgress(j), 0) / all.value.length : 0));
    const runState = computed(() => stateOf(props.data.run));
    const headline = computed(() => {
      const st = runState.value;
      const waiting = serverBoxes.value.filter((s) => s.state === 'held');
      if (waiting.length && st !== 'failure' && st !== 'cancelled') {
        const busy = serverBoxes.value.find((s) => s.state === 'running');
        if (!busy) return `Ready — ${waiting.map((s) => s.name).join(', ')} waits for you`;
      }
      if (st === 'success') return 'Done — everything passed';
      if (st === 'failure') {
        const j = all.value.find((x) => stateOf(x) === 'failure');
        return j ? `Stopped: “${j.name}” failed` : 'The run failed';
      }
      if (st === 'cancelled') return 'Cancelled';
      const runningServer = serverBoxes.value.find((s) => s.state === 'running');
      if (runningServer) {
        const step = currentStep(runningServer.job);
        return `Deploying on ${runningServer.name}${step ? ` — ${step.name}` : ''}`;
      }
      const h = hosted.value.find((j) => stateOf(j) === 'running');
      if (h) {
        const step = currentStep(h);
        return `${h.name}${step ? ` — ${step.name}` : ''}`;
      }
      return 'Waiting for a runner…';
    });
    const elapsed = computed(() => {
      const a = ms(props.data.run.started_at);
      if (!a) return '';
      const b = props.data.run.status === 'completed' ? ms(props.data.run.updated_at) : props.now;
      return dur(b - a);
    });
    const trim = (t, n) => (String(t || '').length > n ? `${String(t).slice(0, n - 1)}…` : String(t || ''));
    // Where a held server's gate sits: on its connection, just before the server.
    const gates = computed(() => serverBoxes.value.filter((s) => s.state === 'held').map((s) => ({ id: s.id, x: s.x - 18, y: s.y + s.h / 2 })));
    return { gates, W, H, motion, hosted, panel, serverBoxes, commit, edges, overall, runState, headline, elapsed, trim, stateOf, jobProgress, currentStep, stepsDone, ICON, hostedState };
  },
  template: `
  <div class="rv-anim" :class="'run-' + runState">
    <div class="rv-hero">
      <div class="rv-hero-text"><span class="rv-hero-dot" :class="'st-' + runState"></span><b>{{ headline }}</b></div>
      <span class="mono muted">{{ elapsed }}</span>
    </div>
    <div class="rv-progress" :class="'st-' + runState"><span :style="{ width: Math.round(overall * 100) + '%' }"></span></div>
    <svg class="rv-scene" :viewBox="'0 0 ' + W + ' ' + H" role="img" :aria-label="headline">
      <defs>
        <radialGradient id="rv-glow"><stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35" /><stop offset="100%" stop-color="var(--accent)" stop-opacity="0" /></radialGradient>
      </defs>
      <!-- connections: code flows along the active ones -->
      <g v-for="e in edges" :key="e.id" class="rv-edge" :class="'st-' + e.state">
        <path :d="e.d" class="rv-edge-base" />
        <path :d="e.d" class="rv-edge-flow" />
        <template v-if="motion && e.state === 'running'">
          <circle v-for="k in 3" :key="k" r="4.5" class="rv-packet">
            <animateMotion :dur="'1.8s'" repeatCount="indefinite" :begin="((k - 1) * 0.6) + 's'" :path="e.d" />
          </circle>
        </template>
      </g>

      <!-- a held server: the code is parked at a gate until you click -->
      <g v-for="g in gates" :key="'gate-' + g.id">
        <template v-if="motion"><circle v-for="k in 3" :key="k" r="3.5" class="rv-parked" :cx="g.x - 18 - (k - 1) * 11" :cy="g.y" :style="{ animationDelay: ((k - 1) * 0.25) + 's' }" /></template>
        <g :transform="'translate(' + g.x + ',' + g.y + ')'"><g class="rv-gate"><circle r="10" /><text y="4" text-anchor="middle">❚❚</text></g></g>
      </g>

      <!-- the commit -->
      <g class="rv-commit" :class="'st-' + runState" :transform="'translate(' + commit.x + ',' + commit.y + ')'">
        <circle r="46" fill="url(#rv-glow)" class="rv-commit-glow" />
        <circle r="30" class="rv-commit-ring" />
        <circle r="9" class="rv-commit-dot" />
        <line x1="-30" y1="0" x2="-9" y2="0" class="rv-commit-line" /><line x1="9" y1="0" x2="30" y2="0" class="rv-commit-line" />
        <text y="56" text-anchor="middle" class="rv-t-strong mono">{{ (data.run.sha || '').slice(0, 7) }}</text>
        <text y="74" text-anchor="middle" class="rv-t-muted">{{ trim(data.run.branch, 18) }}</text>
      </g>

      <!-- GitHub's machines (and self-hosted jobs that are not one of this project's servers) -->
      <g v-if="panel" class="rv-panel" :class="'st-' + hostedState">
        <rect :x="panel.x" :y="panel.y" :width="panel.w" :height="panel.h" rx="14" class="rv-panel-box" />
        <text :x="panel.x + 16" :y="panel.y + 26" class="rv-t-strong">GitHub Actions</text>
        <text :x="panel.x + panel.w - 16" :y="panel.y + 26" text-anchor="end" class="rv-t-muted">{{ hosted.filter(j => stateOf(j) === 'success').length }}/{{ hosted.length }}</text>
        <g v-for="(j, i) in hosted" :key="j.id" :class="'st-' + stateOf(j)" :transform="'translate(' + (panel.x + 12) + ',' + (panel.y + 42 + i * 46) + ')'">
          <rect :width="panel.w - 24" height="38" rx="9" class="rv-chip" />
          <g transform="translate(19,19)"><circle r="9" class="rv-chip-ico" /><text y="4" text-anchor="middle" class="rv-chip-glyph">{{ ICON[stateOf(j)] }}</text>
            <circle v-if="stateOf(j) === 'running'" r="13" class="rv-spin" /></g>
          <text x="38" y="17" class="rv-t-small">{{ trim(j.name, 30) }}</text>
          <text x="38" y="31" class="rv-t-tiny">{{ currentStep(j) ? trim(currentStep(j).name, 34) : (j.steps.length ? stepsDone(j) + '/' + j.steps.length + ' steps' : '') }}</text>
          <rect x="38" y="34" :width="(panel.w - 74)" height="2" rx="1" class="rv-mini-track" />
          <rect x="38" y="34" :width="(panel.w - 74) * jobProgress(j)" height="2" rx="1" class="rv-mini-bar" />
        </g>
      </g>

      <!-- your servers -->
      <g v-for="s in serverBoxes" :key="s.id" class="rv-server" :class="'st-' + s.state" :transform="'translate(' + s.x + ',' + s.y + ')'">
        <rect :width="s.w" :height="s.h" rx="14" class="rv-server-box" />
        <g transform="translate(16,18)" class="rv-rack">
          <rect width="34" height="12" rx="3" /><rect y="17" width="34" height="12" rx="3" /><rect y="34" width="34" height="12" rx="3" />
          <circle cx="27" cy="6" r="2.2" class="rv-led l1" /><circle cx="27" cy="23" r="2.2" class="rv-led l2" /><circle cx="27" cy="40" r="2.2" class="rv-led l3" />
        </g>
        <text x="64" y="28" class="rv-t-strong">{{ trim(s.name, 20) }}</text>
        <template v-if="s.state === 'held'">
          <text x="64" y="47" class="rv-t-small">Waits for you</text>
          <text x="64" y="64" class="rv-t-tiny">{{ s.held.run_at ? 'or at the quiet time' : 'the others have it' }}</text>
          <g :transform="'translate(' + (s.w - 22) + ',22)'"><g class="rv-hg"><text y="6" text-anchor="middle" style="font-size:17px">⏳</text></g></g>
          <g class="rv-hold-btn dev-only" role="button" tabindex="0" :aria-label="'Deploy ' + s.name + ' now'" :transform="'translate(' + (s.w - 92) + ',' + (s.h - 36) + ')'" @click="$emit('deploy', s.held)" @keydown.enter="$emit('deploy', s.held)">
            <rect width="78" height="22" rx="11" /><text x="39" y="15" text-anchor="middle">Deploy ▶</text></g>
        </template>
        <template v-else>
        <text x="64" y="47" class="rv-t-small">{{ s.job ? trim(s.job.name, 26) : s.released ? 'Got its turn later' : 'No job in this run' }}</text>
        <text x="64" y="64" class="rv-t-tiny">{{ s.job ? (currentStep(s.job) ? trim(currentStep(s.job).name, 30) : s.state === 'success' ? (/deploy/i.test(s.job.name) ? 'Deployed ✓' : 'Passed ✓') : s.state === 'failure' ? 'Failed' : s.state === 'queued' ? 'Waiting…' : (stepsDone(s.job) + '/' + s.job.steps.length + ' steps')) : '' }}</text>
        </template>
        <rect x="14" :y="s.h - 9" :width="s.w - 28" height="3" rx="1.5" class="rv-mini-track" />
        <rect x="14" :y="s.h - 9" :width="(s.w - 28) * (s.job ? jobProgress(s.job) : 0)" height="3" rx="1.5" class="rv-mini-bar" />
        <g v-if="s.state === 'success' || s.state === 'failure'" :transform="'translate(' + (s.w - 22) + ',22)'">
          <g class="rv-stamp"><circle r="13" /><text y="5" text-anchor="middle">{{ s.state === 'success' ? '✓' : '✕' }}</text></g>
        </g>
        <circle v-if="s.state === 'success'" class="rv-burst" :cx="s.w - 22" cy="22" r="13" />
      </g>
    </svg>
    <div class="rv-legend small muted"><span><i class="lg st-running"></i>running</span><span><i class="lg st-success"></i>passed</span><span><i class="lg st-failure"></i>failed</span><span><i class="lg st-queued"></i>waiting</span><span><i class="lg st-held"></i>waits for you</span></div>
  </div>`,
};

/* ------------------------------------------------------------------ the dialog */
export const RunViewer = {
  props: { projectId: Number, runId: Number },
  components: { ProView, AnimView },
  setup(props) {
    const data = ref(null);
    const error = ref('');
    const now = ref(Date.now());
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
    let pollT = null;
    let tickT = null;
    let alive = true;
    const running = computed(() => data.value && data.value.run.status !== 'completed');
    async function load() {
      try {
        data.value = await http.get(`/projects/${props.projectId}/ci/runs/${props.runId}/live`);
        error.value = '';
      } catch (e) {
        error.value = e.message;
      }
      if (alive && (!data.value || running.value)) pollT = setTimeout(load, POLL_MS);
    }
    onMounted(() => {
      load();
      tickT = setInterval(() => (now.value = Date.now()), 1000);
    });
    onUnmounted(() => {
      alive = false;
      clearTimeout(pollT);
      clearInterval(tickT);
    });
    const st = computed(() => (data.value ? stateOf(data.value.run) : 'queued'));
    const total = computed(() => {
      if (!data.value) return '';
      const a = ms(data.value.run.started_at);
      const b = data.value.run.status === 'completed' ? ms(data.value.run.updated_at) : now.value;
      return a ? dur(b - a) : '';
    });
    const eventText = (e) => ({ push: 'push', pull_request: 'pull request', workflow_dispatch: 'run by hand', schedule: 'schedule' })[e] || e;
    // Errors after this run's deploy? Deploy an older commit of the branch again.
    const rollBack = () => openDialog('deploy-plan', { projectId: props.projectId, rollback: true });
    // A server that waits for you with this commit: deploy it now (your workflow runs again for that server only).
    const deploying = ref(false);
    async function deployHeld(h) {
      if (!h || deploying.value) return;
      deploying.value = true;
      try {
        const r = await http.post(`/held-deploys/${h.id}/deploy`);
        toast(r.message || `Deploy of ${h.server_name} started`, 'success');
        if (r.job) showJob(r.job.id);
        else {
          clearTimeout(pollT);
          await load();
        }
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        deploying.value = false;
      }
    }
    // Stop the run on GitHub. A second click (it hangs on clean-up steps) force-stops it.
    const stopping = ref(false);
    const sentAt = ref(0);
    async function cancelRun() {
      const force = !!sentAt.value;
      const servers = [...new Set(data.value.jobs.filter((j) => j.server && j.status !== 'completed').map((j) => j.server.name))];
      const ok = await confirmBox({
        title: `${force ? 'Force-stop' : 'Cancel'} run #${data.value.run.number}?`,
        message: (force ? 'GitHub stops it right away and also skips its clean-up steps.' : 'GitHub stops the jobs that are running now and does not start the others.') + (servers.length ? ` Running on ${servers.join(', ')} now — a deploy cut off halfway can leave a server between two versions.` : ''),
        confirmText: force ? 'Force-stop' : 'Cancel run',
        danger: true,
      });
      if (!ok) return;
      stopping.value = true;
      try {
        await http.post(`/projects/${props.projectId}/ci/runs/${props.runId}/cancel`, { force });
        sentAt.value = Date.now();
        toast(`${force ? 'Force-stop' : 'Cancel'} sent to GitHub`, 'success');
        clearTimeout(pollT);
        pollT = setTimeout(load, 2000);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        stopping.value = false;
      }
    }
    return { data, error, view, now, running, st, total, eventText, LABEL, BADGE, closeDialog, rollBack, cancelRun, stopping, sentAt, deployHeld, deploying };
  },
  template: `
  <modal :title="data ? 'Run #' + data.run.number + ' · ' + data.run.title : 'Run'" size="xl" @close="closeDialog">
    <div v-if="error && !data" class="alert alert-error"><span class="alert-icon">✖</span><span>{{ error }}</span></div>
    <div v-else-if="!data" class="muted"><span class="spinner"></span> Asking GitHub…</div>
    <div v-else class="rv">
      <div class="rv-top">
        <div class="rv-meta">
          <span class="badge" :class="BADGE[st]">{{ LABEL[st] }}</span>
          <span v-if="running" class="live-pill live-live"><i></i>LIVE</span>
          <span class="small"><span class="muted">{{ eventText(data.run.event) }} on</span> <code>{{ data.run.branch }}</code></span>
          <span class="small mono muted">{{ (data.run.sha || '').slice(0, 7) }}</span>
          <span class="small muted" v-if="data.run.actor">by {{ data.run.actor }}</span>
          <span class="small mono">{{ total }}</span>
        </div>
        <div class="seg rv-switch" role="tablist" aria-label="View">
          <button type="button" role="tab" :aria-selected="view === 'pro'" :class="{ on: view === 'pro' }" @click="view = 'pro'">Professional</button>
          <button type="button" role="tab" :aria-selected="view === 'anim'" :class="{ on: view === 'anim' }" @click="view = 'anim'">Animated</button>
        </div>
      </div>
      <div v-if="error" class="hint text-amber">Could not refresh: {{ error }} (showing the last data)</div>
      <div v-for="h in (data.held || [])" :key="h.id" class="rv-held-bar">
        <span><span class="rv-hourglass">⏳</span> <b>{{ h.server_name }}</b> <span class="badge badge-green">LIVE</span> waits for you — commit <code>{{ (data.run.sha || '').slice(0, 7) }}</code>{{ h.run_at ? ' (or at the quiet time)' : '' }}</span>
        <button class="btn btn-sm btn-primary dev-only" @click="deployHeld(h)" :disabled="deploying"><span v-if="deploying" class="spinner"></span>Deploy {{ h.server_name }} now</button>
      </div>
      <pro-view v-if="view === 'pro'" :data="data" :now="now" />
      <anim-view v-else :data="data" :now="now" @deploy="deployHeld" />
    </div>
    <template #footer>
      <span class="muted small" v-if="data">{{ running ? (sentAt ? 'Stopping… updates every 5 seconds' : 'Updates every 5 seconds') : 'Finished' }}</span>
      <button v-if="running" class="btn btn-danger dev-only" @click="cancelRun" :disabled="stopping">{{ sentAt ? 'Force-stop' : 'Cancel run' }}</button>
      <button v-if="data && !running && data.run.event !== 'pull_request'" class="btn dev-only" :class="{ 'btn-danger': st === 'failure' }" @click="rollBack" title="Deploy an older commit of the branch again">↩ Roll back…</button>
      <a v-if="data" class="btn btn-ghost" :href="data.run.html_url" target="_blank" rel="noopener">Open in GitHub ↗</a>
      <button class="btn" @click="closeDialog">Close</button>
    </template>
  </modal>`,
};

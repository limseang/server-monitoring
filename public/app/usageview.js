import { ref, computed, watch, onMounted, nextTick } from '/vendor/vue.js';
import { store, http, toast, bytes, fmtDate } from './lib.js';
import { useLive, LivePill, LiveNum, reducedMotion, useTween } from './live.js';

/* ------------------------------------------------------------------ line chart (crosshair + tooltip) */
const niceMax = (v) => {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
};
const timeLabel = (t, spanMin) =>
  spanMin <= 15
    ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : spanMin > 1440 ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

let clipSeq = 0;

export const LineChart = {
  props: {
    series: Array, // [{ t, ...values }]
    lines: Array, // [{ k, label, color }]
    fixedMax: Number, // e.g. 100 for percentages
    fmt: { type: Function, default: (v) => String(v) },
    bands: { type: Array, default: () => [] }, // [{ from, to }] ISO — shaded busy times
    limits: { type: Array, default: () => [] }, // [{ v, label }] dashed lines
    spanMin: Number,
    perPoint: Number,
    label: String,
    xTicks: { type: Number, default: 6 },
    // live mode: a fixed window of `capacity` readings that scrolls left by itself, curved lines
    capacity: Number,
    every: { type: Number, default: 2 }, // seconds between live readings (scroll speed)
    smooth: Boolean,
  },
  setup(props) {
    const W = 900;
    const H = 200;
    const PAD = { l: 52, r: 8, t: 10, b: 24 };
    const hover = ref(null);
    const n = computed(() => props.series?.length || 0);
    const rawMax = computed(() => props.fixedMax || niceMax(Math.max(1, ...(props.series || []).flatMap((p) => props.lines.map((l) => p[l.k] ?? 0)))));
    // live: when the scale changes (e.g. a network burst) it stretches smoothly instead of jumping
    const maxTw = props.capacity ? useTween(() => rawMax.value, { duration: 700 }) : null;
    const max = computed(() => (maxTw ? maxTw.value : rawMax.value));
    const stepC = computed(() => (W - PAD.l - PAD.r) / Math.max(1, (props.capacity || 2) - 1));
    // live: newest reading at the right edge, older ones one fixed step further left each
    const x = (i) => (props.capacity ? W - PAD.r - (n.value - 1 - i) * stepC.value : PAD.l + (n.value <= 1 ? 0 : (i / (n.value - 1)) * (W - PAD.l - PAD.r)));
    const y = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - Math.min(v, max.value) / max.value);
    const f = (v) => v.toFixed(1);
    const clampY = (v) => Math.min(H - PAD.b, Math.max(PAD.t, v));
    // Catmull-Rom → cubic Bézier: a soft curve through every reading
    function seg(pts) {
      if (!props.smooth || pts.length < 3) return pts.map((p, j) => `${j ? 'L' : 'M'}${f(p[0])},${f(p[1])}`).join('');
      let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
      for (let j = 0; j < pts.length - 1; j++) {
        const p0 = pts[j - 1] || pts[j];
        const p1 = pts[j];
        const p2 = pts[j + 1];
        const p3 = pts[j + 2] || p2;
        d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(clampY(p1[1] + (p2[1] - p0[1]) / 6))} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(clampY(p2[1] - (p3[1] - p1[1]) / 6))} ${f(p2[0])},${f(p2[1])}`;
      }
      return d;
    }
    // gaps (no samples) break the line instead of drawing to zero
    const paths = computed(() =>
      props.lines.map((l) => {
        let d = '';
        let pts = [];
        (props.series || []).forEach((p, i) => {
          const v = p[l.k];
          if (v == null) {
            if (pts.length) d += seg(pts);
            pts = [];
            return;
          }
          pts.push([x(i), y(v)]);
        });
        if (pts.length) d += seg(pts);
        const dots = (props.series || []).map((p, i) => ({ i, v: p[l.k] })).filter((p, j, a) => p.v != null && (a[j - 1]?.v == null) && (a[j + 1]?.v == null));
        return { ...l, d, dots };
      }),
    );
    const t0 = computed(() => Date.parse(props.series?.[0]?.t || 0));
    const t1 = computed(() => Date.parse(props.series?.[n.value - 1]?.t || 0));
    const xt = (ms) => PAD.l + (t1.value > t0.value ? ((ms - t0.value) / (t1.value - t0.value)) * (W - PAD.l - PAD.r) : 0);
    const bandRects = computed(() =>
      props.bands
        .map((b) => {
          const a = Math.max(PAD.l, xt(Date.parse(b.from)));
          const z = Math.min(W - PAD.r, xt(b.to ? Date.parse(b.to) : Date.now()));
          return z > a ? { x: a, w: Math.max(2, z - a) } : null;
        })
        .filter(Boolean),
    );
    const ticks = computed(() => [0, 0.5, 1].map((f) => ({ v: max.value * f, y: y(max.value * f) })));
    const xlabels = computed(() => {
      const s = props.series || [];
      if (props.capacity) {
        // live: labels stick to their reading (by sequence number) and slide left with it
        const step = Math.max(1, Math.floor(props.capacity / props.xTicks));
        return s
          .map((p, i) => ({ i, p }))
          .filter((q) => q.p.seq != null && q.p.seq % step === 0 && x(q.i) > PAD.l + 30)
          .map((q) => ({ key: q.p.seq, x: x(q.i), t: timeLabel(q.p.t, props.spanMin) }));
      }
      const step = Math.max(1, Math.floor(s.length / props.xTicks));
      return s.map((p, i) => ({ i, p })).filter((q) => q.i % step === 0).map((q) => ({ key: q.i, x: x(q.i), t: timeLabel(q.p.t, props.spanMin) }));
    });
    // live: each new reading slides the lines one step left over the time until the next one
    const shift = ref(0);
    const gliding = ref(false);
    watch(
      () => props.series?.[n.value - 1]?.t,
      (t, old) => {
        if (!props.capacity || !old || !t || reducedMotion() || document.hidden) return;
        gliding.value = false;
        shift.value = stepC.value;
        nextTick(() => requestAnimationFrame(() => requestAnimationFrame(() => ((gliding.value = true), (shift.value = 0)))));
      },
    );
    const scrollStyle = computed(() => ({ transform: `translateX(${shift.value}px)`, transition: gliding.value ? `transform ${props.every}s linear` : 'none' }));
    const clipId = `lc${++clipSeq}`;
    const heads = computed(() => {
      if (!props.capacity || !n.value) return [];
      const last = props.series[n.value - 1];
      return props.lines.filter((l) => last[l.k] != null).map((l) => ({ k: l.k, color: l.color, left: (x(n.value - 1) / W) * 100, top: (y(last[l.k]) / H) * 220 }));
    });
    function move(ev) {
      const r = ev.currentTarget.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = props.capacity ? n.value - 1 - Math.round((W - PAD.r - px) / stepC.value) : Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n.value - 1));
      hover.value = i >= 0 && i < n.value ? { i, p: props.series[i], x: x(i) } : null;
    }
    const per = computed(() => (props.perPoint === 0 ? 'live reading' : props.perPoint > 1 ? `avg of ${props.perPoint >= 60 ? props.perPoint / 60 + ' h' : props.perPoint + ' min'}` : 'per minute'));
    return { W, H, PAD, hover, paths, ticks, xlabels, bandRects, y, move, per, scrollStyle, clipId, heads };
  },
  template: `
  <div class="tchart" :class="{ 'tchart-live': capacity }" :style="capacity ? { '--live-every': every + 's' } : null">
    <div class="tchart-legend" v-if="lines.length > 1"><span v-for="l in lines" :key="l.k"><i :style="{ background: l.color }"></i>{{ l.label }}</span><span v-if="bands.length"><i class="uchart-band-key"></i>busy</span></div>
    <div class="tchart-wrap" @mouseleave="hover = null">
      <svg :viewBox="'0 0 ' + W + ' ' + H" preserveAspectRatio="none" class="tchart-svg" role="img" :aria-label="label" @mousemove="move">
        <rect v-for="(b, i) in bandRects" :key="'b' + i" :x="b.x" :y="PAD.t" :width="b.w" :height="H - PAD.t - PAD.b" class="uchart-band" />
        <line v-for="(t, ti) in ticks" :key="ti" :x1="PAD.l" :x2="W - PAD.r" :y1="t.y" :y2="t.y" class="tchart-grid" />
        <line v-for="l in limits" :key="'l' + l.v + l.label" :x1="PAD.l" :x2="W - PAD.r" :y1="y(l.v)" :y2="y(l.v)" class="uchart-limit" />
        <defs v-if="capacity"><clipPath :id="clipId"><rect :x="PAD.l" :y="0" :width="W - PAD.l - PAD.r" :height="H" /></clipPath></defs>
        <g :clip-path="capacity ? 'url(#' + clipId + ')' : null"><g :style="capacity ? scrollStyle : null">
          <path v-for="p in paths" :key="p.k" :d="p.d" fill="none" :stroke="p.color" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
        </g></g>
        <line v-if="hover" :x1="hover.x" :x2="hover.x" :y1="PAD.t" :y2="H - PAD.b" class="uchart-cross" />
      </svg>
      <div class="tchart-y"><span v-for="(t, ti) in ticks" :key="ti" :style="{ top: (t.y / H * 100) + '%' }">{{ fmt(t.v) }}</span></div>
 <span v-for="h in heads" :key="'h' + h.k" class="live-head" :style="{ left: h.left + '%', top: h.top + 'px', '--c': h.color }"></span>
      <div class="tchart-x"><span v-for="l in xlabels" :key="l.key" :style="{ left: (l.x / W * 100) + '%' }">{{ l.t }}</span></div>
      <template v-if="hover"><span v-for="p in paths" :key="'d' + p.k" v-show="hover.p[p.k] != null" class="uchart-dot" :style="{ left: (hover.x / W * 100) + '%', top: (y(hover.p[p.k] ?? 0) / H * 220) + 'px', background: p.color }"></span></template>
      <div v-if="hover" class="tchart-tip" :style="{ left: Math.min(85, Math.max(12, (hover.x / W) * 100)) + '%' }">
        <b>{{ new Date(hover.p.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: perPoint === 0 ? '2-digit' : undefined }) }}</b> · {{ per }}
        <div v-for="l in lines" :key="l.k" class="tchart-tip-row"><span><i :style="{ background: l.color }"></i>{{ l.label }}</span><b>{{ hover.p[l.k] == null ? 'no data' : fmt(hover.p[l.k]) }}<template v-if="hover.p[l.k + '_max'] != null && hover.p[l.k + '_max'] !== hover.p[l.k]"> <span class="muted">(max {{ fmt(hover.p[l.k + '_max']) }})</span></template></b></div>
      </div>
    </div>
  </div>`,
};

/* ------------------------------------------------------------------ Usage history tab */
const CAUSE = {
  traffic: { label: 'High traffic', badge: 'badge-red', fix: 'Add a server to the load balancer' },
  memory: { label: 'Memory full', badge: 'badge-amber', fix: 'Restart / free memory' },
  cpu: { label: 'Heavy work', badge: 'badge-blue', fix: 'Check containers, restart' },
};

/** Live now: a reading every 2 seconds while this tab is open (not stored). */
export const LiveUsage = {
  props: { server: Object },
  components: { LineChart, LivePill, LiveNum },
  setup(props) {
    const samples = ref([]);
    let seq = 0; // numbers each reading, so chart labels can travel with it
    const every = ref(2);
    const error = ref('');
    const live = useLive(() => `/servers/${props.server.id}/live?metrics=1`, {
      init(d) {
        every.value = d.every || 2;
        samples.value = (d.samples || []).map((x) => ({ ...x, seq: seq++ }));
        error.value = d.error || '';
      },
      sample(s) {
        error.value = '';
        samples.value = [...samples.value.slice(-149), { ...s, seq: seq++ }];
      },
      status(d) {
        error.value = d.ok ? '' : d.error;
      },
    });
    const last = computed(() => samples.value[samples.value.length - 1]);
    const hasGpu = computed(() => samples.value.some((s) => s.gpu != null));
    const resLines = computed(() => [
      { k: 'cpu', label: 'CPU', color: 'var(--series-1)' },
      { k: 'mem', label: 'Memory', color: 'var(--series-2)' },
      ...(hasGpu.value ? [{ k: 'gpu', label: 'GPU', color: 'var(--series-3)' }] : []),
    ]);
    const netLines = [
      { k: 'net_rx', label: 'In', color: 'var(--series-1)' },
      { k: 'net_tx', label: 'Out', color: 'var(--series-2)' },
    ];
    const pctFmt = (v) => `${Math.round(v)}%`;
    const rateFmt = (v) => `${bytes(v)}/s`;
    const span = computed(() => Math.max(1, Math.round((samples.value.length * every.value) / 60)));
    return { live, samples, every, error, last, hasGpu, resLines, netLines, pctFmt, rateFmt, span, bytes };
  },
  template: `
  <div class="card card-body live-card">
    <div class="row between wrap gap-8 mb-12">
      <div><h3 class="row gap-8">Live now <live-pill :state="live.state.value" :every="every" /></h3><div class="hint">A reading every {{ every }} seconds while this page is open — the last {{ span }} min</div></div>
      <div class="row gap-6">
        <button v-if="live.state.value === 'paused'" class="btn btn-xs" @click="live.resume()">▶ Live</button>
        <button v-else class="btn btn-xs btn-ghost" @click="live.pause()">❚❚ Pause</button>
      </div>
    </div>
    <div v-if="error" class="alert alert-warn mb-12"><span class="alert-icon">⚠</span><span>{{ error }}</span></div>
    <div class="tiles live-tiles">
      <div class="tile"><div class="tile-label">CPU</div><div class="tile-value"><live-num :value="last?.cpu" /><span class="muted">%</span></div><div class="tile-sub">load {{ (last?.load || []).join(' · ') || '—' }}</div></div>
      <div class="tile"><div class="tile-label">Memory</div><div class="tile-value"><live-num :value="last?.mem" /><span class="muted">%</span></div><div class="tile-sub">{{ last ? bytes(last.mem_used) + ' of ' + bytes(last.mem_total) : '—' }}</div></div>
      <div class="tile" v-if="hasGpu"><div class="tile-label">GPU</div><div class="tile-value"><live-num :value="last?.gpu" /><span class="muted">%</span></div><div class="tile-sub">NVIDIA</div></div>
      <div class="tile"><div class="tile-label">Network</div><div class="tile-value small-value">↓ <live-num :value="last?.net_rx" :fmt="rateFmt" /></div><div class="tile-sub">↑ <live-num :value="last?.net_tx" :fmt="rateFmt" /> out</div></div>
    </div>
    <div v-if="samples.length > 1" class="grid grid-2 mt-8">
      <line-chart :series="samples" :lines="resLines" :fixed-max="100" :fmt="pctFmt" :span-min="5" :per-point="0" :x-ticks="4" :capacity="150" :every="every" smooth label="Live CPU and memory use in percent" />
      <line-chart :series="samples" :lines="netLines" :fmt="rateFmt" :span-min="5" :per-point="0" :x-ticks="4" :capacity="150" :every="every" smooth label="Live network bytes per second" />
    </div>
    <div v-else-if="live.state.value !== 'paused'" class="muted small mt-8">Waiting for the first readings…</div>
  </div>`,
};

export const UsageTab = {
  props: { server: Object },
  components: { LineChart, LiveUsage },
  setup(props) {
    const minutes = ref(1440);
    const u = ref(null);
    const showTable = ref(false);
    async function load() {
      try {
        u.value = await http.get(`/servers/${props.server.id}/usage?minutes=${minutes.value}`);
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    onMounted(load);
    watch(minutes, load);
    watch(() => store.live, load);
    const RANGES = [[60, '1 hour'], [360, '6 hours'], [1440, '24 hours'], [10080, '7 days'], [43200, '30 days']];
    const pctFmt = (v) => `${Math.round(v)}%`;
    const rateFmt = (v) => `${bytes(v)}/s`;
    const numFmt = (v) => (v >= 1e4 ? `${Math.round(v / 1e3)}k` : String(Math.round(v * 10) / 10));
    const resLines = computed(() => [
      { k: 'cpu', label: 'CPU', color: 'var(--series-1)' },
      { k: 'mem', label: 'Memory', color: 'var(--series-2)' },
      ...(u.value?.has_gpu ? [{ k: 'gpu', label: 'GPU', color: 'var(--series-3)' }] : []),
    ]);
    const netLines = [
      { k: 'net_rx', label: 'In (download)', color: 'var(--series-1)' },
      { k: 'net_tx', label: 'Out (upload)', color: 'var(--series-2)' },
    ];
    const bands = computed(() => (u.value?.periods || []).map((p) => ({ from: p.started_at, to: p.ended_at })));
    const limits = computed(() =>
      u.value ? [{ v: u.value.thresholds.cpu, label: 'CPU limit' }, ...(u.value.thresholds.mem !== u.value.thresholds.cpu ? [{ v: u.value.thresholds.mem, label: 'Memory limit' }] : [])] : [],
    );
    const hasRpm = computed(() => u.value?.series.some((p) => p.rpm != null));
    const dur = (m) => (m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 1440)} days`);
    const everyText = computed(() => {
      const s = u.value?.interval || 300;
      return s < 60 ? `${s} s` : s % 60 ? `${s} s` : `${s / 60} min`;
    });
    const adviceCls = computed(() => ({ good: 'alert-success', warn: 'alert-warn', bad: 'alert-error', info: 'alert-info' })[u.value?.advice.level] || 'alert-info');
    return { minutes, u, RANGES, pctFmt, rateFmt, numFmt, resLines, netLines, bands, limits, hasRpm, dur, everyText, CAUSE, fmtDate, showTable, adviceCls, bytes };
  },
  template: `
  <div v-if="!u" class="muted">Loading…</div>
  <div v-else class="stack">
    <live-usage :server="server" />
    <div class="row between wrap gap-8">
      <div class="seg"><button v-for="r in RANGES" :key="r[0]" :class="{ on: minutes === r[0] }" @click="minutes = r[0]">{{ r[1] }}</button></div>
      <span class="muted small">a reading every {{ everyText }} · busy = CPU ≥ {{ u.thresholds.cpu }}% or memory ≥ {{ u.thresholds.mem }}% for {{ u.thresholds.minutes }} min (Settings → Monitoring)</span>
    </div>

    <div class="alert" :class="adviceCls"><span class="alert-icon">{{ u.advice.level === 'good' ? '✓' : u.advice.level === 'info' ? 'ℹ' : '⚠' }}</span><span>{{ u.advice.text }}</span></div>

    <div class="tiles">
      <div class="tile"><div class="tile-label">CPU</div><div class="tile-value">{{ u.summary.cpu_avg ?? '—' }}<span class="muted">%</span></div><div class="tile-sub">average · peak {{ u.summary.cpu_peak ?? '—' }}%</div></div>
      <div class="tile"><div class="tile-label">Memory</div><div class="tile-value">{{ u.summary.mem_avg ?? '—' }}<span class="muted">%</span></div><div class="tile-sub">average · peak {{ u.summary.mem_peak ?? '—' }}%</div></div>
      <div class="tile"><div class="tile-label">Requests / min</div><div class="tile-value">{{ u.summary.rpm_avg ?? '—' }}</div><div class="tile-sub">average · busiest minute {{ u.summary.rpm_peak ?? '—' }}</div></div>
      <div class="tile" :class="{ 'tile-bad': u.summary.busy_count }"><div class="tile-label">Busy</div><div class="tile-value">{{ u.summary.busy_count }}<span class="muted"> {{ u.summary.busy_count === 1 ? 'time' : 'times' }}</span></div><div class="tile-sub">{{ u.summary.busy_count ? dur(u.summary.busy_minutes) + ' in total' : 'never in this period' }}</div></div>
    </div>

    <div class="card card-body">
      <div class="row between mb-12"><div><h3>CPU &amp; memory{{ u.has_gpu ? ' & GPU' : '' }}</h3><div class="hint">Dashed line = busy limit · shaded = busy times</div></div><button class="btn btn-xs btn-ghost" @click="showTable = !showTable">{{ showTable ? 'Chart' : 'Table' }}</button></div>
      <line-chart v-if="!showTable" :series="u.series" :lines="resLines" :fixed-max="100" :fmt="pctFmt" :bands="bands" :limits="limits" :span-min="u.minutes" :per-point="u.per_point" label="CPU and memory use in percent over time" />
      <div v-else class="table-wrap" style="max-height:320px;overflow:auto"><table class="table">
        <thead><tr><th>From</th><th>CPU avg</th><th>CPU max</th><th>Memory avg</th><th>Memory max</th><th v-if="u.has_gpu">GPU</th><th v-if="hasRpm">Req/min</th><th v-if="u.has_net">Network in / out</th></tr></thead>
        <tbody><tr v-for="p in u.series.filter(x => x.n).slice().reverse()" :key="p.t"><td class="small">{{ fmtDate(p.t) }}</td><td>{{ p.cpu }}%</td><td>{{ p.cpu_max }}%</td><td>{{ p.mem }}%</td><td>{{ p.mem_max }}%</td><td v-if="u.has_gpu">{{ p.gpu ?? '—' }}%</td><td v-if="hasRpm">{{ p.rpm }}</td><td v-if="u.has_net" class="small">{{ bytes(p.net_rx) }}/s · {{ bytes(p.net_tx) }}/s</td></tr></tbody>
      </table></div>
      <div v-if="!u.summary.samples" class="empty">No readings in this period yet.</div>
    </div>

    <div class="grid grid-2">
      <div class="card card-body">
        <h3 class="mb-12">Requests per minute</h3>
        <line-chart v-if="hasRpm" :series="u.series" :lines="[{ k: 'rpm', label: 'Requests / min', color: 'var(--series-1)' }]" :fmt="numFmt" :bands="bands" :span-min="u.minutes" :per-point="u.per_point" :x-ticks="4" label="Requests per minute over time" />
        <div v-else class="empty">No request data — the Traffic tab reads nginx logs (kept 8 days).</div>
      </div>
      <div class="card card-body" style="margin-top:0">
        <h3 class="mb-12">Network</h3>
        <line-chart v-if="u.has_net" :series="u.series" :lines="netLines" :fmt="rateFmt" :bands="bands" :span-min="u.minutes" :per-point="u.per_point" :x-ticks="4" label="Network bytes per second in and out over time" />
        <div v-else class="empty">No network readings yet.</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>Busy times</h3><div class="hint">Every time this server was busy, kept for a year. Alerts also go to Telegram / your webhook.</div></div></div>
      <div v-if="!u.periods.length" class="empty">Never busy so far 👍</div>
      <div v-else class="table-wrap"><table class="table">
        <thead><tr><th>When</th><th>How long</th><th>Peak CPU / memory</th><th>Requests / min</th><th>Why</th><th>What helps</th></tr></thead>
        <tbody><tr v-for="p in u.periods" :key="p.id">
          <td class="small">{{ fmtDate(p.started_at) }}<span v-if="!p.ended_at" class="badge badge-red" style="margin-left:6px">now</span></td>
          <td class="small">{{ dur(p.minutes) }}</td>
          <td class="small">{{ p.peak_cpu ?? '—' }}% / {{ p.peak_mem ?? '—' }}%<span v-if="p.peak_gpu != null" class="muted"> · GPU {{ p.peak_gpu }}%</span></td>
          <td class="small"><template v-if="p.avg_rpm != null">{{ p.avg_rpm }} <span class="muted">(usual {{ p.baseline_rpm }}, top {{ p.peak_rpm }})</span></template><span v-else class="muted">no log data</span></td>
          <td><span class="badge" :class="(CAUSE[p.cause] || CAUSE.cpu).badge">{{ (CAUSE[p.cause] || CAUSE.cpu).label }}</span></td>
          <td class="small muted">{{ (CAUSE[p.cause] || CAUSE.cpu).fix }}</td>
        </tr></tbody>
      </table></div>
    </div>
  </div>`,
};

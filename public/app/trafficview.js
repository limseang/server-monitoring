import { ref, computed, watch, onMounted, onUnmounted, nextTick } from '/vendor/vue.js';
import { store, http, toast, openDialog, bytes, fmtDate } from './lib.js';
import { useLive, LivePill, LiveNum } from './live.js';

/* ------------------------------------------------------------------ stacked bar chart */
const CLASSES = [
  { k: 's2', label: '2xx OK', color: 'var(--green)' },
  { k: 's3', label: '3xx redirect', color: 'var(--blue)' },
  { k: 's4', label: '4xx client error', color: 'var(--amber)' },
  { k: 's5', label: '5xx server error', color: 'var(--red)' },
];

const niceMax = (v) => {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
};

export const TrafficChart = {
  props: { series: Array, perBar: Number },
  setup(props) {
    const W = 900;
    const H = 220;
    const PAD = { l: 44, r: 8, t: 10, b: 24 };
    const hover = ref(null);
    const max = computed(() => niceMax(Math.max(1, ...(props.series || []).map((b) => b.req))));
    const bw = computed(() => (W - PAD.l - PAD.r) / Math.max(1, props.series?.length || 1));
    const y = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max.value);
    const bars = computed(() =>
      (props.series || []).map((b, i) => {
        let acc = 0;
        const segs = [];
        for (const c of CLASSES) {
          const v = b[c.k];
          if (!v) continue;
          const y0 = y(acc);
          const y1 = y(acc + v);
          acc += v;
          // 2px surface gap between stacked segments
          const h = Math.max(1, y0 - y1 - (segs.length ? 2 : 0));
          segs.push({ color: c.color, y: y1, h });
        }
        return { i, x: PAD.l + i * bw.value + Math.min(1.5, bw.value * 0.15), w: Math.max(1, bw.value - Math.min(3, bw.value * 0.3)), segs, b };
      }),
    );
    const ticks = computed(() => [0, 0.5, 1].map((f) => ({ v: Math.round(max.value * f), y: y(max.value * f) })));
    const labels = computed(() => {
      const s = props.series || [];
      if (!s.length) return [];
      const step = Math.max(1, Math.floor(s.length / 6));
      return s.map((b, i) => ({ i, b })).filter((x) => x.i % step === 0).map((x) => ({ x: PAD.l + x.i * bw.value + bw.value / 2, t: new Date(x.b.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }));
    });
    const per = computed(() => (props.perBar >= 1 ? `${props.perBar} min` : 'minute'));
    return { W, H, PAD, hover, bars, ticks, labels, bw, CLASSES, per };
  },
  template: `
  <div class="tchart">
    <div class="tchart-legend"><span v-for="c in CLASSES" :key="c.k"><i :style="{ background: c.color }"></i>{{ c.label }}</span></div>
    <div class="tchart-wrap" @mouseleave="hover = null">
      <svg :viewBox="'0 0 ' + W + ' ' + H" preserveAspectRatio="none" class="tchart-svg tchart-bars" role="img" aria-label="Requests per time slot, stacked by response status">
        <g v-for="t in ticks" :key="t.v"><line :x1="PAD.l" :x2="W - PAD.r" :y1="t.y" :y2="t.y" class="tchart-grid" /></g>
        <g v-for="bar in bars" :key="bar.b.t" @mouseenter="hover = bar">
          <rect :x="PAD.l + bar.i * bw" :y="PAD.t" :width="bw" :height="H - PAD.t - PAD.b" fill="transparent" />
          <rect v-for="(s, j) in bar.segs" :key="j" class="tbar" :x="bar.x" :y="s.y" :width="bar.w" :height="s.h" :fill="s.color" rx="1.5" :opacity="hover && hover.i !== bar.i ? 0.45 : 1" />
        </g>
      </svg>
      <div class="tchart-y"><span v-for="t in ticks" :key="t.v" :style="{ top: (t.y / H * 100) + '%' }">{{ t.v }}</span></div>
      <div class="tchart-x"><span v-for="l in labels" :key="l.x" :style="{ left: (l.x / W * 100) + '%' }">{{ l.t }}</span></div>
      <div v-if="hover" class="tchart-tip" :style="{ left: Math.min(85, Math.max(8, (hover.x / W) * 100)) + '%' }">
        <b>{{ new Date(hover.b.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}</b> · {{ per }}
        <div class="tchart-tip-row"><span>Requests</span><b>{{ hover.b.req }}</b></div>
        <div v-for="c in CLASSES" :key="c.k" class="tchart-tip-row"><span><i :style="{ background: c.color }"></i>{{ c.label }}</span><b>{{ hover.b[c.k] }}</b></div>
      </div>
    </div>
  </div>`,
};

/* ------------------------------------------------------------------ Traffic tab */
export const TrafficTab = {
  props: { server: Object },
  components: { TrafficChart, LivePill, LiveNum },
  setup(props) {
    const minutes = ref(60);
    const t = ref(null);
    const showTable = ref(false);
    let loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        t.value = await http.get(`/servers/${props.server.id}/traffic?minutes=${minutes.value}`);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        loading = false;
      }
    }
    // Live: while this tab is open the server reads the nginx logs every 5 s (instead of every minute).
    const liveErr = ref('');
    const every = ref(5);
    const live = useLive(() => `/servers/${props.server.id}/live?traffic=1`, {
      init: (d) => ((every.value = d.every || 5), (liveErr.value = d.error || '')),
      traffic: () => ((liveErr.value = ''), load()),
      status: (d) => (liveErr.value = d.ok ? '' : d.error),
    });
    onMounted(load);
    watch(minutes, load);
    watch(() => store.live, load);
    const errPct = computed(() => (t.value?.total.req ? Math.round((t.value.total.s5 / t.value.total.req) * 1000) / 10 : 0));
    const notFound = computed(() => (t.value?.total.req ? Math.round((t.value.total.s4 / t.value.total.req) * 1000) / 10 : 0));
    const RANGES = [[60, '1 hour'], [360, '6 hours'], [1440, '24 hours'], [10080, '7 days']];
    const collecting = ref(false);
    async function collectNow() {
      collecting.value = true;
      try {
        const r = await http.post(`/servers/${props.server.id}/traffic/collect`);
        if (!r.ok) toast(r.error, 'error');
        await load();
      } finally {
        collecting.value = false;
      }
    }
    const switchAway = (p) => (location.hash = `#/projects/${p.id}`);
    const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString());
    return { live, liveErr, every, collecting, collectNow, minutes, t, showTable, errPct, notFound, RANGES, switchAway, fmt, bytes, fmtDate, load };
  },
  template: `
  <div v-if="!t" class="muted">Loading…</div>
  <div v-else class="stack">
    <div v-if="liveErr && liveErr !== t.error" class="alert alert-warn"><span class="alert-icon">⚠</span><span>Live: {{ liveErr }}</span></div>
    <div v-if="t.error" class="alert alert-warn"><span class="alert-icon">⚠</span><span>Traffic: {{ t.error }}</span></div>
    <div v-if="!t.sources.length && !t.error" class="alert alert-info"><span class="alert-icon">ℹ</span><span>Looking for nginx access logs on this server — the first numbers appear within 1–2 minutes.</span></div>
    <div v-if="t.live_for.length" class="alert alert-info"><span class="alert-icon">●</span><span><b>Live server</b> for {{ t.live_for.map(p => p.name).join(', ') }}. If something looks wrong here, <a v-for="p in t.live_for" :key="p.id" :href="'#/projects/' + p.id">switch {{ p.name }} to a standby</a>.</span></div>

    <div class="row between wrap gap-8">
      <div class="seg"><button v-for="r in RANGES" :key="r[0]" :class="{ on: minutes === r[0] }" @click="minutes = r[0]">{{ r[1] }}</button></div>
      <span class="row gap-8 wrap"><live-pill :state="live.state.value" :every="every" /><span class="muted small" v-if="t.polled_at">read <ago :at="t.polled_at" /> · {{ live.state.value === 'live' ? 'every ' + every + ' s while open' : 'every minute' }} from {{ t.sources.filter(s => s.type === 'file' || s.type === 'docker').length }} log(s)</span>
        <button v-if="live.state.value === 'paused'" class="btn btn-sm" @click="live.resume()">▶ Live</button><button v-else class="btn btn-sm btn-ghost" @click="live.pause()">❚❚ Pause</button>
        <button class="btn btn-sm dev-only" @click="collectNow" :disabled="collecting"><span v-if="collecting" class="spinner"></span><icon v-else name="refresh" />Read now</button></span>
    </div>

    <div class="tiles">
      <div class="tile"><div class="tile-label">Requests / min now</div><div class="tile-value"><live-num :value="t.rpm_now" /></div><div class="tile-sub">last 5 minutes</div></div>
      <div class="tile" :class="{ 'tile-bad': t.err_now >= 5 }"><div class="tile-label">Server errors now</div><div class="tile-value"><live-num :value="t.err_now" /><span class="muted">%</span></div><div class="tile-sub">5xx in the last 5 minutes</div></div>
      <div class="tile"><div class="tile-label">Requests</div><div class="tile-value"><live-num :value="t.total.req" :fmt="(v) => fmt(Math.round(v))" /></div><div class="tile-sub">{{ errPct }}% 5xx · {{ notFound }}% 4xx · {{ bytes(t.total.bytes) }} sent</div></div>
      <div class="tile"><div class="tile-label">Visitors (IPs)</div><div class="tile-value"><live-num :value="t.unique_ips" :fmt="(v) => fmt(Math.round(v))" /></div><div class="tile-sub">{{ t.avg_ms != null ? 'avg ' + t.avg_ms + ' ms · ' : '' }}{{ t.total.ssh_fail }} failed SSH logins</div></div>
    </div>

    <div class="card card-body">
      <div class="row between mb-12"><h3>Requests</h3><button class="btn btn-xs btn-ghost" @click="showTable = !showTable">{{ showTable ? 'Chart' : 'Table' }}</button></div>
      <traffic-chart v-if="!showTable" :series="t.series" :per-bar="t.per_bar" />
      <div v-else class="table-wrap" style="max-height:320px;overflow:auto"><table class="table">
        <thead><tr><th>From</th><th>Requests</th><th>2xx</th><th>3xx</th><th>4xx</th><th>5xx</th></tr></thead>
        <tbody><tr v-for="b in t.series.filter(x => x.req).slice().reverse()" :key="b.t"><td class="small">{{ fmtDate(b.t) }}</td><td>{{ b.req }}</td><td>{{ b.s2 }}</td><td>{{ b.s3 }}</td><td>{{ b.s4 }}</td><td>{{ b.s5 }}</td></tr></tbody>
      </table></div>
    </div>

    <div class="grid grid-3">
      <div class="card"><div class="card-head"><h3>Top pages</h3></div>
        <div class="toplist"><div v-for="[k, n] in t.top_paths" :key="k" class="toprow"><span class="mono ellipsis" :title="k">{{ k }}</span><b>{{ fmt(n) }}</b><i :style="{ width: (n / t.top_paths[0][1] * 100) + '%' }"></i></div>
          <div v-if="!t.top_paths.length" class="empty">No requests yet</div></div></div>
      <div class="card"><div class="card-head"><h3>Top IP addresses</h3></div>
        <div class="toplist"><div v-for="[k, n] in t.top_ips" :key="k" class="toprow"><span class="mono">{{ k }}</span><b>{{ fmt(n) }} <span class="muted tiny">{{ t.total.req ? Math.round(n / t.total.req * 100) : 0 }}%</span></b><i :style="{ width: (n / t.top_ips[0][1] * 100) + '%' }"></i></div>
          <div v-if="!t.top_ips.length" class="empty">—</div></div></div>
      <div class="card"><div class="card-head"><h3>Status codes &amp; clients</h3></div>
        <div class="toplist"><div v-for="[k, n] in t.statuses.slice(0, 8)" :key="k" class="toprow"><span><span class="badge" :class="k[0] === '5' ? 'badge-red' : k[0] === '4' ? 'badge-amber' : k[0] === '3' ? 'badge-blue' : 'badge-green'">{{ k }}</span></span><b>{{ fmt(n) }}</b></div>
          <div v-for="[k, n] in t.top_uas.slice(0, 5)" :key="'u' + k" class="toprow"><span class="small ellipsis muted" :title="k">{{ k }}</span><b>{{ fmt(n) }}</b></div></div></div>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>Unusual activity</h3><div class="hint">Alerts are also sent to Telegram / your webhook. Limits: Settings → Monitoring.</div></div></div>
      <div v-if="!t.events.length" class="empty">Nothing unusual 👍</div>
      <div v-else class="toplist"><div v-for="e in t.events" :key="e.id" class="toprow"><span class="small"><span class="badge" :class="e.level === 'error' ? 'badge-red' : 'badge-amber'">{{ e.level === 'error' ? 'alert' : 'warning' }}</span> {{ e.message.replace(/^Unusual on [^:]+: /, '') }}</span><span class="tiny muted nowrap"><ago :at="e.at" /></span></div></div>
    </div>
  </div>`,
};

/* ------------------------------------------------------------------ Logs tab */
const MAX_LINES = 5000;

export const LogsTab = {
  props: { server: Object },
  components: { LivePill },
  setup(props) {
    const sources = ref(null);
    const source = ref('');
    const lines = ref(200);
    const q = ref('');
    const out = ref([]);
    const err = ref('');
    const box = ref(null);
    const atBottom = ref(true); // auto-scroll only while the user is at the bottom
    const unseen = ref(0); // new lines that came in while scrolled up
    const skipped = ref(0);
    let lineId = 0; // stable keys, so only lines that are really new get the fade-in
    async function loadSources() {
      try {
        sources.value = await http.get(`/servers/${props.server.id}/log-sources`);
        source.value = sources.value[0]?.id || '';
      } catch (e) {
        err.value = e.message;
        sources.value = [];
      }
    }
    const toBottom = () =>
      nextTick(() => {
        if (box.value) box.value.scrollTop = box.value.scrollHeight;
      });
    function onScroll() {
      const el = box.value;
      if (!el) return;
      atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (atBottom.value) unseen.value = 0;
    }
    function jump() {
      unseen.value = 0;
      atBottom.value = true;
      toBottom();
    }
    // One stream: first the last N lines, then each new line as it is written (tail -F / docker logs -f).
    const live = useLive(
      () => (source.value ? `/servers/${props.server.id}/logs/live?source=${encodeURIComponent(source.value)}&lines=${lines.value}&q=${encodeURIComponent(q.value)}` : null),
      {
        lines(d) {
          err.value = '';
          const wrap = (arr, fresh) => arr.map((text) => ({ id: ++lineId, text, fresh }));
          if (d.first) {
            out.value = wrap(d.lines, false);
            skipped.value = 0;
            unseen.value = 0;
            atBottom.value = true;
          } else {
            const next = out.value.concat(wrap(d.lines, true));
            out.value = next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
            if (!atBottom.value) unseen.value += d.lines.length;
          }
          skipped.value += d.skipped || 0;
          if (atBottom.value) toBottom();
        },
        end(d) {
          if (d.error) err.value = d.error;
          if (d.fatal) live.stop();
        },
      },
    );
    onMounted(async () => {
      await loadSources();
      live.restart();
    });
    watch([source, lines], () => live.resume());
    let qt = null;
    watch(q, () => {
      clearTimeout(qt);
      qt = setTimeout(() => live.resume(), 500);
    });
    onUnmounted(() => clearTimeout(qt));
    const toggle = () => (live.state.value === 'paused' || live.state.value === 'off' ? live.resume() : live.pause());
    const cls = (l) =>
      / (5\d\d) \d+ /.test(l) || /\b(error|emerg|crit|fatal|exception|failed password|invalid user)\b/i.test(l) ? 'l-err' : / (4\d\d) \d+ /.test(l) || /\b(warn|warning)\b/i.test(l) ? 'l-warn' : '';
    return { sources, source, lines, q, out, err, box, live, toggle, onScroll, jump, atBottom, unseen, skipped, cls };
  },
  template: `
  <div class="stack">
    <div class="row gap-8 wrap logs-bar">
      <select v-model="source" style="max-width:380px" :disabled="!sources"><option v-if="!sources" value="">Finding logs on the server (a few seconds)…</option><option v-for="s in sources || []" :key="s.id" :value="s.id">{{ s.label }}</option></select>
      <select v-model.number="lines" style="max-width:120px"><option :value="100">100 lines</option><option :value="200">200 lines</option><option :value="500">500 lines</option><option :value="2000">2000 lines</option></select>
      <input v-model="q" placeholder="Filter (e.g. 500, an IP, error)…" style="max-width:260px">
      <button class="btn btn-sm" :class="{ 'btn-primary': live.state.value === 'paused' || live.state.value === 'off' }" @click="toggle" :disabled="!source">{{ live.state.value === 'paused' || live.state.value === 'off' ? '▶ Live' : '❚❚ Pause' }}</button>
      <live-pill v-if="source" :state="live.state.value" />
    </div>
    <div v-if="err" class="alert alert-warn"><span class="alert-icon">⚠</span><span>{{ err }}</span></div>
    <div class="log-wrap">
      <div class="log tall" ref="box" @scroll="onScroll"><div v-for="l in out" :key="l.id" :class="[cls(l.text), { 'l-new': l.fresh }]">{{ l.text }}</div><div v-if="!out.length" class="log-empty">{{ sources && !sources.length ? 'No logs found on this server.' : live.state.value === 'connecting' ? 'Connecting…' : 'No lines' + (q ? ' match the filter' : '') + ' yet — new lines show up here as they are written.' }}</div></div>
      <button v-if="!atBottom && out.length" class="btn btn-sm log-jump" @click="jump">↓ Jump to latest<template v-if="unseen"> · {{ unseen }} new</template></button>
    </div>
    <div class="hint">Red = server errors (5xx) and error messages · amber = 4xx and warnings. New lines appear as they are written; scroll up to stop following, Pause to freeze.<template v-if="skipped"> {{ skipped }} lines were skipped because the log was very fast.</template></div>
  </div>`,
};

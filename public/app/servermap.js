import { ref, computed } from '/vendor/vue.js';
import { reducedMotion } from './live.js';
import { go } from './lib.js';

/*
 * Server map: an isometric picture of where visitors go.
 *
 *   visitors → Cloudflare (green) → your servers (3D boxes)
 *
 * Yellow dots flow to every server that takes visitors (live server or load-balancer member); faster when the site
 * answers quickly. A server that is down turns red and smokes; a busy one glows amber. The bar on each server's base
 * is its CPU. "Pretend a server crashes" is a preview only — nothing on the server changes — and shows what
 * Switchboard would do: move visitors to a healthy standby when auto-failover is on, or the site goes down.
 */

const C = Math.cos(Math.PI / 6);
const S = 0.5;
/** world (x, y, z) → screen */
const iso = (x, y, z = 0) => [(x - y) * C, (x + y) * S - z];
const pt = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
const poly = (...ps) => ps.map(pt).join(' ');
/** SVG transforms that map face-local (u right, v down) onto a box face */
const faceFront = (o) => `matrix(${C},${S},0,1,${o[0].toFixed(1)},${o[1].toFixed(1)})`; // y = D face (lower left)
const faceSide = (o) => `matrix(${C},${-S},0,1,${o[0].toFixed(1)},${o[1].toFixed(1)})`; // x = W face (lower right)
const faceTop = (o) => `matrix(${C},${S},${-C},${S},${o[0].toFixed(1)},${o[1].toFixed(1)})`;

/** One isometric box at world (x, y): faces + the transforms for drawing on them. */
function box(x, y, w, d, h, z = 0) {
  const P = (a, b, c) => iso(x + a, y + b, z + c);
  return {
    top: poly(P(0, 0, h), P(w, 0, h), P(w, d, h), P(0, d, h)),
    front: poly(P(0, d, h), P(w, d, h), P(w, d, 0), P(0, d, 0)),
    side: poly(P(w, d, h), P(w, 0, h), P(w, 0, 0), P(w, d, 0)),
    tFront: faceFront(P(0, d, h)),
    tSide: faceSide(P(w, d, h)),
    tTop: faceTop(P(0, 0, h)),
  };
}

const SW = 62; // server width/depth
const SH = 50; // server height (two units)
const GAP = 150; // between servers in a row (along x)
const ROW = 230; // between rows (along y)
const CF = { x: -40, w: 84, h: 22 };

export const ServerMap = {
  props: { servers: Array, projects: Array },
  setup(props) {
    const pretend = ref(new Set());
    const still = reducedMotion();
    const toggle = (id) => {
      const s = new Set(pretend.value);
      s.has(id) ? s.delete(id) : s.add(id);
      pretend.value = s;
    };

    const scene = computed(() => {
      const servers = props.servers || [];
      const projects = props.projects || [];
      const fake = pretend.value;
      const n = servers.length;
      const cols = Math.min(4, Math.max(1, n));
      const cfY = (SW - CF.w) / 2; // Cloudflare sits in line with the first row
      const cfCenter = iso(CF.x + CF.w / 2, cfY + CF.w / 2, 2);

      const isDown = (s) => fake.has(s.id) || s.status === 'down';
      const depUp = (d) => !fake.has(d.server_id) && d.health === 'up';

      // who takes visitors, with "pretend" failover applied
      const traffic = new Map(); // server id → { ms: [], moved: bool, lost: bool }
      const notes = [];
      const hit = (id) => traffic.get(id) || (traffic.set(id, { ms: [], moved: false, lost: false }), traffic.get(id));
      for (const p of projects) {
        const deps = p.deployments || [];
        const lb = deps.some((d) => d.lb_state === 'active');
        const carrying = deps.filter((d) => d.is_active || d.lb_state === 'active');
        for (const d of carrying) {
          if (!fake.has(d.server_id)) {
            const t = hit(d.server_id);
            if (d.health_detail?.ms != null) t.ms.push(d.health_detail.ms);
            if (d.health === 'down') t.lost = true;
            continue;
          }
          hit(d.server_id).lost = true;
          if (lb) {
            const rest = carrying.filter((x) => x !== d && depUp(x));
            notes.push(rest.length ? { ok: true, text: `${p.name}: the load balancer keeps sending visitors to ${rest.map((x) => x.server_name).join(', ')}` } : { ok: false, text: `${p.name} would be down — no other healthy server behind the load balancer` });
            continue;
          }
          const spare = deps.find((x) => !x.is_active && depUp(x));
          if (spare && p.auto_failover) {
            hit(spare.server_id).moved = true;
            notes.push({ ok: true, text: `${p.name}: auto-failover moves visitors to ${spare.server_name}` });
          } else if (spare) notes.push({ ok: false, text: `${p.name} would be down until you switch to ${spare.server_name} (auto-failover is off)` });
          else notes.push({ ok: false, text: `${p.name} would be down — no healthy standby server` });
        }
      }
      const hosts = new Set(projects.flatMap((p) => (p.deployments || []).map((d) => d.server_id)));

      const nodes = servers.map((s, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        const x = 110 + c * GAP, y = r * ROW;
        const m = s.metrics || {};
        const down = isDown(s);
        const cpu = down ? 0 : Math.max(0, Math.min(100, Math.round(m.cpu_pct ?? 0)));
        const t = traffic.get(s.id);
        const state = down ? 'down' : m.busy || cpu >= 85 ? 'busy' : t && (t.ms.length || t.moved) ? 'live' : s.status === 'up' ? 'idle' : 'unknown';
        const ms = t?.ms.length ? Math.round(t.ms.reduce((a, b) => a + b, 0) / t.ms.length) : null;
        const base = box(x - 8, y - 8, SW + 16, SW + 16, 6);
        const body = box(x, y, SW, SW, SH, 6);
        const lbl = iso(x + SW + 8, y + SW + 8, 0);
        // link on the ground, behind the row: out of Cloudflare, along x, then into the server (dots vanish inside it)
        const xMid = x + SW / 2, bus = y - 26 - r * 6;
        const path = `M${pt(cfCenter)} L${pt(iso(CF.x + CF.w / 2, bus, 2))} L${pt(iso(xMid, bus, 2))} L${pt(iso(xMid, y + SW / 2, 2))}`;
        const flowing = !!t && !down && (t.ms.length > 0 || t.moved) && !t.lost;
        const dur = Math.max(1.2, Math.min(5, (ms ?? 300) / 90));
        return {
          s, x, y, i, down, cpu, state, ms, base, body, path, flowing, dur, moved: !!t?.moved,
          linked: hosts.has(s.id), lost: !!t?.lost || (down && hosts.has(s.id)), fake: fake.has(s.id),
          leds: [0, 1].map((k) => ({ k, delay: ((i * 7 + k * 3) % 10) / 10 })),
          bar: Array.from({ length: 10 }, (_, k) => ({ k, on: cpu > k * 10, cls: k >= 8 ? 'hot' : k >= 6 ? 'warm' : 'ok' })),
          label: { x: lbl[0], y: lbl[1] + 26 },
          smoke: iso(x + SW / 2, y + SW / 2, SH + 6),
          depth: x + y,
        };
      });
      nodes.sort((p, q) => p.depth - q.depth);

      const cf = box(CF.x, cfY, CF.w, CF.w, CF.h, 4);
      const cfBase = box(CF.x - 8, cfY - 8, CF.w + 16, CF.w + 16, 4);
      const cfTopMid = iso(CF.x + CF.w / 2, cfY + CF.w / 2, CF.h + 4);
      // visitors: a few dots on the left that flow into Cloudflare
      const vx = CF.x - 110;
      const visitors = [0, 1, 2, 3, 4].map((k) => {
        const p = iso(vx + (k % 2) * 22, cfY + 12 + k * 14, 0);
        return { k, x: p[0], y: p[1], path: `M${pt(p)} L${pt(iso(CF.x - 8, cfY + 12 + k * 14, 2))}` };
      });
      const anyLive = nodes.some((nd) => nd.flowing);

      // fit the view box around everything
      const xs = [], ys = [];
      const add = (p) => (xs.push(p[0]), ys.push(p[1]));
      nodes.forEach((nd) => { add(iso(nd.x - 8, nd.y - 8)); add(iso(nd.x + SW + 8, nd.y + SW + 8)); add(iso(nd.x + SW + 8, nd.y - 8)); add(iso(nd.x - 8, nd.y + SW + 8)); add(iso(nd.x, nd.y, SH + 50)); add([nd.label.x, nd.label.y + 16]); });
      add(iso(vx, cfY + 12)); add(iso(vx + 22, cfY + 12 + 4 * 14)); add(iso(CF.x - 8, cfY + CF.w + 8)); add(iso(CF.x + CF.w + 8, cfY - 8, CF.h + 30));
      const pad = 26;
      const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
      const vb = `${minX.toFixed(0)} ${minY.toFixed(0)} ${(Math.max(...xs) - minX + pad).toFixed(0)} ${(Math.max(...ys) - minY + pad).toFixed(0)}`;

      const up = servers.filter((s) => !isDown(s));
      const cpus = up.map((s) => s.metrics?.cpu_pct).filter((v) => v != null);
      const allMs = nodes.map((nd) => nd.ms).filter((v) => v != null);
      const stats = [
        { k: 'Servers up', v: `${up.length} / ${n}`, cls: up.length < n ? 'bad' : 'good' },
        { k: 'CPU avg', v: cpus.length ? `${Math.round(cpus.reduce((a, b) => a + b, 0) / cpus.length)}%` : '—', cls: cpus.length && Math.max(...cpus) >= 85 ? 'warn' : '' },
        { k: 'Response', v: allMs.length ? `${Math.round(allMs.reduce((a, b) => a + b, 0) / allMs.length)} ms` : '—', cls: '' },
        { k: 'Taking visitors', v: String(nodes.filter((nd) => nd.flowing).length), cls: '' },
      ];
      return { nodes, cf, cfBase, cfTopMid, visitors, anyLive, vb, stats, notes };
    });

    const short = (name) => (name || '?').slice(0, 14);
    return { scene, pretend, toggle, still, short, SW, open: (id) => go(`/servers/${id}`) };
  },
  template: `
  <div class="smap card" :class="{ 'smap-still': still }">
    <div class="smap-stats">
      <div v-for="st in scene.stats" :key="st.k" class="smap-stat"><div class="smap-k">{{ st.k }}</div><div class="smap-v" :class="st.cls">{{ st.v }}</div></div>
    </div>
    <svg class="smap-svg" :viewBox="scene.vb" role="img" aria-label="Map of your servers and where visitors go" preserveAspectRatio="xMidYMid meet">
      <defs>
        <filter id="smap-glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="2.4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>

      <!-- links (drawn first, under the boxes) -->
      <g v-for="v in scene.visitors" :key="'v' + v.k">
        <path :d="v.path" class="smap-link" :class="{ on: scene.anyLive }" />
        <circle :cx="v.x" :cy="v.y" r="3.4" class="smap-person" />
        <circle v-if="scene.anyLive && !still" r="2.6" class="smap-dot" filter="url(#smap-glow)">
          <animateMotion :path="v.path" dur="1.6s" :begin="(v.k * 0.31) + 's'" repeatCount="indefinite" />
        </circle>
      </g>
      <g v-for="nd in scene.nodes" :key="'l' + nd.s.id">
        <path v-if="nd.linked || nd.flowing" :d="nd.path" class="smap-link" :class="{ on: nd.flowing, lost: nd.lost && !nd.flowing, moved: nd.moved }" />
        <template v-if="nd.flowing && !still">
          <circle v-for="k in 3" :key="k" r="3" class="smap-dot" :class="{ moved: nd.moved }" filter="url(#smap-glow)">
            <animateMotion :path="nd.path" :dur="nd.dur + 's'" :begin="((k - 1) * nd.dur / 3) + 's'" repeatCount="indefinite" />
          </circle>
        </template>
      </g>

      <!-- Cloudflare -->
      <g class="smap-cf">
        <title>Cloudflare — sends visitors to the live server</title>
        <polygon :points="scene.cfBase.top" class="smap-base-top" /><polygon :points="scene.cfBase.front" class="smap-base-f" /><polygon :points="scene.cfBase.side" class="smap-base-s" />
        <polygon :points="scene.cf.front" class="f" /><polygon :points="scene.cf.side" class="s" /><polygon :points="scene.cf.top" class="t" />
        <g :transform="scene.cf.tTop" class="smap-cf-icon">
          <path d="M42 20 L42 40 M42 40 L24 60 M42 40 L60 60 M42 40 L42 64" />
          <circle cx="42" cy="20" r="3.2" /><circle cx="42" cy="40" r="3.2" /><circle cx="24" cy="60" r="3.2" /><circle cx="60" cy="60" r="3.2" /><circle cx="42" cy="64" r="3.2" />
        </g>
        <g :transform="scene.cf.tFront" class="smap-bays"><rect v-for="k in 4" :key="k" :x="34 + k * 9" y="6" width="6" height="10" rx="1" /></g>
      </g>

      <!-- servers, back to front -->
      <g v-for="nd in scene.nodes" :key="nd.s.id" class="smap-srv" :class="'st-' + nd.state" tabindex="0" role="link" :aria-label="nd.s.name"
         @click="open(nd.s.id)" @keydown.enter="open(nd.s.id)">
        <title>{{ nd.s.name }}{{ nd.fake ? ' (pretend crash)' : '' }} — {{ nd.down ? 'down' : nd.state === 'busy' ? 'busy' : 'up' }}{{ nd.down ? '' : ', CPU ' + nd.cpu + '%' }}{{ nd.ms != null ? ', ' + nd.ms + ' ms' : '' }}</title>
        <polygon :points="nd.base.top" class="smap-base-top" /><polygon :points="nd.base.front" class="smap-base-f" /><polygon :points="nd.base.side" class="smap-base-s" />
        <g :transform="nd.base.tFront">
          <rect v-for="b in nd.bar" :key="b.k" :x="10 + b.k * 5" y="1.2" width="3.4" height="3.6" class="smap-seg" :class="[b.cls, { on: b.on }]" />
        </g>
        <g class="smap-body">
          <polygon :points="nd.body.front" class="f" /><polygon :points="nd.body.side" class="s" /><polygon :points="nd.body.top" class="t" />
          <!-- front: two units, drive bays + blinking lights -->
          <g :transform="nd.body.tFront" class="smap-bays">
            <line x1="0" :y1="SW * 0 + 25" :x2="SW" :y2="25" class="smap-seam" />
            <template v-for="u in 2" :key="u">
              <rect v-for="k in 4" :key="k" :x="4 + (k - 1) * 8" :y="(u - 1) * 25 + 6" width="5.6" height="13" rx="1" />
              <circle v-for="l in nd.leds" :key="l.k" :cx="44 + l.k * 6" :cy="(u - 1) * 25 + 15" r="1.9" class="smap-led" :class="'led-' + l.k" :style="{ animationDelay: (l.delay + u * 0.37) + 's' }" />
            </template>
          </g>
          <!-- side: vents -->
          <g :transform="nd.body.tSide" class="smap-vents">
            <line v-for="k in 4" :key="'a' + k" :x1="30" :y1="3 + k * 4.2" :x2="58" :y2="3 + k * 4.2" />
            <line v-for="k in 4" :key="'b' + k" :x1="30" :y1="28 + k * 4.2" :x2="58" :y2="28 + k * 4.2" />
          </g>
          <g :transform="nd.body.tTop" class="smap-vents">
            <line v-for="k in 4" :key="k" :x1="14" :y1="12 + k * 8" :x2="48" :y2="12 + k * 8" />
          </g>
        </g>
        <g v-if="nd.down && !still" class="smap-smoke">
          <circle v-for="k in 3" :key="k" :cx="nd.smoke[0] + (k - 2) * 5" :cy="nd.smoke[1] - 4" :r="6 + k" :style="{ animationDelay: (k - 1) * 0.8 + 's' }" />
        </g>
        <text :x="nd.label.x" :y="nd.label.y" class="smap-name" text-anchor="middle">{{ short(nd.s.name) }}</text>
        <text :x="nd.label.x" :y="nd.label.y + 13" class="smap-sub" text-anchor="middle">{{ nd.down ? (nd.fake ? 'pretend crash' : 'down') : 'CPU ' + nd.cpu + '%' + (nd.ms != null ? ' · ' + nd.ms + ' ms' : '') }}</text>
      </g>
    </svg>

    <div class="smap-foot">
      <div class="smap-crash">
        <span class="smap-k">Pretend a server crashes</span>
        <div class="smap-chips">
          <button v-for="nd in scene.nodes.slice().sort((a, b) => a.i - b.i)" :key="nd.s.id" class="smap-chip" :class="{ on: pretend.has(nd.s.id) }" :aria-pressed="pretend.has(nd.s.id)" @click="toggle(nd.s.id)" :title="'Preview only: ' + nd.s.name + ' is not touched'">{{ short(nd.s.name) }}</button>
        </div>
        <span class="tiny muted">Preview only — nothing on your servers changes.</span>
      </div>
      <div class="smap-legend tiny">
        <span><i class="lg-cf"></i>Cloudflare</span><span><i class="lg-dot"></i>Visitors</span><span><i class="lg-down"></i>Down</span><span><i class="lg-busy"></i>Busy</span>
      </div>
    </div>
    <div v-if="scene.notes.length" class="smap-notes">
      <div v-for="(n, i) in scene.notes" :key="i" class="small" :class="n.ok ? 'text-green' : 'text-red'">{{ n.ok ? '✓' : '✖' }} {{ n.text }}</div>
    </div>
  </div>`,
};

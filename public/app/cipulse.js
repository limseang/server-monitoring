import { computed } from '/vendor/vue.js';
import { tick, ago } from './lib.js';

/*
 * CI/CD pulse on the home screen: one line per server that gets new code from Git right now, and per repo that
 * GitHub is still building. Switchboard looks at GitHub by itself (every 20 s, every 6 s while something runs),
 * so a push shows up here without opening the CI/CD tab. Nothing running: a quiet "watching" line.
 *   ci: /api/overview → ci  ({ items, deploying, building, watching, checked_at, error })
 */
const PHASE = {
  deploy: { icon: '⬇', text: 'getting new code' },
  wait: { icon: '⏳', text: 'waiting' },
  build: { icon: '⚙', text: 'building on GitHub' },
};

function since(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const CiPulse = {
  props: { ci: Object },
  setup(props) {
    const items = computed(() => {
      tick.value;
      return (props.ci?.items || [])
        .slice()
        .sort((a, b) => (a.phase === 'deploy' ? 0 : a.phase === 'build' ? 1 : 2) - (b.phase === 'deploy' ? 0 : b.phase === 'build' ? 1 : 2))
        .map((it) => ({
          ...it,
          key: `${it.source}-${it.run_id || it.job_id}-${it.server_id || 'gh'}`,
          ph: PHASE[it.phase] || PHASE.wait,
          elapsed: it.started_at ? since(it.started_at) : '',
          pct: Math.round((it.frac || 0) * 100),
          from: it.source === 'github' ? `GitHub${it.run_number ? ' #' + it.run_number : ''}` : it.via === 'git' ? 'Git pull' : 'Switchboard',
        }));
    });
    const checked = computed(() => (tick.value, props.ci?.checked_at ? ago(props.ci.checked_at) : 'soon'));
    const show = computed(() => items.value.length || props.ci?.watching);
    const headline = computed(() => {
      const d = props.ci?.deploying || 0;
      const b = props.ci?.building || 0;
      const parts = [d ? `${d} server${d === 1 ? '' : 's'} getting new code` : '', b ? `${b} project${b === 1 ? '' : 's'} building on GitHub` : ''].filter(Boolean);
      return parts.join(' · ') || 'code waits for its turn';
    });
    return { items, checked, show, headline };
  },
  template: `
  <div v-if="show" class="cip card" :class="{ busy: items.length, many: (ci.deploying || 0) >= 2 }">
    <div class="cip-head">
      <span class="cip-radar" :class="{ on: items.length }" aria-hidden="true"><i></i></span>
      <b v-if="items.length">CI/CD running — {{ headline }}</b>
      <b v-else>CI/CD: quiet</b>
      <span class="tiny muted grow">Watching {{ ci.watching }} project{{ ci.watching === 1 ? '' : 's' }} on GitHub for new code · checked {{ checked }}</span>
      <span v-if="ci.error" class="tiny text-red" :title="ci.error">GitHub: {{ ci.error }}</span>
    </div>
    <div v-if="items.length" class="cip-list">
      <a v-for="it in items" :key="it.key" class="cip-row" :class="'ph-' + it.phase" :href="it.link">
        <span class="cip-icon" aria-hidden="true">{{ it.ph.icon }}</span>
        <span class="cip-main">
          <span class="cip-title"><b>{{ it.project }}</b><template v-if="it.server_name"> → <b>{{ it.server_name }}</b></template> <span class="muted">· {{ it.ph.text }}</span></span>
          <span class="tiny muted ellipsis">{{ it.from }}<template v-if="it.branch"> · {{ it.branch }}</template><template v-if="it.sha"> @ {{ it.sha.slice(0, 7) }}</template><template v-if="it.title"> · {{ it.title }}</template><template v-if="it.actor"> · by {{ it.actor }}</template></span>
        </span>
        <span class="cip-step tiny mono ellipsis" :title="it.step">{{ it.step }}</span>
        <span class="cip-time tiny mono">{{ it.elapsed }}<template v-if="it.jobs_total"><br />jobs {{ it.jobs_done }}/{{ it.jobs_total }}</template></span>
        <span class="cip-bar"><i :style="{ width: Math.max(8, it.pct) + '%' }"></i></span>
      </a>
    </div>
  </div>`,
};

/** server id → the CI item for it (deploying beats waiting), for badges on cards. projectId: only that project's. */
export function ciByServer(ci, projectId = null) {
  const m = new Map();
  for (const it of ci?.items || []) {
    if (!it.server_id || (projectId && it.project_id !== projectId)) continue;
    const prev = m.get(it.server_id);
    if (!prev || (prev.phase !== 'deploy' && it.phase === 'deploy')) m.set(it.server_id, it);
  }
  return m;
}

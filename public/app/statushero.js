import { computed } from '/vendor/vue.js';

/**
 * Big, plain-language status at the top of a project page, for people who
 * don't know much about servers: one sentence on how the website is doing,
 * what to do about it, and a small animated picture of the path a visitor
 * takes (visitors → Cloudflare → server). Dots flow along the path while the
 * site is healthy, slow down when it is unstable and stop when it is down.
 */
export const StatusHero = {
  props: { p: Object, active: Object, lb: Boolean, lbCount: Number, checking: Boolean },
  emits: ['check', 'switch', 'maintenance'],
  setup(props) {
    const state = computed(() => {
      const p = props.p, a = props.active;
      const where = a ? a.server_name : '';
      const others = (p.deployments || []).filter((d) => !d.is_active);
      const spareOk = others.some((d) => d.health === 'up');
      if (props.lb) {
        const up = (p.deployments || []).filter((d) => d.lb_state !== 'off' && d.health === 'up').length;
        if (up === 0) return { cls: 'red', icon: '✖', title: 'Your website is down', text: 'None of the servers behind the load balancer answer.', flow: 'down' };
        if (up < props.lbCount) return { cls: 'amber', icon: '!', title: 'Working, but not at full strength', text: `${up} of ${props.lbCount} servers answer. Visitors are sent only to the healthy ones.`, flow: 'slow' };
        return { cls: 'green', icon: '✓', title: 'Everything looks good', text: `Visitors are shared across ${props.lbCount} healthy servers.`, flow: 'ok' };
      }
      if (!a) return { cls: 'gray', icon: '?', title: 'No live server yet', text: 'Add a server to this project, then switch traffic to it so visitors can reach your site.', flow: 'none' };
      switch (a.health) {
        case 'up':
          return { cls: 'green', icon: '✓', title: 'Everything looks good', text: `Visitors reach ${p.domain || 'your site'} on ${where}, and it answers quickly.`, flow: 'ok' };
        case 'degraded':
          return {
            cls: 'amber', icon: '!', title: 'Your website is slow or not always answering',
            text: `${where} is online, but the website didn't answer some checks. It may fix itself in a minute.` + (spareOk ? ' If it keeps happening, you can switch visitors to a standby server.' : ' If it keeps happening, check the app on the server.'),
            flow: 'slow', canSwitch: spareOk,
          };
        case 'down':
          return {
            cls: 'red', icon: '✖', title: 'Your website is down',
            text: `Visitors can't reach ${where}.` + (p.auto_failover ? ' Auto-failover is on, so Switchboard will move visitors to a healthy standby by itself.' : spareOk ? ' A standby server is healthy — switch visitors to it.' : ''),
            flow: 'down', canSwitch: spareOk,
          };
        case 'maintenance':
          return { cls: 'blue', icon: '⏸', title: 'Maintenance mode is on', text: `Visitors see a "back soon" page on ${where}. Turn it off when you're done.`, flow: 'pause', canEndMaint: true };
        default:
          return { cls: 'gray', icon: '…', title: 'Checking your website…', text: 'The first check runs within a minute.', flow: 'none' };
      }
    });
    return { state };
  },
  template: `
  <div class="shero" :class="'shero-' + state.cls">
    <div class="shero-orb" :class="'orb-' + state.cls" aria-hidden="true"><span>{{ state.icon }}</span></div>
    <div class="shero-main">
      <div class="shero-title">{{ state.title }}</div>
      <div class="shero-text">{{ state.text }}</div>
      <div class="shero-actions">
        <button class="btn btn-sm" @click="$emit('check')" :disabled="checking"><span v-if="checking" class="spinner"></span>Check again</button>
        <button v-if="state.canSwitch" class="admin-only btn btn-sm btn-primary" @click="$emit('switch')">⇄ Switch server</button>
        <button v-if="state.canEndMaint" class="dev-only btn btn-sm" @click="$emit('maintenance')">Turn maintenance off</button>
        <span v-if="active && active.checked_at" class="tiny muted">last checked <ago :at="active.checked_at" /></span>
      </div>
    </div>
    <div class="sflow" :class="'sflow-' + state.flow" aria-hidden="true">
      <div class="sflow-node"><span class="sflow-ico"><icon name="globe" :size="18" /></span><small>Visitors</small></div>
      <div class="sflow-line"><i></i><i></i><i></i></div>
      <div class="sflow-node"><span class="sflow-ico"><icon name="shield" :size="18" /></span><small>Cloudflare</small></div>
      <div class="sflow-line sflow-last"><i></i><i></i><i></i></div>
      <div class="sflow-node sflow-end"><span class="sflow-ico"><icon name="servers" :size="18" /></span><small class="ellipsis">{{ lb ? lbCount + ' servers' : active ? active.server_name : 'No server' }}</small></div>
    </div>
  </div>`,
};

import { ref, onUnmounted } from '/vendor/vue.js';
import { store } from './lib.js';

/**
 * A live channel (Server-Sent Events) for one view.
 * - reconnects by itself after a network drop (1 s, 2 s, 5 s, 10 s, then every 15 s)
 * - notices a silent dead connection (the server sends a heartbeat every 15 s)
 * - disconnects while the browser tab is hidden (iPad in the background), so the server
 *   stops watching over SSH, and connects again when it is shown
 * urlFn() returns the URL, or null for "nothing to watch now".
 * handlers: { eventName(data) } — data is already parsed JSON.
 * state: 'connecting' | 'live' | 'offline' (reconnecting) | 'paused' | 'off'
 */
export function useLive(urlFn, handlers, { paused = false } = {}) {
  const state = ref(paused ? 'paused' : 'connecting');
  let es = null;
  let retry = null;
  let watchdog = null;
  let attempts = 0;
  let userPaused = paused;
  let dead = false;
  const DELAYS = [1000, 2000, 5000, 10000, 15000];

  const alive = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => reconnect(), 40000);
  };
  function close() {
    clearTimeout(retry);
    clearTimeout(watchdog);
    if (es) {
      es.onopen = es.onerror = null;
      es.close();
      es = null;
    }
  }
  function open() {
    close();
    if (dead || userPaused) return;
    const url = urlFn();
    if (!url) {
      state.value = 'off';
      return;
    }
    if (document.hidden) return; // connects again on visibilitychange
    if (state.value !== 'offline') state.value = 'connecting';
    es = new EventSource(`/api${url}`);
    es.onopen = () => {
      attempts = 0;
      state.value = 'live';
      alive();
    };
    es.onerror = () => reconnect();
    for (const name of ['hb', ...Object.keys(handlers)]) {
      es.addEventListener(name, (e) => {
        alive();
        if (state.value !== 'live') state.value = 'live';
        if (name === 'hb') return;
        let data = null;
        try {
          data = JSON.parse(e.data);
        } catch {}
        handlers[name](data);
      });
    }
    alive();
  }
  function reconnect() {
    close();
    if (dead || userPaused || !store.user) return;
    state.value = 'offline';
    retry = setTimeout(open, DELAYS[Math.min(attempts++, DELAYS.length - 1)]);
  }
  const onVisible = () => {
    if (document.hidden) {
      close();
      if (state.value === 'live') state.value = 'connecting';
    } else if (!es && !userPaused) open();
  };
  const onOnline = () => state.value === 'offline' && open();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  onUnmounted(() => {
    dead = true;
    close();
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
  });
  open();
  return {
    state,
    /** Connect again (e.g. after the URL changed). */
    restart() {
      attempts = 0;
      open();
    },
    pause() {
      userPaused = true;
      close();
      state.value = 'paused';
    },
    resume() {
      userPaused = false;
      attempts = 0;
      open();
    },
    /** Stop for good (e.g. the server said the request can never work). */
    stop() {
      userPaused = true;
      close();
      state.value = 'off';
    },
  };
}

/** Small pulsing "LIVE" badge. */
export const LivePill = {
  props: { state: { type: String, default: 'live' }, every: Number },
  computed: {
    label() {
      return { live: 'LIVE', connecting: 'Connecting…', offline: 'Reconnecting…', paused: 'Paused', off: 'Off' }[this.state] || this.state;
    },
    tip() {
      if (this.state === 'live') return this.every ? `Updates by itself every ${this.every} s` : 'Updates by itself as it happens';
      if (this.state === 'offline') return 'Connection lost — trying again by itself';
      if (this.state === 'paused') return 'Paused — press Live to continue';
      return '';
    },
  },
  template: `<span class="live-pill" :class="'live-' + state" :title="tip" role="status"><i aria-hidden="true"></i>{{ label }}</span>`,
};

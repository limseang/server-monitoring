import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from '/vendor/vue.js';
import { http, toast, confirmBox, store } from './lib.js';

/*
 * Visual editor for a GitHub workflow file — for people new to CI/CD.
 *
 *   picture:  "When" (the trigger) → jobs, left to right in the order they run; each card says WHERE it runs
 *             (GitHub's machine, or one of your servers) and its steps. "Show how it runs" plays it as an animation.
 *   edit:     click a card → change it in plain words; add jobs and steps from a library; the YAML is written for you
 *             (only what changed — comments and untouched parts stay). YAML ⇄ picture stay in sync both ways.
 *   reuse:    copy the flow to another project (pick which server takes each job), duplicate a job for another
 *             server, save it as a template, start from a template or a ready-made flow, download the .yml.
 */

const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'job';
const step = (name, o = {}) => ({ name, uses: '', run: '', with: {}, if: '', ...o });
const job = (id, name, runs_on, steps, o = {}) => ({ id, name, runs_on, needs: [], if: '', steps, uses: '', environment: '', extra: [], ...o });
const GH = { kind: 'github', image: 'ubuntu-latest' };
const onServer = (s) => ({ kind: 'server', label: s.label });
const appFolder = (s) => (s && s.app_dir) || '/var/www/app';
const repoFolder = (s) => appFolder(s).replace(/\/docker\/?$/, '');

/* ------------------------------------------------------------------ the library */
/** Steps you can add to a job (`s` = the job's server, when it runs on one). */
export const STEP_LIBRARY = [
  { key: 'checkout', icon: '📥', title: 'Get the code', hint: 'Downloads your repository into the job', make: () => step('Get the code', { uses: 'actions/checkout@v4' }) },
  { key: 'run', icon: '⌨️', title: 'Run commands', hint: 'Any shell commands', make: () => step('Run commands', { run: 'echo "Hello from CI/CD"' }) },
  { key: 'node', icon: '🟩', title: 'Set up Node.js', hint: 'For npm / JavaScript projects', make: () => step('Set up Node.js', { uses: 'actions/setup-node@v4', with: { 'node-version': '22' } }) },
  { key: 'php', icon: '🐘', title: 'Set up PHP', hint: 'For Laravel / Composer projects', make: () => step('Set up PHP', { uses: 'shivammathur/setup-php@v2', with: { 'php-version': '8.3' } }) },
  { key: 'pull', icon: '⬇️', title: 'git pull on the server', hint: 'Bring the app folder to the newest code', make: (s) => step('Get the newest code', { run: `cd ${repoFolder(s)}\ngit pull --ff-only` }) },
  { key: 'compose', icon: '🐳', title: 'Docker Compose: rebuild + restart', hint: 'docker compose up -d --build', make: (s) => step('Rebuild and restart the containers', { run: `cd ${appFolder(s)}\ndocker compose up -d --build --remove-orphans\ndocker image prune -f` }) },
  { key: 'migrate', icon: '🗄️', title: 'Laravel: migrate database', hint: 'php artisan migrate --force', make: (s) => step('Migrate the database', { run: `cd ${appFolder(s)}\ndocker compose exec -T app php artisan migrate --force` }) },
  { key: 'cache', icon: '🧹', title: 'Laravel: rebuild caches', hint: 'config, routes, views', make: (s) => step('Rebuild Laravel caches', { run: `cd ${appFolder(s)}\ndocker compose exec -T app php artisan optimize` }) },
  { key: 'health', icon: '🩺', title: 'Health check', hint: 'Fail if the app does not answer', make: () => step('Health check', { run: 'curl -fsS --retry 10 --retry-delay 3 --retry-all-errors http://localhost/ > /dev/null' }) },
  { key: 'telegram', icon: '📣', title: 'Message on Telegram', hint: 'Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID secrets', make: () => step('Message on Telegram', { run: 'curl -sS -X POST "https://api.telegram.org/bot${{ secrets.TELEGRAM_BOT_TOKEN }}/sendMessage" \\\n  --data-urlencode chat_id="${{ secrets.TELEGRAM_CHAT_ID }}" \\\n  --data-urlencode text="✅ ${{ github.repository }}: ${{ github.workflow }} finished (${{ github.sha }})"' }) },
  { key: 'wait', icon: '⏱️', title: 'Wait a little', hint: 'Give a service time to start', make: () => step('Wait 10 seconds', { run: 'sleep 10' }) },
];

/** Whole jobs you can add (`s` = the server picked for it, `servers` = the project's). */
export const JOB_LIBRARY = [
  { key: 'tests-node', icon: '🧪', title: 'Run tests — Node.js', hint: "On GitHub's machine: npm ci, npm test", server: false,
    make: () => job('tests', 'Run tests', GH, [STEP_LIBRARY[0].make(), STEP_LIBRARY[2].make(), step('Install and test', { run: 'npm ci\nnpm test' })]) },
  { key: 'tests-php', icon: '🧪', title: 'Run tests — Laravel / PHP', hint: "On GitHub's machine: composer install, php artisan test", server: false,
    make: () => job('tests', 'Run tests', GH, [STEP_LIBRARY[0].make(), STEP_LIBRARY[3].make(), step('Install and test', { run: 'composer install --no-interaction --prefer-dist\ncp .env.example .env\nphp artisan key:generate\nphp artisan test' })]) },
  { key: 'build-image', icon: '📦', title: 'Build a Docker image', hint: "On GitHub's machine, saved in GitHub Packages (ghcr.io)", server: false,
    make: () => job('build', 'Build the Docker image', GH, [STEP_LIBRARY[0].make(), step('Log in to GitHub Packages', { uses: 'docker/login-action@v3', with: { registry: 'ghcr.io', username: '${{ github.actor }}', password: '${{ secrets.GITHUB_TOKEN }}' } }), step('Build and push', { run: 'IMAGE=ghcr.io/$(echo "$GITHUB_REPOSITORY" | tr "[:upper:]" "[:lower:]")\ndocker build -t "$IMAGE:$GITHUB_SHA" -t "$IMAGE:latest" .\ndocker push --all-tags "$IMAGE"' })]) },
  { key: 'deploy', icon: '🚀', title: 'Deploy on a server', hint: 'On your server: git pull + Docker Compose rebuild', server: true,
    make: (s) => job(`deploy-${slug(s?.label)}`, `Deploy on ${s?.name || 'server'}`, s ? onServer(s) : { kind: 'server', label: 'my-server' }, [STEP_LIBRARY[4].make(s), STEP_LIBRARY[5].make(s), STEP_LIBRARY[8].make(s)]) },
  { key: 'health', icon: '🩺', title: 'Check a server is healthy', hint: 'On your server: the app answers', server: true,
    make: (s) => job(`check-${slug(s?.label)}`, `Check ${s?.name || 'server'}`, s ? onServer(s) : { kind: 'server', label: 'my-server' }, [STEP_LIBRARY[8].make(s)]) },
  { key: 'live-waits', icon: '⏸️', title: 'Live server waits for Switchboard', hint: 'Switchboard holds the live server until you click "Deploy now"', server: false,
    make: (s, servers) => job('hold-live', `Live server waits for Switchboard (${(servers || []).find((x) => x.live)?.name || 'live'})`, GH, [step('Waiting for you in Switchboard', { run: 'echo "The live server waits — Deploy now in Switchboard → CI/CD"' })]) },
  { key: 'notify', icon: '📣', title: 'Message on Telegram', hint: 'When everything is done (also if it failed)', server: false,
    make: () => job('notify', 'Message on Telegram', GH, [STEP_LIBRARY[9].make()], { if: 'always()' }) },
  { key: 'empty', icon: '✳️', title: 'Empty job', hint: 'Start from nothing', server: false, make: () => job('job', 'New job', GH, [STEP_LIBRARY[1].make()]) },
];

/** Ready-made whole flows, built for this project's servers. */
const T0 = () => ({ push: { on: true, branches: ['main'] }, pull_request: { on: false, branches: [] }, manual: true, schedule: [], other: [] });
export const STARTERS = [
  { key: 'test-deploy', icon: '🛡️', title: 'Test, then deploy every server', hint: 'Tests on GitHub; then each server one by one — standby first, the live server last', tags: ['Tests', 'Docker Compose'],
    make: (servers, branch) => {
      const order = [...servers].sort((a, b) => a.live - b.live);
      const jobs = [JOB_LIBRARY[1].make()];
      let prev = 'tests';
      for (const s of order) {
        const j = JOB_LIBRARY[3].make(s);
        j.needs = [prev];
        prev = j.id;
        jobs.push(j);
      }
      return { name: 'Test and deploy', triggers: { ...T0(), push: { on: true, branches: [branch] } }, jobs };
    } },
  { key: 'deploy', icon: '🚀', title: 'Deploy on every push (no tests)', hint: 'Each server pulls and rebuilds — standby first, live last', tags: ['Simple', 'Docker Compose'],
    make: (servers, branch) => {
      const order = [...servers].sort((a, b) => a.live - b.live);
      const jobs = [];
      let prev = null;
      for (const s of order) {
        const j = JOB_LIBRARY[3].make(s);
        if (prev) j.needs = [prev];
        prev = j.id;
        jobs.push(j);
      }
      return { name: 'Deploy', triggers: { ...T0(), push: { on: true, branches: [branch] } }, jobs: jobs.length ? jobs : [JOB_LIBRARY[7].make()] };
    } },
  { key: 'live-waits', icon: '⏸️', title: 'Deploy standby, the live server waits for me', hint: 'Standby servers get it right away; Switchboard holds the live one for "Deploy now"', tags: ['Tests', 'Live waits', 'Docker Compose'],
    make: (servers, branch) => {
      const standby = servers.filter((s) => !s.live);
      const jobs = [JOB_LIBRARY[1].make()];
      let prev = 'tests';
      for (const s of standby) {
        const j = JOB_LIBRARY[3].make(s);
        j.needs = [prev];
        prev = j.id;
        jobs.push(j);
      }
      if (servers.some((s) => s.live)) {
        const h = JOB_LIBRARY[5].make(null, servers);
        h.needs = [prev];
        jobs.push(h);
      }
      return { name: 'Deploy (live waits)', triggers: { ...T0(), push: { on: true, branches: [branch] } }, jobs };
    } },
];

/** More ready-made flows: each job gets the right server and folder from the project. */
const standbyFirst = (servers) => [...servers].sort((a, b) => a.live - b.live);
/** One job per server, one after the other (standby first). With `liveWaits` and 2+ servers the live one waits for Switchboard. */
function perServer(servers, makeJob, { after = null, liveWaits = false } = {}) {
  const jobs = [];
  let prev = after;
  const list = standbyFirst(servers);
  const waits = liveWaits && list.length > 1 && list.some((s) => s.live);
  for (const s of waits ? list.filter((x) => !x.live) : list) {
    const j = makeJob(s);
    if (prev) j.needs = [prev];
    prev = j.id;
    jobs.push(j);
  }
  if (waits) {
    const h = JOB_LIBRARY[5].make(null, servers);
    if (prev) h.needs = [prev];
    jobs.push(h);
  }
  return jobs;
}
const T = (o = {}) => ({ ...T0(), ...o });
STARTERS.push(
  { key: 'laravel', icon: '🐘', title: 'Laravel with Docker — full', hint: 'Tests on GitHub; each server: pull, rebuild, migrate, caches, health check; the live server waits for you', tags: ['Laravel', 'Tests', 'Live waits'],
    make: (servers, branch) => {
      const tests = JOB_LIBRARY[1].make();
      const deploy = (s) => job(`deploy-${slug(s.label)}`, `Deploy on ${s.name}`, onServer(s), [STEP_LIBRARY[4].make(s), STEP_LIBRARY[5].make(s), STEP_LIBRARY[6].make(s), STEP_LIBRARY[7].make(s), STEP_LIBRARY[8].make(s)]);
      return { name: 'Laravel: test and deploy', triggers: T({ push: { on: true, branches: [branch] } }), jobs: [tests, ...perServer(servers, deploy, { after: 'tests', liveWaits: true })] };
    } },
  { key: 'images', icon: '📦', title: 'Build images on GitHub, servers only pull them', hint: 'The build runs on GitHub (not on your servers); each server pulls the new image and restarts — live waits. Your docker-compose.yml uses image: ghcr.io/<owner>/<repo>', tags: ['Docker', 'GitHub Packages', 'Live waits'],
    make: (servers, branch) => {
      const build = JOB_LIBRARY[2].make();
      const deploy = (s) => job(`deploy-${slug(s.label)}`, `Deploy on ${s.name}`, onServer(s), [
        step('Log in to GitHub Packages', { run: 'echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u "${{ github.actor }}" --password-stdin' }),
        step('Pull the new image and restart', { run: `cd ${appFolder(s)}\ndocker compose pull\ndocker compose up -d --remove-orphans\ndocker image prune -f` }),
        STEP_LIBRARY[8].make(s),
      ]);
      return { name: 'Build and deploy images', triggers: T({ push: { on: true, branches: [branch] } }), jobs: [build, ...perServer(servers, deploy, { after: 'build', liveWaits: true })] };
    } },
  { key: 'node-pm2', icon: '🟩', title: 'Node / Nuxt app with PM2', hint: 'Tests on GitHub; each server: git pull, npm ci, build, pm2 reload — standby first, live last', tags: ['Node', 'Nuxt', 'PM2'],
    make: (servers, branch) => {
      const deploy = (s) => job(`deploy-${slug(s.label)}`, `Deploy on ${s.name}`, onServer(s), [
        STEP_LIBRARY[4].make(s),
        step('Install, build and reload', { run: `cd ${repoFolder(s)}\nnpm ci\nnpm run build\npm2 reload ecosystem.config.js --update-env || pm2 reload all --update-env` }),
        STEP_LIBRARY[8].make(s),
      ]);
      return { name: 'Node app: test and deploy', triggers: T({ push: { on: true, branches: [branch] } }), jobs: [JOB_LIBRARY[0].make(), ...perServer(servers, deploy, { after: 'tests' })] };
    } },
  { key: 'static', icon: '🌐', title: 'Static site (Vue, React…) to nginx', hint: 'Build once on GitHub, then each server copies the files into its web folder', tags: ['Vue', 'Static', 'nginx'],
    make: (servers, branch) => {
      const build = job('build', 'Build the site', GH, [STEP_LIBRARY[0].make(), STEP_LIBRARY[2].make(), step('Build', { run: 'npm ci\nnpm run build' }), step('Keep the files for the servers', { uses: 'actions/upload-artifact@v4', with: { name: 'site', path: 'dist' } })]);
      const deploy = (s) => job(`publish-${slug(s.label)}`, `Publish on ${s.name}`, onServer(s), [step('Get the built files', { uses: 'actions/download-artifact@v4', with: { name: 'site', path: 'site' } }), step('Copy into the web folder', { run: `rsync -a --delete site/ ${appFolder(s)}/` })]);
      return { name: 'Build and publish the site', triggers: T({ push: { on: true, branches: [branch] } }), jobs: [build, ...perServer(servers, deploy, { after: 'build' })] };
    } },
  { key: 'pr-tests', icon: '🔍', title: 'Check pull requests (tests only)', hint: 'Every pull request runs the tests — nothing is deployed. Good next to a deploy workflow', tags: ['Tests', 'Pull requests'],
    make: (servers, branch) => ({ name: 'Check pull requests', triggers: T({ push: { on: false, branches: [] }, pull_request: { on: true, branches: [branch] } }), jobs: [JOB_LIBRARY[0].make()] }) },
  { key: 'nightly', icon: '🌙', title: 'Nightly clean-up on every server', hint: 'Every night: remove old Docker images and build cache, show free disk space', tags: ['Schedule', 'Maintenance'],
    make: (servers) => ({
      name: 'Nightly clean-up',
      triggers: T({ push: { on: false, branches: [] }, schedule: ['0 3 * * *'] }),
      jobs: (servers.length ? servers : [{ name: 'server', label: 'my-server' }]).map((s) => job(`clean-${slug(s.label)}`, `Clean up ${s.name}`, onServer(s), [step('Remove old images and build cache', { run: 'docker image prune -af --filter "until=168h"\ndocker builder prune -f --filter "until=168h"' }), step('Free disk space', { run: 'df -h /' })])),
    }) },
);

const IF_PRESETS = [
  { value: '', label: 'When the jobs before it worked (normal)' },
  { value: 'always()', label: 'Always — even if something before it failed' },
  { value: 'failure()', label: 'Only when something before it failed' },
  { value: "github.event_name == 'push'", label: 'Only for a push (not a manual run)' },
  { value: "github.ref == 'refs/heads/main'", label: 'Only on the main branch' },
];
const SCHEDULE_PRESETS = [
  ['0 3 * * *', 'Every night at 3:00 (UTC)'],
  ['0 * * * *', 'Every hour'],
  ['0 6 * * 1', 'Every Monday 6:00 (UTC)'],
];

/* ------------------------------------------------------------------ layout */
const CARD_W = 236;
const CARD_H = 150;
const COL_W = 300;
const ROW_H = 180;
const PAD = 28;

/** Each job's column = 1 + the column of the latest job it waits for ("needs"). */
function layout(flow) {
  const jobs = flow?.jobs || [];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const level = new Map();
  const lvl = (j, seen = new Set()) => {
    if (level.has(j.id)) return level.get(j.id);
    if (seen.has(j.id)) return 1; // a loop: shown, the YAML check will complain
    seen.add(j.id);
    const n = (j.needs || []).map((id) => byId.get(id)).filter(Boolean);
    const v = n.length ? 1 + Math.max(...n.map((x) => lvl(x, seen))) : 1;
    level.set(j.id, v);
    return v;
  };
  jobs.forEach((j) => lvl(j));
  const cols = new Map();
  for (const j of jobs) {
    const c = level.get(j.id);
    if (!cols.has(c)) cols.set(c, []);
    cols.get(c).push(j);
  }
  const maxRows = Math.max(1, ...[...cols.values()].map((c) => c.length));
  const height = PAD * 2 + maxRows * ROW_H - (ROW_H - CARD_H);
  const pos = new Map();
  for (const [c, list] of cols) {
    const top = (height - (list.length * ROW_H - (ROW_H - CARD_H))) / 2;
    list.forEach((j, i) => pos.set(j.id, { x: PAD + c * COL_W, y: top + i * ROW_H, col: c }));
  }
  const trigger = { x: PAD, y: height / 2 - CARD_H / 2, col: 0 };
  const maxCol = Math.max(0, ...level.values());
  return { pos, trigger, level, width: PAD * 2 + (maxCol + 1) * COL_W - (COL_W - CARD_W), height };
}
const curve = (a, b) => {
  const x1 = a.x + CARD_W;
  const y1 = a.y + CARD_H / 2;
  const x2 = b.x;
  const y2 = b.y + CARD_H / 2;
  const dx = Math.max(40, (x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
};

/* ------------------------------------------------------------------ a small picture of a flow (template cards) */
export const MiniFlow = {
  props: { flow: Object },
  setup(props) {
    const W = 300;
    const H = 96;
    const geo = computed(() => {
      const L = layout(props.flow);
      const k = Math.min(W / L.width, H / L.height, 0.32);
      const ox = (W - L.width * k) / 2;
      const oy = (H - L.height * k) / 2;
      const box = (p) => ({ x: ox + p.x * k, y: oy + p.y * k, w: CARD_W * k, h: CARD_H * k });
      const boxes = (props.flow?.jobs || []).map((j) => ({ id: j.id, name: j.name || j.id, kind: j.runs_on?.kind === 'server' || /self-hosted/.test(j.runs_on?.raw || '') ? 'server' : j.runs_on?.kind === 'github' ? 'github' : 'custom', wait: /waits for switchboard/i.test(j.name), ...box(L.pos.get(j.id)) }));
      const t = box(L.trigger);
      const at = (id) => (id === 'trigger' ? t : boxes.find((b) => b.id === id));
      const lines = [];
      for (const j of props.flow?.jobs || []) {
        const to = at(j.id);
        for (const n of j.needs?.length ? j.needs : ['trigger']) {
          const fr = at(n);
          if (fr && to) lines.push({ id: `${n}-${j.id}`, d: `M ${fr.x + fr.w} ${fr.y + fr.h / 2} C ${fr.x + fr.w + 12} ${fr.y + fr.h / 2}, ${to.x - 12} ${to.y + to.h / 2}, ${to.x} ${to.y + to.h / 2}` });
        }
      }
      return { boxes, t, lines };
    });
    return { geo, W, H };
  },
  template: `
  <svg class="fl-mini" :viewBox="'0 0 ' + W + ' ' + H" role="img" :aria-label="(flow?.jobs || []).map(j => j.name || j.id).join(' then ')">
    <path v-for="l in geo.lines" :key="l.id" :d="l.d" class="fl-mini-line" />
    <rect :x="geo.t.x" :y="geo.t.y" :width="geo.t.w" :height="geo.t.h" rx="5" class="fl-mini-box k-trigger" />
    <rect v-for="b in geo.boxes" :key="b.id" :x="b.x" :y="b.y" :width="b.w" :height="b.h" rx="5" class="fl-mini-box" :class="['k-' + b.kind, { wait: b.wait }]"><title>{{ b.name }}</title></rect>
  </svg>`,
};

/* ------------------------------------------------------------------ the editor */
export const FlowEditor = {
  props: {
    projectId: Number,
    content: String,
    readonly: Boolean,
    branch: { type: String, default: 'main' },
    path: { type: String, default: '.github/workflows/deploy.yml' },
    compact: Boolean, // picture only (e.g. Switchboard's own file)
    startOpen: Boolean, // open the template gallery first (a new file)
  },
  emits: ['update:content', 'commit'],
  setup(props, { emit }) {
    const flow = ref(null);
    const errors = ref([]);
    const servers = ref([]);
    const view = ref('flow'); // flow | yaml | both
    const selected = ref(null); // job id | 'trigger'
    const openStep = ref(-1);
    const library = ref(null); // { kind: 'job' | 'step' | 'start', after }
    const pickServer = ref('');
    const sim = reactive({ on: false, state: {}, step: {}, text: '', idx: 0 });
    const busy = ref(false);
    let ownWrite = null; // the text we just wrote: don't read it back
    let parseT = null;
    let applyT = null;

    const isAdmin = computed(() => !props.readonly);
    async function parse(text) {
      try {
        const r = await http.post(`/projects/${props.projectId}/ci/flow/parse`, { content: text || '' });
        errors.value = r.errors || [];
        servers.value = r.servers || [];
        if (r.flow) flow.value = r.flow;
        if (selected.value && selected.value !== 'trigger' && !flow.value?.jobs.some((j) => j.id === selected.value)) selected.value = null;
      } catch (e) {
        errors.value = [e.message];
      }
    }
    watch(
      () => props.content,
      (t) => {
        if (t === ownWrite) return;
        clearTimeout(parseT);
        parseT = setTimeout(() => parse(t), flow.value ? 450 : 0);
      },
      { immediate: true },
    );
    onUnmounted(() => {
      clearTimeout(parseT);
      clearTimeout(applyT);
      stopSim();
    });

    /** Every edit of the picture → the YAML (debounced; only what changed is rewritten by the server). */
    function changed() {
      if (props.readonly) return;
      clearTimeout(applyT);
      applyT = setTimeout(apply, 250);
    }
    async function apply() {
      try {
        const r = await http.post(`/projects/${props.projectId}/ci/flow/apply`, { content: props.content || '', flow: flow.value });
        ownWrite = r.content;
        emit('update:content', r.content);
        errors.value = [];
      } catch (e) {
        errors.value = [e.message];
      }
    }

    const lay = computed(() => layout(flow.value));
    // Shrink the picture to fit the box (down to 60 %; wider flows scroll).
    const wrap = ref(null);
    const wrapW = ref(0);
    let ro = null;
    onMounted(() => {
      if (!window.ResizeObserver) return;
      ro = new ResizeObserver(([e]) => (wrapW.value = e.contentRect.width));
      watch(wrap, (el) => el && ro.observe(el), { immediate: true });
    });
    onUnmounted(() => ro && ro.disconnect());
    const scale = computed(() => (wrapW.value && lay.value.width > wrapW.value ? Math.max(0.6, (wrapW.value - 4) / lay.value.width) : 1));
    const jobsOf = computed(() => flow.value?.jobs || []);
    const sel = computed(() => (selected.value && selected.value !== 'trigger' ? jobsOf.value.find((j) => j.id === selected.value) : null));
    const serverByLabel = (label) => servers.value.find((s) => s.label === label) || null;
    const where = (j) => {
      if (j.uses) return { icon: '🔁', text: 'Another workflow', cls: 'custom' };
      const r = j.runs_on || {};
      if (r.kind === 'github') return { icon: '☁️', text: `GitHub's machine (${r.image})`, cls: 'github' };
      if (r.kind === 'server') {
        const s = serverByLabel(r.label);
        return { icon: '🖥️', text: s ? s.name : `server "${r.label}"`, cls: 'server', live: !!s?.live, unknown: !s };
      }
      if (/self-hosted/.test(r.raw || '')) return { icon: '🖥️', text: 'Your servers (picked while it runs)', cls: 'server' };
      return { icon: '⚙️', text: 'Picked while it runs', cls: 'custom' };
    };
    /** "Deploy to ${{ matrix.server.name }}" → "Deploy to each server": names readable for people new to YAML. */
    const plain = (t) =>
      String(t || '').replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (m, e) => (/^matrix\./.test(e) ? (/label/.test(e) ? '' : 'each server') : /live_name|live/.test(e) ? 'the live server' : /github\.sha/.test(e) ? 'this commit' : '…')).replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
    const title = (j) => plain(j.name) || j.id;
    const badges = (j) => {
      const b = [];
      if (/approv|choose/i.test(j.name)) b.push('✋ asks you first');
      if (/waits for switchboard/i.test(j.name)) b.push('⏸ live waits');
      if (j.extra.includes('strategy')) b.push('🔀 several servers');
      if (j.if) b.push(IF_PRESETS.find((p) => p.value === j.if)?.label.split(' —')[0] || 'only if…');
      if (j.environment) b.push(`🔒 ${j.environment}`);
      return b.slice(0, 2);
    };
    const triggerText = computed(() => {
      const t = flow.value?.triggers;
      if (!t) return [];
      const out = [];
      if (t.push.on) out.push(`⬆️ Push to ${t.push.branches.length ? t.push.branches.join(', ') : 'any branch'}`);
      if (t.pull_request.on) out.push(`🔀 Pull request${t.pull_request.branches.length ? ` to ${t.pull_request.branches.join(', ')}` : ''}`);
      if (t.manual) out.push('▶️ "Run" button (by hand)');
      for (const c of t.schedule) out.push(`⏰ ${SCHEDULE_PRESETS.find((p) => p[0] === c)?.[1] || c}`);
      for (const o of t.other) out.push(`• ${o}`);
      return out.length ? out : ['Nothing starts it yet'];
    });
    const edges = computed(() => {
      const L = lay.value;
      const out = [];
      for (const j of jobsOf.value) {
        const to = L.pos.get(j.id);
        if (!to) continue;
        const from = (j.needs || []).filter((n) => L.pos.has(n));
        if (!from.length) out.push({ id: `t-${j.id}`, d: curve(L.trigger, to), from: 'trigger', to: j.id });
        for (const n of from) out.push({ id: `${n}-${j.id}`, d: curve(L.pos.get(n), to), from: n, to: j.id });
      }
      return out;
    });
    const edgeState = (e) => {
      const a = e.from === 'trigger' ? (sim.on ? 'done' : '') : sim.state[e.from];
      const b = sim.state[e.to];
      if (b === 'running') return 'running';
      if (a === 'done' && b === 'done') return 'done';
      return '';
    };

    /* ---------- "Show how it runs": a pretend run, job by job, in plain words */
    let simT = null;
    function stopSim() {
      clearTimeout(simT);
      sim.on = false;
      sim.state = {};
      sim.step = {};
      sim.text = '';
    }
    function play() {
      if (sim.on) return stopSim();
      if (!jobsOf.value.length) return;
      stopSim();
      sim.on = true;
      const fast = reducedMotion();
      const cols = [...new Set([...lay.value.level.values()])].sort((a, b) => a - b);
      const t = flow.value.triggers;
      sim.text = `It starts: ${t.push.on ? `someone pushes to ${t.push.branches.join(', ') || 'a branch'}` : t.manual ? 'you click Run' : 'its trigger fires'}…`;
      sim.state = { trigger: 'running' };
      let i = 0;
      const next = () => {
        if (!sim.on) return;
        if (i >= cols.length) {
          sim.state = { ...sim.state, trigger: 'done' };
          const live = jobsOf.value.find((j) => /waits for switchboard/i.test(j.name));
          sim.text = live ? '✅ Done — the live server now waits for you in Switchboard ("Deploy now")' : '✅ Done — this happens every time it starts';
          simT = setTimeout(() => (sim.on ? (sim.text = sim.text) : null), 10);
          return;
        }
        const col = cols[i++];
        const list = jobsOf.value.filter((j) => lay.value.level.get(j.id) === col);
        sim.state = { ...sim.state, trigger: 'done', ...Object.fromEntries(list.map((j) => [j.id, 'running'])) };
        const names = list.map((j) => {
          const w = where(j);
          return `${w.cls === 'server' ? (j.runs_on.kind === 'server' ? `your server ${w.text}` : 'your servers') : w.cls === 'github' ? "GitHub's machine" : 'a runner'} runs “${title(j)}”`;
        });
        sim.text = `${names.join(' · ')}${list.some((j) => j.needs.length) ? ' — after the jobs before it finished' : ''}`;
        const maxSteps = Math.max(1, ...list.map((j) => j.steps.length));
        const per = fast ? 60 : Math.max(260, Math.min(650, 2600 / maxSteps));
        let k = 0;
        const tick = () => {
          if (!sim.on) return;
          sim.step = Object.fromEntries(list.map((j) => [j.id, Math.min(k, j.steps.length)]));
          if (k++ < maxSteps) simT = setTimeout(tick, per);
          else {
            sim.state = { ...sim.state, ...Object.fromEntries(list.map((j) => [j.id, 'done'])) };
            simT = setTimeout(next, fast ? 50 : 450);
          }
        };
        tick();
      };
      simT = setTimeout(next, fast ? 50 : 900);
    }
    watch(() => props.content, () => sim.on && stopSim());

    /* ---------- editing */
    const select = (id) => {
      selected.value = selected.value === id ? null : id;
      openStep.value = -1;
    };
    const uniqueId = (base) => {
      let id = slug(base).replace(/^[^a-z_]+/, '') || 'job';
      const taken = new Set(jobsOf.value.map((j) => j.id));
      if (!taken.has(id)) return id;
      for (let n = 2; ; n++) if (!taken.has(`${id}-${n}`)) return `${id}-${n}`;
    };
    function addJob(tpl, after) {
      const s = serverByLabel(pickServer.value) || servers.value.find((x) => !x.live) || servers.value[0] || null;
      const j = tpl.make(tpl.server ? s : null, servers.value);
      j.id = uniqueId(j.id);
      if (after && after !== 'trigger') j.needs = [after];
      flow.value.jobs.push(j);
      library.value = null;
      selected.value = j.id;
      changed();
      nextTick(() => document.querySelector(`[data-flow-job="${j.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }));
    }
    function addStep(tpl) {
      const j = sel.value;
      if (!j) return;
      j.steps.push(tpl.make(j.runs_on.kind === 'server' ? serverByLabel(j.runs_on.label) : null));
      openStep.value = j.steps.length - 1;
      library.value = null;
      changed();
    }
    const moveStep = (i, d) => {
      const s = sel.value.steps;
      if (i + d < 0 || i + d >= s.length) return;
      [s[i], s[i + d]] = [s[i + d], s[i]];
      openStep.value = i + d;
      changed();
    };
    const removeStep = (i) => {
      sel.value.steps.splice(i, 1);
      openStep.value = -1;
      changed();
    };
    async function removeJob(j) {
      const users = jobsOf.value.filter((x) => x.needs.includes(j.id));
      if (!(await confirmBox({ title: `Remove “${j.name || j.id}”?`, message: users.length ? `${users.map((x) => x.name || x.id).join(', ')} ran after it — they will run after what it waited for instead.` : 'It is removed from the flow (nothing is saved to GitHub until you commit).', confirmText: 'Remove', danger: true }))) return;
      for (const u of users) u.needs = [...new Set([...u.needs.filter((n) => n !== j.id), ...j.needs])];
      flow.value.jobs = jobsOf.value.filter((x) => x !== j);
      selected.value = null;
      changed();
    }
    function renameJob(j, v) {
      const id = String(v || '').trim().replace(/[^A-Za-z0-9_-]/g, '-');
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) return toast('The id needs to start with a letter (letters, numbers, - and _)', 'error');
      if (id !== j.id && jobsOf.value.some((x) => x.id === id)) return toast(`There is already a job "${id}"`, 'error');
      for (const x of jobsOf.value) x.needs = x.needs.map((n) => (n === j.id ? id : n));
      j.id = id;
      selected.value = id;
      changed();
    }
    /** Jobs this job may wait for: not itself, nor jobs that (directly or not) wait for it. */
    const canNeed = (j) => {
      const after = new Set([j.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const x of jobsOf.value) if (!after.has(x.id) && x.needs.some((n) => after.has(n))) (after.add(x.id), (grew = true));
      }
      return jobsOf.value.filter((x) => !after.has(x.id));
    };
    const toggleNeed = (j, id) => {
      j.needs = j.needs.includes(id) ? j.needs.filter((n) => n !== id) : [...j.needs, id];
      changed();
    };
    const setWhere = (j, kind) => {
      if (kind === 'github') j.runs_on = { kind: 'github', image: j.runs_on.image || 'ubuntu-latest' };
      else if (kind === 'server') j.runs_on = { kind: 'server', label: j.runs_on.label || servers.value.find((s) => !s.live)?.label || servers.value[0]?.label || 'my-server' };
      else j.runs_on = { kind: 'custom', raw: j.runs_on.raw || 'ubuntu-latest' };
      changed();
    };
    const ifPreset = (j) => (IF_PRESETS.some((p) => p.value === j.if) ? j.if : '__custom');
    const setIf = (j, v) => {
      if (v !== '__custom') j.if = v;
      else if (IF_PRESETS.some((p) => p.value === j.if)) j.if = 'success()';
      changed();
    };
    const withText = (s) => Object.entries(s.with || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
    const setWith = (s, text) => {
      const o = {};
      for (const line of String(text).split('\n')) {
        const m = line.match(/^\s*([^:#]+?)\s*:\s*(.*)$/);
        if (m) o[m[1]] = m[2];
      }
      s.with = o;
      changed();
    };
    const stepKind = (s) => (s.uses ? 'uses' : 'run');
    const setStepKind = (s, k) => {
      if (k === 'uses') {
        s.uses = s.uses || 'actions/checkout@v4';
        s.run = '';
      } else {
        s.uses = '';
        s.with = {};
        s.run = s.run || 'echo "Hello"';
      }
      changed();
    };
    const stepIcon = (s) => (s.uses ? (STEP_LIBRARY.find((l) => l.make().uses && s.uses.startsWith(l.make().uses.split('@')[0]))?.icon || '🧩') : /docker compose/.test(s.run) ? '🐳' : /git pull/.test(s.run) ? '⬇️' : /curl/.test(s.run) ? '🩺' : '⌨️');
    const stepTitle = (s, i) => plain(s.name) || (s.uses ? s.uses.split('@')[0] : String(s.run || '').split('\n')[0]) || `Step ${i + 1}`;

    // Triggers
    const t = computed(() => flow.value?.triggers);
    const branches = (ev) => (t.value?.[ev].branches || []).join(', ');
    const setBranches = (ev, v) => {
      t.value[ev].branches = String(v).split(',').map((x) => x.trim()).filter(Boolean);
      changed();
    };
    const toggleSchedule = (c) => {
      const s = t.value.schedule;
      t.value.schedule = s.includes(c) ? s.filter((x) => x !== c) : [...s, c];
      changed();
    };

    // Duplicate a job for another server (same steps, another runner label)
    const dupFor = ref('');
    function duplicateFor(j) {
      const s = serverByLabel(dupFor.value);
      if (!s) return;
      const copy = clone(j);
      const from = j.runs_on.kind === 'server' ? serverByLabel(j.runs_on.label) : null;
      copy.id = uniqueId(`${j.id.replace(new RegExp(`-?${from?.label || '$^'}$`), '')}-${s.label}`);
      copy.name = from && j.name.includes(from.name) ? j.name.split(from.name).join(s.name) : `${j.name || j.id} (${s.name})`;
      copy.runs_on = onServer(s);
      for (const st of copy.steps) if (from?.app_dir && s.app_dir) st.run = String(st.run || '').split(from.app_dir).join(s.app_dir);
      flow.value.jobs.push(copy);
      selected.value = copy.id;
      dupFor.value = '';
      changed();
      toast(`“${copy.name}” added — it runs on ${s.name}`, 'success');
    }

    /* ---------- start from / templates / copy / download */
    const templates = ref([]);
    const loadTemplates = async () => {
      try {
        templates.value = await http.get('/flow-templates');
      } catch {}
    };
    /* ---------- template gallery: pick a flow, use it as it is (commit) or use it and add more */
    const gallery = reactive({ open: false, flows: {}, preview: null, previewYaml: '', projects: [], busy: '' });
    async function openGallery() {
      gallery.open = true;
      gallery.preview = null;
      library.value = null;
      // Each ready-made flow, built for this project's servers (for the small pictures).
      gallery.flows = Object.fromEntries(STARTERS.map((st) => [st.key, st.make(servers.value, props.branch)]));
      loadTemplates();
      try {
        gallery.projects = (await http.get('/projects')).filter((p) => !p.parent_id && p.id !== props.projectId && p.git_repo && p.ci_workflow_path);
      } catch {
        gallery.projects = [];
      }
    }
    const flowLine = (f) => (f?.jobs || []).map((j) => j.name || j.id).join(' → ');
    async function previewStarter(st) {
      try {
        gallery.previewYaml = (await http.post(`/projects/${props.projectId}/ci/flow/apply`, { content: '', flow: gallery.flows[st.key] })).content;
        gallery.preview = st;
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    async function useStarter(st, commitNow) {
      if (props.content && props.content.trim() && !(await confirmBox({ title: `Use “${st.title}”?`, message: commitNow ? 'The workflow file is replaced by this flow and committed to GitHub now.' : 'The flow in the editor is replaced (nothing is saved to GitHub until you commit).', confirmText: commitNow ? 'Use and commit' : 'Use it' }))) return;
      gallery.busy = st.key;
      try {
        const r = await http.post(`/projects/${props.projectId}/ci/flow/apply`, { content: '', flow: st.make(servers.value, props.branch) });
        ownWrite = null;
        emit('update:content', r.content);
        gallery.open = false;
        selected.value = null;
        if (commitNow) nextTick(() => emit('commit'));
        else toast('Now make it yours: click a card to change it, + to add a job — then Commit to GitHub', 'success');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        gallery.busy = '';
      }
    }
    async function useProjectFlow(p) {
      gallery.busy = `p${p.id}`;
      try {
        const r = await http.get(`/projects/${p.id}/ci/workflows?path=${encodeURIComponent(p.ci_workflow_path)}`);
        if (!r.content) throw new Error(`${p.ci_workflow_path} is not in ${p.git_repo} any more`);
        gallery.open = false;
        await useTemplate({ name: `${p.name} — ${p.ci_workflow_path.split('/').pop()}`, content: r.content });
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        gallery.busy = '';
      }
    }
    watch(
      () => [props.startOpen, flow.value != null],
      ([open, ready]) => {
        if (open && ready && !props.readonly && !props.compact && !gallery.shown) {
          gallery.shown = true;
          openGallery();
        }
      },
      { immediate: true },
    );

    async function startFrom(st) {
      if (props.content && props.content.trim() && !(await confirmBox({ title: `Start from “${st.title}”?`, message: 'The flow (and its YAML) in the editor is replaced. Nothing is saved to GitHub until you commit.', confirmText: 'Replace' }))) return;
      const f = st.make(servers.value, props.branch);
      try {
        const r = await http.post(`/projects/${props.projectId}/ci/flow/apply`, { content: '', flow: f });
        ownWrite = null;
        emit('update:content', r.content);
        library.value = null;
        selected.value = null;
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    const remap = reactive({ open: false, mode: 'copy', tpl: null, to: '', path: '', follow: true, map: {}, target: null, labels: [], projects: [], busy: false });
    const usedLabels = (f) => [...new Set((f?.jobs || []).filter((j) => j.runs_on.kind === 'server').map((j) => j.runs_on.label))];
    async function openCopy() {
      Object.assign(remap, { open: true, mode: 'copy', tpl: null, to: '', path: props.path, follow: true, map: {}, target: null, labels: usedLabels(flow.value) });
      try {
        remap.projects = (await http.get('/projects')).filter((p) => !p.parent_id && p.id !== props.projectId);
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    async function useTemplate(tpl) {
      library.value = null;
      try {
        const r = await http.post(`/projects/${props.projectId}/ci/flow/parse`, { content: tpl.content });
        Object.assign(remap, { open: true, mode: 'template', tpl, map: {}, target: { servers: servers.value }, labels: usedLabels(r.flow) });
        for (const l of remap.labels) remap.map[l] = serverByLabel(l) ? l : servers.value.find((s) => !s.live)?.label || servers.value[0]?.label || 'github';
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    watch(
      () => remap.to,
      async (id) => {
        remap.target = null;
        if (!id) return;
        try {
          remap.target = await http.get(`/projects/${id}/ci/flow/servers`);
          // Same name → same server; the live job → the target's live server; else the first standby.
          for (const l of remap.labels) {
            const from = serverByLabel(l);
            const ts = remap.target.servers;
            remap.map[l] = (ts.find((s) => s.label === l) || (from?.live ? ts.find((s) => s.live) : ts.find((s) => !s.live)) || ts[0])?.label || 'github';
          }
        } catch (e) {
          toast(e.message, 'error');
        }
      },
    );
    async function doRemap() {
      remap.busy = true;
      try {
        if (remap.mode === 'copy') {
          const r = await http.post(`/projects/${props.projectId}/ci/flow/copy`, { to: Number(remap.to), content: props.content, path: remap.path, map: remap.map, follow: remap.follow });
          toast(`${r.changed ? 'Committed' : 'Already the same'}: ${r.path} in ${r.repo}`, 'success');
        } else {
          // A template here: swap its servers for this project's, then put it in the editor.
          const tpl = remap.tpl;
          const p = await http.post(`/projects/${props.projectId}/ci/flow/parse`, { content: tpl.content });
          for (const j of p.flow.jobs) {
            if (j.runs_on.kind !== 'server' || !(j.runs_on.label in remap.map)) continue;
            const to = remap.map[j.runs_on.label];
            j.runs_on = to === 'github' ? { kind: 'github', image: 'ubuntu-latest' } : { ...j.runs_on, label: to };
          }
          const r = await http.post(`/projects/${props.projectId}/ci/flow/apply`, { content: tpl.content, flow: p.flow });
          ownWrite = null;
          emit('update:content', r.content);
          toast(`Started from “${tpl.name}” — check it, then Commit to GitHub`, 'success');
        }
        remap.open = false;
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        remap.busy = false;
      }
    }
    const tplForm = reactive({ open: false, name: '', description: '', busy: false });
    async function saveTemplate() {
      tplForm.busy = true;
      try {
        await http.post('/flow-templates', { name: tplForm.name, description: tplForm.description, content: props.content });
        toast(`Template “${tplForm.name}” saved — use it in any project: 📚 Templates`, 'success');
        tplForm.open = false;
        loadTemplates();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        tplForm.busy = false;
      }
    }
    async function deleteTemplate(tpl) {
      if (!(await confirmBox({ title: `Delete the template “${tpl.name}”?`, confirmText: 'Delete', danger: true }))) return;
      try {
        await http.del(`/flow-templates/${tpl.id}`);
        loadTemplates();
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    function download() {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([props.content || ''], { type: 'text/yaml' }));
      a.download = props.path.split('/').pop() || 'workflow.yml';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    function openLibrary(kind, after = null) {
      library.value = { kind, after };
      if (kind === 'start') loadTemplates();
      if (!pickServer.value) pickServer.value = servers.value.find((s) => !s.live)?.label || servers.value[0]?.label || '';
    }
    onMounted(() => {
      const onKey = (e) => {
        if (e.key === 'Escape' && library.value) library.value = null;
      };
      window.addEventListener('keydown', onKey);
      onUnmounted(() => window.removeEventListener('keydown', onKey));
    });
    const onYaml = (e) => emit('update:content', e.target.value);

    return {
      flow, errors, servers, view, title, wrap, scale, selected, sel, openStep, library, pickServer, sim, busy, isAdmin, lay, jobsOf, edges, edgeState, triggerText, where, badges, t, branches,
      CARD_W, CARD_H, STEP_LIBRARY, JOB_LIBRARY, STARTERS, IF_PRESETS, SCHEDULE_PRESETS, templates, remap, tplForm, dupFor, store,
      play, stopSim, select, addJob, addStep, moveStep, removeStep, removeJob, renameJob, canNeed, toggleNeed, setWhere, ifPreset, setIf, withText, setWith, stepKind, setStepKind, stepIcon, stepTitle,
      setBranches, toggleSchedule, duplicateFor, startFrom, gallery, openGallery, previewStarter, useStarter, useProjectFlow, flowLine, openCopy, useTemplate, doRemap, saveTemplate, deleteTemplate, download, openLibrary, changed, onYaml, serverByLabel,
    };
  },
  template: `
  <div class="fl" :class="{ 'fl-compact': compact }">
    <div class="fl-bar">
      <div class="row gap-6 wrap">
        <button class="btn btn-sm" :class="sim.on ? '' : 'btn-primary'" @click="play" :disabled="!jobsOf.length">{{ sim.on ? '■ Stop' : '▶ Show how it runs' }}</button>
        <template v-if="isAdmin && !compact">
          <button class="btn btn-sm" @click="openLibrary('job')" :disabled="!flow">+ Add a job</button>
          <button class="btn btn-sm fl-tpl-btn" @click="openGallery">📚 Templates</button>
          <button class="btn btn-sm" @click="openCopy" :disabled="!flow || !content">Copy to another project…</button>
          <button class="btn btn-sm" @click="tplForm.open = true; tplForm.name = (flow && flow.name) || ''" :disabled="!flow || !content">Save as template</button>
        </template>
        <button class="btn btn-sm btn-ghost" @click="download" :disabled="!content">⬇ .yml</button>
      </div>
      <div v-if="!compact" class="seg" role="tablist" aria-label="View">
        <button type="button" role="tab" :aria-selected="view === 'flow'" :class="{ on: view === 'flow' }" @click="view = 'flow'">Flow</button>
        <button type="button" role="tab" :aria-selected="view === 'both'" :class="{ on: view === 'both' }" @click="view = 'both'">Both</button>
        <button type="button" role="tab" :aria-selected="view === 'yaml'" :class="{ on: view === 'yaml' }" @click="view = 'yaml'">YAML</button>
      </div>
    </div>

    <div v-if="errors.length" class="alert alert-error" style="margin:0"><span class="alert-icon">✖</span><span><b>The YAML has a problem</b> — {{ errors[0] }}<template v-if="errors.length > 1"> (+{{ errors.length - 1 }} more)</template></span></div>
    <div class="fl-narrate" :class="{ on: sim.on }" aria-live="polite">{{ sim.on ? sim.text : (jobsOf.length ? 'Read it left → right: what starts it, then each job when the ones before it are done. Click a card to change it.' : 'No jobs yet — add one, or Start from a ready-made flow.') }}</div>

    <div class="fl-body" :class="'fv-' + (compact ? 'flow' : view)">
      <!-- ============ the picture ============ -->
      <div v-show="view !== 'yaml' || compact" class="fl-canvas-wrap" ref="wrap">
        <div v-if="flow" :style="{ width: lay.width * scale + 'px', height: lay.height * scale + 'px' }">
        <div class="fl-canvas" :style="{ width: lay.width + 'px', height: lay.height + 'px', transform: scale < 1 ? 'scale(' + scale + ')' : null }">
          <svg class="fl-edges" :width="lay.width" :height="lay.height" aria-hidden="true">
            <g v-for="e in edges" :key="e.id" class="fl-edge" :class="'st-' + edgeState(e)">
              <path :d="e.d" class="fl-edge-base" />
              <path :d="e.d" class="fl-edge-flow" />
              <circle v-if="edgeState(e) === 'running'" r="5" class="fl-packet"><animateMotion dur="1.1s" repeatCount="indefinite" :path="e.d" /></circle>
            </g>
          </svg>

          <!-- when -->
          <div class="fl-card fl-trigger" :class="['st-' + (sim.state.trigger || ''), { sel: selected === 'trigger' }]" :style="{ left: lay.trigger.x + 'px', top: lay.trigger.y + 'px', width: CARD_W + 'px', height: CARD_H + 'px' }"
               role="button" tabindex="0" @click="select('trigger')" @keydown.enter="select('trigger')" aria-label="When it starts">
            <div class="fl-card-head"><span class="fl-ico">⚡</span><b>When it starts</b></div>
            <div class="fl-trig-list"><div v-for="x in triggerText" :key="x" class="small">{{ x }}</div></div>
            <button v-if="isAdmin && !compact" class="fl-plus" @click.stop="openLibrary('job', 'trigger')" title="Add a job that starts first" aria-label="Add a job">+</button>
          </div>

          <!-- jobs -->
          <div v-for="j in jobsOf" :key="j.id" :data-flow-job="j.id" class="fl-card fl-job" :class="['w-' + where(j).cls, 'st-' + (sim.state[j.id] || ''), { sel: selected === j.id, live: where(j).live }]"
               :style="{ left: lay.pos.get(j.id).x + 'px', top: lay.pos.get(j.id).y + 'px', width: CARD_W + 'px', height: CARD_H + 'px' }"
               role="button" tabindex="0" @click="select(j.id)" @keydown.enter="select(j.id)" :aria-label="'Job ' + title(j)">
            <div class="fl-where"><span>{{ where(j).icon }}</span><span class="fl-where-t">{{ where(j).text }}</span><span v-if="where(j).live" class="badge badge-green">LIVE</span><span v-if="where(j).unknown" class="badge badge-amber" title="No server of this project has this runner label">?</span></div>
            <div class="fl-name">{{ title(j) }}</div>
            <div class="fl-steps-mini">
              <div v-for="(s, i) in j.steps.slice(0, 3)" :key="i" class="fl-step-mini" :class="{ done: sim.step[j.id] > i, now: sim.state[j.id] === 'running' && sim.step[j.id] === i }"><span>{{ stepIcon(s) }}</span>{{ stepTitle(s, i) }}</div>
              <div v-if="j.steps.length > 3" class="fl-more">+{{ j.steps.length - 3 }} more step{{ j.steps.length - 3 > 1 ? 's' : '' }}</div>
              <div v-if="j.uses" class="fl-more">uses {{ j.uses }}</div>
            </div>
            <div class="fl-foot"><span v-for="b in badges(j)" :key="b" class="fl-badge">{{ b }}</span></div>
            <div class="fl-bar-run"><span :style="{ width: (sim.state[j.id] === 'done' ? 100 : sim.state[j.id] === 'running' ? Math.round(100 * (sim.step[j.id] || 0) / Math.max(1, j.steps.length)) : 0) + '%' }"></span></div>
            <span v-if="sim.state[j.id] === 'done'" class="fl-done">✓</span>
            <button v-if="isAdmin && !compact" class="fl-plus" @click.stop="openLibrary('job', j.id)" title="Add a job that runs after this one" aria-label="Add a job after this">+</button>
          </div>
        </div>
        </div>
        <div v-else-if="!errors.length" class="muted" style="padding:20px"><span class="spinner"></span> Reading the workflow…</div>
      </div>

      <!-- ============ the YAML ============ -->
      <div v-if="!compact" v-show="view !== 'flow'" class="fl-yaml">
        <textarea :value="content" @input="onYaml" class="code" spellcheck="false" :disabled="!isAdmin" aria-label="Workflow YAML"></textarea>
      </div>
    </div>

    <!-- ============ edit panel ============ -->
    <div v-if="!compact && selected === 'trigger' && t" class="fl-panel">
      <div class="row between wrap gap-8"><h4>⚡ When it starts</h4><button class="btn btn-xs btn-ghost" @click="selected = null">Close</button></div>
      <label class="check"><input type="checkbox" v-model="t.push.on" @change="changed" :disabled="!isAdmin"><span class="check-text"><b>When code is pushed</b><span class="hint">e.g. a merge into main</span></span></label>
      <div v-if="t.push.on" class="field fl-indent"><label>Branches <span class="muted">(comma between them, empty = any)</span></label><input class="code" :value="branches('push')" @change="setBranches('push', $event.target.value)" :disabled="!isAdmin" placeholder="main"></div>
      <label class="check"><input type="checkbox" v-model="t.pull_request.on" @change="changed" :disabled="!isAdmin"><span class="check-text"><b>When a pull request is opened or updated</b><span class="hint">Good for running tests before you merge</span></span></label>
      <div v-if="t.pull_request.on" class="field fl-indent"><label>Into branches</label><input class="code" :value="branches('pull_request')" @change="setBranches('pull_request', $event.target.value)" :disabled="!isAdmin" placeholder="main"></div>
      <label class="check"><input type="checkbox" v-model="t.manual" @change="changed" :disabled="!isAdmin"><span class="check-text"><b>A "Run" button</b><span class="hint">Start it by hand (GitHub, or "Run now" in Switchboard)</span></span></label>
      <div class="field"><label>On a schedule</label><div class="row gap-6 wrap">
        <button v-for="p in SCHEDULE_PRESETS" :key="p[0]" type="button" class="btn btn-xs" :class="{ 'btn-primary': t.schedule.includes(p[0]) }" @click="toggleSchedule(p[0])" :disabled="!isAdmin">{{ p[1] }}</button></div>
        <span class="hint" v-if="t.schedule.some(c => !SCHEDULE_PRESETS.some(p => p[0] === c))">Also: <code v-for="c in t.schedule.filter(c => !SCHEDULE_PRESETS.some(p => p[0] === c))" :key="c">{{ c }} </code>(edit in YAML)</span></div>
      <div v-if="t.other.length" class="hint">Also starts on: {{ t.other.join(', ') }} (kept as it is)</div>
    </div>

    <div v-if="!compact && sel" class="fl-panel">
      <div class="row between wrap gap-8"><h4>{{ where(sel).icon }} {{ title(sel) }}</h4>
        <div class="row gap-6"><button v-if="isAdmin" class="btn btn-xs btn-danger" @click="removeJob(sel)">Remove job</button><button class="btn btn-xs btn-ghost" @click="selected = null">Close</button></div></div>
      <div v-if="sel.uses" class="alert alert-info" style="margin:0"><span class="alert-icon">ℹ</span><span>This job runs another workflow (<code>{{ sel.uses }}</code>) — change it in YAML.</span></div>
      <div class="form-row">
        <div class="field"><label>Name <span class="muted">(what you see in GitHub)</span></label><input v-model="sel.name" @input="changed" :disabled="!isAdmin"></div>
        <div class="field"><label>Id <span class="muted">(short, used by "runs after")</span></label><input class="code" :value="sel.id" @change="renameJob(sel, $event.target.value)" :disabled="!isAdmin"></div>
      </div>
      <div class="field" v-if="!sel.uses"><label>Where does it run?</label>
        <div class="seg" style="align-self:flex-start">
          <button type="button" :class="{ on: sel.runs_on.kind === 'github' }" @click="setWhere(sel, 'github')" :disabled="!isAdmin">☁️ GitHub's machine</button>
          <button type="button" :class="{ on: sel.runs_on.kind === 'server' }" @click="setWhere(sel, 'server')" :disabled="!isAdmin">🖥️ One of my servers</button>
          <button type="button" :class="{ on: sel.runs_on.kind === 'custom' }" @click="setWhere(sel, 'custom')" :disabled="!isAdmin">⚙️ Advanced</button>
        </div>
        <span v-if="sel.runs_on.kind === 'github'" class="hint">A fresh machine from GitHub for each run — good for building and tests. It can't see your servers' files.</span>
        <template v-if="sel.runs_on.kind === 'server'">
          <select v-model="sel.runs_on.label" @change="changed" :disabled="!isAdmin">
            <option v-for="s in servers" :key="s.label" :value="s.label">{{ s.name }}{{ s.live ? ' (live)' : '' }} — runner label "{{ s.label }}"</option>
            <option v-if="!serverByLabel(sel.runs_on.label)" :value="sel.runs_on.label">"{{ sel.runs_on.label }}" (not a server of this project)</option>
          </select>
          <span class="hint">Runs on that server's GitHub runner (Servers and Git → "+ Self-hosted runner", access <b>Full</b>), so it can use Docker and the app folder.</span>
        </template>
        <template v-if="sel.runs_on.kind === 'custom'"><input class="code" v-model="sel.runs_on.raw" @change="changed" :disabled="!isAdmin" placeholder="ubuntu-latest, or [self-hosted, label], or \${{ ... }}"><span class="hint">Exactly what goes after <code>runs-on:</code>.</span></template>
      </div>
      <div class="field"><label>Runs after</label>
        <div class="row gap-6 wrap">
          <label v-for="x in canNeed(sel)" :key="x.id" class="fl-chip" :class="{ on: sel.needs.includes(x.id) }"><input type="checkbox" :checked="sel.needs.includes(x.id)" @change="toggleNeed(sel, x.id)" :disabled="!isAdmin">{{ title(x) }}</label>
          <span v-if="!canNeed(sel).length" class="hint">No other jobs yet.</span>
        </div>
        <span class="hint">{{ sel.needs.length ? 'Starts when those are done.' : 'Nothing ticked: starts right away, at the same time as the other first jobs.' }}</span></div>
      <div class="field"><label>Run it…</label>
        <select :value="ifPreset(sel)" @change="setIf(sel, $event.target.value)" :disabled="!isAdmin">
          <option v-for="p in IF_PRESETS" :key="p.value" :value="p.value">{{ p.label }}</option>
          <option value="__custom">Custom condition…</option>
        </select>
        <input v-if="ifPreset(sel) === '__custom'" class="code" v-model="sel.if" @change="changed" :disabled="!isAdmin" placeholder="github.ref == 'refs/heads/main'"></div>

      <div v-if="!sel.uses" class="field"><label>Steps <span class="muted">(one after the other)</span></label>
        <div class="fl-step-list">
          <div v-for="(s, i) in sel.steps" :key="i" class="fl-step" :class="{ open: openStep === i }">
            <div class="fl-step-head" role="button" tabindex="0" @click="openStep = openStep === i ? -1 : i" @keydown.enter="openStep = openStep === i ? -1 : i">
              <span class="fl-step-n">{{ i + 1 }}</span><span>{{ stepIcon(s) }}</span><span class="fl-step-t">{{ stepTitle(s, i) }}</span>
              <span class="row gap-4" v-if="isAdmin" @click.stop><button class="icon-btn" @click="moveStep(i, -1)" :disabled="i === 0" aria-label="Move up">↑</button><button class="icon-btn" @click="moveStep(i, 1)" :disabled="i === sel.steps.length - 1" aria-label="Move down">↓</button><button class="icon-btn" @click="removeStep(i)" aria-label="Remove step">✕</button></span>
            </div>
            <div v-if="openStep === i" class="fl-step-body">
              <div class="field"><label>Name</label><input v-model="s.name" @input="changed" :disabled="!isAdmin"></div>
              <div class="seg" style="align-self:flex-start"><button type="button" :class="{ on: stepKind(s) === 'run' }" @click="setStepKind(s, 'run')" :disabled="!isAdmin">⌨️ Commands</button><button type="button" :class="{ on: stepKind(s) === 'uses' }" @click="setStepKind(s, 'uses')" :disabled="!isAdmin">🧩 Ready-made action</button></div>
              <div v-if="stepKind(s) === 'run'" class="field"><label>Commands <span class="muted">(bash; one per line)</span></label><textarea class="code" rows="5" v-model="s.run" @input="changed" :disabled="!isAdmin" spellcheck="false"></textarea></div>
              <template v-else>
                <div class="field"><label>Action</label><input class="code" v-model="s.uses" @input="changed" :disabled="!isAdmin" placeholder="actions/checkout@v4"></div>
                <div class="field"><label>Settings <span class="muted">(with: — one "name: value" per line)</span></label><textarea class="code" rows="3" :value="withText(s)" @change="setWith(s, $event.target.value)" :disabled="!isAdmin" spellcheck="false"></textarea></div>
              </template>
              <div v-if="s.extra" class="hint">Also has {{ s.extra.join(', ') }} — kept as it is.</div>
            </div>
          </div>
        </div>
        <button v-if="isAdmin" class="btn btn-sm" style="align-self:flex-start" @click="openLibrary('step')">+ Add a step</button></div>

      <div v-if="isAdmin && !sel.uses && servers.length" class="field"><label>Same job on another server</label>
        <div class="row gap-6 wrap"><select v-model="dupFor" style="max-width:260px"><option value="">Pick a server…</option><option v-for="s in servers.filter(x => !(sel.runs_on.kind === 'server' && x.label === sel.runs_on.label))" :key="s.label" :value="s.label">{{ s.name }}{{ s.live ? ' (live)' : '' }}</option></select>
          <button class="btn btn-sm" @click="duplicateFor(sel)" :disabled="!dupFor">Duplicate</button></div>
        <span class="hint">A copy with the same steps that runs on that server (folders are swapped too).</span></div>
      <div v-if="sel.extra.length" class="hint">Also set in YAML (kept as it is): <code v-for="k in sel.extra" :key="k" style="margin-right:4px">{{ k }}</code></div>
    </div>

    <!-- ============ library ============ -->
    <modal v-if="library" :title="library.kind === 'step' ? 'Add a step' : library.kind === 'start' ? 'Start from…' : 'Add a job'" size="lg" @close="library = null">
      <template v-if="library.kind === 'job'">
        <div v-if="servers.length" class="field"><label>For jobs that run on a server</label><select v-model="pickServer"><option v-for="s in servers" :key="s.label" :value="s.label">{{ s.name }}{{ s.live ? ' (live)' : '' }}</option></select></div>
        <div class="fl-lib">
          <button v-for="x in JOB_LIBRARY" :key="x.key" class="fl-lib-item" @click="addJob(x, library.after)"><span class="fl-lib-ico">{{ x.icon }}</span><span><b>{{ x.title }}</b><span class="hint">{{ x.hint }}</span></span></button>
        </div>
        <div class="hint">{{ library.after && library.after !== 'trigger' ? 'It runs after the job you clicked +' : 'It starts right away.' }} Change anything afterwards by clicking its card.</div>
      </template>
      <div v-else-if="library.kind === 'step'" class="fl-lib">
        <button v-for="x in STEP_LIBRARY" :key="x.key" class="fl-lib-item" @click="addStep(x)"><span class="fl-lib-ico">{{ x.icon }}</span><span><b>{{ x.title }}</b><span class="hint">{{ x.hint }}</span></span></button>
      </div>
      <template v-else>
        <h4 style="margin:0">Ready-made — built for this project's servers ({{ servers.map(s => s.name).join(', ') || 'none yet' }})</h4>
        <div class="fl-lib">
          <button v-for="x in STARTERS" :key="x.key" class="fl-lib-item" @click="useStarter(x, false)"><span class="fl-lib-ico">{{ x.icon }}</span><span><b>{{ x.title }}</b><span class="hint">{{ x.hint }}</span></span></button>
        </div>
        <h4 style="margin:0">Your templates</h4>
        <div v-if="templates.length" class="fl-lib">
          <div v-for="x in templates" :key="x.id" class="fl-lib-item as-row"><button class="fl-lib-main" @click="useTemplate(x)"><span class="fl-lib-ico">📋</span><span><b>{{ x.name }}</b><span class="hint">{{ x.description || 'Saved by ' + (x.created_by || '?') }}</span></span></button><button class="icon-btn" @click="deleteTemplate(x)" aria-label="Delete template">✕</button></div>
        </div>
        <div v-else class="hint">None yet — open a flow you like and click "Save as template".</div>
      </template>
    </modal>

    <!-- ============ template gallery ============ -->
    <modal v-if="gallery.open" :title="gallery.preview ? gallery.preview.icon + ' ' + gallery.preview.title : '📚 Choose a template'" size="xl" @close="gallery.open = false">
      <template v-if="gallery.preview">
        <div class="hint" style="margin:0">{{ gallery.preview.hint }}</div>
        <flow-editor :project-id="projectId" :content="gallery.previewYaml" readonly compact :branch="branch" />
        <details class="fl-tpl-yaml"><summary>See the YAML</summary><pre class="log" style="min-height:0">{{ gallery.previewYaml }}</pre></details>
      </template>
      <template v-else>
        <div class="fl-tpl-intro">Pick a flow to start from. <b>Use as it is</b> commits it right away; <b>Use and edit</b> puts it in the editor so you can add jobs and steps first. Built for this project's servers: <b>{{ servers.map(s => s.name + (s.live ? ' (live)' : '')).join(', ') || 'no servers yet' }}</b>.</div>
        <div class="fl-tpl-grid">
          <div v-for="x in STARTERS" :key="x.key" class="fl-tpl">
            <button class="fl-tpl-pic" @click="previewStarter(x)" :aria-label="'Preview ' + x.title"><mini-flow :flow="gallery.flows[x.key]" /></button>
            <div class="fl-tpl-body">
              <div class="fl-tpl-title"><span>{{ x.icon }}</span><b>{{ x.title }}</b></div>
              <div class="hint" style="margin:0">{{ x.hint }}</div>
              <div class="fl-tpl-line small muted">{{ flowLine(gallery.flows[x.key]) }}</div>
              <div class="fl-tpl-tags"><span v-for="t in x.tags || []" :key="t" class="fl-badge">{{ t }}</span></div>
            </div>
            <div class="fl-tpl-actions">
              <button class="btn btn-xs btn-ghost" @click="previewStarter(x)">▶ Preview</button>
              <button class="btn btn-xs" @click="useStarter(x, false)" :disabled="!!gallery.busy">Use and edit</button>
              <button class="btn btn-xs btn-primary" @click="useStarter(x, true)" :disabled="!!gallery.busy"><span v-if="gallery.busy === x.key" class="spinner"></span>Use as it is</button>
            </div>
          </div>
        </div>
        <template v-if="gallery.projects.length">
          <h4 class="fl-tpl-h">From your other projects</h4>
          <div class="fl-lib">
            <button v-for="p in gallery.projects" :key="p.id" class="fl-lib-item" @click="useProjectFlow(p)" :disabled="!!gallery.busy"><span class="fl-lib-ico">🔁</span><span><b>{{ p.name }}</b><span class="hint">{{ p.ci_workflow_path.split('/').pop() }} in {{ p.git_repo }} — you pick which of this project's servers takes each job</span></span></button>
          </div>
        </template>
        <h4 class="fl-tpl-h">Your templates</h4>
        <div v-if="templates.length" class="fl-lib">
          <div v-for="x in templates" :key="x.id" class="fl-lib-item as-row"><button class="fl-lib-main" @click="gallery.open = false; useTemplate(x)"><span class="fl-lib-ico">📋</span><span><b>{{ x.name }}</b><span class="hint">{{ x.description || 'Saved by ' + (x.created_by || '?') }}</span></span></button><button class="icon-btn" @click="deleteTemplate(x)" aria-label="Delete template">✕</button></div>
        </div>
        <div v-else class="hint">None yet — make a flow you like, then "Save as template" to reuse it in every project.</div>
      </template>
      <template #footer>
        <template v-if="gallery.preview">
          <button class="btn btn-ghost" @click="gallery.preview = null">← All templates</button>
          <button class="btn" @click="useStarter(gallery.preview, false)" :disabled="!!gallery.busy">Use and edit</button>
          <button class="btn btn-primary" @click="useStarter(gallery.preview, true)" :disabled="!!gallery.busy">Use as it is</button>
        </template>
        <button v-else class="btn btn-ghost" @click="gallery.open = false">{{ flow && flow.jobs.length ? 'Keep my flow' : 'Close' }}</button>
      </template>
    </modal>

    <!-- ============ copy to another project / use a template ============ -->
    <modal v-if="remap.open" :title="remap.mode === 'copy' ? 'Copy this flow to another project' : 'Use “' + remap.tpl.name + '”'" size="md" @close="remap.open = false">
      <div v-if="remap.mode === 'copy'" class="field"><label>Project</label>
        <select v-model="remap.to"><option value="">Pick a project…</option><option v-for="p in remap.projects" :key="p.id" :value="p.id" :disabled="!p.git_repo">{{ p.name }}{{ p.git_repo ? ' — ' + p.git_repo : ' (no repository)' }}</option></select></div>
      <div v-if="remap.mode === 'copy'" class="field"><label>File in that repository</label><input class="code" v-model="remap.path"></div>
      <template v-if="remap.target">
        <div v-if="remap.labels.length" class="field"><label>Which server takes each job?</label>
          <div v-for="l in remap.labels" :key="l" class="fl-map-row">
            <span><span class="muted">jobs on</span> <b>{{ (serverByLabel(l) || {}).name || l }}</b>{{ (serverByLabel(l) || {}).live ? ' (live)' : '' }}</span><span class="muted">→</span>
            <select v-model="remap.map[l]"><option v-for="s in remap.target.servers" :key="s.label" :value="s.label">{{ s.name }}{{ s.live ? ' (live)' : '' }}</option><option value="github">GitHub's machine</option><option :value="l">keep "{{ l }}"</option></select>
          </div></div>
        <div v-else class="hint">No job runs on a server — it is copied as it is.</div>
        <label v-if="remap.mode === 'copy'" class="check"><input type="checkbox" v-model="remap.follow"><span class="check-text">Switchboard follows this file in that project (shows its runs, "Run now")</span></label>
      </template>
      <template #footer>
        <button class="btn btn-ghost" @click="remap.open = false">Cancel</button>
        <button class="btn btn-primary" @click="doRemap" :disabled="remap.busy || !remap.target || (remap.mode === 'copy' && !remap.to)"><span v-if="remap.busy" class="spinner"></span>{{ remap.mode === 'copy' ? 'Commit to that repository' : 'Put it in the editor' }}</button>
      </template>
    </modal>

    <modal v-if="tplForm.open" title="Save as template" size="sm" @close="tplForm.open = false">
      <div class="field"><label>Name</label><input v-model="tplForm.name" placeholder="Laravel: test, deploy standby, live waits"></div>
      <div class="field"><label>What it does <span class="muted">(optional)</span></label><input v-model="tplForm.description"></div>
      <div class="hint">Saved in Switchboard. In any project: 📚 Templates → Your templates (you pick which server takes each job).</div>
      <template #footer><button class="btn btn-ghost" @click="tplForm.open = false">Cancel</button><button class="btn btn-primary" @click="saveTemplate" :disabled="!tplForm.name || tplForm.busy">Save</button></template>
    </modal>
  </div>`,
};

// The gallery's preview shows a flow with the same editor (picture only).
FlowEditor.components = { FlowEditor, MiniFlow };

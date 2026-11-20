// Starter project → "Link with GitHub": a new repository with the server's code, a congratulation,
// and how to clone / run / pull / push it on your own computer ("Use on my PC").
import { ref, reactive, computed, onMounted, onUnmounted } from '/vendor/vue.js';
import { store, http, toast, closeDialog, openDialog, runJob } from './lib.js';
import { Modal } from './components.js';

/** Commands to get the project onto a PC and work with it, for this kind of app. */
export function cloneSteps(p) {
  const urls = p.git_urls || {};
  const folder = (p.git_repo || '').split('/')[1] || p.slug;
  const branch = p.git_branch || 'main';
  const port = p.template === 'laravel' ? 8000 : 3000;
  const run = p.has_makefile
    ? { title: 'Run it (with Docker)', cmd: `make setup               # first time: makes .env, builds and starts — http://localhost:${port}\nmake                     # shows every command: make start, make stop, make logs…`, note: 'Needs Docker Desktop on your PC (docker.com). The whole stack runs the same as on the server.' }
    : {
    laravel:{ title: 'Run it', cmd: 'composer install\ncp .env.example .env\nphp artisan key:generate\nphp artisan serve        # http://localhost:8000', note: 'Needs PHP 8.4 and Composer on your PC.' },
    frontend: { title: 'Run it', cmd: 'npm install\nnpm run dev              # http://localhost:5173 — changes show at once', note: 'Needs Node.js on your PC (nodejs.org).' },
    static: { title: 'Look at it', cmd: 'npx serve .              # http://localhost:3000', note: 'Or just open index.html in your browser.' },
  }[p.template] || { title: 'Run it', cmd: 'npm install\nnpm start                # http://localhost:3000', note: 'Needs Node.js on your PC (nodejs.org).' };
  if (p.has_makefile) run.cmd += '\nmake build               # after you change code: rebuild and restart';
  const deploys = p.ci_enabled ? `Switchboard deploys every push to ${branch} by itself.` : 'Then click Deploy on the project page (or turn on CI/CD to deploy every push).';
  return [
    { title: '1. Get the code (first time)', cmd: `git clone ${urls.https || ''}\ncd ${folder}`, note: `With an SSH key on GitHub you can use: git clone ${urls.ssh || ''}` },
    { title: `2. ${run.title}`, cmd: run.cmd, note: run.note },
    { title: '3. Get the newest code (already cloned)', cmd: `git pull`, note: 'Do this before you start working, so you have what others pushed.' },
    { title: '4. Send your changes', cmd: `git add -A\ngit commit -m "Describe your change"\ngit push`, note: deploys },
  ];
}

export const CloneGuide = {
  props: { project: Object },
  setup(props) {
    const steps = computed(() => cloneSteps(props.project));
    const copy = (t) => navigator.clipboard?.writeText(t.replace(/\s+#.*$/gm, '')).then(() => toast('Copied', 'success'));
    return { steps, copy };
  },
  template: `
  <div class="stack" style="gap:10px">
    <div v-for="s in steps" :key="s.title">
      <div class="row between"><b class="small">{{ s.title }}</b><button class="btn btn-xs" @click="copy(s.cmd)">Copy</button></div>
      <pre class="mono small" style="margin:4px 0;padding:8px 10px;background:var(--bg-2, rgba(0,0,0,.25));border-radius:8px;white-space:pre-wrap">{{ s.cmd }}</pre>
      <div v-if="s.note" class="tiny muted">{{ s.note }}</div>
    </div>
    <div class="tiny muted">Repository: <a :href="project.git_urls && project.git_urls.web" target="_blank" rel="noopener">{{ project.git_repo }} ↗</a> · branch {{ project.git_branch || 'main' }}</div>
  </div>`,
};

/** "Use on my PC" from the project page. */
export const CloneGuideDialog = {
  props: { project: Object },
  components: { Modal, CloneGuide },
  setup: () => ({ closeDialog }),
  template: `
  <modal :title="'Use ' + project.name + ' on your computer'" @close="closeDialog">
    <clone-guide :project="project" />
    <template #footer><button class="btn" @click="closeDialog">Close</button></template>
  </modal>`,
};

/** Project page: the code is only on the server → link it with GitHub. */
export const GitLinkBanner = {
  props: { project: Object },
  setup(props) {
    const show = computed(() => !props.project.git_repo && props.project.template && !props.project.parent_id && props.project.deployments?.length);
    return { show, link: () => openDialog('link-github', { project: props.project }), store };
  },
  template: `
  <div v-if="show" class="admin-only alert alert-info mb-12" style="align-items:center">
    <span class="alert-icon">🐙</span>
    <span class="grow">This app's code is only on the server. <b>Link it with GitHub</b> to keep it safe, work on it on your computer, and deploy every push.</span>
    <button class="btn btn-sm btn-primary" @click="link">Link with GitHub</button>
  </div>`,
};

export const LinkGithubDialog = {
  props: { project: Object },
  components: { Modal, CloneGuide },
  setup(props) {
    const me = ref(null);
    const f = reactive({ repo: '', private: true, ci: true });
    const job = ref(null); // { id, status, log }
    const done = ref(null); // the project after linking
    const busy = ref(false);
    let timer = null;
    onMounted(async () => {
      me.value = await http.get('/github/me').catch(() => ({ connected: false }));
      if (me.value.login) f.repo = `${me.value.login}/${props.project.slug}`;
    });
    onUnmounted(() => clearTimeout(timer));
    const valid = computed(() => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(f.repo));
    async function poll() {
      try {
        const j = await http.get(`/jobs/${job.value.id}`);
        job.value = { id: j.id, status: j.status, error: j.error, last: String(j.log || '').trim().split('\n').filter((l) => !/^\s*│/.test(l)).slice(-1)[0] || '' };
        if (j.status === 'success') {
          done.value = await http.get(`/projects/${props.project.id}`);
          store.live++;
          return;
        }
        if (j.status === 'failed' || j.status === 'cancelled') return;
      } catch {
        /* try again */
      }
      timer = setTimeout(poll, 2000);
    }
    async function link() {
      busy.value = true;
      try {
        const r = await http.post(`/projects/${props.project.id}/link-github`, f);
        job.value = { id: r.job.id, status: 'queued', last: '' };
        poll();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busy.value = false;
      }
    }
    const tryAgain = () => (job.value = null);
    return { me, f, job, done, busy, valid, link, tryAgain, closeDialog };
  },
  template: `
  <modal :title="done ? '🎉 ' + project.name + ' is on GitHub' : 'Link ' + project.name + ' with GitHub'" @close="closeDialog">
    <div v-if="done" class="form">
      <div class="alert alert-success" style="align-items:center"><span class="alert-icon">🎉</span><span><b>Congratulations!</b> Your code is now in <a :href="done.git_urls.web" target="_blank" rel="noopener">{{ done.git_repo }}</a>{{ f.ci ? ', and every push will be deployed' : '' }}. Here is how to work on it on your computer:</span></div>
      <clone-guide :project="done" />
    </div>
    <div v-else-if="job" class="form">
      <div v-if="job.status === 'failed' || job.status === 'cancelled'" class="alert alert-error"><span class="alert-icon">✖</span><span>{{ job.error || 'It did not work' }} — <a :href="'#/jobs/' + job.id">see the log</a></span></div>
      <div v-else class="row gap-8"><span class="spinner"></span><span>Linking… <span class="muted small">{{ job.last }}</span></span></div>
      <div class="tiny muted">Creating the repository, putting the server's code in it as the first commit, then connecting the other servers.</div>
    </div>
    <div v-else-if="!me" class="muted">Checking your GitHub account…</div>
    <div v-else-if="!me.connected" class="form">
      <p>Switchboard needs a GitHub token to create the repository. <a href="#/settings" @click="closeDialog">Settings → GitHub</a>, then come back here.</p>
    </div>
    <div v-else class="form">
      <p class="muted small">Switchboard creates a new GitHub repository and puts the code that is on the server now into it as the first commit. Nothing on the server changes.</p>
      <div class="field"><label>Repository</label><input v-model.trim="f.repo" class="code" placeholder="your-name/my-app"><span class="hint">owner/name — a new (or empty) repository. Signed in to GitHub as <b>{{ me.login }}</b>.</span></div>
      <label class="row gap-8"><input type="checkbox" v-model="f.private"> Private repository (only you and people you invite can see it)</label>
      <label class="row gap-8"><input type="checkbox" v-model="f.ci"> Deploy every push automatically (CI/CD)</label>
    </div>
    <template #footer>
      <template v-if="done"><button class="btn btn-primary" @click="closeDialog">Done</button></template>
      <template v-else-if="job && (job.status === 'failed' || job.status === 'cancelled')"><button class="btn" @click="tryAgain">Try again</button><button class="btn" @click="closeDialog">Close</button></template>
      <template v-else-if="!job"><button class="btn" @click="closeDialog">Cancel</button><button class="btn btn-primary" :disabled="!me || !me.connected || !valid || busy" @click="link">Link with GitHub</button></template>
      <template v-else><button class="btn" @click="closeDialog">Close (keeps running)</button></template>
    </template>
  </modal>`,
};

/** Commands on the server itself (SSH), for this kind of app. */
export function serverSteps(p) {
  const dep = p.deployments.find((d) => d.is_active) || p.deployments[0];
  if (!dep) return [];
  const user = p.ssh_users?.[dep.server_id] || 'root';
  const cd = `ssh ${user}@${dep.server_ip}\ncd ${dep.app_dir || '~'}`;
  const docker = user === 'root' ? '' : ' (if Docker says "permission denied", log out and in again, or put sudo in front)';
  if (p.has_makefile) {
    return [
      { title: `On ${dep.server_name}: go to the app`, cmd: cd, note: '' },
      { title: 'Control the whole stack', cmd: `make ps                   # what is running\nmake logs                 # follow the logs\nmake restart              # restart everything\nmake stop / make start${p.template === 'laravel' ? '\nmake artisan c="migrate:status"\nmake tinker' : ''}`, note: `"make" alone lists every command${docker}.` },
    ];
  }
  if (p.template === 'frontend') return [{ title: `On ${dep.server_name}`, cmd: `${cd}\nnpm run build             # build again by hand (deploys do this for you)`, note: 'nginx serves the built folder (dist).' }];
  if (p.template === 'pm2') return [{ title: `On ${dep.server_name}`, cmd: `${cd}\npm2 list\npm2 logs`, note: '' }];
  return [{ title: `On ${dep.server_name}`, cmd: `${cd}\ndocker compose ps\ndocker compose logs -f`, note: '' }];
}

const StepList = {
  props: { steps: Array },
  setup: () => ({ copy: (t) => navigator.clipboard?.writeText(t.replace(/\s+#.*$/gm, '')).then(() => toast('Copied', 'success')) }),
  template: `
  <div class="stack" style="gap:10px">
    <div v-for="s in steps" :key="s.title">
      <div class="row between"><b class="small">{{ s.title }}</b><button class="btn btn-xs" @click="copy(s.cmd)">Copy</button></div>
      <pre class="mono small" style="margin:4px 0;padding:8px 10px;background:var(--bg-2, rgba(0,0,0,.25));border-radius:8px;white-space:pre-wrap">{{ s.cmd }}</pre>
      <div v-if="s.note" class="tiny muted">{{ s.note }}</div>
    </div>
  </div>`,
};

/** 📘 How to use: on the server, on your computer, and deploy-on-push. */
export const ProjectGuideDialog = {
  props: { project: Object },
  components: { Modal, CloneGuide, StepList },
  setup(props) {
    const p = computed(() => props.project);
    const tab = ref('server');
    const server = computed(() => serverSteps(p.value));
    const turningOn = ref(false);
    async function ciOn() {
      turningOn.value = true;
      try {
        await http.put(`/projects/${p.value.id}/ci`, { ci_mode: 'pull' });
        const r = await http.post(`/projects/${p.value.id}/ci/setup`, { commit: true });
        closeDialog();
        if (r?.job) runJob(Promise.resolve(r));
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        turningOn.value = false;
      }
    }
    const link = () => openDialog('link-github', { project: p.value });
    const parts = computed(() => (p.value.services || []).join(', '));
    return { p, tab, server, ciOn, turningOn, link, parts, closeDialog };
  },
  template: `
  <modal :title="'How to use ' + p.name" @close="closeDialog">
    <div class="form">
      <div v-if="p.template === 'laravel'" class="small muted">One Docker stack: app (PHP + nginx), database{{ parts ? ', ' + parts : '' }}. {{ p.has_makefile ? 'Control it with make (Makefile in the app folder).' : '' }}</div>
      <div class="row gap-6">
        <button class="btn btn-sm" :class="{ 'btn-primary': tab === 'server' }" @click="tab = 'server'">🖥️ On the server</button>
        <button class="btn btn-sm" :class="{ 'btn-primary': tab === 'pc' }" @click="tab = 'pc'">💻 On your computer</button>
        <button class="btn btn-sm" :class="{ 'btn-primary': tab === 'ci' }" @click="tab = 'ci'">🚀 Deploy</button>
      </div>
      <step-list v-if="tab === 'server'" :steps="server" />
      <template v-if="tab === 'pc'">
        <clone-guide v-if="p.git_repo && p.git_urls" :project="p" />
        <div v-else class="alert alert-info" style="align-items:center"><span class="alert-icon">🐙</span><span class="grow">The code is only on the server for now. Link it with GitHub to get it onto your computer.</span><button class="admin-only btn btn-sm btn-primary" @click="link">Link with GitHub</button></div>
      </template>
      <template v-if="tab === 'ci'">
        <div v-if="p.ci_enabled" class="alert alert-success"><span class="alert-icon">✔</span><span>CI/CD is on: every push to <b>{{ p.git_branch || 'main' }}</b> is deployed by itself. Details on the CI/CD tab.</span></div>
        <div v-else-if="p.git_repo" class="alert alert-info" style="align-items:center"><span class="alert-icon">🚀</span><span class="grow">Deploy every push to <b>{{ p.git_branch || 'main' }}</b> automatically — Switchboard pulls the new code and rebuilds.</span><button class="admin-only btn btn-sm btn-primary" @click="ciOn" :disabled="turningOn">Turn on CI/CD</button></div>
        <div v-else class="muted small">Link the project with GitHub first (💻 On your computer), then turn on CI/CD here.</div>
        <div class="tiny muted">Without CI/CD: push your code, then click <b>Deploy</b> on the project page.</div>
      </template>
    </div>
    <template #footer><button class="btn" @click="closeDialog">Close</button></template>
  </modal>`,
};

/** After a new app is made: "🎉 ready — How to use it" (until dismissed). */
export const ReadyBanner = {
  props: { project: Object },
  setup(props) {
    const key = computed(() => `sb-ready-${props.project.id}`);
    const hidden = ref(false);
    try {
      hidden.value = !!localStorage.getItem(key.value);
    } catch {
      /* private window: show it */
    }
    const fresh = computed(() => props.project.template && Date.now() - new Date(props.project.created_at).getTime() < 3 * 86400000 && props.project.deployments?.length);
    const hide = () => {
      hidden.value = true;
      try {
        localStorage.setItem(key.value, '1');
      } catch {
        /* fine */
      }
    };
    return { hidden, fresh, hide, open: () => openDialog('project-guide', { project: props.project }) };
  },
  template: `
  <div v-if="fresh && !hidden" class="alert alert-success mb-12" style="align-items:center">
    <span class="alert-icon">🎉</span>
    <span class="grow"><b>{{ project.name }} is ready.</b> See how to use it — on the server, on your computer{{ project.has_makefile ? ' (make start, make stop…)' : '' }}, and deploying every push.</span>
    <button class="btn btn-sm btn-primary" @click="open">How to use</button>
    <button class="btn btn-sm btn-ghost" @click="hide" title="Hide">✕</button>
  </div>`,
};

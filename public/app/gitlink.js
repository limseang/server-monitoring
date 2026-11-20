// Starter project → "Link with GitHub": a new repository with the server's code, a congratulation,
// and how to clone / run / pull / push it on your own computer ("Use on my PC").
import { ref, reactive, computed, onMounted, onUnmounted } from '/vendor/vue.js';
import { store, http, toast, closeDialog, openDialog } from './lib.js';
import { Modal } from './components.js';

/** Commands to get the project onto a PC and work with it, for this kind of app. */
export function cloneSteps(p) {
  const urls = p.git_urls || {};
  const folder = (p.git_repo || '').split('/')[1] || p.slug;
  const branch = p.git_branch || 'main';
  const run = {
    laravel: { title: 'Run it', cmd: 'composer install\ncp .env.example .env\nphp artisan key:generate\nphp artisan serve        # http://localhost:8000', note: 'Needs PHP 8.4 and Composer on your PC.' },
    frontend: { title: 'Run it', cmd: 'npm install\nnpm run dev              # http://localhost:5173 — changes show at once', note: 'Needs Node.js on your PC (nodejs.org).' },
    static: { title: 'Look at it', cmd: 'npx serve .              # http://localhost:3000', note: 'Or just open index.html in your browser.' },
  }[p.template] || { title: 'Run it', cmd: 'npm install\nnpm start                # http://localhost:3000', note: 'Needs Node.js on your PC (nodejs.org).' };
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

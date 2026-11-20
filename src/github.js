import { config } from './config.js';
import { getSetting } from './settings.js';

/**
 * Small GitHub REST client for CI/CD. Uses the token from Settings → GitHub.
 * Token: classic token with the "repo" and "workflow" scopes, or a fine-grained token with
 * Administration, Contents, Workflows, Actions (read & write) and Pull requests (read) on the repos.
 */

export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const WORKFLOW_FILE = 'switchboard.yml';
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;

const enc = encodeURIComponent;
const repoPath = (repo) => {
  if (!REPO_RE.test(String(repo || ''))) throw new Error(`Not a GitHub repository name: "${repo}" (use owner/name)`);
  return repo.split('/').map(enc).join('/');
};

export const hasToken = () => !!getSetting('github_token');
export const gitUrl = (repo) => config.githubGitUrl.replace('{repo}', repo);
export const webUrl = (repo) => `${config.githubWebBase}/${repo}`;

export async function gh(method, path, { body, token, okStatus = [] } = {}) {
  const tok = token || getSetting('github_token');
  if (!tok) throw new Error('GitHub token is not set (Settings → GitHub)');
  let res;
  try {
    res = await fetch(config.githubApiBase + path, {
      method,
      headers: {
        Authorization: `Bearer ${tok}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'switchboard',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`GitHub API unreachable: ${e.cause?.code || e.message}`);
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok && !okStatus.includes(res.status)) {
    const detail = data?.errors?.map((e) => e.message || e.code).filter(Boolean).join('; ');
    const msg = `${data?.message || `HTTP ${res.status}`}${detail ? ` — ${detail}` : ''}`;
    const hint = res.status === 404 ? ' (repository not found, or the token has no access to it)' : res.status === 403 ? ' (the token is missing a permission)' : '';
    throw Object.assign(new Error(`GitHub: ${msg}${hint}`), { status: res.status });
  }
  return Object.assign(data ?? {}, { _status: res.status });
}

export async function whoami(token) {
  const u = await gh('GET', '/user', { token });
  return { login: u.login, name: u.name || '' };
}

export const getRepo = (repo) => gh('GET', `/repos/${repoPath(repo)}`);

export async function createRepo(repo, { privateRepo = true, description = '' } = {}) {
  const [owner, name] = repo.split('/');
  const me = await whoami();
  const path = owner.toLowerCase() === me.login.toLowerCase() ? '/user/repos' : `/orgs/${enc(owner)}/repos`;
  return gh('POST', path, { body: { name, private: privateRepo, description, auto_init: false } });
}

/** Add an SSH deploy key. A key that is already on the repo counts as success. */
export async function addDeployKey(repo, title, key, { readOnly = true } = {}) {
  const r = await gh('POST', `/repos/${repoPath(repo)}/keys`, { body: { title, key, read_only: readOnly }, okStatus: [422] });
  if (r._status === 422 && !/already in use/i.test(JSON.stringify(r))) throw new Error(`GitHub refused the deploy key: ${r.message}`);
  if (r._status === 422) {
    // Same key already added to this repo? Fine. Used by another repo? GitHub allows a key on one repo only.
    const keys = await gh('GET', `/repos/${repoPath(repo)}/keys?per_page=100`);
    if (!keys.some?.((k) => k.key?.trim() === key.trim().split(' ').slice(0, 2).join(' '))) {
      throw new Error('This server key is already a deploy key on another repository — GitHub allows a key on one repository only.');
    }
  }
}

export async function branchSha(repo, branch) {
  const r = await gh('GET', `/repos/${repoPath(repo)}/git/ref/heads/${branch.split('/').map(enc).join('/')}`, { okStatus: [404] });
  return r._status === 404 ? null : r.object?.sha;
}

/** Create `branch` from `from` when it doesn't exist yet. */
export async function ensureBranch(repo, branch, from) {
  if (await branchSha(repo, branch)) return false;
  const sha = await branchSha(repo, from);
  if (!sha) throw new Error(`Branch "${from}" does not exist in ${repo}`);
  await gh('POST', `/repos/${repoPath(repo)}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha } });
  return true;
}

export const runnerRegistrationToken = async (repo) => (await gh('POST', `/repos/${repoPath(repo)}/actions/runners/registration-token`)).token;
export const runnerRemoveToken = async (repo) => (await gh('POST', `/repos/${repoPath(repo)}/actions/runners/remove-token`)).token;
export const listRunners = async (repo) => (await gh('GET', `/repos/${repoPath(repo)}/actions/runners?per_page=100`)).runners || [];

/** Latest GitHub Actions runner for Linux: { version, url } for the server's CPU (x64 / arm64). */
export async function latestRunner(arch = 'x64') {
  const r = await gh('GET', '/repos/actions/runner/releases/latest');
  const version = String(r.tag_name || '').replace(/^v/, '');
  const asset = (r.assets || []).find((a) => a.name === `actions-runner-linux-${arch}-${version}.tar.gz`);
  if (!asset) throw new Error(`No GitHub runner download for linux-${arch} in release ${r.tag_name}`);
  return { version, url: asset.browser_download_url };
}

export async function getFile(repo, path, ref) {
  const r = await gh('GET', `/repos/${repoPath(repo)}/contents/${path.split('/').map(enc).join('/')}?ref=${enc(ref)}`, { okStatus: [404] });
  if (r._status === 404) return null;
  return { sha: r.sha, content: Buffer.from(r.content || '', 'base64').toString('utf8') };
}

/** Create or update a file on a branch. Returns false when it already had exactly this content. */
export async function putFile(repo, path, content, { branch, message }) {
  const cur = await getFile(repo, path, branch);
  if (cur && cur.content === content) return false;
  await gh('PUT', `/repos/${repoPath(repo)}/contents/${path.split('/').map(enc).join('/')}`, {
    body: { message, content: Buffer.from(content).toString('base64'), branch, ...(cur ? { sha: cur.sha } : {}) },
  });
  return true;
}

/** Runs of one workflow file (`file` = its name, e.g. deploy.yml; default Switchboard's own). */
export async function listRuns(repo, { perPage = 30, file = WORKFLOW_FILE } = {}) {
  const r = await gh('GET', `/repos/${repoPath(repo)}/actions/workflows/${enc(file)}/runs?per_page=${perPage}`, { okStatus: [404] });
  return r._status === 404 ? [] : r.workflow_runs || [];
}

export const dispatchWorkflow = (repo, ref, file = WORKFLOW_FILE, inputs = null) =>
  gh('POST', `/repos/${repoPath(repo)}/actions/workflows/${enc(file)}/dispatches`, { body: { ref, ...(inputs ? { inputs } : {}) } });

/** Set a repository variable (Actions → Variables), creating it when it does not exist. Token: Variables read & write. */
export async function setVariable(repo, name, value) {
  const r = await gh('PATCH', `/repos/${repoPath(repo)}/actions/variables/${enc(name)}`, { body: { name, value }, okStatus: [404] });
  if (r?._status === 404) await gh('POST', `/repos/${repoPath(repo)}/actions/variables`, { body: { name, value } });
}

/** The newest commits of a branch (for "deploy another commit" / rollback). */
export async function listCommits(repo, branch, perPage = 25) {
  const r = await gh('GET', `/repos/${repoPath(repo)}/commits?sha=${enc(branch)}&per_page=${perPage}`);
  return (Array.isArray(r) ? r : Object.values(r).filter((x) => x && typeof x === 'object' && x.sha)).map((c) => ({
    sha: c.sha,
    title: String(c.commit?.message || '').split('\n')[0].slice(0, 200),
    author: c.author?.login || c.commit?.author?.name || '',
    date: c.commit?.committer?.date || c.commit?.author?.date || null,
  }));
}

/** One run, and its jobs with their steps (for the live run view). */
export const getRun = (repo, id) => gh('GET', `/repos/${repoPath(repo)}/actions/runs/${Number(id)}`);
export async function listRunJobs(repo, id) {
  const r = await gh('GET', `/repos/${repoPath(repo)}/actions/runs/${Number(id)}/jobs?per_page=100`);
  return r.jobs || [];
}

/** Runs of any workflow in the repo that have not finished (queued, running, or waiting for an approval). */
export async function listActiveRuns(repo) {
  const lists = await Promise.all(['in_progress', 'queued', 'waiting'].map((s) => gh('GET', `/repos/${repoPath(repo)}/actions/runs?status=${s}&per_page=20`).then((r) => r.workflow_runs || [])));
  const seen = new Set();
  return lists.flat().filter((r) => !seen.has(r.id) && seen.add(r.id)).sort((a, b) => b.id - a.id);
}

/** Stop a run. force: also skips its "always run" steps (when a normal cancel hangs). */
export const cancelRun = (repo, id, force = false) => gh('POST', `/repos/${repoPath(repo)}/actions/runs/${Number(id)}/${force ? 'force-cancel' : 'cancel'}`);

/** The workflow files in .github/workflows on a branch (names only). */
export async function listWorkflowFiles(repo, ref) {
  const r = await gh('GET', `/repos/${repoPath(repo)}/contents/.github/workflows?ref=${enc(ref)}`, { okStatus: [404] });
  if (r._status === 404) return [];
  const list = Array.isArray(r) ? r : Object.values(r).filter((x) => x && typeof x === 'object' && x.name);
  return list.filter((f) => f.type === 'file' && /\.ya?ml$/i.test(f.name)).map((f) => `.github/workflows/${f.name}`);
}

export const listOpenPulls = async (repo) => {
  const r = await gh('GET', `/repos/${repoPath(repo)}/pulls?state=open&per_page=100`);
  return Array.isArray(r) ? r : Object.values(r).filter((x) => x && typeof x === 'object' && x.number);
};

/** Repositories the token can see (newest activity first). */
export async function listMyRepos() {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const r = await gh('GET', `/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=${page}`);
    const list = Array.isArray(r) ? r : [];
    out.push(...list.map((x) => ({ full_name: x.full_name, private: !!x.private, default_branch: x.default_branch || 'main', description: x.description || '', updated_at: x.pushed_at || x.updated_at })));
    if (list.length < 100) break;
  }
  return out;
}

export async function listBranches(repo) {
  const r = await gh('GET', `/repos/${repoPath(repo)}/branches?per_page=100`);
  return (Array.isArray(r) ? r : []).map((b) => b.name);
}

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

// Which JavaScript app a package.json is: a server (runs all the time, e.g. with PM2) or a front-end (built once,
// then plain files that nginx serves). Server frameworks win: Nuxt and Next also list vue / react.
const JS_SERVERS = [['nuxt', 'Nuxt'], ['next', 'Next.js'], ['@sveltejs/kit', 'SvelteKit'], ['@remix-run/node', 'Remix'], ['@nestjs/core', 'NestJS'], ['express', 'Express'], ['fastify', 'Fastify'], ['koa', 'Koa'], ['hono', 'Hono']];
const JS_FRONTENDS = [['@angular/core', 'Angular'], ['vue', 'Vue'], ['react', 'React'], ['svelte', 'Svelte'], ['solid-js', 'Solid'], ['astro', 'Astro'], ['vite', 'Vite']];

/** package.json text → { kind: 'server' | 'frontend' | null, framework } (exported for tests). */
export function classifyPackage(text) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return { kind: null, framework: null };
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const hit = (list) => list.find(([d]) => d in deps)?.[1] || null;
  const server = hit(JS_SERVERS);
  // Nuxt with `nuxt generate` / Next with `next export` as the build: static files after all
  if (server && /\b(nuxt generate|next export)\b/.test(pkg.scripts?.build || '')) return { kind: 'frontend', framework: server };
  if (server) return { kind: 'server', framework: server };
  const front = hit(JS_FRONTENDS);
  if (front && pkg.scripts?.build) return { kind: 'frontend', framework: front };
  if (pkg.scripts?.start) return { kind: 'server', framework: 'Node.js' };
  return { kind: front ? 'frontend' : null, framework: front };
}

/**
 * Look at a repo's top-level files and guess how to run it:
 * its own Docker Compose file → "compose", artisan → Laravel, package.json → Node, else static.
 */
export async function detectRepo(repo, branch) {
  const info = await getRepo(repo);
  const ref = branch || info.default_branch || 'main';
  const list = await gh('GET', `/repos/${repoPath(repo)}/contents?ref=${enc(ref)}`, { okStatus: [404] });
  const names = Array.isArray(list) ? list.map((f) => f.name) : [];
  const compose = COMPOSE_FILES.find((n) => names.includes(n)) || null;
  let ports = [];
  if (compose) {
    const f = await getFile(repo, compose, ref).catch(() => null);
    ports = [...new Set([...(f?.content || '').matchAll(/["'\s-](?:[\d.]+:)?(\d{2,5}):\d{2,5}(?:\/tcp)?["'\s]/g)].map((m) => Number(m[1])))].filter((p) => p > 0 && p < 65536);
  }
  let js = { kind: null, framework: null };
  if (!compose && names.includes('package.json')) js = classifyPackage((await getFile(repo, 'package.json', ref).catch(() => null))?.content || '');
  // A front-end without its own Dockerfile: build it on the server, no Docker needed
  const suggest = compose ? 'compose' : names.includes('artisan') ? 'laravel' : js.kind === 'frontend' && !names.includes('Dockerfile') ? 'frontend' : names.includes('package.json') ? 'node' : 'static';
  return { repo: info.full_name, private: !!info.private, default_branch: info.default_branch, branch: ref, files: names.slice(0, 60), compose, ports, suggest, js, empty: !names.length };
}

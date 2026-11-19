// Fake GitHub for the test lab (in-memory API + real git repos served over git://). Test lab only.
//   REST: the endpoints Switchboard's src/github.js uses
//   git:  git://172.30.0.6/<owner>/<repo>.git (read + push)
//   test helpers: /__state /__reset /__runs /__pulls /__pulls/close /__commit
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const TOKEN = process.env.GH_TOKEN || 'gh-test-token';
const LOGIN = 'lab-user';
const ROOT = '/repos';
const SELF = process.env.SELF_URL || 'http://172.30.0.6:8788';
fs.mkdirSync(ROOT, { recursive: true });

spawn('git', ['daemon', '--reuseaddr', `--base-path=${ROOT}`, '--export-all', '--enable=receive-pack', '--informative-errors', ROOT], { stdio: 'inherit' });

let S;
const reset = () => {
  S = { repos: {}, keys: {}, runners: {}, runs: {}, pulls: {}, dispatches: [], tokens: [] };
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
};
reset();

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
const bare = (repo) => path.join(ROOT, `${repo}.git`);
const tryGit = (args) => {
  try {
    return git(args);
  } catch {
    return null;
  }
};
const runId = () => 1000 + Math.floor(Math.random() * 1e6);

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function createRepo(full, priv = true) {
  fs.mkdirSync(bare(full), { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main', bare(full)]);
  S.repos[full] = { full_name: full, private: priv, default_branch: 'main' };
  console.log(`repo created ${full}`);
}

/** Commit one file to a branch of a bare repo. */
function commitFile(repo, branch, file, content, message) {
  const tmp = fs.mkdtempSync('/tmp/gh-');
  try {
    git(['clone', '-q', bare(repo), tmp]);
    const exists = tryGit(['-C', tmp, 'rev-parse', '--verify', `origin/${branch}`]);
    if (exists) git(['-C', tmp, 'checkout', '-q', '-B', branch, `origin/${branch}`]);
    else git(['-C', tmp, 'checkout', '-q', '--orphan', branch]);
    fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
    fs.writeFileSync(path.join(tmp, file), content);
    git(['-C', tmp, 'add', file]);
    git(['-C', tmp, '-c', 'user.name=lab', '-c', 'user.email=lab@lab', 'commit', '-q', '-m', message]);
    git(['-C', tmp, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
    return git(['-C', tmp, 'rev-parse', 'HEAD']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const body = await readBody(req);
    let m;
    try {
      // ---- test helpers (no auth)
      if (p === '/__state') return send(res, 200, S);
      if (p === '/__reset') return reset(), send(res, 200, { ok: true });
      if (p === '/__download/runner.tgz') {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        return fs.createReadStream('/srv/runner.tgz').pipe(res);
      }
      if (p === '/__runner/register' && req.method === 'POST') {
        if (!S.tokens.includes(body.token)) return send(res, 403, { message: 'bad registration token' });
        S.runners[body.repo] = (S.runners[body.repo] || []).filter((r) => r.name !== body.name);
        S.runners[body.repo].push({ id: crypto.randomInt(1e6), name: body.name, labels: body.labels, user: body.user, status: 'online', busy: false });
        console.log(`runner registered ${body.name} on ${body.repo} (${body.labels}) as ${body.user}`);
        return send(res, 200, { ok: true });
      }
      if (p === '/__runner/remove' && req.method === 'POST') {
        S.runners[body.repo] = (S.runners[body.repo] || []).filter((r) => r.name !== body.name);
        return send(res, 200, { ok: true });
      }
      if (p === '/__runs' && req.method === 'POST') {
        const r = { id: runId(), run_number: (S.runs[body.repo] || []).length + 1, status: 'completed', conclusion: 'success', event: 'push', head_branch: 'main', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), actor: { login: LOGIN }, ...body.run };
        r.html_url = `${SELF}/${body.repo}/actions/runs/${r.id}`;
        (S.runs[body.repo] ||= []).unshift(r);
        return send(res, 200, r);
      }
      // Change a run (status, conclusion, jobs) — to play a run step by step in tests.
      if ((m = p.match(/^\/__runs\/(\d+)$/)) && req.method === 'POST') {
        const r = Object.values(S.runs).flat().find((x) => x.id === Number(m[1]));
        if (!r) return send(res, 404, { message: 'Not Found' });
        Object.assign(r, body, { updated_at: new Date().toISOString() });
        return send(res, 200, r);
      }
      if (p === '/__commit' && req.method === 'POST') return send(res, 200, { sha: commitFile(body.repo, body.branch, body.file, body.content, body.message || 'test commit') });
      if (p === '/__pulls' && req.method === 'POST') {
        // A pull request from `head_ref`: GitHub keeps refs/pull/<n>/head pointing at its newest commit.
        const sha = git(['-C', bare(body.repo), 'rev-parse', `refs/heads/${body.head_ref}`]);
        git(['-C', bare(body.repo), 'update-ref', `refs/pull/${body.number}/head`, sha]);
        const pr = { number: body.number, title: body.title || `PR ${body.number}`, state: 'open', head: { ref: body.head_ref, sha, repo: { full_name: body.repo } }, user: { login: LOGIN } };
        S.pulls[body.repo] = (S.pulls[body.repo] || []).filter((x) => x.number !== body.number).concat(pr);
        return send(res, 200, pr);
      }
      if (p === '/__pulls/close' && req.method === 'POST') {
        S.pulls[body.repo] = (S.pulls[body.repo] || []).filter((x) => x.number !== body.number);
        return send(res, 200, { ok: true });
      }

      // ---- REST API
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { message: 'Bad credentials' });
      if (p === '/user') return send(res, 200, { login: LOGIN, name: 'Lab User' });
      if (p === '/user/repos' && req.method === 'GET') return send(res, 200, Object.values(S.repos).map((r) => ({ ...r, description: '', pushed_at: new Date().toISOString() })));
      if (p === '/repos/actions/runner/releases/latest') {
        const v = '9.9.9';
        return send(res, 200, { tag_name: `v${v}`, assets: ['x64', 'arm64', 'arm'].map((a) => ({ name: `actions-runner-linux-${a}-${v}.tar.gz`, browser_download_url: `${SELF}/__download/runner.tgz` })) });
      }
      if (p === '/user/repos' && req.method === 'POST') {
        const full = `${LOGIN}/${body.name}`;
        if (S.repos[full]) return send(res, 422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] });
        createRepo(full, body.private !== false);
        return send(res, 201, S.repos[full]);
      }
      if (!(m = p.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/))) return send(res, 404, { message: 'Not Found' });
      const repo = m[1];
      const rest = m[2] || '';
      if (!S.repos[repo]) return send(res, 404, { message: 'Not Found' });
      if (!rest) return send(res, 200, S.repos[repo]);
      if (rest === '/keys') {
        S.keys[repo] ||= [];
        if (req.method === 'GET') return send(res, 200, S.keys[repo]);
        if (S.keys[repo].some((k) => k.key === body.key.trim().split(' ').slice(0, 2).join(' '))) return send(res, 422, { message: 'Validation Failed', errors: [{ message: 'key is already in use' }] });
        const k = { id: S.keys[repo].length + 1, title: body.title, key: body.key.trim().split(' ').slice(0, 2).join(' '), read_only: body.read_only };
        S.keys[repo].push(k);
        return send(res, 201, k);
      }
      if (rest === '/branches') {
        const out = tryGit(['-C', bare(repo), 'for-each-ref', '--format=%(refname:short)', 'refs/heads']);
        return send(res, 200, (out || '').split('\n').filter(Boolean).map((name) => ({ name })));
      }
      if (rest === '/contents') {
        const ref = url.searchParams.get('ref') || 'main';
        const out = tryGit(['-C', bare(repo), 'ls-tree', '--name-only', ref]);
        if (out === null) return send(res, 404, { message: 'Not Found' });
        return send(res, 200, out.split('\n').filter(Boolean).map((name) => ({ name, type: 'file' })));
      }
      if ((m = rest.match(/^\/git\/ref\/heads\/(.+)$/))) {
        const sha = tryGit(['-C', bare(repo), 'rev-parse', '--verify', `refs/heads/${decodeURIComponent(m[1])}`]);
        return sha ? send(res, 200, { ref: `refs/heads/${m[1]}`, object: { sha } }) : send(res, 404, { message: 'Not Found' });
      }
      if (rest === '/git/refs' && req.method === 'POST') {
        git(['-C', bare(repo), 'update-ref', body.ref, body.sha]);
        return send(res, 201, { ref: body.ref, object: { sha: body.sha } });
      }
      if (rest === '/actions/runners/registration-token' || rest === '/actions/runners/remove-token') {
        const token = `T${crypto.randomBytes(8).toString('hex')}`;
        S.tokens.push(token);
        return send(res, 201, { token, expires_at: new Date(Date.now() + 3600e3).toISOString() });
      }
      if (rest.startsWith('/actions/runners')) return send(res, 200, { total_count: (S.runners[repo] || []).length, runners: S.runners[repo] || [] });
      if ((m = rest.match(/^\/contents\/(.+)$/))) {
        const file = decodeURIComponent(m[1]);
        const ref = url.searchParams.get('ref') || body.branch || 'main';
        if (req.method === 'GET') {
          const blob = tryGit(['-C', bare(repo), 'rev-parse', `${ref}:${file}`]);
          if (!blob) return send(res, 404, { message: 'Not Found' });
          if (tryGit(['-C', bare(repo), 'cat-file', '-t', blob]) === 'tree') {
            const out = tryGit(['-C', bare(repo), 'ls-tree', `${ref}:${file}`]) || '';
            return send(res, 200, out.split('\n').filter(Boolean).map((l) => ({ name: l.split('\t')[1], path: `${file}/${l.split('\t')[1]}`, type: l.split(' ')[1] === 'tree' ? 'dir' : 'file' })));
          }
          const content = execFileSync('git', ['-C', bare(repo), 'show', `${ref}:${file}`]);
          return send(res, 200, { sha: blob, path: file, content: content.toString('base64') });
        }
        if (req.method === 'PUT') {
          const cur = tryGit(['-C', bare(repo), 'rev-parse', `${body.branch}:${file}`]);
          if (cur && body.sha !== cur) return send(res, 409, { message: 'sha does not match' });
          const sha = commitFile(repo, body.branch, file, Buffer.from(body.content, 'base64'), body.message);
          return send(res, cur ? 200 : 201, { commit: { sha } });
        }
      }
      if (rest === '/commits') {
        const ref = url.searchParams.get('sha') || 'main';
        const n = Number(url.searchParams.get('per_page')) || 30;
        const out = tryGit(['-C', bare(repo), 'log', `-${n}`, '--format=%H%x09%an%x09%cI%x09%s', ref]);
        if (out === null) return send(res, 404, { message: 'Not Found' });
        return send(res, 200, out.split('\n').filter(Boolean).map((l) => {
          const [sha, name, date, msg] = l.split('\t');
          return { sha, author: { login: LOGIN }, commit: { message: msg, author: { name, date }, committer: { date } } };
        }));
      }
      if ((m = rest.match(/^\/actions\/runs\/(\d+)(\/jobs)?$/))) {
        const r = (S.runs[repo] || []).find((x) => x.id === Number(m[1]));
        if (!r) return send(res, 404, { message: 'Not Found' });
        if (!m[2]) return send(res, 200, r);
        const jobs = (r.jobs || []).map((j, i) => ({ id: r.id * 100 + i, run_id: r.id, html_url: `${r.html_url}/job/${i}`, steps: [], labels: ['ubuntu-latest'], ...j }));
        return send(res, 200, { total_count: jobs.length, jobs });
      }
      // Runs are kept per repo; a run made with "workflow" belongs to that file (default switchboard.yml).
      if ((m = rest.match(/^\/actions\/workflows\/([^/]+)\/runs$/))) {
        const runs = (S.runs[repo] || []).filter((r) => (r.workflow || 'switchboard.yml') === decodeURIComponent(m[1]));
        return send(res, 200, { total_count: runs.length, workflow_runs: runs });
      }
      if ((m = rest.match(/^\/actions\/workflows\/([^/]+)\/dispatches$/)) && req.method === 'POST') {
        S.dispatches.push({ repo, ref: body.ref, workflow: decodeURIComponent(m[1]), at: new Date().toISOString() });
        return send(res, 204);
      }
      if (rest === '/pulls') return send(res, 200, S.pulls[repo] || []);
      return send(res, 404, { message: `No fake route for ${req.method} ${p}` });
    } catch (e) {
      console.error(e);
      return send(res, 500, { message: e.message });
    }
  })
  .listen(8788, () => console.log('fake GitHub API on :8788, git daemon on :9418'));

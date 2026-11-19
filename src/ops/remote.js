import { connect, exec, shq } from '../ssh.js';
import { byteCounter, fmtBytes, lastLines } from '../util.js';

export { shq };

/** "docker" or e.g. "sudo docker", configured per server. */
export const dockerBin = (server) => String(server.docker_cmd || 'docker').trim() || 'docker';

/** Run a shell script as root: as-is when logged in as root, otherwise through passwordless sudo. */
export const asRoot = (server, script) =>
  (server.ssh_user || 'root') === 'root' ? `sh -c ${shq(script)}` : `sudo -n sh -c ${shq(script)}`;

/**
 * Stream stdout of `srcCmd` (on srcConn) into stdin of `dstCmd` (on dstConn), through Switchboard.
 * If either side fails, the other is stopped so the pipe can't hang. Progress goes to the job log.
 * Throws on a bad exit code; returns { bytes, srcCode }.
 */
export async function streamCopy(ctx, { srcConn, srcCmd, dstConn, dstCmd, srcName = 'source', dstName = 'target', okSrcCodes = [0] }) {
  const pipe = byteCounter((n) => ctx.log(`  … ${fmtBytes(n)} transferred`));
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const srcP = exec(srcConn, srcCmd, { pipeTo: pipe, signal: ac.signal, onStderr: (d) => ctx.output(d, 'se') }).then((r) => {
      if (!okSrcCodes.includes(r.code)) ac.abort();
      return r;
    });
    const dstP = exec(dstConn, dstCmd, { stdin: pipe, signal: ac.signal, onStderr: (d) => ctx.output(d, 'de') }).then((r) => {
      if (r.code !== 0) ac.abort();
      return r;
    });
    const [rs, rt] = await Promise.allSettled([srcP, dstP]);
    if (ctx.signal.aborted) throw new Error('Cancelled');
    if (rs.status === 'fulfilled' && !okSrcCodes.includes(rs.value.code)) {
      throw new Error(`Reading on ${srcName} failed (exit ${rs.value.code}): ${lastLines(rs.value.stderr)}`);
    }
    if (rt.status === 'fulfilled' && rt.value.code !== 0) {
      throw new Error(`Writing on ${dstName} failed (exit ${rt.value.code}): ${lastLines(rt.value.stderr)}`);
    }
    if (rs.status === 'rejected') throw rs.reason;
    if (rt.status === 'rejected') throw rt.reason;
    return { bytes: pipe.total, srcCode: rs.value.code };
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

/** Enables pipefail when the remote login shell supports it (bash, ash, zsh); harmless otherwise. */
export const PIPEFAIL = '(set -o pipefail) 2>/dev/null && set -o pipefail; ';

/**
 * Build `docker exec` running a POSIX sh script inside a container.
 * Values in `env` are passed with -e and are visible only to that process.
 */
export function dockerExec(server, container, script, { env = {}, interactive = false } = {}) {
  const envArgs = Object.entries(env)
    .map(([k, v]) => `-e ${k}=${shq(v ?? '')}`)
    .join(' ');
  return `${dockerBin(server)} exec ${interactive ? '-i ' : ''}${envArgs ? `${envArgs} ` : ''}${shq(container)} sh -c ${shq(script)}`;
}

/**
 * Shell lines that make git (in the current folder) fail fast instead of waiting forever for
 * something nobody can answer: a username/password or credential-manager login, an SSH
 * passphrase or host-key question, or a dead/stalled network connection. Keeps the repo's own
 * core.sshCommand (e.g. its deploy key) and only adds the safety options to it.
 */
export const GIT_NO_WAIT = `export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_ASKPASS=true SSH_ASKPASS=true SSH_ASKPASS_REQUIRE=never
export GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=60
if command -v git >/dev/null 2>&1; then
  sb_ssh="\${GIT_SSH_COMMAND:-$(git config --get core.sshCommand 2>/dev/null || true)}"
  export GIT_SSH_COMMAND="\${sb_ssh:-ssh} -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"
  unset sb_ssh
fi
`;

/**
 * Run in the app folder before a deploy, as the deploy user: when the Git checkout holding it (the folder or a
 * parent) belongs to another user, git refuses every command ("dubious ownership"). Mark just that checkout as
 * safe for this user (git config --global safe.directory) — the owner is not changed. Prints one line when it did.
 */
export const GIT_TRUST = `d="$(pwd)"; while [ -n "$d" ] && [ "$d" != / ] && [ ! -e "$d/.git" ]; do d="$(dirname "$d")"; done
if [ -e "$d/.git" ] && command -v git >/dev/null 2>&1 && git -C "$d" rev-parse --git-dir 2>&1 | grep -q 'dubious ownership'; then
  git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$d" || git config --global --add safe.directory "$d"
  echo "SB_TRUSTED $d $(ls -ld "$d" | awk '{print $3}')"
fi`;

/**
 * Move the Git checkout holding the app folder to one exact commit (newer OR older — a rollback), before the
 * deploy script runs. `git reset --keep` keeps edits made on the server and stops if one would be overwritten.
 * Prints "SB_MOVE back|forward|same <from> <to>". Runs as the deploy user, with GIT_NO_WAIT.
 */
export const gitCheckoutCommit = (commit, branch) => `C=${shq(commit)}; B=${shq(branch)}
git rev-parse --git-dir >/dev/null 2>&1 || { echo 'SB_MOVE none'; exit 0; }
git fetch -q origin "+refs/heads/$B:refs/remotes/origin/$B" || git fetch -q origin
git cat-file -e "$C^{commit}" 2>/dev/null || { echo "Commit $C is not in this repository (not on $B?)" >&2; exit 3; }
FROM="$(git rev-parse HEAD)"; TO="$(git rev-parse "$C^{commit}")"
if [ "$FROM" = "$TO" ]; then echo "SB_MOVE same $FROM $TO"; exit 0; fi
if git merge-base --is-ancestor "$TO" "$FROM"; then DIR=back; else DIR=forward; fi
git reset -q --keep "$TO" || { echo "Edits on the server would be overwritten by going to \${TO%"\${TO#???????}"} — see git status in $(git rev-parse --show-toplevel)" >&2; exit 4; }
echo "SB_MOVE $DIR $FROM $TO"`;

/** Plain-language hint for a failed git step (null when the output doesn't look like a git problem). */
export function gitHint(text) {
  const t = String(text || '');
  if (/could not read (Username|Password)|terminal prompts disabled|Authentication failed|Invalid username or password/i.test(t))
    return 'git needs a login for this repo (HTTPS remote). On the server, switch the remote to SSH with a deploy key (git remote set-url origin git@github.com:OWNER/REPO.git), or save a token with a credential helper for the deploy user.';
  if (/dubious ownership/i.test(t))
    return 'The app folder belongs to another user, so git refuses it. Project → CI/CD → Servers and Git → "Connect to Git" fixes it (marks the folder as safe for git), or run on the server as the deploy user: git config --global --add safe.directory <folder>.';
  if (/Host key verification failed/i.test(t))
    return 'The server does not know GitHub\'s SSH host key yet. Log in to the server as the deploy user once and run: ssh -T git@github.com (answer "yes").';
  if (/Permission denied \(publickey\)|Load key .*: (incorrect passphrase|bad permissions)|passphrase/i.test(t))
    return 'GitHub refused the server\'s SSH key. Add the deploy user\'s public key (~/.ssh/*.pub) as a deploy key of the repo, and use a key without a passphrase (deploys can\'t type one).';
  if (/Connection timed out|Operation timed out|Could not resolve host|Network is unreachable|Connection refused|timeout|Timeout was reached|transfer rate|ssh: connect to host/i.test(t))
    return 'The server could not reach GitHub (network/DNS/firewall). Check on the server: ping github.com, and that outgoing port 22 (SSH) or 443 (HTTPS) is allowed.';
  return null;
}

/** Wrap a (multi-line) script so it runs with bash when available, in an optional directory. */
export function shellScript(script, { cwd, strict = false, prelude = '' } = {}) {
  const body = `${prelude}${strict ? 'set -ex\n' : ''}${script}\n`;
  const cd = cwd ? `cd ${shq(cwd)} || exit 1; ` : '';
  return `${cd}SB_SH="$(command -v bash || command -v sh)"; "$SB_SH" -c ${shq(body)}`;
}

export async function connectTo(ctx, server, { required = true } = {}) {
  ctx?.log(`Connecting to ${server.name} (${server.ssh_user}@${server.ssh_host || server.ip}:${server.ssh_port})…`);
  try {
    return await connect(server, { signal: ctx?.signal });
  } catch (e) {
    if (required) throw e;
    ctx?.warn(`Could not connect to ${server.name}: ${e.message}`);
    return null;
  }
}

/**
 * Run a command, stream its output into the job log, throw on a bad exit code.
 * Pass `signal: null` for steps that must not be interrupted (rollbacks).
 */
export async function runRemote(ctx, conn, cmd, { timeout = 0, okCodes = [0], quiet = false, signal, stdin } = {}) {
  const r = await exec(conn, cmd, {
    signal: signal === undefined ? ctx?.signal : signal || undefined,
    timeout,
    stdin,
    onStdout: quiet || !ctx ? undefined : (d) => ctx.output(d, 'o'),
    onStderr: quiet || !ctx ? undefined : (d) => ctx.output(d, 'e'),
  });
  if (!okCodes.includes(r.code)) {
    const msg = lastLines(r.stderr) || lastLines(r.stdout);
    const err = new Error(`Command failed (exit ${r.code ?? r.signal ?? '?'})${msg ? `: ${msg}` : ''}`);
    err.result = r;
    throw err;
  }
  return r;
}

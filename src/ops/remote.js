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

/** Wrap a (multi-line) script so it runs with bash when available, in an optional directory. */
export function shellScript(script, { cwd, strict = false } = {}) {
  const body = `${strict ? 'set -ex\n' : ''}${script}\n`;
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

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import ssh2 from 'ssh2';
import { decrypt } from './crypto.js';
import { run } from './db.js';

const { Client } = ssh2;

/** Quote a value for a POSIX shell. Safe to nest. */
export const shq = (s) => `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;

/** OpenSSH-style SHA256 fingerprint of a raw host key. */
export const fingerprint = (key) => 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');

function authConfig(server) {
  const cfg = {};
  switch (server.auth_type) {
    case 'password':
      cfg.password = decrypt(server.ssh_password);
      if (!cfg.password) throw new Error('No SSH password saved for this server');
      break;
    case 'agent':
      cfg.agent = process.env.SSH_AUTH_SOCK;
      if (!cfg.agent) throw new Error('SSH_AUTH_SOCK is not set, so ssh-agent auth is not available');
      break;
    case 'keyfile': {
      const p = String(server.ssh_key_path || '').replace(/^~(?=\/|$)/, os.homedir());
      if (!p) throw new Error('No private key file path set for this server');
      try {
        cfg.privateKey = fs.readFileSync(p);
      } catch (e) {
        throw new Error(`Cannot read key file ${p}: ${e.code || e.message}`);
      }
      break;
    }
    default:
      cfg.privateKey = decrypt(server.ssh_key);
      if (!cfg.privateKey) throw new Error('No SSH private key saved for this server');
  }
  if (server.auth_type === 'key' || server.auth_type === 'keyfile' || !server.auth_type) {
    const pass = decrypt(server.ssh_passphrase);
    if (pass) cfg.passphrase = pass;
  }
  return cfg;
}

/**
 * The public key ("ssh-ed25519 AAAA…") of the private key Switchboard logs in with, or null
 * when the server uses a password or ssh-agent.
 */
export function loginPublicKey(server) {
  if (!['key', 'keyfile', undefined, null, ''].includes(server.auth_type)) return null;
  const cfg = authConfig(server);
  const k = ssh2.utils.parseKey(cfg.privateKey, cfg.passphrase);
  const key = Array.isArray(k) ? k[0] : k;
  if (!key || key instanceof Error) throw new Error(`Cannot read the SSH key of ${server.name}: ${key?.message || 'unknown format'}`);
  return `${key.type} ${key.getPublicSSH().toString('base64')}`;
}

/** The saved SSH password (decrypted), for password logins. */
export const loginPassword = (server) => (server.auth_type === 'password' ? authConfig(server).password : null);

/**
 * Open an SSH connection. Host keys are trusted on first use and then pinned;
 * a changed host key refuses to connect (possible MITM or rebuilt server).
 */
export function connect(server, { timeout = 20000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    let auth;
    try {
      auth = authConfig(server);
    } catch (e) {
      return reject(e);
    }
    const host = server.ssh_host || server.ip;
    const port = Number(server.ssh_port) || 22;
    const conn = new Client();
    let seenKey = null;
    let mismatch = false;
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (err) {
        conn.end();
        reject(err);
      } else resolve(value);
    };
    const onAbort = () => done(new Error('Cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });

    conn.on('ready', () => {
      if (!server.host_key && seenKey) {
        if (server.id) run('UPDATE servers SET host_key = ? WHERE id = ? AND host_key IS NULL', seenKey, server.id);
        server.host_key = seenKey;
      }
      conn.hostKey = seenKey;
      done(null, conn);
    });
    conn.on('error', (err) => {
      if (mismatch) {
        return done(new Error(`SSH host key for ${host} CHANGED (expected ${server.host_key}, got ${seenKey}). If you rebuilt this server, reset its host key in the server settings.`));
      }
      const authFail = err.level === 'client-authentication';
      done(new Error(`SSH ${server.ssh_user || 'root'}@${host}:${port} — ${authFail ? 'authentication failed (check user / key / password)' : err.message}`));
    });
    conn.on('close', () => done(new Error(`SSH connection to ${host} closed`)));

    conn.connect({
      host,
      port,
      username: server.ssh_user || 'root',
      readyTimeout: timeout,
      keepaliveInterval: 10000,
      keepaliveCountMax: 6,
      hostVerifier: (key) => {
        seenKey = fingerprint(key);
        if (server.host_key && server.host_key !== seenKey) {
          mismatch = true;
          return false;
        }
        return true;
      },
      ...auth,
    });
  });
}

/**
 * Kill a remote process group (TERM, then KILL) over a fresh channel.
 * OpenSSH starts every non-tty session in its own process group, so this stops the
 * command and everything it started (pipelines, scripts, docker CLI…).
 */
function killGroup(conn, pgid) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 6000);
    const k = (sig) => `kill -${sig} -- -${pgid} 2>/dev/null || kill -${sig} -${pgid} 2>/dev/null`;
    try {
      conn.exec(`${k('TERM')}; sleep 1; ${k('KILL')}; true`, (err, s) => {
        if (err) {
          clearTimeout(t);
          return resolve();
        }
        s.on('close', () => {
          clearTimeout(t);
          resolve();
        });
        s.resume();
        s.stderr.resume();
        s.end();
      });
    } catch {
      clearTimeout(t);
      resolve();
    }
  });
}

const PGID_MARK = '\x1eSBPGID ';

/**
 * Run a command over an open connection.
 * - stdin: string | Buffer | Readable (piped to the remote process)
 * - pipeTo: Writable that receives stdout (stdout is then not buffered)
 * - onStdout / onStderr: streaming callbacks
 * Cancelling (signal) or timing out kills the remote process group, not just the channel.
 * Resolves with { code, signal, stdout, stderr } — it does not throw on non-zero exit.
 */
export function exec(conn, command, { stdin, pipeTo, onStdout, onStderr, signal, timeout = 0, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    // First line on stderr = the shell's PID, which is also its process-group id. Stripped from the output below.
    const wrapped = `printf '\\036SBPGID %s\\n' "$$" >&2; ${command}`;
    conn.exec(wrapped, (err, stream) => {
      if (err) return reject(err);
      const out = [];
      const errs = [];
      let outLen = 0;
      let errLen = 0;
      let code = null;
      let sig = null;
      let settled = false;
      let timer = null;
      let pgid = null;
      let head = ''; // stderr bytes until the PGID line has been seen (null afterwards)
      const finish = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (e) {
          if (pipeTo && !pipeTo.destroyed) pipeTo.destroy();
          return reject(e);
        }
        resolve({ code, signal: sig, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errs).toString('utf8') });
      };
      let stopping = null; // the error to report once we are stopping the command
      const stop = async (error) => {
        if (settled || stopping) return;
        stopping = error;
        if (pgid) await killGroup(conn, pgid);
        try {
          stream.close();
        } catch {}
        finish(error);
      };
      const onAbort = () => stop(new Error('Cancelled'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeout) timer = setTimeout(() => stop(new Error(`Command timed out after ${Math.round(timeout / 1000)}s`)), timeout);
      stream.on('exit', (c, s) => {
        if (typeof c === 'number') code = c;
        if (s) sig = s;
      });
      if (pipeTo) stream.pipe(pipeTo);
      else {
        stream.on('data', (d) => {
          onStdout?.(d);
          if (outLen < maxBuffer) {
            out.push(d);
            outLen += d.length;
          }
        });
      }
      stream.stderr.on('data', (chunk) => {
        let d = chunk;
        if (head !== null) {
          head += chunk.toString('latin1');
          const nl = head.indexOf('\n');
          if (nl < 0 && head.length < 256) return;
          const first = nl >= 0 ? head.slice(0, nl) : '';
          const i = first.indexOf(PGID_MARK);
          if (i >= 0) {
            pgid = Number(first.slice(i + PGID_MARK.length)) || null;
            d = Buffer.from(head.slice(0, i) + head.slice(nl + 1), 'latin1');
          } else d = Buffer.from(head, 'latin1');
          head = null;
          if (!d.length) return;
        }
        onStderr?.(d);
        if (errLen < maxBuffer) {
          errs.push(d);
          errLen += d.length;
        }
      });
      stream.on('close', (c, s) => {
        if (code === null && typeof c === 'number') code = c;
        if (!sig && s) sig = s;
        finish(stopping || undefined);
      });
      stream.on('error', (e) => finish(e));

      if (stdin === undefined || stdin === null) stream.end();
      else if (typeof stdin === 'string' || Buffer.isBuffer(stdin)) stream.end(stdin);
      else {
        stdin.on('error', (e) => stop(e));
        stdin.pipe(stream);
      }
    });
  });
}

/** Connect, run fn(conn), always disconnect. */
export async function withSSH(server, fn, opts) {
  const conn = await connect(server, opts);
  try {
    return await fn(conn);
  } finally {
    conn.end();
  }
}

import path from 'node:path';
import { getServer } from '../models.js';
import { fmtBytes } from '../util.js';
import { dockerExec, shq, streamCopy } from './remote.js';

/**
 * Project "files to sync" — one entry per line:
 *   storage/app/public                      → relative to the app directory on the host
 *   /srv/uploads                            → absolute host path
 *   app:/var/www/html/storage/app/public    → path inside the app container
 * Files are copied (tar stream through Switchboard). Nothing is deleted on the target.
 */
export function parseSyncPaths(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function resolveEntry(entry, dep) {
  const m = entry.match(/^app:(\/.*)$/);
  if (m) {
    if (!dep.app_container) throw new Error(`"${entry}" needs the app container to be set for ${dep.server_name}`);
    return { container: dep.app_container, dir: path.posix.normalize(m[1]) };
  }
  if (entry.startsWith('/')) return { container: null, dir: path.posix.normalize(entry) };
  if (!dep.app_dir) throw new Error(`Relative path "${entry}" needs the app directory to be set for ${dep.server_name}`);
  return { container: null, dir: path.posix.join(dep.app_dir, entry) };
}

export async function syncFiles(ctx, { project, source, target, srcConn, dstConn }) {
  const entries = parseSyncPaths(project.sync_paths);
  if (!entries.length) {
    ctx.log('No file paths configured for this project — skipping file copy');
    return;
  }
  const srcServer = getServer(source.server_id);
  const dstServer = getServer(target.server_id);
  for (const entry of entries) {
    const s = resolveEntry(entry, source);
    const t = resolveEntry(entry, target);
    ctx.step(`Copy files "${entry}" (${source.server_name} → ${target.server_name})`);
    const readScript = `if [ ! -d ${shq(s.dir)} ]; then echo 'Directory not found: '${shq(s.dir)} >&2; exit 3; fi; tar -C ${shq(s.dir)} -czf - .`;
    const writeScript = `mkdir -p ${shq(t.dir)} && tar -C ${shq(t.dir)} -xzf -`;
    const srcCmd = s.container ? dockerExec(srcServer, s.container, readScript) : readScript;
    const dstCmd = t.container ? dockerExec(dstServer, t.container, writeScript, { interactive: true }) : writeScript;

    // tar exit 1 = "some files changed while reading" — not fatal.
    const r = await streamCopy(ctx, {
      srcConn,
      srcCmd,
      dstConn,
      dstCmd,
      srcName: source.server_name,
      dstName: target.server_name,
      okSrcCodes: [0, 1],
    });
    if (r.srcCode === 1) ctx.warn('Some files changed while being copied (tar exit 1) — usually harmless');
    ctx.log(`Copied ${fmtBytes(r.bytes)} (compressed)`);
  }
}

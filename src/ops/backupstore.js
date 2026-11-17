import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { all, get, update, now } from '../db.js';
import { bus } from '../bus.js';
import { alert, logEvent } from '../events.js';
import { defineJob } from '../jobs.js';
import { getSetting } from '../settings.js';
import { fmtBytes, isoAgo } from '../util.js';
import { s3Config, s3Enabled, objectKey, putFile, getFile, deleteObject } from '../s3.js';

/**
 * Where backups live. With S3 on, every backup is uploaded right after it is made; the copy on the
 * Switchboard machine is removed once it is safely in S3 (unless "keep a local copy" is on).
 * Restore and download fetch the file back from S3 when it is not here.
 */

const absPath = (b) => path.join(config.backupDir, b.file);
let queue = Promise.resolve();
let lastAlert = 0;

async function uploadOne(id) {
  const b = get('SELECT * FROM backups WHERE id = ?', id);
  if (!b || b.s3_key || !s3Enabled()) return null;
  const file = absPath(b);
  if (!fs.existsSync(file)) return null;
  const c = s3Config();
  const key = objectKey(c, b.file);
  try {
    await putFile(c, key, file);
    update('backups', id, { s3_key: key, s3_at: now(), s3_error: null });
    bus.emit('state', { projectId: b.project_id });
    return key;
  } catch (e) {
    update('backups', id, { s3_error: e.message.slice(0, 500) });
    if (Date.now() - lastAlert > 30 * 60000) {
      lastAlert = Date.now();
      alert('error', `Backup #${id} could not be uploaded to S3: ${e.message} — it is kept on the Switchboard machine and retried`, { projectId: b.project_id, link: '#/settings' });
    }
    throw e;
  }
}

/** Upload in the background, one at a time (called after every new backup). */
export function queueUpload(id) {
  if (!s3Enabled()) return;
  queue = queue.then(() => uploadOne(id).catch(() => {}));
}

/** Path of a backup on this machine, downloading it from S3 first when needed. */
export async function ensureLocal(b, ctx) {
  const file = absPath(b);
  if (fs.existsSync(file)) return file;
  if (!b.s3_key) throw new Error(`Backup file is missing: ${b.file}`);
  ctx?.log(`Download backup #${b.id} from S3 (${fmtBytes(b.size)})…`);
  const c = s3Config();
  await getFile(c, b.s3_key, file);
  ctx?.log(`Downloaded ${b.s3_key}`);
  return file;
}

export const backupAvailable = (b) => fs.existsSync(absPath(b)) || !!b.s3_key;

/** Delete a backup's file here and in S3 (the database row is removed by the caller). */
export function removeBackupFiles(b) {
  fs.rmSync(absPath(b), { force: true });
  if (b.s3_key) {
    const c = s3Config();
    deleteObject(c, b.s3_key).catch((e) => logEvent('warn', `Could not delete ${b.s3_key} from S3: ${e.message}`, { projectId: b.project_id }));
  }
}

/**
 * Remove local copies that are safely in S3 (older than `minAgeMs`, so a running copy/restore job
 * that still reads the file is never disturbed). Also retries uploads that failed.
 */
export function cleanupLocal({ minAgeMs = 30 * 60000 } = {}) {
  if (!s3Enabled()) return 0;
  for (const b of all('SELECT id FROM backups WHERE s3_key IS NULL ORDER BY id')) queueUpload(b.id);
  if (Number(getSetting('s3_keep_local'))) return 0;
  let n = 0;
  for (const b of all('SELECT * FROM backups WHERE s3_key IS NOT NULL AND created_at < ?', isoAgo(minAgeMs))) {
    const busy = get("SELECT 1 AS x FROM jobs WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1", b.project_id);
    if (busy) continue;
    const file = absPath(b);
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      n++;
    }
  }
  return n;
}

/** Upload every backup that is not in S3 yet (Settings → "Upload existing backups"). */
defineJob('s3-upload-all', async (ctx) => {
  if (!s3Enabled()) throw new Error('Turn on S3 backup storage first (Settings → Backup storage)');
  const list = all('SELECT * FROM backups WHERE s3_key IS NULL ORDER BY id');
  ctx.step(`Upload ${list.length} backup(s) to S3`);
  let ok = 0;
  let missing = 0;
  for (const b of list) {
    if (ctx.signal.aborted) throw new Error('Cancelled');
    if (!fs.existsSync(absPath(b))) {
      missing++;
      continue;
    }
    ctx.log(`#${b.id} ${b.file} (${fmtBytes(b.size)})`);
    await uploadOne(b.id);
    ok++;
  }
  ctx.log(`Uploaded ${ok}${missing ? `, ${missing} skipped (file no longer on this machine)` : ''}`);
  const removed = cleanupLocal({ minAgeMs: 0 });
  if (removed) ctx.log(`Removed ${removed} local copies that are now in S3`);
  logEvent('success', `${ok} backup(s) uploaded to S3`, { jobId: ctx.id, user: ctx.user });
});

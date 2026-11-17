#!/usr/bin/env node
// End-to-end test for keeping backups in S3. Needs the lab (./dev/setup.sh, then node dev/e2e.mjs once for the
// "Home Electric Shop" project) and the S3 test server: docker compose -f dev/docker-compose.yml --profile s3 up -d s3
//   node dev/e2e-s3.mjs
// S3 server: SeaweedFS (checks AWS signatures). Turns S3 storage off again at the end.
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

const BASE = process.env.SB_URL || 'http://localhost:8090';
const S3 = { s3_endpoint: 'http://172.30.0.7:8333', s3_region: 'us-east-1', s3_bucket: 'sb-lab', s3_access_key: 'LABACCESSKEY0001', s3_secret_key: 'lab-secret-key-for-tests-only-123', s3_path_style: 1, s3_prefix: 'switchboard-backups' };
let failures = 0;
let cookie = '';

async function api(method, url, body, { raw = false } = {}) {
  const go = () => fetch(`${BASE}/api${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'switchboard', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await go().catch((e) => (e.message === 'fetch failed' ? go() : Promise.reject(e)));
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('sb_session=')) cookie = c.split(';')[0];
  if (raw) return res;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
  return data;
}
const sh = (cmd, input) => execSync(cmd, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
/** Run a snippet inside the Switchboard container (same database, same S3 client). */
const inSwitchboard = (code) => sh(`docker exec -i -w /app -e DATA_DIR=/data switchboard-dev-switchboard-1 node --input-type=module -`, code);
/** Look at the bucket directly through SeaweedFS's own file API (independent of Switchboard's S3 client). */
const inBucket = (key) => sh(`docker exec lab-s3 sh -c ${JSON.stringify(`wget -qO- 'http://127.0.0.1:8888/buckets/${S3.s3_bucket}/${key}' | wc -c || echo 0`)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(cond, msg) {
  if (cond) console.log('  ✔', msg);
  else {
    failures++;
    console.log('  ✖', msg);
  }
}
async function step(name, fn) {
  console.log(`\n▶ ${name}`);
  try {
    await fn();
  } catch (e) {
    failures++;
    console.log('  ✖ ERROR', e.message);
  }
}
async function waitJob(job, expect = 'success') {
  for (let i = 0; i < 600; i++) {
    const j = await api('GET', `/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) {
      if (j.status !== expect || process.env.VERBOSE) console.log(j.log.split('\n').slice(-25).map((l) => `      ${l}`).join('\n'));
      check(j.status === expect, `job #${j.id} "${j.title}" → ${j.status}${j.error ? ` (${j.error})` : ''}`);
      return j;
    }
    await sleep(1000);
  }
  throw new Error('job did not finish');
}
const backupsOf = (p) => api('GET', `/projects/${p.id}/backups`);
async function waitUploaded(p, id) {
  for (let i = 0; i < 60; i++) {
    const b = (await backupsOf(p)).find((x) => x.id === id);
    if (b?.s3_key || b?.s3_error) return b;
    await sleep(500);
  }
  return (await backupsOf(p)).find((x) => x.id === id);
}

let project;
let depA;
let depB;

await step('Settings: wrong key refused, right key works', async () => {
  await api('POST', '/auth/login', { username: 'admin', password: 'admin-password-123' });
  project = (await api('GET', '/projects')).find((p) => p.name === 'Home Electric Shop');
  if (!project) throw new Error('Run node dev/e2e.mjs first (it creates the Home Electric Shop project)');
  project = await api('GET', `/projects/${project.id}`);
  // depA = the live server (backups come from it), depB = the standby (restores go there).
  depA = project.deployments.find((d) => d.is_active);
  depB = project.deployments.find((d) => !d.is_active);
  // The S3 server can take a few seconds to start: retry creating the bucket for up to a minute.
  inSwitchboard(`const { createBucket } = await import('/app/src/s3.js');
const c = ${JSON.stringify({ endpoint: S3.s3_endpoint, region: 'us-east-1', bucket: S3.s3_bucket, accessKey: S3.s3_access_key, secretKey: S3.s3_secret_key, pathStyle: true, prefix: '' })};
for (let i = 0; ; i++) { try { await createBucket(c); break; } catch (e) { if (i > 30) throw e; await new Promise((r) => setTimeout(r, 2000)); } }`);
  const bad = await api('POST', '/settings/s3/test', { ...S3, s3_secret_key: 'wrong-secret' });
  check(!bad.ok && /SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied|403/.test(bad.error), `wrong secret refused: ${bad.error}`);
  const good = await api('POST', '/settings/s3/test', S3);
  check(good.ok, `test write/read/delete works${good.error ? `: ${good.error}` : ''}`);
  await api('PUT', '/settings', { ...S3, s3_enabled: 1, s3_keep_local: 0 });
  const s = await api('GET', '/settings');
  check(s.s3_enabled === 1 && s.has_s3_secret_key && !s.s3_secret_key && !s.s3_access_key, 'saved; keys are never sent back to the browser');
});

let backup;
await step('A new backup goes to S3', async () => {
  const { job } = await api('POST', `/deployments/${depA.id}/backup`, { note: 's3 test' });
  await waitJob(job);
  const latest = (await backupsOf(project))[0];
  backup = await waitUploaded(project, latest.id);
  check(!!backup.s3_key && backup.s3_key.startsWith('switchboard-backups/'), `uploaded as ${backup.s3_key}${backup.s3_error ? ` (error: ${backup.s3_error})` : ''}`);
  check(Number(inBucket(backup.s3_key)) === backup.size, `the object in the bucket has the same size (${backup.size} bytes)`);
});

await step('Local copy removed once it is in S3', async () => {
  inSwitchboard(`const { cleanupLocal } = await import('/app/src/ops/backupstore.js'); console.log(cleanupLocal({ minAgeMs: 0 }));`);
  const b = (await backupsOf(project)).find((x) => x.id === backup.id);
  check(!b.local && b.exists, 'not on the Switchboard machine any more, still available (in S3)');
});

await step('Restore and download fetch it back from S3', async () => {
  const { job } = await api('POST', `/backups/${backup.id}/restore`, { target: depB.id, backupFirst: true, maintenance: false });
  const j = await waitJob(job);
  check(/Download backup #\d+ from S3/.test(j.log), 'restore downloaded the file from S3');
  const res = await api('GET', `/backups/${backup.id}/download`, undefined, { raw: true });
  const buf = Buffer.from(await res.arrayBuffer());
  check(res.status === 200 && buf.length === backup.size && buf[0] === 0x1f && buf[1] === 0x8b, `download works (${buf.length} bytes, gzip)`);
  const safety = (await backupsOf(project)).find((x) => x.kind === 'pre-restore');
  const up = safety && (await waitUploaded(project, safety.id));
  check(!!up?.s3_key, 'the safety backup made before the restore is in S3 too');
});

await step('Big files are uploaded in parts and come back identical', async () => {
  const out = inSwitchboard(`
import crypto from 'node:crypto'; import fs from 'node:fs';
const { s3Config, putFile, getFile, deleteObject } = await import('/app/src/s3.js');
const c = s3Config();
const f = '/data/tmp/s3-big.bin'; fs.writeFileSync(f, crypto.randomBytes(70 * 1024 * 1024));
const h1 = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
await putFile(c, 'switchboard-backups/test/big.bin', f);
await getFile(c, 'switchboard-backups/test/big.bin', f + '.back');
const h2 = crypto.createHash('sha256').update(fs.readFileSync(f + '.back')).digest('hex');
await deleteObject(c, 'switchboard-backups/test/big.bin'); fs.rmSync(f); fs.rmSync(f + '.back');
console.log(h1 === h2 ? 'same' : 'DIFFERENT');`);
  check(out === 'same', '70 MB file: multipart upload + download, same checksum');
});

await step('Deleting a backup deletes it in S3', async () => {
  await api('DELETE', `/backups/${backup.id}`);
  await sleep(1500);
  check(Number(inBucket(backup.s3_key)) === 0, 'object removed from the bucket');
});

await step('Upload existing backups', async () => {
  await api('PUT', '/settings', { s3_enabled: 0 });
  const { job } = await api('POST', `/deployments/${depA.id}/backup`, { note: 'made while S3 was off' });
  await waitJob(job);
  const b = (await backupsOf(project))[0];
  check(!b.s3_key && b.local, 'backup made while S3 was off stays local');
  await api('PUT', '/settings', { s3_enabled: 1 });
  const r = await api('POST', '/settings/s3/upload-all');
  await waitJob(r.job);
  const after = (await backupsOf(project)).find((x) => x.id === b.id);
  check(!!after.s3_key && !after.local, 'uploaded to S3 and the local copy removed');
  const st = await api('GET', '/settings/s3/status');
  check(st.in_s3 >= 1 && !st.failed, `status: ${st.in_s3} of ${st.total} in S3, ${st.failed || 0} failed`);
});

await api('PUT', '/settings', { s3_enabled: 0, s3_keep_local: 0 });
console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);

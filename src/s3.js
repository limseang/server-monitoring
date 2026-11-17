import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getSetting } from './settings.js';

/**
 * Minimal S3 client (AWS Signature V4) for any S3-compatible storage: AWS, MinIO, Ceph,
 * Wasabi, Cloudflare R2, DigitalOcean Spaces… No SDK needed.
 * Files up to 32 MB go in one PUT, bigger ones as a multipart upload (32 MB parts).
 */

const PART = 32 * 1024 * 1024;
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

export function s3Config(over = {}) {
  const c = {
    endpoint: String(over.s3_endpoint ?? getSetting('s3_endpoint') ?? '').replace(/\/+$/, ''),
    region: String(over.s3_region || getSetting('s3_region') || 'us-east-1'),
    bucket: String(over.s3_bucket ?? getSetting('s3_bucket') ?? ''),
    accessKey: String(over.s3_access_key || getSetting('s3_access_key') || ''),
    secretKey: String(over.s3_secret_key || getSetting('s3_secret_key') || ''),
    pathStyle: Number(over.s3_path_style ?? getSetting('s3_path_style')) !== 0,
    prefix: String(over.s3_prefix ?? getSetting('s3_prefix') ?? 'switchboard-backups').replace(/^\/+|\/+$/g, ''),
  };
  return c;
}

export const s3Enabled = () => !!Number(getSetting('s3_enabled')) && !!s3Config().bucket;

function urlFor(c, key = '', query = '') {
  const u = new URL(c.endpoint);
  const keyPath = key ? `/${key.split('/').map(enc).join('/')}` : '';
  if (c.pathStyle) u.pathname = `/${enc(c.bucket)}${keyPath}`;
  else {
    u.hostname = `${c.bucket}.${u.hostname}`;
    u.pathname = keyPath || '/';
  }
  u.search = query;
  return u;
}

function sign(c, method, u, headers, payloadHash) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const h = { ...headers, host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const names = Object.keys(h)
    .map((k) => k.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [method, u.pathname, query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${c.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${c.secretKey}`, day), c.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

async function request(c, method, key, { query = '', body, headers = {}, okStatus = [], timeoutMs = 10 * 60000 } = {}) {
  if (!c.endpoint || !c.bucket || !c.accessKey || !c.secretKey) throw new Error('S3 is not fully set up (endpoint, bucket, access key and secret key)');
  const u = urlFor(c, key, query);
  const payload = body ?? Buffer.alloc(0);
  const h = sign(c, method, u, { ...headers, ...(method === 'GET' || method === 'HEAD' || method === 'DELETE' ? {} : { 'content-length': payload.length }) }, sha256(payload));
  delete h.host;
  let res;
  try {
    res = await fetch(u, { method, headers: h, body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : payload, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(`S3 unreachable (${c.endpoint}): ${e.cause?.code || e.message}`);
  }
  if (!res.ok && !okStatus.includes(res.status)) {
    const text = await res.text().catch(() => '');
    const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
    const msg = text.match(/<Message>([^<]+)<\/Message>/)?.[1];
    const hint = { NoSuchBucket: ' — check the bucket name', InvalidAccessKeyId: ' — check the access key', SignatureDoesNotMatch: ' — check the secret key (and region)', AccessDenied: ' — the key has no permission for this bucket/action' }[code] || '';
    throw Object.assign(new Error(`S3 ${method} ${key || c.bucket}: HTTP ${res.status}${code ? ` ${code}` : ''}${msg ? ` — ${msg}` : ''}${hint}`), { status: res.status, code });
  }
  return res;
}

export const objectKey = (c, rel) => [c.prefix, rel.split(path.sep).join('/')].filter(Boolean).join('/');

/** Upload a local file. Big files go in parts; a failed multipart upload is aborted. */
export async function putFile(c, key, file) {
  const size = fs.statSync(file).size;
  if (size <= PART) {
    await request(c, 'PUT', key, { body: fs.readFileSync(file), headers: { 'content-type': 'application/gzip' } });
    return size;
  }
  const init = await (await request(c, 'POST', key, { query: 'uploads=', headers: { 'content-type': 'application/gzip' } })).text();
  const uploadId = init.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) throw new Error('S3 did not start the multipart upload');
  const fd = fs.openSync(file, 'r');
  const etags = [];
  try {
    for (let n = 1, off = 0; off < size; n++, off += PART) {
      const len = Math.min(PART, size - off);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, off);
      const r = await request(c, 'PUT', key, { query: `partNumber=${n}&uploadId=${enc(uploadId)}`, body: buf });
      etags.push(`<Part><PartNumber>${n}</PartNumber><ETag>${r.headers.get('etag')}</ETag></Part>`);
    }
    await request(c, 'POST', key, { query: `uploadId=${enc(uploadId)}`, body: Buffer.from(`<CompleteMultipartUpload>${etags.join('')}</CompleteMultipartUpload>`), headers: { 'content-type': 'application/xml' } });
  } catch (e) {
    await request(c, 'DELETE', key, { query: `uploadId=${enc(uploadId)}`, okStatus: [404] }).catch(() => {});
    throw e;
  } finally {
    fs.closeSync(fd);
  }
  return size;
}

/** Download an object to a local file (written to .part first, so a broken download never looks complete). */
export async function getFile(c, key, dest) {
  const res = await request(c, 'GET', key, { timeoutMs: 60 * 60000 });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return fs.statSync(dest).size;
}

export async function headObject(c, key) {
  const r = await request(c, 'HEAD', key, { okStatus: [404] });
  return r.status === 404 ? null : { size: Number(r.headers.get('content-length')) || 0 };
}

export const deleteObject = (c, key) => request(c, 'DELETE', key, { okStatus: [404] });

export const createBucket = (c) => request(c, 'PUT', '', { okStatus: [409] });

/** Write, read back and delete a small object: proves the settings work. */
export async function testS3(c) {
  const key = objectKey(c, `.switchboard-test-${Date.now()}.txt`);
  const body = Buffer.from(`Switchboard test ${new Date().toISOString()}\n`);
  await request(c, 'PUT', key, { body, headers: { 'content-type': 'text/plain' } });
  const h = await headObject(c, key);
  if (!h || h.size !== body.length) throw new Error('S3 accepted the upload but the object could not be read back');
  await deleteObject(c, key);
  return { ok: true, where: `${c.endpoint}/${c.bucket}/${c.prefix}/` };
}

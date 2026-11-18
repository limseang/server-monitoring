import { config } from './config.js';
import { getSetting } from './settings.js';

const enc = encodeURIComponent;

export async function cfFetch(method, path, { body, token } = {}) {
  const tok = token || getSetting('cf_token');
  if (!tok) throw new Error('Cloudflare API token is not set (Settings → Cloudflare)');
  let res;
  try {
    res = await fetch(config.cfApiBase + path, {
      method,
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new Error(`Cloudflare API unreachable: ${e.cause?.code || e.message}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.success === false) {
    const msg = data?.errors?.length
      ? data.errors.map((e) => `${e.message}${e.code ? ` (code ${e.code})` : ''}`).join('; ')
      : `HTTP ${res.status}`;
    throw new Error(`Cloudflare: ${msg}`);
  }
  return data;
}

async function paged(path, opts) {
  const out = [];
  for (let page = 1; page <= 100; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await cfFetch('GET', `${path}${sep}page=${page}`, opts);
    out.push(...(data.result || []));
    const info = data.result_info;
    if (!info || page >= (info.total_pages || 1)) break;
  }
  return out;
}

export async function listZones(token) {
  const zones = await paged('/zones?per_page=50', { token });
  return zones.map((z) => ({ id: z.id, name: z.name, status: z.status, plan: z.plan?.name || '' }));
}

export async function listRecords(zoneId) {
  const recs = await paged(`/zones/${enc(zoneId)}/dns_records?per_page=100`);
  return recs
    .filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type))
    .map(({ id, name, type, content, proxied, ttl }) => ({ id, name, type, content, proxied, ttl }));
}

export async function getRecord(zoneId, recordId) {
  return (await cfFetch('GET', `/zones/${enc(zoneId)}/dns_records/${enc(recordId)}`)).result;
}

export async function updateRecord(zoneId, recordId, patch) {
  return (await cfFetch('PATCH', `/zones/${enc(zoneId)}/dns_records/${enc(recordId)}`, { body: patch })).result;
}

export async function purgeEverything(zoneId) {
  await cfFetch('POST', `/zones/${enc(zoneId)}/purge_cache`, { body: { purge_everything: true } });
}

export async function verifyToken(token) {
  const zones = await listZones(token);
  return { zones: zones.length, names: zones.slice(0, 20).map((z) => z.name) };
}

/** All records with exactly this name (any type). */
export async function findRecords(zoneId, name) {
  return (await cfFetch('GET', `/zones/${enc(zoneId)}/dns_records?name=${enc(name)}&per_page=50`)).result || [];
}

export async function createRecord(zoneId, { type = 'A', name, content, proxied = true, ttl = 1, comment }) {
  return (await cfFetch('POST', `/zones/${enc(zoneId)}/dns_records`, { body: { type, name, content, proxied, ttl, ...(comment ? { comment } : {}) } })).result;
}

export async function deleteRecord(zoneId, recordId) {
  await cfFetch('DELETE', `/zones/${enc(zoneId)}/dns_records/${enc(recordId)}`);
}

/** A zone setting such as "ssl" (off / flexible / full / strict) or "always_use_https" (on / off). */
export async function getZoneSetting(zoneId, name) {
  return (await cfFetch('GET', `/zones/${enc(zoneId)}/settings/${enc(name)}`)).result?.value;
}

export async function setZoneSetting(zoneId, name, value) {
  return (await cfFetch('PATCH', `/zones/${enc(zoneId)}/settings/${enc(name)}`, { body: { value } })).result?.value;
}

/**
 * Have Cloudflare's Origin CA sign a certificate request (CSR) — the certificate for HTTPS between
 * Cloudflare and a server. Trusted by Cloudflare only (not browsers); valid for 15 years.
 * Token permission: Zone · SSL and Certificates · Edit.
 */
export async function createOriginCert(csr, hostnames, days = 5475) {
  return (await cfFetch('POST', '/certificates', { body: { csr, hostnames, request_type: 'origin-rsa', requested_validity: days } })).result;
}

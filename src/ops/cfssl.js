import http from 'node:http';
import net from 'node:net';
import * as cf from '../cloudflare.js';
import { certCheck } from '../health.js';
import { deploymentsOf, parseJSON } from '../models.js';

/**
 * HTTPS between Cloudflare and the servers ("SSL" for a proxied project).
 *
 * Cloudflare's SSL mode is a ZONE setting (it covers every proxied hostname in the zone):
 *   off       visitors get plain http only
 *   flexible  visitor → Cloudflare is https, Cloudflare → server is plain http.
 *             If the server (or Laravel) redirects http → https, that makes an endless redirect loop.
 *   full      Cloudflare → server is https, any certificate is accepted (Switchboard's web proxy
 *             has a self-signed one — this works out of the box)
 *   strict    like full, but the server needs a trusted certificate or a Cloudflare Origin Certificate
 * Safe default: full.
 */
export const SSL_MODES = ['off', 'flexible', 'full', 'strict'];
export const DEFAULT_SSL_MODE = 'full';

/** Does http://<ip>/ (Host: name) answer with a redirect to https? Then Flexible mode would loop. */
function httpRedirectsToHttps(ip, name, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.request({ host: ip, port: 80, path: '/', method: 'GET', headers: { Host: name, 'User-Agent': 'Switchboard SSL check' }, timeout: timeoutMs }, (res) => {
      res.resume();
      const loc = String(res.headers.location || '');
      resolve(res.statusCode >= 300 && res.statusCode < 400 && /^https:/i.test(loc));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

const strictOk = (c) => c.ok && c.days_left >= 0 && (c.trusted || /cloudflare/i.test(c.issuer || ''));

async function pool(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}

/**
 * Current SSL setup of the project's zone(s), plus a check of every hostname a mode change would touch:
 * each proxied A/AAAA record of the zone (not only this project's) and each server of the project.
 */
export async function sslStatus(project) {
  const linked = parseJSON(project.dns_records, []);
  const deps = deploymentsOf(project.id);
  const zoneIds = [...new Set(linked.map((r) => r.zone_id))];
  const zones = [];
  const targets = new Map(); // `${ip}|${name}` → target
  const add = (t) => {
    const k = `${t.ip}|${t.name}`;
    if (!targets.has(k)) targets.set(k, t);
    else Object.assign(targets.get(k), { linked: targets.get(k).linked || t.linked, server: targets.get(k).server || t.server });
  };
  const linkedIds = new Set(linked.map((r) => r.id));
  const mainName = project.domain || linked[0]?.name || '';
  for (const zid of zoneIds) {
    const z = { zone_id: zid, zone_name: linked.find((r) => r.zone_id === zid)?.zone_name || '', ssl: null, always_use_https: null, error: null, other_hosts: 0 };
    try {
      [z.ssl, z.always_use_https] = await Promise.all([cf.getZoneSetting(zid, 'ssl'), cf.getZoneSetting(zid, 'always_use_https')]);
      const recs = await cf.listRecords(zid);
      for (const r of recs) {
        if (!r.proxied || !net.isIP(r.content)) continue;
        const dep = deps.find((d) => d.server_ip === r.content || d.server_ipv6 === r.content);
        add({ name: r.name, ip: r.content, linked: linkedIds.has(r.id), proxied: true, server: dep?.server_name || null });
        if (!linkedIds.has(r.id)) z.other_hosts++;
      }
      for (const r of linked.filter((x) => x.zone_id === zid)) {
        const cur = recs.find((x) => x.id === r.id);
        if (cur && !cur.proxied && net.isIP(cur.content)) {
          const dep = deps.find((d) => d.server_ip === cur.content || d.server_ipv6 === cur.content);
          add({ name: cur.name, ip: cur.content, linked: true, proxied: false, server: dep?.server_name || null });
        }
      }
    } catch (e) {
      z.error = e.message;
    }
    zones.push(z);
  }
  // Standby servers too: after a switch they get the visitors.
  if (mainName) for (const d of deps) if (d.server_ip) add({ name: mainName, ip: d.server_ip, linked: true, proxied: null, server: d.server_name, standby: true });
  const list = [...targets.values()].slice(0, 40);
  const checks = await pool(list, 8, async (t) => {
    const c = await certCheck({ host: t.ip, servername: t.name, port: 443, timeoutMs: 6000 });
    return {
      ...t,
      https: c.ok,
      error: c.ok ? null : c.error,
      issuer: c.issuer || null,
      trusted: !!c.trusted,
      days_left: c.days_left ?? null,
      strict_ok: strictOk(c),
      redirects_to_https: await httpRedirectsToHttps(t.ip, t.name),
    };
  });
  return { zones, checks, default_mode: DEFAULT_SSL_MODE, truncated: targets.size > list.length };
}

/** Hostnames that would break with this mode (only proxied ones use Cloudflare's SSL mode). */
export function sslProblems(status, mode) {
  const live = status.checks.filter((c) => c.proxied);
  if (mode === 'full') return live.filter((c) => !c.https).map((c) => `${c.name} (${c.ip}) does not answer HTTPS on port 443${c.error ? ` — ${c.error}` : ''}`);
  if (mode === 'strict') {
    return live.filter((c) => !c.strict_ok).map((c) => `${c.name} (${c.ip}) ${!c.https ? `does not answer HTTPS on port 443${c.error ? ` — ${c.error}` : ''}` : `has a certificate Cloudflare won't accept in strict mode (${c.issuer || 'self-signed'}${c.days_left < 0 ? ', expired' : ''})`}`);
  }
  if (mode === 'flexible') return live.filter((c) => c.redirects_to_https).map((c) => `${c.name} (${c.ip}) redirects http → https, so Flexible would make an endless redirect loop (ERR_TOO_MANY_REDIRECTS)`);
  return [];
}

/** Set the SSL mode (and optionally Always Use HTTPS) on every zone of the project. */
export async function applySsl(project, { mode, alwaysHttps }) {
  const zoneIds = [...new Set(parseJSON(project.dns_records, []).map((r) => r.zone_id))];
  if (!zoneIds.length) throw new Error('Link the Cloudflare DNS records to this project first');
  const out = [];
  for (const zid of zoneIds) {
    const before = await cf.getZoneSetting(zid, 'ssl');
    await cf.setZoneSetting(zid, 'ssl', mode);
    let https = null;
    if (alwaysHttps !== undefined) https = await cf.setZoneSetting(zid, 'always_use_https', alwaysHttps ? 'on' : 'off');
    out.push({ zone_id: zid, before, ssl: mode, always_use_https: https });
  }
  return out;
}

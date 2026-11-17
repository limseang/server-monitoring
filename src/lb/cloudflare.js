/**
 * Cloudflare Load Balancing (paid add-on) as the load balancer of a project.
 *
 *   monitor  (account) — Cloudflare's own health check, same path/port/Host as the project's
 *   pool     (account) — one origin per server in the project; enabled = gets visitors
 *   LB       (zone)    — one per hostname linked to the project (shop.com, www.shop.com…),
 *                        it takes over the hostname; the DNS record stays underneath
 *
 * The API token needs: Account → Load Balancing: Monitors and Pools → Edit,
 * and Zone → Load Balancers → Edit (plus the DNS permissions Switchboard already uses).
 */
import { cfFetch } from '../cloudflare.js';
import { parseJSON } from '../models.js';

const enc = encodeURIComponent;
const nameFor = (project) => `switchboard-${project.slug}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60);

/** Turn "200-399" / "200,301" into what Cloudflare monitors accept ("2xx", "200"…). */
export function cfExpectedCodes(expect) {
  const first = String(expect || '200-399').split(',')[0].trim();
  const [a, b] = first.split('-').map(Number);
  if (!Number.isFinite(a)) return '2xx';
  if (Number.isFinite(b) && b !== a) return `${String(a)[0]}xx`;
  return String(a);
}

function friendly(e) {
  const m = String(e.message || e);
  if (/1001|not entitled|subscription|load balancing is not enabled|not enabled for/i.test(m)) {
    return new Error(`${m} — Load Balancing is a paid Cloudflare add-on: enable it in the Cloudflare dashboard (Traffic → Load Balancing) first.`);
  }
  if (/10000|Authentication error|permission/i.test(m)) {
    return new Error(`${m} — the API token needs "Load Balancing: Monitors and Pools — Edit" (account) and "Load Balancers — Edit" (zone).`);
  }
  return e;
}

async function call(method, path, body) {
  try {
    return (await cfFetch(method, path, { body })).result;
  } catch (e) {
    throw friendly(e);
  }
}

/** Zones (from the linked DNS records) and the account they belong to. */
async function zonesOf(project) {
  const records = parseJSON(project.dns_records, []);
  if (!records.length) throw new Error('Link the Cloudflare DNS records first (project Settings) — they are the hostnames the load balancer takes over');
  const zones = [...new Set(records.map((r) => r.zone_id))];
  const accounts = new Set();
  for (const z of zones) accounts.add((await call('GET', `/zones/${enc(z)}`)).account?.id);
  if (accounts.size !== 1 || [...accounts][0] == null) throw new Error('All linked hostnames must be in zones of the same Cloudflare account');
  return { records, account: [...accounts][0] };
}

function monitorBody(project) {
  const https = project.health_scheme !== 'http';
  return {
    type: https ? 'https' : 'http',
    method: 'GET',
    path: project.health_path || '/',
    port: Number(project.health_port) || (https ? 443 : 80),
    expected_codes: cfExpectedCodes(project.health_expect),
    expected_body: project.health_keyword || '',
    header: project.domain ? { Host: [project.domain] } : {},
    allow_insecure: true,
    follow_redirects: false,
    interval: 60,
    retries: 2,
    timeout: 5,
    description: `Switchboard: ${project.name}`,
  };
}

/** Members → pool origins. Weights are 0–1 in Cloudflare. */
function origins(members) {
  const max = Math.max(1, ...members.map((m) => Number(m.lb_weight) || 1));
  return members.map((m) => ({
    name: `sb-${m.id}-${String(m.server_name).replace(/[^A-Za-z0-9_-]/g, '-')}`.slice(0, 60),
    address: m.server_ip,
    enabled: m.lb_state === 'active',
    weight: Math.round(((Number(m.lb_weight) || 1) / max) * 100) / 100,
  }));
}

/**
 * Create or update monitor + pool + one load balancer per hostname.
 * Returns the new lb_config to store on the project.
 */
export async function applyCloudflare(ctx, project, members, cfg) {
  const { records, account } = await zonesOf(project);
  const acc = `/accounts/${enc(account)}/load_balancers`;
  const next = { ...cfg, account_id: account };

  // Monitor
  if (next.monitor_id) {
    try {
      await call('PUT', `${acc}/monitors/${enc(next.monitor_id)}`, monitorBody(project));
    } catch {
      next.monitor_id = null; // deleted in the Cloudflare dashboard → create again
    }
  }
  if (!next.monitor_id) {
    next.monitor_id = (await call('POST', `${acc}/monitors`, monitorBody(project))).id;
    ctx?.log('Cloudflare health monitor created');
  }

  // Pool
  const pool = { name: nameFor(project), description: `Switchboard: ${project.name}`, enabled: true, minimum_origins: 1, monitor: next.monitor_id, origins: origins(members) };
  if (next.pool_id) {
    try {
      await call('PUT', `${acc}/pools/${enc(next.pool_id)}`, pool);
    } catch {
      next.pool_id = null;
    }
  }
  if (!next.pool_id) {
    next.pool_id = (await call('POST', `${acc}/pools`, pool)).id;
    ctx?.log('Cloudflare pool created');
  }
  for (const o of pool.origins) ctx?.log(`  origin ${o.name} ${o.address}: ${o.enabled ? `gets visitors (weight ${o.weight})` : 'no new visitors'}`);

  // One load balancer per hostname
  const lbs = { ...(next.lbs || {}) };
  for (const r of records) {
    const body = {
      name: r.name,
      description: `Switchboard: ${project.name}`,
      default_pools: [next.pool_id],
      fallback_pool: next.pool_id,
      proxied: true,
      steering_policy: 'off',
      session_affinity: next.sticky ? 'cookie' : 'none',
      session_affinity_attributes: { drain_duration: Number(project.drain_seconds) || 30 },
    };
    const zp = `/zones/${enc(r.zone_id)}/load_balancers`;
    let id = lbs[r.name];
    if (!id) id = (await call('GET', zp)).find((x) => x.name === r.name)?.id;
    if (id) {
      try {
        await call('PUT', `${zp}/${enc(id)}`, body);
      } catch {
        id = null;
      }
    }
    if (!id) {
      id = (await call('POST', zp, body)).id;
      ctx?.log(`Cloudflare load balancer for ${r.name} created`);
    }
    lbs[r.name] = id;
  }
  next.lbs = lbs;
  return next;
}

/** Origin health as Cloudflare sees it: { [ip]: true|false|null } (majority of data centers). */
export async function cloudflareHealth(cfg) {
  if (!cfg?.account_id || !cfg?.pool_id) return {};
  const r = await call('GET', `/accounts/${enc(cfg.account_id)}/load_balancers/pools/${enc(cfg.pool_id)}/health`);
  const votes = {};
  for (const pop of Object.values(r?.pop_health || {})) {
    for (const o of pop.origins || []) {
      for (const [ip, h] of Object.entries(o)) {
        votes[ip] ||= { up: 0, all: 0 };
        votes[ip].all++;
        if (h.healthy) votes[ip].up++;
      }
    }
  }
  return Object.fromEntries(Object.entries(votes).map(([ip, v]) => [ip, v.all ? v.up * 2 > v.all : null]));
}

/** Remove the load balancers, pool and monitor (the plain DNS records take over again). */
export async function removeCloudflare(ctx, project, cfg) {
  const records = parseJSON(project.dns_records, []);
  for (const r of records) {
    const zp = `/zones/${enc(r.zone_id)}/load_balancers`;
    const id = cfg.lbs?.[r.name] || (await call('GET', zp).catch(() => [])).find?.((x) => x.name === r.name)?.id;
    if (!id) continue;
    await call('DELETE', `${zp}/${enc(id)}`).catch((e) => ctx?.warn(`Could not delete the load balancer for ${r.name}: ${e.message}`));
    ctx?.log(`Cloudflare load balancer for ${r.name} removed`);
  }
  if (cfg.account_id) {
    const acc = `/accounts/${enc(cfg.account_id)}/load_balancers`;
    if (cfg.pool_id) await call('DELETE', `${acc}/pools/${enc(cfg.pool_id)}`).catch((e) => ctx?.warn(`Pool not deleted: ${e.message}`));
    if (cfg.monitor_id) await call('DELETE', `${acc}/monitors/${enc(cfg.monitor_id)}`).catch((e) => ctx?.warn(`Monitor not deleted: ${e.message}`));
  }
  return { sticky: cfg.sticky };
}

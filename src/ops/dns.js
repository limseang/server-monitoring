import { config } from '../config.js';
import { isPrivateAddress } from '../util.js';
import { update, now } from '../db.js';
import { bus } from '../bus.js';
import { alert, logEvent } from '../events.js';
import { deploymentsOf, getProject, getServer, parseJSON } from '../models.js';
import * as cf from '../cloudflare.js';

const ipFor = (record, dep) => (record.type === 'AAAA' ? dep.server_ipv6 : dep.server_ip);

/**
 * Why DNS must not be pointed at this server, or null. A private IP (home Wi-Fi 192.168.x.x, a VPS's
 * internal 10.x.x.x) can't be reached by Cloudflare or visitors: switching to it takes the site down.
 */
export function dnsTargetProblem(project, dep) {
  if (config.allowPrivateDns) return null;
  for (const r of parseJSON(project.dns_records, [])) {
    const ip = ipFor(r, dep);
    if (ip && isPrivateAddress(ip)) {
      return `${dep.server_name} has the private IP ${ip}, which visitors and Cloudflare can't reach — pointing ${r.name} there would take the site down. Set the server's public IP (Servers → ${dep.server_name} → Edit; keep the private one as "SSH host" if Switchboard reaches it on your network), and make sure ports 80/443 are forwarded to it.`;
    }
  }
  return null;
}

/**
 * Point every Cloudflare record of the project to the deployment's server IP.
 * If one update fails, records already changed are reverted.
 */
export async function pointDnsTo(ctx, project, dep) {
  const records = parseJSON(project.dns_records, []);
  if (!records.length) throw new Error('No Cloudflare DNS records are linked to this project (Project → Settings → DNS records)');
  for (const r of records) {
    if (!ipFor(r, dep)) throw new Error(`Record ${r.name} is ${r.type} but ${dep.server_name} has no ${r.type === 'AAAA' ? 'IPv6' : 'IPv4'} address`);
  }
  const problem = dnsTargetProblem(project, dep);
  if (problem) throw new Error(problem);
  const changed = [];
  try {
    for (const r of records) {
      const want = ipFor(r, dep);
      const cur = await cf.getRecord(r.zone_id, r.id);
      if (cur.content === want) {
        ctx?.log(`DNS ${r.type} ${cur.name} already points to ${want}`);
        continue;
      }
      await cf.updateRecord(r.zone_id, r.id, { content: want });
      changed.push({ r, old: cur.content });
      const how = cur.proxied ? 'proxied → takes effect in seconds' : `DNS only, TTL ${cur.ttl === 1 ? 'auto' : `${cur.ttl}s`}`;
      ctx?.log(`DNS ${r.type} ${cur.name}: ${cur.content} → ${want} (${how})`);
      if (!cur.proxied && cur.ttl > 300) ctx?.warn(`${cur.name} is not proxied and has TTL ${cur.ttl}s — some visitors may reach the old server until it expires. Consider proxied mode or TTL 60.`);
    }
  } catch (e) {
    if (changed.length) {
      ctx?.warn('DNS update failed — reverting the records that were already changed');
      for (const c of changed.reverse()) {
        try {
          await cf.updateRecord(c.r.zone_id, c.r.id, { content: c.old });
          ctx?.log(`Reverted ${c.r.name} → ${c.old}`);
        } catch (e2) {
          ctx?.warn(`Could not revert ${c.r.name}: ${e2.message}`);
        }
      }
    }
    throw e;
  }
  return changed.length;
}

export async function purgeProjectCache(project) {
  const zones = [...new Set(parseJSON(project.dns_records, []).map((r) => r.zone_id))];
  for (const z of zones) await cf.purgeEverything(z);
  return zones.length;
}

/**
 * Read the project's records from Cloudflare and compare with the active server.
 * - drift: Cloudflare doesn't point to the server Switchboard thinks is active
 * - if no active server is set yet and all records point to one server, adopt it
 */
export async function refreshDnsState(projectId) {
  const project = getProject(projectId);
  if (!project) return null;
  const records = parseJSON(project.dns_records, []);
  if (!records.length) {
    if (project.dns_state) update('projects', projectId, { dns_state: null });
    return null;
  }
  const deps = deploymentsOf(projectId);
  let active = deps.find((d) => d.id === project.active_deployment_id);
  const state = { checked_at: now(), records: [], drift: false, error: null, points_to: null };
  // Load balanced: records point at the LB server (own nginx), or sit under Cloudflare's load balancer.
  const lbMode = project.traffic_mode === 'lb' ? project.lb_provider : null;
  const lbServer = lbMode === 'own' ? getServer(project.lb_server_id) : null;
  if (lbMode) state.lb = lbMode;
  try {
    for (const r of records) {
      const cur = await cf.getRecord(r.zone_id, r.id);
      const owner = deps.find((d) => ipFor(r, d) === cur.content);
      state.records.push({
        id: r.id,
        name: cur.name,
        type: cur.type,
        content: cur.content,
        proxied: !!cur.proxied,
        ttl: cur.ttl,
        owner_id: owner?.id ?? null,
        owner_name: owner?.server_name ?? null,
      });
    }
    const owners = [...new Set(state.records.map((r) => r.owner_id))];
    state.points_to = owners.length === 1 ? owners[0] : null;
    if (lbMode) {
      for (const rec of state.records) {
        if (lbMode === 'cloudflare') {
          rec.expected = null;
          rec.ok = true;
          rec.note = 'Cloudflare load balancer answers for this hostname';
        } else {
          rec.expected = rec.type === 'AAAA' ? lbServer?.ipv6 : lbServer?.ip;
          rec.ok = !!rec.expected && rec.content === rec.expected;
          if (rec.ok) rec.owner_name = `${lbServer.name} (load balancer)`;
        }
      }
      state.drift = lbMode === 'own' && state.records.some((r) => !r.ok);
    } else if (!active && state.points_to) {
      active = deps.find((d) => d.id === state.points_to);
      update('projects', projectId, { active_deployment_id: active.id });
      update('deployments', active.id, { data_at: null, data_note: null });
      logEvent('info', `${project.name}: Cloudflare points to ${active.server_name}, marked it as the active server`, { projectId });
    }
    if (!lbMode) {
      for (const rec of state.records) {
        rec.expected = active ? (rec.type === 'AAAA' ? active.server_ipv6 : active.server_ip) : null;
        rec.ok = !!rec.expected && rec.content === rec.expected;
      }
      state.drift = !!active && state.records.some((r) => !r.ok);
    }
  } catch (e) {
    state.error = e.message;
  }
  const prev = parseJSON(project.dns_state);
  update('projects', projectId, { dns_state: JSON.stringify(state) });
  if (state.drift && !prev?.drift) {
    const where = state.records.filter((r) => !r.ok).map((r) => `${r.name} → ${r.content}${r.owner_name ? ` (${r.owner_name})` : ''}`);
    alert('warn', `${project.name}: DNS drift — Cloudflare does not point to ${lbServer ? `the load balancer ${lbServer.name}` : `the active server ${active.server_name}`}: ${where.join(', ')}`, {
      projectId,
      link: `#/projects/${projectId}`,
    });
  } else if (!state.drift && prev?.drift && !state.error) {
    logEvent('success', `${project.name}: DNS points to the active server again`, { projectId });
  }
  bus.emit('state', { projectId });
  return state;
}

/**
 * Change one linked record by hand: point it at another IP and/or turn the Cloudflare proxy on/off.
 * Returns { before, after } (Cloudflare's record before and after the change).
 */
export async function setRecord(project, recordId, { content, proxied }) {
  const rec = parseJSON(project.dns_records, []).find((r) => r.id === recordId);
  if (!rec) throw new Error('That record is not linked to this project');
  const before = await cf.getRecord(rec.zone_id, rec.id);
  const patch = {};
  if (content !== undefined && content !== before.content) {
    if (project.traffic_mode === 'lb') throw new Error('This project is load balanced — its records are managed by the load balancer (Traffic tab), not by hand');
    if (!config.allowPrivateDns && isPrivateAddress(content)) {
      throw new Error(`${content} is a private IP — visitors and Cloudflare can't reach it, so ${before.name} would go down. Use the server's public IP.`);
    }
    patch.content = content;
  }
  if (proxied !== undefined && !!proxied !== !!before.proxied) {
    patch.proxied = !!proxied;
  }
  if (!Object.keys(patch).length) return { before, after: before, changed: false };
  const after = await cf.updateRecord(rec.zone_id, rec.id, patch);
  return { before, after, changed: true };
}

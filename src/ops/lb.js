/**
 * LOAD BALANCING — several live servers behind one load balancer.
 *
 * Each server in a load-balanced project has a pool state:
 *   active   — gets visitors
 *   draining — no new visitors, running requests finish (for `drain_seconds`)
 *   off      — no visitors
 *
 * The load balancer is either Cloudflare Load Balancing or nginx on a server of yours
 * (project.lb_provider = 'cloudflare' | 'own'). Everything that changes who gets
 * visitors goes through applyLb(), so both behave the same.
 */
import { update, now, tx } from '../db.js';
import { getProject, getServer, getDeployment, deploymentsOf, parseJSON } from '../models.js';
import { probe, httpCheck } from '../health.js';
import { sleep } from '../util.js';
import { connectTo } from './remote.js';
import { pointDnsTo, refreshDnsState } from './dns.js';
import { applyCloudflare, cloudflareHealth, removeCloudflare } from '../lb/cloudflare.js';
import { ensureNginx, applyNginx, removeNginx, inRotation } from '../lb/nginx.js';

export const lbConfig = (p) => parseJSON(p?.lb_config, {}) || {};
export const lbRuntime = (p) => parseJSON(p?.lb_state, {}) || {};
export const isLb = (p) => p?.traffic_mode === 'lb';

export function saveRuntime(projectId, patch) {
  const p = getProject(projectId);
  update('projects', projectId, { lb_state: JSON.stringify({ ...lbRuntime(p), ...patch }) });
}

/** What the load balancer should look like right now — used to notice when it must be re-applied. */
export function rotationSig(project, members) {
  if (project.lb_provider === 'cloudflare') return members.map((m) => `${m.id}:${m.lb_state}:${m.lb_weight}`).join(',');
  const on = new Set(inRotation(members).map((m) => m.id));
  return members.map((m) => `${m.id}:${on.has(m.id) ? 'on' : 'down'}:${m.lb_weight}`).join(',');
}

/** The LB server as a "deployment-like" object, for pointing DNS at it. */
const lbAsTarget = (s) => ({ server_name: `${s.name} (load balancer)`, server_ip: s.ip, server_ipv6: s.ipv6 });

/** Push the current pool to the load balancer. */
export async function applyLb(ctx, projectId, { ensure = false } = {}) {
  const project = getProject(projectId);
  const members = deploymentsOf(projectId);
  const cfg = lbConfig(project);
  if (project.lb_provider === 'cloudflare') {
    const next = await applyCloudflare(ctx, project, members, cfg);
    update('projects', projectId, { lb_config: JSON.stringify(next) });
  } else {
    const lb = getServer(project.lb_server_id);
    if (!lb) throw new Error('No load balancer server chosen for this project');
    const conn = await connectTo(ctx, lb);
    try {
      if (ensure) await ensureNginx(ctx, conn, lb);
      await applyNginx(ctx, conn, lb, project, members, cfg);
    } finally {
      conn.end();
    }
    const on = inRotation(members);
    ctx?.log(`nginx on ${lb.name} updated — visitors go to: ${on.map((m) => m.server_name).join(', ') || 'nobody'}`);
  }
  saveRuntime(projectId, { applied_sig: rotationSig(getProject(projectId), deploymentsOf(projectId)), applied_at: now(), error: null });
}

async function healthy(ctx, project, dep, attempts = 5) {
  let r;
  for (let i = 1; i <= attempts; i++) {
    r = await probe(project, dep);
    if (r.ok) return r;
    if (i < attempts) {
      ctx?.log(`  ${dep.server_name}: ${r.error} — retrying in 3s…`);
      await sleep(3000);
    }
  }
  return r;
}

/** Cloudflare only: wait until its own monitor sees the server healthy (it won't send visitors before that anyway). */
async function waitCloudflareHealthy(ctx, project, dep, seconds = 150) {
  if (project.lb_provider !== 'cloudflare') return;
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    ctx.throwIfCancelled();
    const h = await cloudflareHealth(lbConfig(getProject(project.id))).catch(() => ({}));
    if (h[dep.server_ip] === true) {
      ctx.log(`Cloudflare sees ${dep.server_name} as healthy`);
      return;
    }
    await sleep(10000);
  }
  ctx.warn(`Cloudflare hasn't reported ${dep.server_name} healthy yet — it only sends visitors once its monitor passes`);
}

async function waitDrain(ctx, project) {
  const s = Math.max(0, Number(project.drain_seconds) || 0);
  if (!s) return;
  ctx.log(`Waiting ${s}s for running requests to finish…`);
  for (let i = 0; i < s; i++) {
    ctx.throwIfCancelled();
    await sleep(1000);
  }
}

function mustMember(project, id) {
  const d = getDeployment(Number(id));
  if (!d || d.project_id !== project.id) throw new Error('That server is not part of this project');
  return d;
}

/* ------------------------------------------------------------------ actions */

/** Put a server into the pool (health-checked first). */
export async function addMember(ctx, projectId, depId, { force = false } = {}) {
  const project = getProject(projectId);
  const dep = mustMember(project, depId);
  ctx.step(`Health check ${dep.server_name} directly at ${dep.server_ip}`);
  const h = await healthy(ctx, project, dep);
  if (h.ok) ctx.log(`Healthy — HTTP ${h.code} in ${h.ms} ms`);
  else if (force) ctx.warn(`${dep.server_name} is NOT healthy (${h.error}) — adding anyway because "force" is on`);
  else throw new Error(`${dep.server_name} failed the health check (${h.error}). Not added to the load balancer.`);
  ctx.step(`Add ${dep.server_name} to the load balancer`);
  update('deployments', dep.id, { lb_state: 'active', health: h.ok ? 'up' : dep.health, fail_count: h.ok ? 0 : dep.fail_count });
  await applyLb(ctx, projectId);
  await waitCloudflareHealthy(ctx, project, dep);
  if (!getProject(projectId).active_deployment_id) update('projects', projectId, { active_deployment_id: dep.id });
}

/** Take a server out without cutting visitors off: no new visitors → wait → off. */
export async function drainMember(ctx, projectId, depId, { force = false } = {}) {
  const project = getProject(projectId);
  const dep = mustMember(project, depId);
  if (dep.lb_state === 'off') {
    ctx.log(`${dep.server_name} is already out of the load balancer`);
    return;
  }
  const others = deploymentsOf(projectId).filter((m) => m.id !== dep.id && m.lb_state === 'active');
  let ok = 0;
  for (const m of others) if ((await probe(project, m)).ok) ok++;
  if (!ok && !force) throw new Error(`${dep.server_name} is the only healthy server getting visitors — add another server first (or use "force")`);
  ctx.step(`Drain ${dep.server_name}: no new visitors, running requests finish`);
  update('deployments', dep.id, { lb_state: 'draining' });
  await applyLb(ctx, projectId);
  await waitDrain(ctx, getProject(projectId));
  update('deployments', dep.id, { lb_state: 'off' });
  await applyLb(ctx, projectId);
  ctx.log(`${dep.server_name} is out of the load balancer`);
  const p = getProject(projectId);
  if (p.active_deployment_id === dep.id) {
    const next = deploymentsOf(projectId).find((m) => m.lb_state === 'active');
    update('projects', projectId, { active_deployment_id: next?.id ?? null });
  }
}

/** Zero-downtime switch: target in, everyone else drained. */
export async function moveTraffic(ctx, projectId, targetId, { force = false } = {}) {
  const project = getProject(projectId);
  const target = mustMember(project, targetId);
  if (target.lb_state !== 'active') await addMember(ctx, projectId, target.id, { force });
  for (const m of deploymentsOf(projectId)) {
    if (m.id === target.id || m.lb_state === 'off') continue;
    await drainMember(ctx, projectId, m.id, { force: true });
  }
  update('projects', projectId, { active_deployment_id: target.id, last_switch_at: now() });
}

/** Run fn() on a server while it is out of rotation (rolling deploy). Skips draining when it's the only one. */
export async function whileDrained(ctx, projectId, dep, fn) {
  const project = getProject(projectId);
  const others = deploymentsOf(projectId).filter((m) => m.id !== dep.id && m.lb_state === 'active' && m.health !== 'down');
  if (dep.lb_state !== 'active' || !others.length) {
    if (dep.lb_state === 'active') ctx.warn(`${dep.server_name} is the only server getting visitors — deploying without draining`);
    return fn();
  }
  ctx.step(`Take ${dep.server_name} out of the load balancer for the deploy`);
  update('deployments', dep.id, { lb_state: 'draining' });
  await applyLb(ctx, projectId);
  await waitDrain(ctx, project);
  try {
    return await fn();
  } finally {
    const h = await healthy(ctx, project, dep, 10);
    update('deployments', dep.id, { lb_state: 'active' });
    if (h.ok) {
      ctx.step(`Put ${dep.server_name} back into the load balancer`);
      await applyLb(ctx, projectId);
    } else {
      // Keep it marked active (so it returns by itself when healthy) but nginx leaves it out while down.
      update('deployments', dep.id, { health: 'down' });
      await applyLb(ctx, projectId);
      ctx.warn(`${dep.server_name} is not healthy after the deploy (${h.error}) — it stays out until it passes the health check`);
    }
  }
}

/* ------------------------------------------------------------------ mode switch */

export async function enableLb(ctx, projectId, opts) {
  let project = getProject(projectId);
  if (isLb(project)) throw new Error('This project is already load balanced');
  const deps = deploymentsOf(projectId);
  if (!deps.length) throw new Error('Add at least one server to the project first');
  const hasDb = deps.some((d) => d.db_type !== 'none');
  if (hasDb && !project.db_server_id && !opts.force) {
    throw new Error('Several live servers must share ONE database. Move the database to a database server first (Traffic tab → Database server). Only skip this for apps without a database.');
  }
  const ids = (opts.members?.length ? opts.members : [project.active_deployment_id || deps[0].id]).map(Number);
  const cfg = { ...lbConfig(project), method: opts.method, tls_cert: opts.tls_cert || '', tls_key: opts.tls_key || '', use_private: opts.use_private !== false, sticky: !!opts.sticky };
  if (opts.provider === 'own') {
    const lb = getServer(Number(opts.lb_server));
    if (!lb) throw new Error('Choose the server that will run nginx as the load balancer');
    if (deps.some((d) => d.server_id === lb.id)) ctx.warn(`${lb.name} is also an app server of this project — fine for testing, but a separate small server is safer`);
  }
  ctx.step('Health check the servers that will get visitors');
  for (const id of ids) {
    const d = mustMember(project, id);
    const h = await healthy(ctx, project, d);
    if (!h.ok && !opts.force) throw new Error(`${d.server_name} failed the health check (${h.error})`);
    ctx.log(`${d.server_name}: ${h.ok ? `HTTP ${h.code} in ${h.ms} ms` : h.error}`);
  }
  tx(() => {
    for (const d of deps) update('deployments', d.id, { lb_state: ids.includes(d.id) ? 'active' : 'off' });
    update('projects', projectId, {
      lb_provider: opts.provider,
      lb_server_id: opts.provider === 'own' ? Number(opts.lb_server) : null,
      lb_config: JSON.stringify(cfg),
      lb_state: JSON.stringify({}),
    });
  });
  try {
    if (opts.provider === 'own') {
      project = getProject(projectId);
      const lb = getServer(project.lb_server_id);
      ctx.step(`Set up nginx on ${lb.name} as the load balancer`);
      await applyLb(ctx, projectId, { ensure: true });
      ctx.step(`Test the load balancer: http://${lb.ip}${project.health_path || '/'} (Host: ${project.domain || lb.ip})`);
      let r;
      for (let i = 0; i < 5; i++) {
        r = await httpCheck({ ip: lb.ip, host: project.domain, scheme: 'http', port: 80, path: project.health_path || '/', expect: project.health_expect, keyword: project.health_keyword || '' });
        if (r.ok) break;
        await sleep(2000);
      }
      if (!r.ok && !opts.force) throw new Error(`The load balancer does not answer correctly (${r.error}). DNS was not changed.`);
      ctx.log(`Load balancer answers — HTTP ${r.code} in ${r.ms} ms`);
      ctx.step(`Point Cloudflare DNS to the load balancer ${lb.name} (${lb.ip})`);
      await pointDnsTo(ctx, project, lbAsTarget(lb));
    } else {
      ctx.step('Create the Cloudflare load balancer (monitor, pool, one load balancer per hostname)');
      await applyLb(ctx, projectId);
      for (const id of ids) await waitCloudflareHealthy(ctx, getProject(projectId), getDeployment(id));
    }
  } catch (e) {
    ctx.warn('Setup failed — undoing');
    try {
      if (opts.provider === 'own') {
        const lb = getServer(Number(opts.lb_server));
        const conn = await connectTo(ctx, lb);
        await removeNginx(ctx, conn, lb, getProject(projectId)).finally(() => conn.end());
      } else await removeCloudflare(ctx, getProject(projectId), lbConfig(getProject(projectId)));
    } catch (e2) {
      ctx.warn(`Undo incomplete: ${e2.message}`);
    }
    tx(() => {
      for (const d of deps) update('deployments', d.id, { lb_state: 'off' });
      update('projects', projectId, { lb_config: JSON.stringify({ ...cfg, pool_id: undefined, monitor_id: undefined, lbs: undefined }) });
    });
    throw e;
  }
  update('projects', projectId, { traffic_mode: 'lb', active_deployment_id: ids[0], last_switch_at: now() });
  await refreshDnsState(projectId).catch(() => {});
}

/** Back to one live server (`target`), with DNS pointing straight at it. */
export async function disableLb(ctx, projectId, targetId, { force = false } = {}) {
  const project = getProject(projectId);
  if (!isLb(project)) throw new Error('This project is not load balanced');
  const target = mustMember(project, targetId);
  const h = await healthy(ctx, project, target);
  if (!h.ok && !force) throw new Error(`${target.server_name} failed the health check (${h.error}) — pick a healthy server`);
  // Make sure the target is getting visitors before DNS moves to it.
  if (target.lb_state !== 'active') await addMember(ctx, projectId, target.id, { force });
  ctx.step(`Point Cloudflare DNS straight to ${target.server_name}`);
  await pointDnsTo(ctx, project, target);
  const cfg = lbConfig(project);
  if (project.lb_provider === 'cloudflare') {
    ctx.step('Remove the Cloudflare load balancer');
    update('projects', projectId, { lb_config: JSON.stringify(await removeCloudflare(ctx, project, cfg)) });
  } else {
    const lb = getServer(project.lb_server_id);
    if (lb) {
      // Visitors whose DNS still points at the LB keep working until the old answer expires.
      await waitDrain(ctx, project);
      ctx.step(`Remove the load balancer config from ${lb.name}`);
      const conn = await connectTo(ctx, lb);
      await removeNginx(ctx, conn, lb, project).finally(() => conn.end());
    }
  }
  tx(() => {
    for (const d of deploymentsOf(projectId)) update('deployments', d.id, { lb_state: 'off' });
    update('projects', projectId, { traffic_mode: 'single', active_deployment_id: target.id, lb_state: null, last_switch_at: now() });
  });
  await refreshDnsState(projectId).catch(() => {});
}

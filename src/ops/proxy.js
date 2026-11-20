import { update, now } from '../db.js';
import { bus } from '../bus.js';
import { logEvent } from '../events.js';
import { defineJob } from '../jobs.js';
import { getProject, getServer, deploymentsOf, parseJSON } from '../models.js';
import { connectTo, runRemote, asRoot, shq } from './remote.js';
import { parseHosts, checkScript, parseCheck, proxySiteName } from './proxycheck.js';

export { parseHosts };
import { installHelper, helper } from './stack.js';

/**
 * Web proxy for a project: nginx on each of the project's servers sends visitors of the project's domain(s)
 * to the app's port (127.0.0.1:<port>). Uses the server helper's "edge" proxy: the server's own nginx when it
 * already runs one, otherwise a small nginx container — so it works on a bare server too. HTTPS behind
 * Cloudflare, websockets and big uploads are set up for you. Every change is checked with `nginx -t` and
 * undone when nginx rejects it.
 *
 * Put on every server of the project (live and standby), so switching servers keeps the site working.
 * Per server: check the app answers on its port → no other site already serves the domain → write → test.
 */

const progressOf = (project, hosts, targets, remove) => ({
  kind: 'proxy',
  project: project.name,
  remove: !!remove,
  hosts,
  started_at: new Date().toISOString(),
  servers: targets.map((t) => ({ id: t.dep.id, name: t.dep.server_name, live: t.dep.id === project.active_deployment_id, port: t.port, state: 'queued', phase: '', code: null, note: null, error: null })),
});

defineJob('proxy-setup', async (ctx, p) => {
  const project = getProject(Number(p.project));
  if (!project) throw new Error('Project not found');
  const hosts = parseHosts((p.hosts || []).join(' '));
  const deps = deploymentsOf(project.id);
  const targets = (p.servers || []).map((s) => ({ dep: deps.find((d) => d.id === Number(s.deployment)), port: Number(s.port) })).filter((t) => t.dep && t.port);
  if (!targets.length) throw new Error('Choose at least one server');
  const prog = progressOf(project, hosts, targets);
  const set = (id, patch) => {
    Object.assign(prog.servers.find((x) => x.id === id), patch);
    ctx.progress(prog);
  };
  ctx.progress(prog);
  let failed = 0;
  for (const { dep, port } of targets) {
    set(dep.id, { state: 'running', phase: 'check' });
    ctx.step(`${dep.server_name}: ${hosts.join(', ')} → port ${port}`);
    const state = { ok: false, port, hosts, at: now() };
    let conn = null;
    try {
      const server = getServer(dep.server_id);
      conn = await connectTo(ctx, server);
      const chk = parseCheck((await runRemote(ctx, conn, asRoot(server, checkScript(project.id, port, hosts)), { quiet: true })).stdout, port, hosts);
      if (chk.other.length) {
        const o = chk.other[0];
        const owner = getProject(Number(o.file.match(/\/sb-proj-(\d+)\.conf$/)?.[1]));
        if (owner) throw new Error(`${hosts.join(', ')} is already used by the web proxy of project "${owner.name}" (${o.file} → ${o.to}). Remove it there first.`);
        throw new Error(`${hosts.join(', ')} is already served by ${o.file} (→ ${o.to}). Remove or change that site first (Server → Nginx sites), then try again.`);
      }
      if (!chk.open) {
        ctx.warn(`Nothing answers on port ${port} on ${dep.server_name} yet — visitors will see "502 Bad Gateway" until the app runs`);
        state.note = `nothing on port ${port} yet`;
      }
      if (chk.same.length) {
        ctx.log(`${chk.same.join(', ')} already sends ${hosts.join(', ')} to port ${port} — kept as it is`);
        state.note = 'already set up by another site';
      } else {
        set(dep.id, { phase: 'write' });
        await installHelper(ctx, conn, server);
        await helper(ctx, conn, server, ['edge-site', proxySiteName(project.id), String(port), ...hosts]);
      }
      set(dep.id, { phase: 'test' });
      const t = await runRemote(ctx, conn, asRoot(server, `curl -s -o /dev/null -m 10 -w '%{http_code}' -H ${shq(`Host: ${hosts[0]}`)} http://127.0.0.1/ || true`), { quiet: true });
      const code = Number(t.stdout.trim()) || null;
      state.code = code;
      state.ok = true;
      if (code === 502 || code === 504) ctx.warn(`nginx works, but the app on port ${port} did not answer (HTTP ${code})`);
      else ctx.log(`http://${hosts[0]} on ${dep.server_name} answers HTTP ${code ?? '—'}`);
      set(dep.id, { state: 'success', phase: 'done', code, note: state.note || null });
      if (!dep.app_port) update('deployments', dep.id, { app_port: port });
    } catch (e) {
      failed++;
      state.error = e.message;
      ctx.warn(`${dep.server_name}: ${e.message}`);
      set(dep.id, { state: 'failure', error: e.message });
    } finally {
      conn?.end();
    }
    update('deployments', dep.id, { proxy_state: JSON.stringify(state) });
  }
  update('projects', project.id, { proxy: JSON.stringify({ hosts, at: now() }) });
  logEvent(failed ? 'warn' : 'success', `${project.name}: web proxy ${hosts.join(', ')} on ${targets.length - failed}/${targets.length} servers`, { projectId: project.id, jobId: ctx.id, user: ctx.user });
  bus.emit('state', {});
  if (failed) throw new Error(`The web proxy could not be set up on ${failed} server${failed > 1 ? 's' : ''} — see above`);
});

defineJob('proxy-remove', async (ctx, p) => {
  const project = getProject(Number(p.project));
  if (!project) throw new Error('Project not found');
  const hosts = parseJSON(project.proxy, {})?.hosts || [];
  const targets = deploymentsOf(project.id).filter((d) => d.proxy_state).map((dep) => ({ dep, port: parseJSON(dep.proxy_state, {})?.port || null }));
  const prog = progressOf(project, hosts, targets, true);
  const set = (id, patch) => {
    Object.assign(prog.servers.find((x) => x.id === id), patch);
    ctx.progress(prog);
  };
  ctx.progress(prog);
  let failed = 0;
  for (const { dep } of targets) {
    set(dep.id, { state: 'running', phase: 'write' });
    let conn = null;
    try {
      const server = getServer(dep.server_id);
      conn = await connectTo(ctx, server);
      await installHelper(ctx, conn, server);
      await helper(ctx, conn, server, ['edge-rm', proxySiteName(project.id)]);
      update('deployments', dep.id, { proxy_state: null });
      set(dep.id, { state: 'success', phase: 'done' });
      ctx.log(`${dep.server_name}: web proxy removed`);
    } catch (e) {
      failed++;
      set(dep.id, { state: 'failure', error: e.message });
      ctx.warn(`${dep.server_name}: ${e.message}`);
    } finally {
      conn?.end();
    }
  }
  if (!failed) update('projects', project.id, { proxy: null });
  logEvent('info', `${project.name}: web proxy removed`, { projectId: project.id, jobId: ctx.id, user: ctx.user });
  bus.emit('state', {});
  if (failed) throw new Error(`Could not remove it on ${failed} server${failed > 1 ? 's' : ''}`);
});

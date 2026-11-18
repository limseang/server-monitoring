import fs from 'node:fs';
import { get, insert, tx, update, now } from '../db.js';
import { bus } from '../bus.js';
import { alert, logEvent } from '../events.js';
import { defineJob } from '../jobs.js';
import { getProject, getServer, getDeployment, deploymentsOf } from '../models.js';
import { probe } from '../health.js';
import { fmtBytes, sleep } from '../util.js';
import { connectTo, runRemote, dockerExec, dockerBin, shellScript, shq, asRoot, GIT_NO_WAIT, gitHint } from './remote.js';
import { syncDatabase, backupDeployment, importFromFile, countTables, backupAbsPath, pruneBackups, requireDb } from './database.js';
import { syncFiles, parseSyncPaths } from './files.js';
import { setMaintenance } from './app.js';
import { pointDnsTo, purgeProjectCache, refreshDnsState, dnsTargetProblem } from './dns.js';
import { runClone } from './clone.js';
import { hostAppScript } from './hostapps.js';
import { ownContainerId } from './wipe.js';
import { checkProjectNow, collectMetrics } from '../monitor.js';
import { isLb, addMember, drainMember, moveTraffic, whileDrained, enableLb, disableLb, applyLb, saveRuntime } from './lb.js';
import { setupDbServer, moveDatabase, sharedDbDep, refreshDbFirewall } from './dbserver.js';
import { ensureLocal } from './backupstore.js';
import { runOsUpgrade } from './osupgrade.js';
import { closeForSwitch, openForSwitch, dbAccessOn } from './dbaccess.js';

function mustProject(id) {
  const p = getProject(id);
  if (!p) throw new Error('Project not found (was it deleted?)');
  return p;
}

function mustDep(project, id) {
  const d = getDeployment(Number(id));
  if (!d || d.project_id !== project.id) throw new Error('That server is not part of this project');
  return d;
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '?');

async function healthWithRetry(ctx, project, dep, attempts = 3) {
  let r;
  for (let i = 1; i <= attempts; i++) {
    r = await probe(project, dep);
    if (r.ok) return r;
    if (i < attempts) {
      ctx.log(`  attempt ${i}: ${r.error} — retrying in 3s…`);
      await sleep(3000);
    }
  }
  return r;
}

/* ---------------------------------------------------------------------------
 * SWITCH: move traffic to another server
 *   1. (optional) maintenance ON at the current server so nothing new is written
 *   2. (optional) copy DB (+ files) current → target, with safety backup of target
 *   3. maintenance OFF at the target, health check the target directly
 *   4. update Cloudflare DNS records → target IP
 * Anything failing before step 4 rolls back maintenance mode; DNS stays untouched.
 * ------------------------------------------------------------------------- */
defineJob('switch', async (ctx, p) => {
  const project = mustProject(ctx.job.project_id);
  const target = mustDep(project, p.target);
  if (isLb(project)) {
    // Load balanced: no DNS change, no copy (shared database) — add the target, drain the others.
    ctx.log(`Move traffic of ${project.name} to ${target.server_name} without downtime (load balancer)`);
    await moveTraffic(ctx, project.id, target.id, { force: !!p.force });
    alert('success', `${project.name}: traffic moved to ${target.server_name} (no downtime)`, { projectId: project.id, jobId: ctx.id, user: ctx.user, link: `#/projects/${project.id}` });
    bus.emit('state', { projectId: project.id });
    return;
  }
  const source = deploymentsOf(project.id).find((d) => d.id === project.active_deployment_id) || null;
  if (source && source.id === target.id) throw new Error(`${target.server_name} is already the active server`);
  const dnsProblem = dnsTargetProblem(project, target);
  if (dnsProblem) throw new Error(dnsProblem); // before maintenance mode / copying, so nothing changes
  const link = `#/projects/${project.id}`;
  const hasDb = !!source && source.db_type !== 'none';
  const wantDb = hasDb && !!p.syncDb;
  const wantFiles = !!source && !!p.syncFiles && parseSyncPaths(project.sync_paths).length > 0;
  const wantSync = wantDb || wantFiles;

  ctx.log(`Switch ${project.name}: ${source ? source.server_name : '(no active server)'} → ${target.server_name}${p.auto ? '  [AUTO-FAILOVER]' : ''}`);
  if (hasDb && !wantDb) {
    ctx.warn(`The database will NOT be copied. ${target.server_name} keeps its own data${target.data_at ? ` (as of ${fmtTime(target.data_at)})` : ''}.`);
  }

  let srcConn = null;
  let dstConn = null;
  let srcMaint = false;
  let srcClosed = false;
  let dnsDone = false;
  try {
    if (source && (wantSync || p.maintenance)) srcConn = await connectTo(ctx, getServer(source.server_id), { required: wantSync });
    dstConn = await connectTo(ctx, getServer(target.server_id), { required: wantSync });

    if (srcConn && wantSync && p.maintenance) {
      ctx.step(`Maintenance mode ON at ${source.server_name} (no new writes while copying)`);
      srcMaint = await setMaintenance(ctx, srcConn, project, source, true);
    }
    // Outside database access (another service writing directly into the DB): pause it before copying
    if (wantDb) srcClosed = await closeForSwitch(ctx, srcConn, project, source, 'nothing is written from outside while copying');
    if (wantDb) await syncDatabase(ctx, { project, source, target, srcConn, dstConn, backupTarget: p.backupTarget !== false, sourceLive: true });
    if (wantFiles) await syncFiles(ctx, { project, source, target, srcConn, dstConn });

    if (dstConn) {
      ctx.step(`Make sure ${target.server_name} is live (maintenance OFF)`);
      try {
        await setMaintenance(ctx, dstConn, project, target, false);
      } catch (e) {
        ctx.warn(`Could not turn maintenance off at ${target.server_name}: ${e.message}`);
      }
    }

    ctx.step(`Health check ${target.server_name} directly at ${target.server_ip}`);
    const h = await healthWithRetry(ctx, project, target);
    if (h.ok) ctx.log(`Healthy — HTTP ${h.code} in ${h.ms} ms`);
    else if (p.force) ctx.warn(`${target.server_name} is NOT healthy (${h.error}) — continuing because "force" is on`);
    else throw new Error(`${target.server_name} failed the health check (${h.error}). DNS was not changed.`);

    ctx.throwIfCancelled();
    ctx.step(`Point Cloudflare DNS to ${target.server_name}`);
    await pointDnsTo(ctx, project, target);
    dnsDone = true;

    const at = now();
    tx(() => {
      update('projects', project.id, { active_deployment_id: target.id, last_switch_at: at });
      if (source) {
        update('deployments', source.id, {
          data_at: at,
          data_note: !hasDb || wantDb
            ? `Was active until the switch to ${target.server_name}`
            : `Was active until the switch — has data ${target.server_name} doesn't (no DB copy was done)`,
        });
      }
      update('deployments', target.id, { data_at: null, data_note: null });
    });
    await refreshDnsState(project.id).catch(() => {});
    // Outside database access follows the live server: open the new one, close the old one
    await openForSwitch(ctx, dstConn, project, target);
    if (source && !srcClosed) {
      const c = srcConn || (await connectTo(ctx, getServer(source.server_id), { required: false }));
      if (c) await closeForSwitch(ctx, c, project, source, 'it is a standby now');
      else if (dbAccessOn(project)) ctx.warn(`Could not reach ${source.server_name} to close outside database access — press Apply in the Database access tab when it is back`);
      if (c && c !== srcConn) c.end();
    }

    if (p.purgeCache) {
      ctx.step('Purge Cloudflare cache');
      try {
        const n = await purgeProjectCache(project);
        ctx.log(`Cache purged (${n} zone${n === 1 ? '' : 's'})`);
      } catch (e) {
        ctx.warn(`Cache purge failed: ${e.message}`);
      }
    }
    if (srcMaint && p.keepOldDown === false) {
      ctx.step(`Maintenance mode OFF at ${source.server_name} (it is a standby now)`);
      try {
        await setMaintenance(ctx, srcConn, project, source, false, { signal: null });
      } catch (e) {
        ctx.warn(`Could not turn maintenance off at ${source.server_name}: ${e.message}`);
      }
    } else if (srcMaint) {
      ctx.log(`${source.server_name} stays in maintenance mode so nobody writes to its old database. Turn it off from the dashboard when you need it.`);
    }
    alert(
      'success',
      `${project.name}: traffic switched ${source ? `${source.server_name} → ` : 'to '}${target.server_name}${p.auto ? ' (AUTO-FAILOVER)' : ''}${hasDb && !wantDb ? ' — database was NOT copied' : ''}`,
      { projectId: project.id, jobId: ctx.id, user: ctx.user, link },
    );
  } catch (e) {
    if (srcClosed && !dnsDone && srcConn) await openForSwitch(ctx, srcConn, project, source).catch(() => {});
    if (srcMaint && !dnsDone && srcConn) {
      ctx.step(`Rollback: maintenance OFF at ${source.server_name}`);
      try {
        await setMaintenance(ctx, srcConn, project, source, false, { signal: null });
      } catch (e2) {
        ctx.warn(`Rollback failed: ${e2.message} — turn maintenance off manually!`);
      }
    }
    alert('error', `${project.name}: switch to ${target.server_name} FAILED — ${e.message}`, { projectId: project.id, jobId: ctx.id, user: ctx.user, link });
    throw e;
  } finally {
    srcConn?.end();
    dstConn?.end();
    bus.emit('state', { projectId: project.id });
  }
});

/* ---------------------------------------------------------------------------
 * SYNC: copy database (and/or files) from one server to another
 * ------------------------------------------------------------------------- */
defineJob('sync', async (ctx, p) => {
  const project = mustProject(ctx.job.project_id);
  const source = mustDep(project, p.source);
  const target = mustDep(project, p.target);
  if (source.id === target.id) throw new Error('Source and target are the same server');
  if (project.db_server_id && p.db !== false && !p.files) throw new Error('All servers of this project share one database — there is nothing to copy');
  if (project.db_server_id) p.db = false;
  const link = `#/projects/${project.id}`;
  const sourceLive = project.active_deployment_id === source.id;
  const targetActive = project.active_deployment_id === target.id;
  if (p.scheduled && (!sourceLive || targetActive)) {
    ctx.log('The active server changed since this sync was scheduled — skipped.');
    return;
  }
  if (targetActive && !p.allowActiveTarget) throw new Error(`${target.server_name} is the ACTIVE server now — refusing to overwrite live data without confirmation`);
  const wantDb = p.db !== false && source.db_type !== 'none';
  const wantFiles = !!p.files;
  if (!wantDb && !wantFiles) throw new Error('Nothing to copy (no database configured and files not selected)');

  const what = [wantDb && 'database', wantFiles && 'files'].filter(Boolean).join(' + ');
  ctx.log(`Copy ${what}: ${source.server_name}${sourceLive ? ' (active)' : ''} → ${target.server_name}${targetActive ? ' (ACTIVE!)' : ''}`);
  const srcConn = await connectTo(ctx, getServer(source.server_id));
  let dstConn = null;
  let srcMaint = false;
  let dstMaint = false;
  try {
    dstConn = await connectTo(ctx, getServer(target.server_id));
    if (p.maintenance && sourceLive) {
      ctx.step(`Maintenance mode ON at ${source.server_name} during the copy`);
      srcMaint = await setMaintenance(ctx, srcConn, project, source, true);
    }
    if (p.maintenance && targetActive) {
      ctx.step(`Maintenance mode ON at ${target.server_name} while its data is replaced`);
      dstMaint = await setMaintenance(ctx, dstConn, project, target, true);
    }
    let info = null;
    if (wantDb) info = await syncDatabase(ctx, { project, source, target, srcConn, dstConn, backupTarget: p.backupTarget !== false, sourceLive });
    if (wantFiles) await syncFiles(ctx, { project, source, target, srcConn, dstConn });
    logEvent('success', `${project.name}: copied ${what} ${source.server_name} → ${target.server_name}${info ? ` (${info.tables} tables, ${fmtBytes(info.size)})` : ''}`, {
      projectId: project.id,
      jobId: ctx.id,
      user: ctx.user,
    });
  } catch (e) {
    alert('error', `${project.name}: copy ${source.server_name} → ${target.server_name} FAILED — ${e.message}`, { projectId: project.id, jobId: ctx.id, user: ctx.user, link });
    throw e;
  } finally {
    if (srcMaint) {
      ctx.step(`Maintenance mode OFF at ${source.server_name}`);
      try {
        await setMaintenance(ctx, srcConn, project, source, false, { signal: null });
      } catch (e) {
        ctx.warn(`Could not turn maintenance off at ${source.server_name}: ${e.message} — do it manually!`);
      }
    }
    if (dstMaint) {
      ctx.step(`Maintenance mode OFF at ${target.server_name}`);
      try {
        await setMaintenance(ctx, dstConn, project, target, false, { signal: null });
      } catch (e) {
        ctx.warn(`Could not turn maintenance off at ${target.server_name}: ${e.message} — do it manually!`);
      }
    }
    srcConn.end();
    dstConn?.end();
    bus.emit('state', { projectId: project.id });
  }
});

/* --------------------------------------------------------------------------- BACKUP */
defineJob('backup', async (ctx, p) => {
  const project = mustProject(ctx.job.project_id);
  const dep = p.shared ? sharedDbDep(project) : mustDep(project, p.deployment);
  if (!dep) throw new Error('This project has no shared database');
  requireDb(dep);
  const conn = await connectTo(ctx, getServer(dep.server_id));
  try {
    ctx.step(`Back up the ${dep.db_type === 'postgres' ? 'PostgreSQL' : 'MySQL/MariaDB'} database on ${dep.server_name}`);
    const b = await backupDeployment(ctx, conn, project, dep, p.kind || 'manual', p.note);
    pruneBackups(project);
    logEvent('success', `${project.name}: backup #${b.id} of ${dep.server_name} (${fmtBytes(b.size)})`, { projectId: project.id, jobId: ctx.id, user: ctx.user });
  } catch (e) {
    alert('error', `${project.name}: backup of ${dep.server_name} FAILED — ${e.message}`, { projectId: project.id, jobId: ctx.id, link: `#/projects/${project.id}` });
    throw e;
  } finally {
    conn.end();
    bus.emit('state', { projectId: project.id });
  }
});

/* --------------------------------------------------------------------------- RESTORE */
defineJob('restore', async (ctx, p) => {
  const project = mustProject(ctx.job.project_id);
  const backup = get('SELECT * FROM backups WHERE id = ? AND project_id = ?', Number(p.backup), project.id);
  if (!backup) throw new Error('Backup not found');
  const file = await ensureLocal(backup, ctx); // downloads it from S3 when it isn't on this machine
  const target = p.target === 'shared' ? sharedDbDep(project) : mustDep(project, p.target);
  if (!target) throw new Error('This project has no shared database');
  requireDb(target);
  if ((backup.db_type === 'postgres') !== (target.db_type === 'postgres')) throw new Error(`Backup is ${backup.db_type} but ${target.server_name} uses ${target.db_type}`);
  const targetActive = p.target === 'shared' || project.active_deployment_id === target.id;
  if (targetActive && !p.allowActiveTarget) throw new Error(`${target.server_name} is the ACTIVE server — refusing to overwrite live data without confirmation`);
  const server = getServer(target.server_id);
  const conn = await connectTo(ctx, server);
  let maint = false;
  try {
    if (targetActive && p.maintenance && target.id) {
      ctx.step(`Maintenance mode ON at ${target.server_name}`);
      maint = await setMaintenance(ctx, conn, project, target, true);
    }
    let safety = null;
    if (p.backupFirst !== false) {
      ctx.step(`Safety backup of the current database on ${target.server_name}`);
      safety = await backupDeployment(ctx, conn, project, target, 'pre-restore', `Before restoring backup #${backup.id}`);
    }
    ctx.step(`Restore backup #${backup.id} (from ${backup.server_name}, ${fmtTime(backup.created_at)}) into ${target.server_name}`);
    try {
      await importFromFile(ctx, conn, server, target, file);
      const n = await countTables(conn, server, target);
      if (backup.tables != null && n !== backup.tables) throw new Error(`Verification failed: the backup had ${backup.tables} tables, the database now has ${n}`);
      ctx.log(`Verified: ${n} tables ✓`);
    } catch (e) {
      if (safety) {
        ctx.step(`Restore failed — putting back the safety backup #${safety.id}`);
        try {
          await importFromFile(ctx, conn, server, target, safety.path, { signal: null });
          ctx.log(`${target.server_name} is back to how it was before.`);
        } catch (e2) {
          ctx.warn(`Putting back the safety backup failed too: ${e2.message}`);
        }
      }
      throw e;
    }
    if (!targetActive && target.id) update('deployments', target.id, { data_at: backup.created_at, data_note: `Restored from backup #${backup.id}` });
    pruneBackups(project);
    logEvent('warn', `${project.name}: backup #${backup.id} restored into ${target.server_name}`, { projectId: project.id, jobId: ctx.id, user: ctx.user });
  } catch (e) {
    alert('error', `${project.name}: restore into ${target.server_name} FAILED — ${e.message}`, { projectId: project.id, jobId: ctx.id, link: `#/projects/${project.id}` });
    throw e;
  } finally {
    if (maint) {
      ctx.step(`Maintenance mode OFF at ${target.server_name}`);
      try {
        await setMaintenance(ctx, conn, project, target, false, { signal: null });
      } catch (e) {
        ctx.warn(`Could not turn maintenance off: ${e.message} — do it manually!`);
      }
    }
    conn.end();
    bus.emit('state', { projectId: project.id });
  }
});

/* --------------------------------------------------------------------------- DEPLOY */
defineJob('deploy', async (ctx, p) => {
  const project = mustProject(ctx.job.project_id);
  const script = String(project.deploy_script || '').trim();
  if (!script) throw new Error('No deploy script set for this project (Project → Settings → Deploy script)');
  const isActive = (d) => (d.id === project.active_deployment_id ? 1 : 0);
  // Deploy standby servers first, the live one last.
  const targets = p.all ? deploymentsOf(project.id).sort((a, b) => isActive(a) - isActive(b)) : [mustDep(project, p.deployment)];
  try {
    const lb = isLb(project);
    if (lb && targets.length > 1) ctx.log('Load balanced: rolling deploy — one server at a time is taken out, deployed and put back, so visitors are never cut off');
    for (const dep of targets) {
      const run1 = async () => {
        ctx.step(`Deploy on ${dep.server_name}${isActive(dep) ? ' (active)' : ''}`);
        if (!dep.app_dir) ctx.warn(`${dep.server_name}: no app directory set — running in the SSH user's home directory`);
        const conn = await connectTo(ctx, getServer(dep.server_id));
        try {
          // A deploy started from GitHub (pull mode) passes the exact commit, like the runner does.
          const env = /^[0-9a-f]{7,40}$/.test(String(p.commit || '')) ? `export SB_COMMIT=${p.commit}; export SB_BRANCH=${shq(project.git_branch || 'main')}\n` : '';
          if (env) ctx.log(`Commit ${p.commit.slice(0, 7)} (${project.git_branch})`);
          // git never waits for a login/passphrase/host-key answer or a dead network (it fails with a hint instead).
          try {
            await runRemote(ctx, conn, shellScript(env + script, { cwd: dep.app_dir, strict: true, prelude: GIT_NO_WAIT }), { timeout: 60 * 60000 });
          } catch (e) {
            const hint = gitHint(`${e.result?.stderr || ''}\n${e.result?.stdout || ''}\n${e.message}`);
            if (hint) {
              ctx.warn(hint);
              e.message = `${e.message} — ${hint}`;
            }
            throw e;
          }
        } finally {
          conn.end();
        }
        const h = await probe(project, dep);
        if (h.ok) ctx.log(`Health after deploy: HTTP ${h.code} in ${h.ms} ms ✓`);
        else ctx.warn(`Health after deploy: ${h.error}`);
      };
      if (lb) await whileDrained(ctx, project.id, getDeployment(dep.id), run1);
      else await run1();
    }
    logEvent('success', `${project.name}: deployed on ${targets.map((d) => d.server_name).join(', ')}`, { projectId: project.id, jobId: ctx.id, user: ctx.user });
  } catch (e) {
    alert('error', `${project.name}: deploy FAILED — ${e.message}`, { projectId: project.id, jobId: ctx.id, link: `#/projects/${project.id}` });
    throw e;
  }
});

/* --------------------------------------------------------------------------- COMMAND */
defineJob('command', async (ctx, p) => {
  const command = String(p.command || '').trim();
  if (!command) throw new Error('Empty command');
  let server;
  let cmd;
  let where;
  if (p.deployment) {
    const dep = getDeployment(Number(p.deployment));
    if (!dep) throw new Error('Server not found in project');
    server = getServer(dep.server_id);
    if (p.where === 'app') {
      if (!dep.app_container) throw new Error(`No app container set for ${dep.server_name}`);
      cmd = dockerExec(server, dep.app_container, command);
      where = `container ${dep.app_container}`;
    } else {
      cmd = shellScript(command, { cwd: dep.app_dir });
      where = dep.app_dir || 'home directory';
    }
  } else {
    server = getServer(Number(p.server));
    if (!server) throw new Error('Server not found');
    cmd = shellScript(command, { cwd: p.cwd || undefined });
    where = p.cwd || 'home directory';
  }
  ctx.log(`${server.name} · ${where}`);
  for (const line of command.split('\n')) ctx.log(`$ ${line}`);
  const conn = await connectTo(ctx, server);
  try {
    await runRemote(ctx, conn, cmd, { timeout: (Number(p.timeout) || 900) * 1000 });
  } finally {
    conn.end();
  }
});

/* --------------------------------------------------------------------------- CONTAINER */
defineJob('container', async (ctx, p) => {
  const server = getServer(Number(p.server));
  if (!server) throw new Error('Server not found');
  const verbs = { restart: 'restarted', stop: 'stopped', start: 'started', rm: 'deleted' };
  if (!verbs[p.action]) throw new Error('Unknown container action');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(String(p.container || ''))) throw new Error('Invalid container name');
  const D = dockerBin(server);
  const conn = await connectTo(ctx, server);
  try {
    if (p.action === 'rm') {
      ctx.step(`Delete container ${p.container} on ${server.name} (docker rm -f — its data volumes are kept)`);
      const info = await runRemote(ctx, conn, `${D} inspect -f '{{.Id}} {{index .Config.Labels "com.docker.compose.project"}}' ${shq(p.container)}`, { quiet: true, timeout: 30000 });
      const [id, project] = info.stdout.trim().split(' ');
      const me = ownContainerId();
      if (me && (id === me || (me.length === 12 && id.startsWith(me)))) throw new Error(`${p.container} is this Switchboard itself — it can't delete its own container`);
      await runRemote(ctx, conn, `${D} rm -f ${shq(p.container)}`, { timeout: 180000 });
      if (project) ctx.log(`It belonged to the Docker Compose project "${project}": "docker compose up" (or Deploy) creates it again. To remove it for good, take the service out of its docker-compose.yml.`);
    } else {
      ctx.step(`docker ${p.action} ${p.container} on ${server.name}`);
      await runRemote(ctx, conn, `${D} ${p.action} ${shq(p.container)}`, { timeout: 180000 });
    }
  } finally {
    conn.end();
  }
  logEvent(p.action === 'rm' ? 'warn' : 'info', `${server.name}: container ${p.container} ${verbs[p.action]}`, { serverId: server.id, jobId: ctx.id, user: ctx.user });
  if (p.action === 'rm') {
    await collectMetrics(getServer(server.id)).catch(() => {});
    bus.emit('state', { serverId: server.id });
  }
});

/* --------------------------------------------------------------------------- MAINTENANCE */
defineJob('maintenance', async (ctx, p) => {
  const project = mustProject(ctx.job.project_id);
  const dep = mustDep(project, p.deployment);
  const conn = await connectTo(ctx, getServer(dep.server_id));
  try {
    ctx.step(`Maintenance mode ${p.on ? 'ON' : 'OFF'} at ${dep.server_name}`);
    const done = await setMaintenance(ctx, conn, project, dep, !!p.on);
    if (!done) throw new Error('The maintenance command could not run (see the log above)');
  } finally {
    conn.end();
  }
  logEvent(p.on ? 'warn' : 'info', `${project.name}: maintenance mode ${p.on ? 'ON' : 'OFF'} at ${dep.server_name}`, { projectId: project.id, jobId: ctx.id, user: ctx.user });
});

/* --------------------------------------------------------------------------- LOAD BALANCER */
const lbJob = (name, fn) =>
  defineJob(name, async (ctx, p) => {
    const project = mustProject(ctx.job.project_id);
    try {
      await fn(ctx, project, p);
    } catch (e) {
      saveRuntime(project.id, { error: e.message });
      alert('error', `${project.name}: ${ctx.job.title} FAILED — ${e.message}`, { projectId: project.id, jobId: ctx.id, user: ctx.user, link: `#/projects/${project.id}` });
      throw e;
    } finally {
      bus.emit('state', { projectId: project.id });
    }
  });

lbJob('lb-enable', async (ctx, project, p) => {
  await enableLb(ctx, project.id, p);
  alert('success', `${project.name}: load balancing is on (${p.provider === 'cloudflare' ? 'Cloudflare' : 'own nginx'})`, { projectId: project.id, jobId: ctx.id, user: ctx.user, link: `#/projects/${project.id}` });
});

lbJob('lb-disable', async (ctx, project, p) => {
  await disableLb(ctx, project.id, Number(p.target), { force: !!p.force });
  const t = getDeployment(Number(p.target));
  alert('warn', `${project.name}: load balancing is off — ${t?.server_name} is the only live server`, { projectId: project.id, jobId: ctx.id, user: ctx.user, link: `#/projects/${project.id}` });
});

lbJob('lb-member', async (ctx, project, p) => {
  const dep = mustDep(project, p.deployment);
  if (p.action === 'add') await addMember(ctx, project.id, dep.id, { force: !!p.force });
  else if (p.action === 'drain') await drainMember(ctx, project.id, dep.id, { force: !!p.force });
  else if (p.action === 'weight') {
    update('deployments', dep.id, { lb_weight: Math.max(1, Math.min(100, Number(p.weight) || 1)) });
    await applyLb(ctx, project.id);
  } else throw new Error('Unknown action');
  logEvent('info', `${project.name}: ${dep.server_name} ${p.action === 'add' ? 'added to' : p.action === 'drain' ? 'taken out of' : 'weight changed in'} the load balancer`, { projectId: project.id, jobId: ctx.id, user: ctx.user });
});

/** Automatic: health changed (own nginx) → re-apply who gets visitors. */
lbJob('lb-apply', async (ctx, project) => {
  if (!isLb(project)) return;
  await applyLb(ctx, project.id);
});

/** Add a spare server: clone the app from a healthy live server (optional), then add it to the pool. */
lbJob('scale-out', async (ctx, project, p) => {
  if (!isLb(project)) throw new Error('Turn on load balancing first');
  const spare = getServer(Number(p.server));
  if (!spare) throw new Error('Server not found');
  let dep = deploymentsOf(project.id).find((d) => d.server_id === spare.id);
  const source = mustDep(project, p.source || project.active_deployment_id);
  if (p.clone !== false) {
    ctx.step(`Clone ${source.server_name} → ${spare.name} (apps, files, settings — the database is shared, so nothing is paused)`);
    await runClone(ctx, { source: source.server_id, target: spare.id, freeze: false, replace: !!p.replace, host: true, hostApps: true, installDocker: true, addToProjects: false });
  }
  if (!dep) {
    const id = insert('deployments', {
      project_id: project.id,
      server_id: spare.id,
      priority: source.priority + 1,
      app_dir: source.app_dir,
      app_container: source.app_container,
      db_type: source.db_type,
      db_container: source.db_container,
      db_name: source.db_name,
      db_user: source.db_user,
      db_password: source.db_password,
      lb_state: 'off',
      lb_weight: source.lb_weight || 1,
      health: 'unknown',
      data_at: null,
      data_note: project.db_server_id ? 'Uses the shared database' : `Cloned from ${source.server_name}`,
      created_at: now(),
    });
    dep = getDeployment(id);
    ctx.log(`${spare.name} added to ${project.name}`);
  }
  if (project.db_server_id) {
    ctx.step('Let the new server through the database firewall');
    await refreshDbFirewall(ctx, project.db_server_id, [spare.id]);
  }
  await addMember(ctx, project.id, dep.id, { force: !!p.force });
  alert('success', `${project.name}: ${spare.name} added — the load balancer now spreads visitors over ${deploymentsOf(project.id).filter((d) => d.lb_state === 'active').length} servers`, {
    projectId: project.id,
    jobId: ctx.id,
    user: ctx.user,
    link: `#/projects/${project.id}`,
  });
});

/* --------------------------------------------------------------------------- OS UPGRADE */
defineJob('os-upgrade', async (ctx, p) => {
  const server = getServer(Number(p.server));
  try {
    const r = await runOsUpgrade(ctx, p);
    alert(r.bad ? 'warn' : 'success', `${server.name}: OS upgraded ${r.from} → ${r.to}${r.bad ? ` — ${r.bad} project(s) not healthy yet, check them` : ''}`, { serverId: server.id, jobId: ctx.id, user: ctx.user, link: `#/servers/${server.id}` });
  } catch (e) {
    alert('error', `${server?.name || '?'}: OS upgrade FAILED — ${e.message}`, { serverId: server?.id, jobId: ctx.id, user: ctx.user, link: server ? `#/servers/${server.id}` : undefined });
    throw e;
  } finally {
    if (server) await collectMetrics(server).catch(() => {});
    bus.emit('state', { serverId: server?.id });
  }
});

/* --------------------------------------------------------------------------- DATABASE SERVER */
defineJob('dbserver-setup', async (ctx, p) => {
  const server = getServer(Number(p.server));
  try {
    await setupDbServer(ctx, p);
    alert('success', `${server?.name}: database server is ready (${p.engine}${p.redis !== false ? ' + Redis' : ''})`, { serverId: server?.id, jobId: ctx.id, user: ctx.user, link: `#/servers/${server?.id}` });
  } catch (e) {
    alert('error', `Database server setup on ${server?.name || '?'} FAILED — ${e.message}`, { serverId: server?.id, jobId: ctx.id, user: ctx.user });
    throw e;
  } finally {
    bus.emit('state', {});
  }
});

lbJob('db-move', async (ctx, project, p) => {
  await moveDatabase(ctx, project.id, p);
  alert('success', `${project.name}: database moved to the database server — every server now uses the same data`, { projectId: project.id, jobId: ctx.id, user: ctx.user, link: `#/projects/${project.id}` });
});

/* --------------------------------------------------------------------------- APP OUTSIDE DOCKER */
defineJob('hostapp', async (ctx, p) => {
  const server = getServer(Number(p.server));
  if (!server) throw new Error('Server not found');
  const script = hostAppScript(p);
  const verbs = { restart: 'restarted', stop: 'stopped', start: 'started' };
  ctx.step(`${p.type === 'pm2' ? `pm2 ${p.action} ${p.name} (user ${p.user})` : `systemctl ${p.action} ${p.name}`} on ${server.name}`);
  const conn = await connectTo(ctx, server);
  try {
    await runRemote(ctx, conn, asRoot(server, script), { timeout: 180000 });
  } finally {
    conn.end();
  }
  logEvent('info', `${server.name}: ${p.type === 'pm2' ? 'PM2 app' : 'service'} ${p.name} ${verbs[p.action]}`, { serverId: server.id, jobId: ctx.id, user: ctx.user });
});

/* --------------------------------------------------------------------------- CLONE SERVER */
defineJob('clone', async (ctx, p) => {
  const src = getServer(Number(p.source));
  const dst = getServer(Number(p.target));
  try {
    const r = await runClone(ctx, p, {
      onProjectsAdded: async (ids) => {
        for (const id of ids) {
          bus.emit('state', { projectId: id });
          await refreshDnsState(id).catch(() => {});
          await checkProjectNow(id).catch(() => {});
        }
      },
    });
    alert(r.bad ? 'warn' : 'success', `Server ${src.name} cloned to ${dst.name} (${r.stacks} stack(s), ${fmtBytes(r.bytes)})${r.bad ? ` — ${r.bad} container(s) need a look` : ''}`, {
      serverId: dst.id,
      jobId: ctx.id,
      user: ctx.user,
      link: `#/servers/${dst.id}`,
    });
  } catch (e) {
    alert('error', `Clone ${src?.name || '?'} → ${dst?.name || '?'} FAILED — ${e.message}`, { serverId: dst?.id, jobId: ctx.id, user: ctx.user, link: dst ? `#/servers/${dst.id}` : undefined });
    throw e;
  } finally {
    bus.emit('state', { serverId: dst?.id });
  }
});

/* --------------------------------------------------------------------------- DNS (fix drift) */
defineJob('dns', async (ctx) => {
  const project = mustProject(ctx.job.project_id);
  if (isLb(project) && project.lb_provider === 'own') {
    const lbs = getServer(project.lb_server_id);
    ctx.step(`Point Cloudflare DNS to the load balancer ${lbs.name}`);
    const n = await pointDnsTo(ctx, project, { server_name: lbs.name, server_ip: lbs.ip, server_ipv6: lbs.ipv6 });
    await refreshDnsState(project.id);
    logEvent('info', `${project.name}: DNS pointed to the load balancer ${lbs.name} (${n} record${n === 1 ? '' : 's'} changed)`, { projectId: project.id, jobId: ctx.id, user: ctx.user });
    return;
  }
  const active = project.active_deployment_id ? getDeployment(project.active_deployment_id) : null;
  if (!active) throw new Error('No active server set for this project');
  // Never send visitors to a server that doesn't answer (this button skips the checks a switch does).
  const problem = dnsTargetProblem(project, active);
  if (problem) throw new Error(problem);
  ctx.step(`Health check ${active.server_name} before touching DNS`);
  const h = await healthWithRetry(ctx, project, active);
  if (!h.ok) {
    throw new Error(
      `${active.server_name} does not answer its health check (${h.error}) — DNS was NOT changed, so the site stays where it is. ` +
        `Fix the server first, or mark the server that really serves the site as live.`,
    );
  }
  ctx.log(`${active.server_name} answers: HTTP ${h.code} in ${h.ms} ms ✓`);
  ctx.step(`Point Cloudflare DNS to the active server ${active.server_name}`);
  const n = await pointDnsTo(ctx, project, active);
  await refreshDnsState(project.id);
  logEvent('info', `${project.name}: DNS pointed to ${active.server_name} (${n} record${n === 1 ? '' : 's'} changed)`, { projectId: project.id, jobId: ctx.id, user: ctx.user });
});

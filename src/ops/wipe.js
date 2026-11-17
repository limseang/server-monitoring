/**
 * WIPE — remove things from servers for real (not only from Switchboard).
 *
 *  • remove-deployment: take one project off one server — DB backup first, then its Docker
 *    containers/volumes/networks, its PM2/systemd apps, the web proxy site and its folder.
 *  • project-delete:    the same on every server of a project, then delete the project. The final
 *    backups are kept in <backups>/_deleted/ so the data can still be brought back.
 *  • server-reset:      make a server like freshly installed: every container, volume, image,
 *    compose folder, app outside Docker (PM2, systemd, nginx sites), crontab, GitHub runner and
 *    Switchboard's own files go. The OS, users, SSH access and Docker itself stay, so the server
 *    can be cloned to / provisioned again right away. Changed /etc files are saved in a
 *    /root/switchboard-reset-<date>.tar.gz first.
 *
 * Every folder that gets deleted goes through safeDir(): system folders, home folders and
 * top-level folders are never deleted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { all, run, now } from '../db.js';
import { bus } from '../bus.js';
import { alert, logEvent } from '../events.js';
import { defineJob } from '../jobs.js';
import { getProject, getServer, getDeployment, deploymentsOf, deploymentsOnServer } from '../models.js';
import { fmtBytes } from '../util.js';
import * as gh from '../github.js';
import { connectTo, runRemote, asRoot, shq } from './remote.js';
import { backupDeployment } from './database.js';
import { removeBackupFiles } from './backupstore.js';
import { scanServer, buildStacks, rootDocker } from './clone.js';
import { detectHostApps, appFolders, PM2RUN } from './hostapps.js';
import { sharedDbDep } from './dbserver.js';
import { serverRoles } from './serverctl.js';
import { RUNNER_USER } from './ci.js';
import { HELPER } from './stack.js';
import { reloadSchedules, collectMetrics } from '../monitor.js';

/* ------------------------------------------------------------------ safety */

/** Folders that are part of the OS — never deleted, nor anything inside them. */
const PROTECTED = /^\/(bin|boot|dev|etc|lib|lib32|lib64|libx32|proc|run|sbin|sys|usr|snap|var\/(lib|log|run|cache|spool|mail|backups|tmp))(\/|$)/;
const UNIT_SKIP = /^(cloud|snap|docker|containerd|getty|serial-getty|ssh|sshd|netplan|systemd-|network|dbus|display-manager|.*@)/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SAFE_USER = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const SAFE_UNIT = /^[A-Za-z0-9_.@-]{1,100}\.(service|timer)$/;

/**
 * May this path be deleted with rm -rf? Only app-like paths at least two levels deep:
 * /srv/shop, /opt/app, /var/www/site, /home/deploy/shop, /root/app — never /, /home,
 * /home/deploy, /var/www, /etc/…, /usr/…, a user's home folder.
 */
export function safeDir(p, homes = []) {
  if (typeof p !== 'string' || !p.startsWith('/') || /[\0\n\r]/.test(p) || /(^|\/)\.\.?(\/|$)/.test(p)) return false;
  const c = p.replace(/\/+$/, '');
  if (!c || PROTECTED.test(c)) return false;
  const depth = c.split('/').filter(Boolean).length;
  if (depth < 2) return false;
  if (/^\/(home|var)\/[^/]+$/.test(c)) return false;
  if (homes.some((h) => h && h.replace(/\/+$/, '') === c)) return false;
  return true;
}

/** The Docker container ID this Switchboard runs in, or '' when it does not run in a container. */
let ownId;
export function ownContainerId() {
  if (ownId !== undefined) return ownId;
  ownId = '';
  try {
    const m = fs.readFileSync('/proc/self/mountinfo', 'utf8').match(/\/(?:docker\/containers|overlay-containers)\/([0-9a-f]{64})\//);
    if (m) ownId = m[1];
  } catch {}
  if (!ownId && /^[0-9a-f]{12}$/.test(os.hostname())) ownId = os.hostname(); // Docker's default hostname = short ID
  return ownId;
}

const cname = (c) => String(c.Name || '').replace(/^\//, '');

/**
 * Switchboard containers on a server:
 *   self   — THIS dashboard (same container ID): wiping that server would delete the dashboard doing it
 *   others — other Switchboard installs there (by container/image name): they get erased too
 */
export function switchboardContainers(containers) {
  const me = ownContainerId();
  const isMe = (c) => !!me && !!c.Id && (c.Id === me || (me.length === 12 && c.Id.startsWith(me)));
  const looksLike = (c) => {
    const name = cname(c);
    if (name === 'switchboard-edge') return false; // the helper's web proxy, not a dashboard
    const image = (c.Config?.Image || '').replace(/^.*\//, '');
    // Image "switchboard" (this repo's compose) or "<compose project>-switchboard" (built by Compose).
    return name === 'switchboard' || /^([^:]*[_-])?switchboard(:|$)/i.test(image);
  };
  return { self: containers.filter(isMe).map(cname), others: containers.filter((c) => !isMe(c) && looksLike(c)).map(cname) };
}

const lines = (s) =>
  String(s || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

async function root(ctx, conn, server, script, opts = {}) {
  return (await runRemote(ctx, conn, asRoot(server, script), { timeout: 10 * 60000, ...opts })).stdout;
}

const quietCtx = () => ({ log() {}, warn() {}, step() {}, output() {}, signal: new AbortController().signal, throwIfCancelled() {} });

/* ------------------------------------------------------------------ one project on one server */

export async function inspectAll(ctx, conn, server) {
  const D = rootDocker(server);
  const out = await root(ctx, conn, server, `command -v ${D.split(' ')[0]} >/dev/null 2>&1 || { echo '[]'; exit 0; }; ids=$(${D} ps -aq); if [ -n "$ids" ]; then ${D} inspect $ids; else echo '[]'; fi`, { quiet: true, timeout: 60000 });
  try {
    return JSON.parse(out || '[]');
  } catch {
    return [];
  }
}

/** Compose project + labels of the containers that belong to a deployment. */
function stackOf(containers, dep) {
  const dir = String(dep.app_dir || '').replace(/\/+$/, '');
  const named = new Set([dep.app_container, dep.db_container].filter(Boolean));
  const projects = new Set();
  const loose = [];
  for (const c of containers) {
    const name = String(c.Name || '').replace(/^\//, '');
    const l = c.Config?.Labels || {};
    const proj = l['com.docker.compose.project'];
    const wd = String(l['com.docker.compose.project.working_dir'] || '').replace(/\/+$/, '');
    if (proj && ((dir && wd === dir) || named.has(name))) projects.add(proj);
    else if (!proj && named.has(name)) loose.push(name);
  }
  const members = containers.filter((c) => projects.has(c.Config?.Labels?.['com.docker.compose.project']) || loose.includes(String(c.Name || '').replace(/^\//, '')));
  return {
    projects: [...projects],
    loose,
    containers: members.map((c) => String(c.Name || '').replace(/^\//, '')),
    images: [...new Set(members.map((c) => c.Image).filter(Boolean))],
  };
}

/** What removing this project from this server would delete. Changes nothing. */
export async function planRemoval(ctx, conn, server, project, dep) {
  const containers = await inspectAll(ctx, conn, server);
  const st = stackOf(containers, dep);
  const warnings = [];
  // Another project on this server using the same compose stack or folder → leave it alone.
  const others = deploymentsOnServer(server.id).filter((d) => d.id !== dep.id);
  const shared = others.filter((o) => {
    const os = stackOf(containers, o);
    return os.projects.some((p) => st.projects.includes(p)) || (dep.app_dir && o.app_dir === dep.app_dir);
  });
  if (shared.length) {
    const names = shared.map((o) => getProject(o.project_id)?.name || '?').join(', ');
    warnings.push(`The same containers/folder are also used by: ${names} — they are kept.`);
  }
  const host = await detectHostApps(ctx, conn, server).catch(() => null);
  const dir = String(dep.app_dir || '').replace(/\/+$/, '');
  const under = (p) => !!dir && (p === dir || String(p || '').startsWith(`${dir}/`));
  const pm2 = host
    ? host.pm2.flatMap((u) => u.list.filter((p) => under(p.pm2_env?.pm_cwd) || under(p.pm2_env?.pm_exec_path)).map((p) => ({ user: u.user, name: p.name })))
    : [];
  const services = host ? host.services.filter((s) => under(s.cwd)).map((s) => s.name) : [];
  const homes = host ? host.pm2.map((u) => u.home) : [];
  let folder = dir || null;
  if (folder && !safeDir(folder, homes)) {
    warnings.push(`The folder ${folder} is a system or home folder — it is kept.`);
    folder = null;
  }
  if (shared.length) {
    folder = null;
    st.projects = [];
    st.loose = [];
    st.containers = [];
    st.images = [];
  }
  const outside = [
    ...new Set(
      containers
        .filter((c) => st.containers.includes(String(c.Name || '').replace(/^\//, '')))
        .flatMap((c) => (c.Mounts || []).filter((m) => m.Type === 'bind' && m.Source && !under(m.Source) && safeDir(m.Source, homes)).map((m) => m.Source)),
    ),
  ];
  if (outside.length) warnings.push(`Kept folders outside ${dir || 'the app folder'} (may be shared — delete them by hand if not): ${outside.join(', ')}`);
  if (!st.containers.length && !pm2.length && !services.length) warnings.push(`No containers or apps of ${project.name} were found on ${server.name}.`);
  return { ...st, pm2, services, folder, slug: project.slug, warnings };
}

/** Delete what planRemoval found. */
export async function removeFromServer(ctx, conn, server, plan) {
  const D = rootDocker(server);
  const cmds = ['set +e'];
  for (const p of plan.projects) {
    const f = shq(`label=com.docker.compose.project=${p}`);
    cmds.push(
      `echo ">>> Docker stack ${p}: containers, volumes, networks"`,
      `ids=$(${D} ps -aq --filter ${f}); [ -n "$ids" ] && ${D} rm -f $ids >/dev/null`,
      `v=$(${D} volume ls -q --filter ${f}); [ -n "$v" ] && ${D} volume rm -f $v`,
      `n=$(${D} network ls -q --filter ${f}); [ -n "$n" ] && ${D} network rm $n >/dev/null`,
    );
  }
  for (const c of plan.loose) cmds.push(`echo ">>> Container ${c}"`, `${D} rm -f ${shq(c)} >/dev/null`);
  if (plan.images.length) cmds.push(`echo '>>> Images no other container uses'`, `for i in ${plan.images.map(shq).join(' ')}; do ${D} rmi "$i" >/dev/null 2>&1 && echo "  removed $i"; done`);
  if (plan.pm2.length) {
    cmds.push(PM2RUN);
    for (const a of plan.pm2) {
      if (!SAFE_USER.test(a.user)) continue;
      cmds.push(`echo ">>> PM2 app ${a.name} (${a.user})"`, `pm2run ${shq(a.user)} ${shq(`delete ${shq(a.name)}`)} >/dev/null && pm2run ${shq(a.user)} 'save --force' >/dev/null`);
    }
  }
  for (const s of plan.services) {
    if (!SAFE_UNIT.test(s)) continue;
    cmds.push(`echo ">>> systemd service ${s}"`, `systemctl disable --now ${shq(s)} >/dev/null 2>&1; rm -f ${shq(`/etc/systemd/system/${s}`)}; systemctl daemon-reload 2>/dev/null`);
  }
  if (SAFE_SLUG.test(plan.slug)) {
    const b = `/etc/switchboard`;
    cmds.push(
      `if [ -f ${b}/projects/${plan.slug}.conf ] || [ -f ${b}/ports/${plan.slug} ]; then echo '>>> Switchboard web proxy site and settings'; [ -x ${HELPER} ] && ${HELPER} edge-rm ${plan.slug} >/dev/null 2>&1; rm -f ${b}/projects/${plan.slug}.conf ${b}/projects/${plan.slug}.deploy.sh ${b}/ports/${plan.slug}; fi`,
    );
  }
  if (plan.folder && safeDir(plan.folder)) cmds.push(`if [ -e ${shq(plan.folder)} ]; then echo ">>> Folder ${plan.folder} ($(du -sh ${shq(plan.folder)} 2>/dev/null | cut -f1))"; rm -rf -- ${shq(plan.folder)}; fi`);
  cmds.push('true');
  await root(ctx, conn, server, cmds.join('\n'));
}

/** Backup (when there is a database), then remove. Throws before deleting anything if the backup fails. */
async function backupAndRemove(ctx, project, dep, { backup }) {
  const server = getServer(dep.server_id);
  const conn = await connectTo(ctx, server);
  try {
    let saved = null;
    if (backup && dep.db_type !== 'none' && !sharedDbDep(project)) {
      ctx.step(`Back up the database of ${project.name} on ${server.name}`);
      saved = await backupDeployment(ctx, conn, project, dep, 'manual', `Before removing ${project.name} from ${server.name}`);
    }
    ctx.step(`Find what ${project.name} has on ${server.name}`);
    const plan = await planRemoval(ctx, conn, server, project, dep);
    for (const w of plan.warnings) ctx.warn(w);
    ctx.log(`Containers: ${plan.containers.join(', ') || 'none'}`);
    if (plan.pm2.length) ctx.log(`PM2 apps: ${plan.pm2.map((a) => a.name).join(', ')}`);
    if (plan.services.length) ctx.log(`systemd services: ${plan.services.join(', ')}`);
    ctx.log(`Folder: ${plan.folder || 'none'}`);
    ctx.throwIfCancelled();
    ctx.step(`Remove ${project.name} from ${server.name}`);
    await removeFromServer(ctx, conn, server, plan);
    return saved;
  } finally {
    conn.end();
  }
}

/* ------------------------------------------------------------------ project record */

/** Delete a project (+ its staging copies) from Switchboard. `keep` = backup ids moved to _deleted/ instead. */
export function deleteProjectRecord(p, { keep = [] } = {}) {
  const ids = [p.id, ...all('SELECT id FROM projects WHERE parent_id = ?', p.id).map((c) => c.id)];
  const files = ids.flatMap((id) => all('SELECT * FROM backups WHERE project_id = ?', id));
  const kept = [];
  if (keep.length) {
    const dir = path.join(config.backupDir, '_deleted', `${p.slug}-${now().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const b of files.filter((f) => keep.includes(f.id))) {
      const from = path.join(config.backupDir, b.file);
      if (!fs.existsSync(from)) continue;
      const to = path.join(dir, path.basename(b.file));
      fs.renameSync(from, to);
      kept.push(to);
    }
  }
  run('DELETE FROM projects WHERE id = ?', p.id); // staging copies go with it (ON DELETE CASCADE)
  for (const f of files) if (!keep.includes(f.id)) removeBackupFiles(f);
  fs.rmSync(path.join(config.backupDir, p.slug), { recursive: true, force: true });
  reloadSchedules();
  return { backups: files.length, kept };
}

/** Why a deployment can't be removed from its server right now (null = fine). */
export function removalProblem(project, dep) {
  if (project.active_deployment_id === dep.id) return `${dep.server_name} is the LIVE server of ${project.name}. Switch to another server first.`;
  if (dep.lb_state && dep.lb_state !== 'off') return `${dep.server_name} is in the load balancer of ${project.name}. Take it out of the load balancer first.`;
  return null;
}

/* ------------------------------------------------------------------ jobs: projects */

defineJob('remove-deployment', async (ctx, p) => {
  const project = getProject(ctx.job.project_id);
  const dep = getDeployment(Number(p.deployment));
  if (!project || !dep || dep.project_id !== project.id) throw new Error('That server is not part of this project any more');
  const problem = removalProblem(project, dep);
  if (problem) throw new Error(problem);
  try {
    const saved = await backupAndRemove(ctx, project, dep, { backup: p.backup !== false });
    run('DELETE FROM deployments WHERE id = ?', dep.id);
    ctx.log(`Done. ${dep.server_name} is no longer part of ${project.name}${saved ? ` — the database backup is #${saved.id} in the Backups tab` : ''}.`);
    logEvent('warn', `${project.name} removed from ${dep.server_name} (containers, volumes and files deleted)${saved ? `, backup #${saved.id} kept` : ''}`, {
      projectId: project.id,
      serverId: dep.server_id,
      jobId: ctx.id,
      user: ctx.user,
    });
  } catch (e) {
    alert('error', `${project.name}: removing it from ${dep.server_name} FAILED — ${e.message}`, { projectId: project.id, jobId: ctx.id, user: ctx.user, link: `#/projects/${project.id}` });
    throw e;
  } finally {
    bus.emit('state', { projectId: project.id });
  }
});

defineJob('project-delete', async (ctx, p) => {
  const project = getProject(ctx.job.project_id);
  if (!project) throw new Error('Project not found (was it deleted already?)');
  if (project.traffic_mode === 'lb') throw new Error('Turn off load balancing first (project → Load balancing)');
  const children = all('SELECT * FROM projects WHERE parent_id = ?', project.id);
  const keep = [];
  try {
    for (const proj of [...children, project]) {
      const shared = sharedDbDep(proj);
      if (shared && p.backup !== false) {
        const conn = await connectTo(ctx, getServer(shared.server_id));
        try {
          ctx.step(`Back up the shared database of ${proj.name}`);
          keep.push((await backupDeployment(ctx, conn, proj, shared, 'manual', 'Before deleting the project')).id);
        } finally {
          conn.end();
        }
        ctx.warn(`The database of ${proj.name} on the shared database server was NOT dropped — remove it there by hand if you want.`);
      }
      for (const dep of deploymentsOf(proj.id)) {
        ctx.throwIfCancelled();
        const saved = await backupAndRemove(ctx, proj, dep, { backup: p.backup !== false });
        if (saved) keep.push(saved.id);
      }
    }
    ctx.step(`Delete ${project.name} from Switchboard`);
    const r = deleteProjectRecord(project, { keep });
    for (const f of r.kept) ctx.log(`Kept: ${f}`);
    ctx.log('Cloudflare DNS records were not touched — delete them in Cloudflare if the domain is not used any more.');
    alert('warn', `Project ${project.name} deleted from Switchboard and from its servers${r.kept.length ? ` — ${r.kept.length} final backup(s) kept in ${path.join(config.backupDir, '_deleted')}` : ''}`, {
      jobId: ctx.id,
      user: ctx.user,
    });
  } catch (e) {
    alert('error', `Deleting project ${project.name} FAILED — ${e.message}. The project is still in Switchboard; run it again after fixing the problem.`, {
      projectId: project.id,
      jobId: ctx.id,
      user: ctx.user,
      link: `#/projects/${project.id}`,
    });
    throw e;
  } finally {
    bus.emit('state', {});
  }
});

/** Unregister this server's GitHub runners (on GitHub and on the server) and forget them. */
export async function removeRunners(ctx, conn, server, runners = all('SELECT * FROM runners WHERE server_id = ?', server.id)) {
  for (const r of runners) {
    ctx.step(`Remove the GitHub runner of ${r.repo}`);
    const token = await gh.runnerRemoveToken(r.repo).catch((e) => (ctx.warn(`Could not unregister it on GitHub (${e.message}) — remove it in GitHub → Settings → Actions → Runners`), ''));
    const dir = `/opt/switchboard-runner/${r.repo.replace(/[^A-Za-z0-9_.-]+/g, '_')}`;
    await runRemote(
      ctx,
      conn,
      asRoot(
        server,
        `read -r TOKEN; DIR=${shq(dir)}; [ -d "$DIR" ] || exit 0; cd "$DIR"
if [ -f .service ]; then ./svc.sh stop >/dev/null 2>&1; ./svc.sh uninstall >/dev/null 2>&1; fi
if [ -f runner.pid ]; then kill -- "-$(cat runner.pid)" 2>/dev/null || kill "$(cat runner.pid)" 2>/dev/null; fi
[ -z "$TOKEN" ] || runuser -u ${RUNNER_USER} -- ./config.sh remove --token "$TOKEN" || echo '(could not unregister)'
true`,
      ),
      { stdin: `${token}\n`, timeout: 120000 },
    ).catch((e) => ctx.warn(e.message));
    run('DELETE FROM runners WHERE id = ?', r.id);
  }
}

/* ------------------------------------------------------------------ server reset */

export function resetOptions(p = {}) {
  return {
    hostApps: p.hostApps !== false,
    crontabs: p.crontabs !== false,
    projects: p.projects !== false,
  };
}

/** Everything a reset would delete, plus the reasons it can't run. Changes nothing. */
async function makeResetPlan(ctx, conn, server, opts) {
  const scan = await scanServer(ctx, conn, server);
  const homes = ['/root', ...scan.users.map((u) => u.home), ...scan.hostApps.pm2.map((u) => u.home)];
  const { stacks } = buildStacks(scan);
  const problems = [];
  const sb = switchboardContainers(scan.containers);
  if (sb.self.length) problems.push(`This Switchboard dashboard runs on this server (container ${sb.self.join(', ')}). Resetting it would delete the dashboard itself.`);
  const warnings = sb.others.length ? [`Another Switchboard runs here (container ${sb.others.join(', ')}) — it is deleted too, with its data. This dashboard is not affected.`] : [];
  for (const r of serverRoles(server.id)) problems.push(`${server.name} is the ${r}. Move that to another server first.`);

  const kept = [];
  const folders = new Set();
  const STOCK = ['/var/www/html']; // nginx/apache default page: part of the installed web server
  const add = (p) => (STOCK.includes(p.replace(/\/+$/, '')) ? null : safeDir(p, homes) ? folders.add(p.replace(/\/+$/, '')) : kept.push(p));
  for (const st of stacks) {
    if (st.dir) add(st.dir);
    for (const b of st.binds) add(b);
  }
  for (const d of deploymentsOnServer(server.id)) if (d.app_dir) add(d.app_dir);
  const pm2 = opts.hostApps ? scan.hostApps.pm2.filter((u) => SAFE_USER.test(u.user)) : [];
  const services = opts.hostApps ? scan.units.map((u) => u.name).filter((n) => SAFE_UNIT.test(n) && !UNIT_SKIP.test(n)) : [];
  if (opts.hostApps) for (const d of appFolders(scan.hostApps)) add(d);
  // PM2 not running: its saved process list still says where the apps are.
  const asleep = pm2.filter((u) => !u.alive);
  if (asleep.length) {
    const out = await root(ctx, conn, server, asleep.map((u) => `grep -o '"pm_cwd":"[^"]*"' ${shq(`${u.home}/.pm2/dump.pm2`)} 2>/dev/null`).join('\n') + '\ntrue', { quiet: true, timeout: 60000 });
    for (const m of out.matchAll(/"pm_cwd":"([^"]+)"/g)) add(m[1]);
  }
  // Nested folders: keep only the outermost one.
  const sorted = [...folders].sort((a, b) => a.length - b.length);
  const outer = sorted.filter((x, i) => !sorted.slice(0, i).some((o) => x.startsWith(`${o}/`)));

  const standalone = scan.containers.filter((c) => !c.Config?.Labels?.['com.docker.compose.project']).map((c) => String(c.Name || '').replace(/^\//, ''));
  const imagesOut = scan.docker === 'none' ? '' : await root(ctx, conn, server, `${rootDocker(server)} images -q | sort -u | wc -l; ${rootDocker(server)} system df --format '{{.Type}}|{{.Size}}' 2>/dev/null`, { quiet: true, timeout: 60000 });
  const [imgCount, ...df] = lines(imagesOut);
  const runners = all('SELECT * FROM runners WHERE server_id = ?', server.id);
  const deployments = deploymentsOnServer(server.id).map((d) => ({ id: d.id, project_id: d.project_id, project: getProject(d.project_id)?.name || '?' }));
  return {
    scan,
    problems,
    kept,
    folders: outer,
    stacks,
    standalone,
    pm2,
    services,
    runners,
    deployments,
    summary: {
      server: { name: server.name, ip: server.ip, os: scan.os.pretty, docker: scan.docker },
      problems,
      warnings,
      stacks: stacks.map((s) => ({ project: s.project, dir: s.dir, running: s.running, containers: s.containers.length, volumes: s.volumes.length })),
      standalone,
      volumes: scan.volumes.length,
      images: Number(imgCount) || 0,
      dockerDisk: df.map((l) => l.split('|')).map(([type, size]) => ({ type, size })),
      folders: outer,
      kept,
      pm2: pm2.flatMap((u) => u.list.map((p) => `${p.name} (${u.user})`)),
      services,
      sites: opts.hostApps ? scan.hostApps.sites.map((s) => s.names[0] || 'default') : [],
      crontabs: opts.crontabs ? scan.crontabs.map((c) => c.user) : [],
      runners: runners.map((r) => r.repo),
      helper: true,
      deployments: opts.projects ? deployments.map((d) => d.project) : [],
      users: scan.users.map((u) => u.name),
    },
  };
}

export async function previewReset(server, raw) {
  const conn = await connectTo(null, server);
  try {
    return (await makeResetPlan(quietCtx(), conn, server, resetOptions(raw))).summary;
  } finally {
    conn.end();
  }
}

defineJob('server-reset', async (ctx, p) => {
  const server = getServer(Number(p.server));
  if (!server) throw new Error('Server not found');
  const opts = resetOptions(p);
  const stamp = now().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const archive = `/root/switchboard-reset-${stamp}.tar.gz`;
  let conn = await connectTo(ctx, server);
  try {
    ctx.step(`Scan ${server.name}`);
    const plan = await makeResetPlan(ctx, conn, server, opts);
    if (plan.problems.length) throw new Error(plan.problems.join(' · '));
    const D = rootDocker(server);
    ctx.log(`${plan.scan.os.pretty}, Docker ${plan.scan.docker}: ${plan.scan.containers.length} container(s), ${plan.scan.volumes.length} volume(s), ${plan.folders.length} folder(s) to delete`);
    for (const w of plan.summary.warnings) ctx.warn(w);
    for (const k of plan.kept) ctx.warn(`Kept (system or home folder): ${k}`);
    ctx.throwIfCancelled();

    // 1. Save the config files that are about to change, so a mistake can be undone by hand.
    ctx.step(`Save configs to ${archive}`);
    const units = plan.services.map((s) => `/etc/systemd/system/${s}`);
    await root(
      ctx,
      conn,
      server,
      `set +e; L=''; for p in /etc/nginx /etc/switchboard /etc/cron.d /var/spool/cron /etc/sudoers.d/switchboard-runner ${units.map(shq).join(' ')}; do [ -e "$p" ] && L="$L $p"; done
[ -n "$L" ] && tar czf ${shq(archive)} $L 2>/dev/null; chmod 600 ${shq(archive)} 2>/dev/null; ls -la ${shq(archive)} 2>/dev/null || echo 'Nothing to save'; true`,
    );

    // 2. GitHub runners (unregister on GitHub, then remove from the server).
    await removeRunners(ctx, conn, server, plan.runners);
    ctx.throwIfCancelled();

    // 3. Apps outside Docker.
    if (opts.hostApps && (plan.pm2.length || plan.services.length)) {
      ctx.step('Stop and remove apps outside Docker (PM2, systemd services)');
      const cmds = ['set +e', PM2RUN];
      for (const u of plan.pm2) {
        cmds.push(
          `echo ">>> PM2 of ${u.user}"`,
          `pm2run ${shq(u.user)} kill >/dev/null 2>&1`,
          `systemctl disable --now ${shq(`pm2-${u.user}.service`)} >/dev/null 2>&1; rm -f ${shq(`/etc/systemd/system/pm2-${u.user}.service`)}`,
          `rm -rf -- ${shq(`${u.home}/.pm2`)}`,
        );
      }
      for (const s of plan.services) cmds.push(`echo ">>> ${s}"`, `systemctl disable --now ${shq(s)} >/dev/null 2>&1; rm -f ${shq(`/etc/systemd/system/${s}`)}`);
      cmds.push('systemctl daemon-reload 2>/dev/null; true');
      await root(ctx, conn, server, cmds.join('\n'));
    }
    ctx.throwIfCancelled();

    // 4. Docker: everything.
    if (plan.scan.docker !== 'none') {
      ctx.step('Remove every Docker container, volume, network and image');
      await root(
        ctx,
        conn,
        server,
        `set +e
ids=$(${D} ps -aq); [ -n "$ids" ] && { echo ">>> $(echo $ids | wc -w) container(s)"; ${D} rm -f $ids >/dev/null; }
v=$(${D} volume ls -q); [ -n "$v" ] && { echo ">>> $(echo $v | wc -w) volume(s)"; ${D} volume rm -f $v >/dev/null; }
echo '>>> networks, images, build cache'
${D} network prune -f >/dev/null
${D} image prune -af | tail -1
${D} builder prune -af >/dev/null 2>&1
echo ">>> left: $(${D} ps -aq | wc -l) containers, $(${D} volume ls -q | wc -l) volumes, $(${D} images -q | wc -l) images"
true`,
        { timeout: 30 * 60000 },
      );
    }
    ctx.throwIfCancelled();

    // 5. Folders: compose folders, their outside data folders, app folders, Switchboard's own files.
    ctx.step('Delete app folders');
    const rm = plan.folders.map((f) => `if [ -e ${shq(f)} ]; then echo "  ${f} ($(du -sh ${shq(f)} 2>/dev/null | cut -f1))"; rm -rf -- ${shq(f)}; fi`);
    await root(
      ctx,
      conn,
      server,
      `set +e
${rm.join('\n')}
echo '>>> Switchboard files (helper, project settings, previews, runners)'
rm -rf /etc/switchboard /srv/previews /opt/switchboard-runner ${shq(HELPER)} /etc/sudoers.d/switchboard-runner /etc/cron.d/switchboard-* 2>/dev/null
id -u ${RUNNER_USER} >/dev/null 2>&1 && { pkill -u ${RUNNER_USER} 2>/dev/null; userdel -r ${RUNNER_USER} 2>/dev/null && echo "  user ${RUNNER_USER} removed"; }
true`,
    );

    // 6. nginx sites (the stock "default" site is kept), checked before reloading.
    if (opts.hostApps) {
      ctx.step('Remove nginx sites');
      await root(
        ctx,
        conn,
        server,
        `set +e
command -v nginx >/dev/null 2>&1 || { echo 'nginx is not installed'; exit 0; }
for f in /etc/nginx/sites-enabled/* /etc/nginx/sites-available/* /etc/nginx/conf.d/*.conf; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  case "$(basename "$f")" in default|default.conf) continue ;; esac
  echo "  $f"; rm -f "$f"
done
[ -f /etc/nginx/sites-available/default ] && [ -d /etc/nginx/sites-enabled ] && [ ! -e /etc/nginx/sites-enabled/default ] && ln -s /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
if nginx -t -q 2>/dev/null; then (systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null); echo '>>> nginx reloaded'
else echo '>>> nginx config has errors after removing the sites — nginx stopped (configs are in ${archive})'; systemctl stop nginx 2>/dev/null || nginx -s stop 2>/dev/null; fi
true`,
      );
    }

    // 7. Crontabs.
    if (opts.crontabs && plan.scan.crontabs.length) {
      ctx.step(`Clear crontabs of ${plan.scan.crontabs.map((c) => c.user).join(', ')}`);
      await root(ctx, conn, server, `set +e\n${plan.scan.crontabs.filter((c) => SAFE_USER.test(c.user)).map((c) => `crontab -r -u ${shq(c.user)} 2>/dev/null`).join('\n')}\ntrue`);
    }

    // 8. Switchboard: this server is no longer part of any project.
    if (opts.projects && plan.deployments.length) {
      ctx.step(`Remove ${server.name} from ${plan.deployments.length} project(s) in Switchboard`);
      for (const d of plan.deployments) {
        run('DELETE FROM deployments WHERE id = ?', d.id);
        ctx.log(`  ${d.project}`);
        bus.emit('state', { projectId: d.project_id });
      }
    }

    ctx.step('Check');
    const left = await root(
      ctx,
      conn,
      server,
      `${plan.scan.docker === 'none' ? 'echo 0; echo 0' : `${D} ps -aq | wc -l; ${D} volume ls -q | wc -l`}; df -Pk / | tail -1 | awk '{print $4}'`,
      { quiet: true },
    );
    const [c, v, free] = lines(left).map(Number);
    ctx.log(`${server.name} now has ${c} container(s), ${v} volume(s), ${fmtBytes(free * 1024)} free disk.`);
    ctx.log(`Kept: the OS, users (${plan.scan.users.map((u) => u.name).join(', ') || 'none'}), SSH access${plan.scan.docker !== 'none' ? ', Docker' : ''}. Old configs: ${archive}`);
    ctx.log('The server is ready to be set up again (Clone to it, or create a project from a template).');
    alert('warn', `${server.name} was reset: all containers, volumes, images and apps were deleted`, { serverId: server.id, jobId: ctx.id, user: ctx.user, link: `#/servers/${server.id}` });
    return { containers: c, volumes: v };
  } catch (e) {
    alert('error', `Reset of ${server.name} FAILED — ${e.message}`, { serverId: server.id, jobId: ctx.id, user: ctx.user, link: `#/servers/${server.id}` });
    throw e;
  } finally {
    conn?.end();
    await collectMetrics(getServer(server.id)).catch(() => {});
    bus.emit('state', { serverId: server.id });
  }
});


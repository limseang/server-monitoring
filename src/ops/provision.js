import { all, get, insert, update, now } from '../db.js';
import { bus } from '../bus.js';
import { alert, logEvent } from '../events.js';
import { defineJob, enqueue } from '../jobs.js';
import { config } from '../config.js';
import { isPrivateAddress } from '../util.js';
import { getProject, getServer, getDeployment, deploymentsOf, parseJSON } from '../models.js';
import * as cf from '../cloudflare.js';
import * as gh from '../github.js';
import { exec } from '../ssh.js';
import { connectTo, runRemote, asRoot, shq, dockerExec } from './remote.js';
import { ensureDocker } from './clone.js';
import { refreshDnsState } from './dns.js';
import { syncDatabase } from './database.js';
import { TEMPLATES, installHelper, pushProjectConf, helper, ensureRepoAccess, scaffoldFiles, projectHosts, appUser } from './stack.js';
import { proxySiteName } from './proxycheck.js';
import { FRONTEND_SCRIPT, PM2_SCRIPT } from '../../public/app/deploypresets.js';

/* ------------------------------------------------------------------ defaults for a template project */
export function deployScriptFor(template, { repo, branch }) {
  // Apps without Docker: the same ready-made scripts as Settings → Deploy script
  if (template === 'frontend') return FRONTEND_SCRIPT;
  if (template === 'pm2') return PM2_SCRIPT;
  const lines = [];
  if (repo) {
    lines.push('# Exact commit from CI ($SB_COMMIT), or the newest commit of the branch for a manual deploy');
    lines.push('git fetch --prune origin');
    lines.push(`git reset --hard "\${SB_COMMIT:-origin/${branch}}"`);
  }
  lines.push('docker compose up -d --build --remove-orphans');
  if (template === 'laravel') lines.push('docker compose exec -T app php artisan migrate --force');
  return lines.join('\n');
}

/** Columns for a new project made from a template. */
export function templateProjectRow({ name, template, db, domain, repo, branch, env = 'production', parentId = null, extraHosts = [], appPort = null, healthPath = null }) {
  const t = TEMPLATES[template];
  if (template === 'compose') {
    return {
      name,
      domain: domain || null,
      template,
      template_opts: JSON.stringify({ db: 'none', extra_hosts: extraHosts, app_port: appPort }),
      git_repo: repo,
      git_branch: branch || 'main',
      env,
      parent_id: parentId,
      // Checked on the app's own port (works without a domain, e.g. a home server on your network)
      health_scheme: 'http',
      health_port: appPort,
      health_path: healthPath || '/',
      health_expect: '200-399',
      deploy_script: [
        '# Exact commit from CI ($SB_COMMIT), or the newest commit of the branch for a manual deploy',
        'git fetch --prune origin',
        `git reset --hard "\${SB_COMMIT:-origin/${branch || 'main'}}"`,
        'docker compose up -d --build --remove-orphans',
      ].join('\n'),
      maintenance_on_cmd: 'true',
      maintenance_off_cmd: 'true',
      ci_test_on: 'none',
      ci_test_cmd: null,
    };
  }
  return {
    name,
    domain: domain || null,
    template,
    template_opts: JSON.stringify({ db, extra_hosts: extraHosts }),
    git_repo: repo || null,
    git_branch: branch || 'main',
    env,
    parent_id: parentId,
    health_scheme: 'http',
    health_port: null,
    health_path: t.health,
    health_expect: '200-399',
    deploy_script: deployScriptFor(template, { repo, branch: branch || 'main' }),
    // checked through the web proxy, with the domain (or the server's IP when there is none) as host name
    maintenance_on_cmd: template === 'laravel' ? 'php artisan down --retry=60' : 'true',
    maintenance_off_cmd: template === 'laravel' ? 'php artisan up' : 'true',
    ci_test_cmd: t.tests,
  };
}

/* ------------------------------------------------------------------ helpers */
async function quickScan(conn, server) {
  const r = await exec(
    conn,
    asRoot(server, `docker version --format '{{.Server.Version}}' 2>/dev/null || echo none; docker compose version --short 2>/dev/null || echo none`),
  );
  const [docker, compose] = r.stdout.trim().split('\n');
  return { docker: docker || 'none', compose: compose || 'none' };
}

async function writeScaffold(ctx, conn, server, dir, files) {
  const user = appUser(server);
  const cmds = ['set -e', `mkdir -p ${shq(dir)}`];
  for (const [rel, content] of Object.entries(files)) {
    if (rel.includes('/')) cmds.push(`mkdir -p ${shq(`${dir}/${rel.slice(0, rel.lastIndexOf('/'))}`)}`);
    cmds.push(`printf %s ${shq(Buffer.from(content).toString('base64'))} | base64 -d > ${shq(`${dir}/${rel}`)}`);
  }
  cmds.push(`chown -R ${shq(user)}: ${shq(dir)}`);
  await runRemote(ctx, conn, asRoot(server, cmds.join('\n')), { quiet: true });
  ctx.log(`Wrote starter files: ${Object.keys(files).join(', ')}`);
}

/** Create or link the Cloudflare records for the project's host names. Returns the dns_records list. */
async function setupDns(ctx, project, zone, ip, { takeover }) {
  const out = [];
  for (const host of projectHosts(project)) {
    if (host !== zone.zone_name && !host.endsWith(`.${zone.zone_name}`)) {
      ctx.warn(`${host} is not in the Cloudflare zone ${zone.zone_name} — add its DNS record yourself`);
      continue;
    }
    const existing = (await cf.findRecords(zone.zone_id, host)).filter((r) => r.name === host && ['A', 'AAAA', 'CNAME'].includes(r.type));
    const a = existing.find((r) => r.type === 'A');
    if (!existing.length) {
      const r = await cf.createRecord(zone.zone_id, { type: 'A', name: host, content: ip, proxied: true, comment: `Switchboard: ${project.name}` });
      ctx.log(`DNS: created A ${host} → ${ip} (proxied)`);
      out.push({ zone_id: zone.zone_id, zone_name: zone.zone_name, id: r.id, name: host, type: 'A' });
    } else if (a) {
      if (a.content !== ip && takeover) {
        await cf.updateRecord(zone.zone_id, a.id, { content: ip });
        ctx.log(`DNS: ${host} pointed from ${a.content} to ${ip}`);
      } else if (a.content !== ip) {
        ctx.warn(`DNS: ${host} already exists and points to ${a.content} — linked but NOT changed. Use "Switch traffic here" when the new server is ready.`);
      } else ctx.log(`DNS: ${host} already points to ${ip}`);
      out.push({ zone_id: zone.zone_id, zone_name: zone.zone_name, id: a.id, name: host, type: 'A' });
    } else {
      ctx.warn(`DNS: ${host} is a ${existing[0].type} record — Switchboard can only switch A records, so it was left alone`);
    }
  }
  return out;
}

/**
 * Apps without Docker still need a web server on ports 80/443. The helper uses the server's own nginx when it
 * runs one; otherwise a small nginx container — so Docker is installed only when there is no nginx.
 */
async function dockerForProxy(ctx, conn, server) {
  const r = await exec(conn, asRoot(server, `command -v nginx >/dev/null 2>&1 && echo nginx; cat /etc/switchboard/edge/mode 2>/dev/null || true`));
  if (/^(nginx|host)$/m.test(r.stdout)) return conn;
  const scan = await quickScan(conn, server);
  if (scan.docker === 'none') ctx.log(`${server.name} has no nginx: Docker is installed to run a small nginx container as the web proxy (the app itself runs without Docker)`);
  return ensureDocker(ctx, conn, server, scan);
}

/**
 * Put the web proxy in front of an app without Docker, as the project's Web proxy (so the Web proxy tab shows and
 * changes it): the built folder (front-end) or the PM2 app's port. Host names: the project's domain(s), or the
 * server's IP when there is no domain (open it at http://IP/).
 */
async function hostProxy(ctx, conn, server, project, dep, { port, folder }) {
  const domains = projectHosts(project);
  const hosts = domains.length ? domains : [server.ip];
  const args = folder ? ['edge-static', proxySiteName(project.id), folder, '1', ...hosts] : ['edge-site', proxySiteName(project.id), String(port), ...hosts];
  if (!folder && !port) throw new Error('The app did not say where it runs (no port and no built folder)');
  ctx.step(`Web proxy: ${hosts.join(', ')} → ${folder ? `folder ${folder}` : `port ${port}`}`);
  await helper(ctx, conn, server, args);
  const t = await exec(conn, asRoot(server, `curl -s -o /dev/null -m 10 -w '%{http_code}' -H ${shq(`Host: ${hosts[0]}`)} http://127.0.0.1/ || true`));
  const code = Number(t.stdout.trim()) || null;
  ctx.log(`http://${hosts[0]} on ${server.name} answers HTTP ${code ?? '—'}`);
  update('deployments', dep.id, {
    proxy_state: JSON.stringify({ ok: true, kind: folder ? 'folder' : 'port', port: folder ? null : port, folder, spa: !!folder, hosts, code, at: now() }),
  });
  if (domains.length) update('projects', project.id, { proxy: JSON.stringify({ hosts: domains, at: now() }) });
  if (!domains.length) ctx.log(`No domain: open it at http://${server.ip}/`);
  return code;
}

/* ------------------------------------------------------------------ jobs */
/**
 * Set up a template project on one or more servers:
 * Docker → helper → (GitHub repo) → code → .env + containers → web proxy → health → DNS.
 * Safe to run again (e.g. after fixing a problem): finished steps are skipped.
 */
defineJob('provision', async (ctx, p) => {
  let project = getProject(ctx.job.project_id);
  if (!project?.template) throw new Error('This project was not made from a template');
  const t = TEMPLATES[project.template];
  const servers = (p.servers || []).map((id) => getServer(Number(id))).filter(Boolean);
  if (!servers.length) throw new Error('No servers chosen');
  const repo = project.git_repo;
  const db = parseJSON(project.template_opts, {})?.db || 'none';
  try {
    if (repo && p.createRepo) {
      ctx.step(`Create the GitHub repository ${repo}`);
      const existing = await gh.getRepo(repo).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
      if (existing) ctx.log(`${repo} already exists — using it`);
      else {
        await gh.createRepo(repo, { privateRepo: p.privateRepo !== false, description: `${project.name} (made with Switchboard)` });
        ctx.log(`Created ${p.privateRepo !== false ? 'private' : 'public'} repository ${gh.webUrl(repo)}`);
      }
    }
    if (repo && p.branchFrom) {
      ctx.step(`Make sure branch ${project.git_branch} exists in ${repo}`);
      if (await gh.ensureBranch(repo, project.git_branch, p.branchFrom)) ctx.log(`Created branch ${project.git_branch} from ${p.branchFrom}`);
      else ctx.log(`Branch ${project.git_branch} already exists`);
    }

    const deps = [];
    let pushed = !(repo && p.createRepo); // a new repo gets its first commit from the first server
    // Apps without Docker: live picture in the job window (code → build → nginx → test), like the Web proxy's
    const prog = t.host ? { kind: 'proxy', setup: true, project: project.name, hosts: projectHosts(project), started_at: new Date().toISOString(), servers: servers.map((s) => ({ id: s.id, name: s.name, live: false, port: null, folder: null, state: 'queued', phase: '', code: null, note: null, error: null })) } : null;
    const setP = (id, patch) => {
      if (!prog) return;
      Object.assign(prog.servers.find((x) => x.id === id), patch);
      ctx.progress(prog);
    };
    if (prog) ctx.progress(prog);
    for (const [i, server] of servers.entries()) {
      ctx.step(`Set up ${project.name} on ${server.name}`);
      setP(server.id, { state: 'running', phase: 'build' });
      let conn = await connectTo(ctx, server);
      try {
        if (t.host) conn = await dockerForProxy(ctx, conn, server);
        else conn = await ensureDocker(ctx, conn, server, await quickScan(conn, server));
        await installHelper(ctx, conn, server);
        // The folder picked in "New app"; when adding servers later, the folder the project already uses
        const sameFolder = get("SELECT app_dir FROM deployments WHERE project_id = ? AND app_dir LIKE '/%' ORDER BY priority LIMIT 1", project.id)?.app_dir;
        const appDir = (p.appDir || sameFolder || `${p.baseDir || '/srv'}/${project.slug}`).replace(/\/+/g, '/');
        let dep = get('SELECT * FROM deployments WHERE project_id = ? AND server_id = ?', project.id, server.id);
        if (!dep) {
          // Never move into a folder that already holds something else (another app, someone's files)
          const busy = (await exec(conn, asRoot(server, `[ -d ${shq(appDir)} ] && [ -n "$(ls -A ${shq(appDir)} 2>/dev/null)" ] && echo yes || echo no`))).stdout.trim() === 'yes';
          if (busy) throw new Error(`${appDir} on ${server.name} already has files — pick an empty or new folder for ${project.name}`);
          ctx.log(`App folder: ${appDir}`);
          const id = insert('deployments', {
            project_id: project.id,
            server_id: server.id,
            priority: 10 * (i + 1),
            app_dir: appDir,
            app_container: t.host ? null : `${project.slug}-app-1`,
            db_type: db === 'none' ? 'none' : db,
            db_container: db === 'none' ? null : `${project.slug}-db-1`,
            db_name: db === 'none' ? null : 'app',
            skip_backup: project.env === 'production' ? 0 : 1,
            created_at: now(),
          });
          dep = get('SELECT * FROM deployments WHERE id = ?', id);
          bus.emit('state', { projectId: project.id });
        }
        await pushProjectConf(ctx, conn, server, project, dep);
        if (repo) await ensureRepoAccess(ctx, conn, server, repo, { write: !pushed, addKey: gh.addDeployKey });

        if (project.template === 'compose' && !repo) throw new Error('A Docker Compose project needs its GitHub repository');
        const hasCode = (await exec(conn, asRoot(server, `[ -e ${shq(`${dep.app_dir}/.git`)} ] || [ -n "$(ls -A ${shq(dep.app_dir)} 2>/dev/null)" ] && echo yes || echo no`))).stdout.trim() === 'yes';
        if (!hasCode && (!repo || !pushed)) {
          ctx.log(`Start a new ${t.label} app in ${dep.app_dir}`);
          if (project.template === 'laravel') await helper(ctx, conn, server, ['scaffold-laravel', project.slug]);
          else await writeScaffold(ctx, conn, server, dep.app_dir, scaffoldFiles(project.template, project.name));
          if (repo) {
            await helper(ctx, conn, server, ['init-repo', project.slug]);
            pushed = true;
          }
        }
        const r = await helper(ctx, conn, server, ['setup', project.slug]);
        const port = Number(r.stdout.match(/SB_PORT=(\d+)/)?.[1]) || null;
        if (port) update('deployments', dep.id, { app_port: port });
        const cont = r.stdout.match(/SB_CONTAINER=([A-Za-z0-9][A-Za-z0-9_.-]*)/)?.[1];
        if (cont && project.template === 'compose') update('deployments', dep.id, { app_container: cont });
        if (t.host) {
          const folder = r.stdout.match(/^SB_SITE_DIR=(\/\S*)$/m)?.[1] || null;
          setP(server.id, { phase: 'write', port: folder ? null : port, folder });
          const code = await hostProxy(ctx, conn, server, project, getDeployment(dep.id), { port, folder });
          setP(server.id, { state: 'success', phase: 'done', code });
        }
        deps.push(getDeployment(dep.id));
      } catch (e) {
        setP(server.id, { state: 'failure', error: e.message });
        throw e;
      } finally {
        conn.end();
      }
    }

    project = getProject(project.id);
    const first = deps[0];
    if (project.domain && p.zone?.zone_id && !config.allowPrivateDns && isPrivateAddress(first.server_ip)) {
      ctx.warn(`${first.server_name} has the private IP ${first.server_ip} — visitors can't reach it, so no DNS record was made. Open it on your network at http://${first.server_ip}${project.health_port ? `:${project.health_port}` : ''}/`);
    } else if (project.domain && p.zone?.zone_id) {
      ctx.step('Cloudflare DNS');
      const records = await setupDns(ctx, project, p.zone, first.server_ip, { takeover: !!p.takeoverDns });
      if (records.length) update('projects', project.id, { dns_records: JSON.stringify(records) });
    }
    if (!project.active_deployment_id) update('projects', project.id, { active_deployment_id: first.id });
    refreshDnsState(project.id).catch(() => {});
    bus.emit('state', { projectId: project.id });
    logEvent('success', `${project.name}: set up from the ${t.label} template on ${servers.map((s) => s.name).join(', ')}`, { projectId: project.id, jobId: ctx.id, user: ctx.user });
    if (p.ci && repo && !project.parent_id) {
      update('projects', project.id, { ci_mode: p.ci === 'runner' ? 'runner' : 'pull' });
      const job = enqueue({ type: 'ci-setup', title: `Set up CI/CD for ${project.name}`, projectId: project.id, params: { commit: true }, user: ctx.user });
      ctx.log(`Next: CI/CD setup (job #${job.id}) — every push to ${project.git_branch} will be deployed`);
    }
  } catch (e) {
    alert('error', `${project.name}: setup FAILED — ${e.message}`, { projectId: project.id, jobId: ctx.id, link: `#/projects/${project.id}` });
    throw e;
  }
});

/**
 * LINK WITH GITHUB — a project started as a starter app (no repository) gets one later:
 * a new GitHub repository, the live server's code as its first commit, the other servers connected to it,
 * and (if asked) CI/CD so every push is deployed. Then the project page shows how to clone it on a PC.
 */
defineJob('link-github', async (ctx, p) => {
  let project = getProject(ctx.job.project_id);
  if (!project) throw new Error('Project not found');
  if (project.git_repo) throw new Error(`${project.name} is already linked to ${project.git_repo}`);
  const repo = String(p.repo || '');
  if (!gh.REPO_RE.test(repo)) throw new Error('Repository must look like owner/name');
  const branch = project.git_branch || 'main';
  const deps = deploymentsOf(project.id).sort((a, b) => (b.id === project.active_deployment_id) - (a.id === project.active_deployment_id));
  if (!deps.length) throw new Error('This project has no server yet');

  ctx.step(`GitHub repository ${repo}`);
  const existing = await gh.getRepo(repo).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
  if (existing) {
    // Only an EMPTY repository may be used: the server's code becomes its first commit.
    const sha = await gh.branchSha(repo, branch).catch(() => null);
    if (sha) throw new Error(`${repo} already has code on ${branch}. Pick a new name — or, to use that code, connect it on the CI/CD tab (Servers and Git).`);
    ctx.log(`${repo} exists and is empty — using it`);
  } else {
    await gh.createRepo(repo, { privateRepo: p.privateRepo !== false, description: `${project.name} (made with Switchboard)` });
    ctx.log(`Created ${p.privateRepo !== false ? 'private' : 'public'} repository ${gh.webUrl(repo)}`);
  }
  update('projects', project.id, { git_repo: repo, git_branch: branch });
  project = getProject(project.id);
  let pushed = false;
  try {
    const { connectGit } = await import('./ci.js');
    for (const dep of deps) {
      const server = getServer(dep.server_id);
      ctx.step(`${pushed ? 'Connect' : 'First commit from'} ${server.name}`);
      const conn = await connectTo(ctx, server);
      try {
        await ensureRepoAccess(ctx, conn, server, repo, { write: !pushed, addKey: gh.addDeployKey });
        await pushProjectConf(ctx, conn, server, project, dep);
        if (!pushed) {
          await helper(ctx, conn, server, ['init-repo', project.slug]);
          pushed = true;
          ctx.log(`The code in ${dep.app_dir} on ${server.name} is now on GitHub: ${gh.webUrl(repo)}`);
        } else {
          await connectGit(ctx, conn, server, project, project, dep);
        }
      } finally {
        conn.end();
      }
    }
  } catch (e) {
    // Nothing reached GitHub: the project goes back to "not linked", so the button is there to try again.
    if (!pushed) update('projects', project.id, { git_repo: null });
    bus.emit('state', { projectId: project.id });
    throw e;
  }
  if (p.ci) {
    update('projects', project.id, { ci_mode: 'pull' });
    const job = enqueue({ type: 'ci-setup', title: `Set up CI/CD for ${project.name}`, projectId: project.id, params: { commit: true }, user: ctx.user });
    ctx.log(`Next: CI/CD setup (job #${job.id}) — every push to ${branch} will be deployed`);
  }
  bus.emit('state', { projectId: project.id });
  logEvent('success', `${project.name}: linked to GitHub ${repo}`, { projectId: project.id, jobId: ctx.id, user: ctx.user });
});

/** Copy the live database of the main project into its staging copy (no backup when the staging server says so). */
defineJob('staging-data', async (ctx) => {
  const staging = getProject(ctx.job.project_id);
  const main = staging?.parent_id && getProject(staging.parent_id);
  if (!main) throw new Error('This is not a staging project');
  const source = deploymentsOf(main.id).find((d) => d.id === main.active_deployment_id);
  const target = deploymentsOf(staging.id).find((d) => d.id === staging.active_deployment_id) || deploymentsOf(staging.id)[0];
  if (!source) throw new Error(`${main.name} has no live server`);
  if (!target) throw new Error(`${staging.name} has no server yet`);
  const srcConn = await connectTo(ctx, getServer(source.server_id));
  const dstConn = target.server_id === source.server_id ? srcConn : await connectTo(ctx, getServer(target.server_id));
  try {
    const info = await syncDatabase(ctx, { project: staging, source, target, srcConn, dstConn, backupTarget: !target.skip_backup, sourceLive: true });
    if (!target.skip_backup) ctx.log('(The staging server is set to "back up first" — untick that in its settings to skip it next time)');
    update('deployments', target.id, { data_note: `Live data from ${main.name}` });
    if (staging.template === 'laravel' && target.app_container) {
      ctx.step('Run migrations on staging (its branch may have newer ones)');
      await runRemote(ctx, dstConn, asRoot(getServer(target.server_id), dockerExec(getServer(target.server_id), target.app_container, 'php artisan migrate --force')), { okCodes: [0, 1] });
    }
    logEvent('success', `${staging.name}: live data copied from ${main.name} (${info.tables} tables)`, { projectId: staging.id, jobId: ctx.id, user: ctx.user });
  } finally {
    srcConn.end();
    if (dstConn !== srcConn) dstConn.end();
  }
  bus.emit('state', { projectId: staging.id });
});

export const childProjects = (id) => all('SELECT * FROM projects WHERE parent_id = ? ORDER BY id', id);

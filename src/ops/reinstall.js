/**
 * REINSTALL OS — erase the whole disk and install a fresh Debian / Ubuntu, over SSH only.
 *
 * Works on any provider (DigitalOcean, AWS, home servers…) because it does not use a provider
 * API: it runs the open-source reinstall tool (github.com/bin456789/reinstall) on the server,
 * pinned to one commit (config.reinstallRef) — the helper files it downloads are pinned too.
 * The tool prepares a small installer, the server reboots into it, and the installer wipes the
 * disk and installs the new OS with the same IP. Then:
 *   • login is root, with the SAME SSH key (or password) Switchboard already uses, same SSH port
 *   • Switchboard waits until the new OS answers, pins its new SSH host key and (optionally)
 *     installs Docker, so the server is ready to be set up again.
 *
 * EVERYTHING on the disk is gone: data, projects, users, configs. If the installer fails
 * (rare: network setup), the server is only reachable through the provider's web console /
 * a screen and keyboard — the job says so.
 */
import { config } from '../config.js';
import { all, run, update } from '../db.js';
import { bus } from '../bus.js';
import { alert } from '../events.js';
import { defineJob } from '../jobs.js';
import { getServer, getProject, deploymentsOnServer } from '../models.js';
import { connect, exec, loginPublicKey, loginPassword } from '../ssh.js';
import { fmtBytes, sleep, isPrivateAddress } from '../util.js';
import { connectTo, runRemote, asRoot, shq } from './remote.js';
import { scanServer, ensureDocker } from './clone.js';
import { serverRoles } from './serverctl.js';
import { inspectAll, switchboardContainers, removeRunners } from './wipe.js';
import { collectMetrics } from '../monitor.js';

export const REINSTALL_OS = {
  'debian-12': { label: 'Debian 12 (bookworm)', id: 'debian', version: '12', args: ['debian', '12'], ramMb: 256 },
  'debian-13': { label: 'Debian 13 (trixie)', id: 'debian', version: '13', args: ['debian', '13'], ramMb: 256 },
  'ubuntu-22.04': { label: 'Ubuntu 22.04 LTS', id: 'ubuntu', version: '22.04', args: ['ubuntu', '22.04'], ramMb: 512 },
  'ubuntu-24.04': { label: 'Ubuntu 24.04 LTS', id: 'ubuntu', version: '24.04', args: ['ubuntu', '24.04'], ramMb: 512 },
  'ubuntu-26.04': { label: 'Ubuntu 26.04 LTS', id: 'ubuntu', version: '26.04', args: ['ubuntu', '26.04'], ramMb: 512 },
};

const MARKER = '/root/.switchboard-before-reinstall';
const toolUrl = () => config.reinstallScriptUrl || `https://raw.githubusercontent.com/bin456789/reinstall/${config.reinstallRef}/reinstall.sh`;

function sections(out) {
  const s = {};
  let cur = null;
  for (const line of String(out).split('\n')) {
    const m = line.match(/^@@(\w+)$/);
    if (m) s[(cur = m[1])] = [];
    else if (cur) s[cur].push(line);
  }
  for (const k of Object.keys(s)) s[k] = s[k].join('\n').trim();
  return s;
}

export function reinstallOptions(p = {}) {
  const os = REINSTALL_OS[p.os] ? p.os : 'debian-12';
  return { os, installDocker: p.installDocker !== false, waitMinutes: Math.min(120, Math.max(10, Number(p.waitMinutes) || 45)) };
}

/** Facts, blocking problems and warnings. Reads only. */
async function preflight(ctx, conn, server, opts) {
  const target = REINSTALL_OS[opts.os];
  const r = await runRemote(
    ctx,
    conn,
    asRoot(
      server,
      `echo @@os; cat /etc/os-release 2>/dev/null
echo @@arch; uname -m
echo @@mem; awk '/MemTotal/{print $2}' /proc/meminfo
echo @@container; if [ -f /.dockerenv ] || [ -f /run/.containerenv ] || [ -d /proc/vz ] || { command -v systemd-detect-virt >/dev/null 2>&1 && systemd-detect-virt -qc; }; then echo yes; else echo no; fi
echo @@virt; (systemd-detect-virt 2>/dev/null || echo unknown)
echo @@boot; [ -d /sys/firmware/efi ] && echo EFI || echo BIOS
echo @@disks; lsblk -dn -b -o NAME,SIZE,TYPE 2>/dev/null | awk '$3=="disk"{print $1" "$2}'
echo @@net; if command -v curl >/dev/null 2>&1; then curl -fsI -m 15 https://raw.githubusercontent.com >/dev/null 2>&1 && echo ok || echo fail; elif command -v wget >/dev/null 2>&1; then wget -q --spider -T 15 https://raw.githubusercontent.com && echo ok || echo fail; else echo nodl; fi
echo @@end; true`,
    ),
    { quiet: true, timeout: 60000 },
  );
  const s = sections(r.stdout);
  const os = Object.fromEntries(
    String(s.os || '')
      .split('\n')
      .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
  const memMb = Math.round((Number(s.mem) || 0) / 1024);
  const disks = String(s.disks || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ name: l.split(' ')[0], bytes: Number(l.split(' ')[1]) || 0 }));
  const problems = [];
  const warnings = [];
  for (const role of serverRoles(server.id)) problems.push(`${server.name} is the ${role}. Move that to another server first.`);
  const sb = switchboardContainers(await inspectAll(ctx, conn, server));
  if (sb.self.length) problems.push(`This Switchboard dashboard runs on this server (container ${sb.self.join(', ')}). Reinstalling it would delete the dashboard itself.`);
  if (sb.others.length) warnings.push(`Another Switchboard runs here (container ${sb.others.join(', ')}) — it is erased too, with its data. This dashboard is not affected.`);
  if (s.container === 'yes' && !config.reinstallAllowContainer) problems.push('This "server" is a container (Docker/LXC/OpenVZ) — its OS can\'t be reinstalled from inside. Use your provider\'s panel.');
  if (memMb && memMb < target.ramMb) problems.push(`${target.label} needs at least ${target.ramMb} MB of RAM (this server has ${memMb} MB).`);
  if (!['x86_64', 'aarch64', 'arm64'].includes(s.arch)) problems.push(`Unsupported CPU architecture: ${s.arch}`);
  if (s.net === 'fail') problems.push('The server cannot reach GitHub (raw.githubusercontent.com) to download the installer.');
  if (s.net === 'nodl') problems.push('Neither curl nor wget is installed — install one first.');
  if (server.auth_type === 'agent') problems.push('This server logs in with ssh-agent — switch it to a saved SSH key or password first, so the new OS gets the same login.');
  if (disks.length > 1) warnings.push(`This server has ${disks.length} disks (${disks.map((d) => `${d.name} ${fmtBytes(d.bytes)}`).join(', ')}). The installer uses the disk the current OS runs from; other disks are not formatted.`);
  if ((server.ssh_user || 'root') !== 'root') warnings.push(`You log in as "${server.ssh_user}" today. After the reinstall the only user is root (same key/password) — Switchboard switches to root by itself.`);
  if (isPrivateAddress(server.ssh_host || server.ip)) warnings.push('This looks like a home / local server. If the installer can\'t set up the network, you need a screen and keyboard on it to fix it.');
  else warnings.push('If the installer can\'t set up the network (rare), the server is only reachable from your provider\'s web console. You can watch the install at http://' + server.ip + '/ while it runs.');
  const deployments = deploymentsOnServer(server.id).map((d) => getProject(d.project_id)?.name || '?');
  return {
    problems,
    warnings,
    facts: {
      os: os.PRETTY_NAME || os.ID || 'unknown',
      arch: s.arch,
      memMb,
      boot: s.boot,
      virt: s.virt,
      disks,
      target: target.label,
      login: `root with the ${server.auth_type === 'password' ? 'same password' : 'same SSH key'}, port ${server.ssh_port || 22}`,
      deployments,
      runners: all('SELECT repo FROM runners WHERE server_id = ?', server.id).map((x) => x.repo),
      tool: `bin456789/reinstall @ ${config.reinstallRef.slice(0, 12)}`,
    },
  };
}

export async function previewReinstall(server, raw) {
  const opts = reinstallOptions(raw);
  const conn = await connectTo(null, server);
  try {
    return await preflight(null, conn, server, opts);
  } finally {
    conn.end();
  }
}

/** One look at the server as root without pinning its host key: 'down' | 'old' | 'installer' | 'new'. */
async function probe(server, target) {
  const probeSrv = { ...server, id: undefined, host_key: null, ssh_user: 'root' };
  let conn;
  try {
    conn = await connect(probeSrv, { timeout: 15000 });
    const r = await exec(conn, `. /etc/os-release 2>/dev/null; echo "$ID $VERSION_ID"; [ -e ${MARKER} ] && echo OLD || echo FRESH; [ -x /usr/bin/dpkg ] && [ -x /usr/bin/apt-get ] && echo APT`, { timeout: 20000 });
    const out = r.stdout;
    if (/OLD/.test(out)) return { state: 'old' };
    const [id, ver] = out.split('\n')[0].trim().split(' ');
    if (id === target.id && ver === target.version && /APT/.test(out)) return { state: 'new', hostKey: conn.hostKey };
    return { state: 'installer', detail: `${id || '?'} ${ver || ''}`.trim() };
  } catch (e) {
    return { state: 'down', detail: e.message };
  } finally {
    conn?.end();
  }
}

defineJob('server-reinstall', async (ctx, p) => {
  const server = getServer(Number(p.server));
  if (!server) throw new Error('Server not found');
  const opts = reinstallOptions(p);
  const target = REINSTALL_OS[opts.os];
  let wiped = false;
  let prepared = false;
  try {
    let conn = await connectTo(ctx, server);
    try {
      ctx.step(`Check ${server.name}`);
      const pre = await preflight(ctx, conn, server, opts);
      ctx.log(`${pre.facts.os}, ${pre.facts.arch}, ${pre.facts.memMb} MB RAM, ${pre.facts.boot} boot, ${pre.facts.virt}`);
      for (const w of pre.warnings) ctx.warn(w);
      if (pre.problems.length) throw new Error(pre.problems.join(' · '));
      ctx.throwIfCancelled();

      // GitHub runners must be unregistered while the server still exists.
      await removeRunners(ctx, conn, server);

      ctx.step(`Prepare the installer for ${target.label} (${pre.facts.tool})`);
      const key = loginPublicKey(server);
      const password = key ? null : loginPassword(server);
      if (!key && !password) throw new Error('No SSH key or password saved for this server');
      const ref = config.reinstallRef;
      prepared = true; // from now on the tool may have armed the next boot
      const args = [...target.args, '--username', 'root', ...(key ? ['--ssh-key', key] : []), ...(Number(server.ssh_port) && Number(server.ssh_port) !== 22 ? ['--ssh-port', String(server.ssh_port)] : [])];
      await runRemote(
        ctx,
        conn,
        asRoot(
          server,
          `set -e
read -r SB_PW || true
exec </dev/null
F=/root/switchboard-reinstall.sh
URL=${shq(toolUrl())}
if command -v curl >/dev/null 2>&1; then curl -fsSL "$URL" -o "$F"; else wget -qO "$F" "$URL"; fi
# The tool downloads more files from its "main" branch while it runs: pin those to the same commit.
sed -i "s#bin456789/reinstall/main#bin456789/reinstall/${ref}#g; s#reinstall/-/git/raw/main#reinstall/-/git/raw/${ref}#g" "$F"
${config.reinstallScriptUrl ? '' : `grep -q 'bin456789/reinstall/${ref}' "$F" || { echo 'Downloaded installer looks wrong (pinning failed) — stopping, nothing was changed' >&2; exit 1; }`}
echo ">>> bash reinstall.sh ${args.slice(0, 2).join(' ')} …"
if [ -n "$SB_PW" ]; then bash "$F" ${args.map(shq).join(' ')} --password "$SB_PW"; else bash "$F" ${args.map(shq).join(' ')}; fi
touch ${MARKER}`,
        ),
        { stdin: `${password || ''}\n`, timeout: 30 * 60000 },
      );
      ctx.throwIfCancelled();

      // From here on, the old system is gone as soon as the server reboots.
      ctx.step(`Reboot ${server.name} into the installer — the disk is erased now`);
      await runRemote(ctx, conn, asRoot(server, `nohup setsid sh -c 'sleep 3; systemctl reboot 2>/dev/null || reboot' >/dev/null 2>&1 </dev/null & echo 'Reboot sent.'`), { timeout: 30000 });
    } finally {
      conn.end();
    }
    wiped = true;
    const deps = deploymentsOnServer(server.id);
    for (const d of deps) {
      run('DELETE FROM deployments WHERE id = ?', d.id);
      bus.emit('state', { projectId: d.project_id });
    }
    if (deps.length) ctx.log(`Removed ${server.name} from ${deps.length} project(s) — its copies are being erased.`);
    update('servers', server.id, { ssh_user: 'root', docker_cmd: 'docker', host_key: null, status: 'down', status_error: 'Reinstalling the OS…' });

    ctx.step(`Wait for ${target.label} to come up (usually 5–20 minutes, up to ${opts.waitMinutes})`);
    const fresh = () => getServer(server.id);
    const until = Date.now() + opts.waitMinutes * 60000;
    let last = '';
    let lastLog = 0;
    let found = null;
    await sleep(20000);
    while (Date.now() < until) {
      ctx.throwIfCancelled();
      const r = await probe(fresh(), target);
      const msg = { down: 'not answering on SSH (rebooting / installing)', old: 'still the old system (reboot pending)', installer: `installer running (${r.detail})`, new: 'new system is up' }[r.state];
      if (msg !== last || Date.now() - lastLog > 120000) {
        ctx.log(`  ${new Date().toISOString().slice(11, 16)} UTC — ${msg}`);
        last = msg;
        lastLog = Date.now();
      }
      if (r.state === 'new') {
        // First boot may still restart once (cloud-init): it must answer twice, 30 s apart.
        await sleep(30000);
        const again = await probe(fresh(), target);
        if (again.state === 'new' && again.hostKey === r.hostKey) {
          found = again;
          break;
        }
      }
      await sleep(20000);
    }
    if (!found) {
      throw new Error(
        `${server.name} did not come back with ${target.label} within ${opts.waitMinutes} minutes. Open your provider's web console (or watch http://${server.ip}/) to see the installer. ` +
          'When it is up, use "Reset SSH host key" on the server page and Refresh.',
      );
    }
    update('servers', server.id, { host_key: found.hostKey, status_error: null });
    ctx.log(`${target.label} is up. New SSH host key pinned.`);

    if (opts.installDocker) {
      const srv = fresh();
      const c = await connectTo(ctx, srv);
      try {
        const scan = await scanServer(ctx, c, srv);
        (await ensureDocker(ctx, c, srv, scan))?.end?.();
      } finally {
        c.end();
      }
    }
    await collectMetrics(fresh()).catch(() => {});
    ctx.log(`Done. ${server.name} is a fresh ${target.label}. Log in: ${server.auth_type === 'password' ? 'root with the same password' : 'root with the same SSH key'}.`);
    alert('success', `${server.name} was reinstalled: fresh ${target.label}${opts.installDocker ? ' with Docker' : ''}`, { serverId: server.id, jobId: ctx.id, user: ctx.user, link: `#/servers/${server.id}` });
  } catch (e) {
    if (prepared && !wiped) {
      // The installer is armed for the next boot: disarm it so a later reboot does not erase the disk.
      ctx.warn('Stopped before the reboot — cancelling the prepared installer (reinstall.sh reset)');
      await (async () => {
        const c = await connectTo(null, server); // not ctx: its signal is already aborted after a cancel
        try {
          await runRemote(null, c, asRoot(server, `if [ -f /root/switchboard-reinstall.sh ]; then bash /root/switchboard-reinstall.sh reset </dev/null; fi; rm -f ${MARKER}`), { timeout: 120000, signal: null });
        } finally {
          c.end();
        }
      })().catch((x) => ctx.warn(`Could not cancel it (${x.message}) — do NOT reboot ${server.name} until you run "bash /root/switchboard-reinstall.sh reset" on it.`));
    }
    alert('error', `Reinstall of ${server.name} FAILED${wiped ? ' after the reboot' : ' before the reboot — the old system is still there'}: ${e.message}`, { serverId: server.id, jobId: ctx.id, user: ctx.user, link: `#/servers/${server.id}` });
    throw e;
  } finally {
    bus.emit('state', { serverId: server.id });
  }
});

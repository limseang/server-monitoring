/**
 * OS UPGRADE — move a server to a newer Ubuntu LTS / Debian release, one release at a time.
 *
 *   Ubuntu: 16.04 → 18.04 → 20.04 → 22.04 → 24.04 → 26.04 (do-release-upgrade, non-interactive)
 *   Debian: 10 → 11 → 12 → 13 (switch the apt sources, full-upgrade)
 *
 * Every long step runs on the server itself (nohup + log file + status file), because a release
 * upgrade restarts sshd and the server reboots in between. Switchboard reconnects, streams the log
 * and waits. Config files you changed are kept (--force-confold).
 *
 * Downgrading is not possible in place on Ubuntu/Debian: reinstall the server with the older
 * version in the provider's panel, then use "Clone" to put everything back.
 *
 * Safety: refuses servers that visitors depend on right now (the live server of a project, a load
 * balancer, a database server). Load-balanced app servers are drained first and added back after.
 */
import { all, get } from '../db.js';
import { getServer, getProject, deploymentsOnServer } from '../models.js';
import { probe } from '../health.js';
import { sleep } from '../util.js';
import { connect } from '../ssh.js';
import { connectTo, runRemote, asRoot, shq } from './remote.js';
import { PM2RUN } from './hostapps.js';
import { isLb, drainMember, addMember } from './lb.js';

export const UBUNTU_LTS = ['16.04', '18.04', '20.04', '22.04', '24.04', '26.04'];
export const DEBIAN = { 10: 'buster', 11: 'bullseye', 12: 'bookworm', 13: 'trixie' };
const LOG = '/var/log/switchboard-os-upgrade.log';
const STATUS = '/var/log/switchboard-os-upgrade.status';
const SCRIPT = '/root/switchboard-os-upgrade.sh';

/** apt never asks: keep the config files you changed, take new defaults for the ones you didn't. */
const APT_QUIET = `export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
cat > /etc/apt/apt.conf.d/99switchboard-upgrade <<'APTCONF'
Dpkg::Options { "--force-confdef"; "--force-confold"; };
APT::Get::Assume-Yes "true";
APTCONF`;

/* ------------------------------------------------------------------ facts */

async function facts(ctx, conn, server) {
  const r = await runRemote(
    ctx,
    conn,
    asRoot(
      server,
      `. /etc/os-release; echo "ID=$ID"; echo "VERSION_ID=$VERSION_ID"; echo "PRETTY=$PRETTY_NAME"; echo "CODENAME=\${VERSION_CODENAME:-\${UBUNTU_CODENAME:-}}"
echo "ROOTFREE=$(df -Pk / | tail -1 | awk '{print $4}')"
echo "BOOTFREE=$(df -Pk /boot 2>/dev/null | tail -1 | awk '{print $4}')"
echo "CONTAINER=$([ -f /.dockerenv ] || grep -qa container= /proc/1/environ 2>/dev/null && echo yes || echo no)"
echo "REBOOT=$([ -f /var/run/reboot-required ] && echo yes || echo no)"
echo "RUNNING=$([ -f ${STATUS}.running ] && echo yes || echo no)"`,
    ),
    { quiet: true, timeout: 30000 },
  );
  const o = {};
  for (const l of r.stdout.split('\n')) {
    const i = l.indexOf('=');
    if (i > 0) o[l.slice(0, i)] = l.slice(i + 1).trim();
  }
  return {
    id: o.ID,
    version: o.VERSION_ID,
    pretty: o.PRETTY,
    codename: o.CODENAME,
    rootFreeKb: Number(o.ROOTFREE) || 0,
    bootFreeKb: Number(o.BOOTFREE) || 0,
    container: o.CONTAINER === 'yes',
    rebootRequired: o.REBOOT === 'yes',
    upgradeRunning: o.RUNNING === 'yes',
  };
}

/** Versions this server can be upgraded to (in order). */
export function upgradePath(os) {
  if (os.id === 'ubuntu') {
    const i = UBUNTU_LTS.indexOf(os.version);
    return i < 0 ? null : UBUNTU_LTS.slice(i + 1);
  }
  if (os.id === 'debian') {
    const v = parseInt(os.version, 10);
    if (!DEBIAN[v]) return null;
    return Object.keys(DEBIAN).map(Number).filter((x) => x > v).map(String);
  }
  return null;
}

const cmpVersion = (a, b) => parseFloat(a) - parseFloat(b);

/** Who depends on this server right now. */
function dependents(server) {
  const blockers = [];
  const drain = [];
  for (const d of deploymentsOnServer(server.id)) {
    const p = getProject(d.project_id);
    if (isLb(p)) {
      if (d.lb_state === 'active') drain.push({ project: p, dep: d });
    } else if (p.active_deployment_id === d.id) {
      blockers.push(`It is the LIVE server of "${p.name}" — switch that project to another server first`);
    }
  }
  for (const p of all("SELECT * FROM projects WHERE traffic_mode = 'lb' AND lb_provider = 'own' AND lb_server_id = ?", server.id)) {
    blockers.push(`It is the load balancer of "${p.name}" — every visitor goes through it`);
  }
  const dbs = get('SELECT id FROM db_servers WHERE server_id = ?', server.id);
  if (dbs) {
    const names = all('SELECT name FROM projects WHERE db_server_id = ?', dbs.id).map((p) => p.name);
    if (names.length) blockers.push(`It is the shared database server of ${names.join(', ')} — they would be down during the reboots`);
  }
  return { blockers, drain };
}

/** Check everything, change nothing. */
export async function planUpgrade(ctx, conn, server, target) {
  const os = await facts(ctx, conn, server);
  const problems = [];
  const warnings = [];
  const path = upgradePath(os);
  const out = { os, path: path || [], steps: [], problems, warnings, drain: [] };
  if (!['ubuntu', 'debian'].includes(os.id)) {
    problems.push(`Only Ubuntu and Debian can be upgraded here (this server runs ${os.pretty})`);
    return out;
  }
  if (!path) {
    problems.push(os.id === 'ubuntu' ? `${os.pretty} is not an LTS release Switchboard knows (supported: ${UBUNTU_LTS.join(', ')})` : `Debian ${os.version} is not supported (10–13)`);
    return out;
  }
  if (os.upgradeRunning) problems.push('An OS upgrade is already running on this server');
  if (target) {
    if (cmpVersion(target, os.version) < 0) {
      problems.push(
        `Downgrading (${os.version} → ${target}) is not possible on ${os.id === 'ubuntu' ? 'Ubuntu' : 'Debian'} without reinstalling. Reinstall the server with ${target} in your provider's panel, reset its SSH host key here, then use "Clone" from a server with your setup to put everything back.`,
      );
    } else if (cmpVersion(target, os.version) === 0) problems.push(`Already on ${os.version}`);
    else if (!path.includes(target)) problems.push(`Can't upgrade ${os.version} → ${target}. Possible: ${path.join(', ') || 'none (already the newest)'}`);
    else out.steps = path.slice(0, path.indexOf(target) + 1);
  }
  if (!path.length) warnings.push(`${os.pretty} is already the newest release Switchboard knows`);
  if (os.rootFreeKb && os.rootFreeKb < 5 * 1024 * 1024) problems.push(`Only ${Math.round(os.rootFreeKb / 1024)} MB free on / — an OS upgrade needs at least 5 GB`);
  if (os.bootFreeKb && os.bootFreeKb < 200 * 1024) warnings.push(`/boot has only ${Math.round(os.bootFreeKb / 1024)} MB free — remove old kernels first (apt autoremove) or the new kernel may not fit`);
  if (os.container) warnings.push('This "server" is a container — reboots are skipped (test lab)');
  if (out.steps.length > 1) warnings.push(`This goes through ${out.steps.length} releases one after another (${[os.version, ...out.steps].join(' → ')}), each with reboots. Plan 20–60 minutes per release.`);
  const dep = dependents(server);
  problems.push(...dep.blockers);
  out.drain = dep.drain.map((x) => ({ project: x.project.name, server: x.dep.server_name }));
  out._drain = dep.drain;
  return out;
}

/* ------------------------------------------------------------------ remote phases */

function hopScript(os, from, to) {
  if (os.id === 'ubuntu') {
    return `${APT_QUIET}
apt-get update
apt-get install -y update-manager-core
[ -f /etc/update-manager/release-upgrades ] && sed -i 's/^Prompt=.*/Prompt=lts/' /etc/update-manager/release-upgrades
echo ">>> do-release-upgrade ${from} → ${to}"
do-release-upgrade -f DistUpgradeViewNonInteractive
. /etc/os-release
[ "$VERSION_ID" = "${to}" ] || { echo "Still on $VERSION_ID after do-release-upgrade (expected ${to}) — see /var/log/dist-upgrade/" >&2; exit 5; }`;
  }
  const a = DEBIAN[from];
  const b = DEBIAN[to];
  return `${APT_QUIET}
echo ">>> switching apt sources ${a} → ${b}"
for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  [ -f "$f" ] || continue
  cp -p "$f" "$f.switchboard-${a}"
  sed -i -E "s#${a}/updates#${b}-security#g; s/\\b${a}\\b/${b}/g" "$f"
done
apt-get update
apt-get upgrade --without-new-pkgs
apt-get full-upgrade
. /etc/os-release
[ "$VERSION_ID" = "${to}" ] || { echo "Still on Debian $VERSION_ID (expected ${to})" >&2; exit 5; }`;
}

/** Before a release jump: bring the current release fully up to date. */
const PREP = `${APT_QUIET}
apt-get update
apt-get full-upgrade
apt-get autoremove --purge`;

/** After a release jump: put third-party repositories (Docker…) back for the new release, update everything. */
const POST = `${APT_QUIET}
. /etc/os-release
NEW="\${VERSION_CODENAME:-\${UBUNTU_CODENAME:-}}"
for f in /etc/apt/sources.list.d/*.list; do
  [ -f "$f" ] || continue
  # do-release-upgrade comments third-party lines out ("# disabled on upgrade to …")
  sed -i -E 's/^# ?(deb .*) # disabled on upgrade to .*/\\1/' "$f"
done
if [ -f /etc/apt/sources.list.d/docker.list ]; then
  sed -i -E "s#(download\\.docker\\.com/linux/[a-z]+) [a-z]+ #\\1 $NEW #" /etc/apt/sources.list.d/docker.list
fi
apt-get update || echo "(some third-party repositories have no packages for $NEW yet — check /etc/apt/sources.list.d)"
apt-get full-upgrade || true
apt-get autoremove --purge || true
rm -f /etc/apt/apt.conf.d/99switchboard-upgrade
systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true`;

/** Run a script on the server in the background and follow its log until it exits. */
async function runDetached(ctx, server, getConn, setConn, name, body, { hours = 3 } = {}) {
  ctx.step(name);
  const wrapped = `#!/bin/sh
touch ${STATUS}.running
trap 'echo $? > ${STATUS}; rm -f ${STATUS}.running' EXIT
set -e
${body}
`;
  await runRemote(
    ctx,
    getConn(),
    asRoot(server, `rm -f ${STATUS}; cat > ${SCRIPT} && chmod 700 ${SCRIPT} && : > ${LOG} && (setsid nohup sh ${SCRIPT} >> ${LOG} 2>&1 < /dev/null &) ; sleep 1; echo started`),
    { stdin: wrapped, quiet: true, timeout: 60000 },
  );
  let offset = 0;
  const until = Date.now() + hours * 3600e3;
  while (Date.now() < until) {
    ctx.throwIfCancelled();
    await sleep(5000);
    let r;
    try {
      r = await runRemote(ctx, getConn(), asRoot(server, `tail -c +${offset + 1} ${LOG} 2>/dev/null | head -c 200000; echo; echo "@@STATUS $(cat ${STATUS} 2>/dev/null || echo running)"`), { quiet: true, timeout: 60000 });
    } catch {
      // sshd restarted during the upgrade → reconnect
      ctx.log('  (connection lost — reconnecting…)');
      setConn(await reconnect(ctx, server, 10));
      continue;
    }
    const i = r.stdout.lastIndexOf('\n@@STATUS ');
    const chunk = r.stdout.slice(0, i);
    const status = r.stdout.slice(i + 10).trim();
    if (chunk.trim()) {
      offset += Buffer.byteLength(chunk);
      ctx.output(`${chunk.replace(/\n$/, '')}\n`, 'o');
    }
    if (status !== 'running') {
      if (status !== '0') throw new Error(`"${name}" failed (exit ${status}) — the full log is in ${LOG} on the server`);
      return;
    }
  }
  throw new Error(`"${name}" took longer than ${hours} hours`);
}

async function reconnect(ctx, server, minutes) {
  const until = Date.now() + minutes * 60000;
  let last;
  while (Date.now() < until) {
    ctx.throwIfCancelled();
    try {
      return await connect(server, { timeout: 15000 });
    } catch (e) {
      last = e;
      await sleep(5000);
    }
  }
  throw new Error(`${server.name} did not come back over SSH within ${minutes} minutes: ${last?.message}`);
}

async function reboot(ctx, server, getConn, setConn, os) {
  if (os.container) {
    ctx.log('Reboot skipped (container in the test lab)');
    return;
  }
  ctx.step(`Reboot ${server.name}`);
  await runRemote(ctx, getConn(), asRoot(server, '(sleep 2; systemctl reboot || reboot) >/dev/null 2>&1 &'), { quiet: true, timeout: 30000 }).catch(() => {});
  getConn().end();
  // Wait until it is really gone, then until it answers again.
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    try {
      const c = await connect(server, { timeout: 5000 });
      c.end();
    } catch {
      break;
    }
  }
  setConn(await reconnect(ctx, server, 20));
  ctx.log(`${server.name} is back`);
}

/* ------------------------------------------------------------------ job */

export async function runOsUpgrade(ctx, p) {
  const server = getServer(Number(p.server));
  if (!server) throw new Error('Server not found');
  let conn = await connectTo(ctx, server);
  const getConn = () => conn;
  const setConn = (c) => (conn = c);
  const drained = [];
  try {
    const plan = await planUpgrade(ctx, conn, server, String(p.target));
    for (const w of plan.warnings) ctx.warn(w);
    if (plan.problems.length) throw new Error(plan.problems.join(' · '));
    const os = plan.os;
    ctx.log(`${server.name}: ${os.pretty} → ${p.target} (${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'})`);

    // Take it out of load balancers first (others keep serving).
    for (const { project, dep } of plan._drain) {
      ctx.step(`Take ${server.name} out of the load balancer of ${project.name}`);
      await drainMember(ctx, project.id, dep.id);
      drained.push({ project, dep });
    }

    // What runs now, to bring it back afterwards.
    const before = await runRemote(
      ctx,
      conn,
      asRoot(server, `(docker ps --format '{{.Names}}' 2>/dev/null || true); echo @@PM2; for u in root $(getent passwd | awk -F: '$3>=1000 && $3<60000 {print $1}'); do h=$(getent passwd "$u" | cut -d: -f6); pid=$(cat "$h/.pm2/pm2.pid" 2>/dev/null); [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$u"; done; true`),
      { quiet: true },
    );
    const [ctrText, pm2Text] = before.stdout.split('@@PM2');
    const containers = ctrText.split('\n').map((x) => x.trim()).filter(Boolean);
    const pm2Users = pm2Text.split('\n').map((x) => x.trim()).filter(Boolean);
    ctx.log(`Running now: ${containers.length} container(s)${pm2Users.length ? `, PM2 for ${pm2Users.join(', ')}` : ''}`);
    if (pm2Users.length) {
      // Make sure PM2 brings the same apps back after the reboots.
      await runRemote(ctx, conn, asRoot(server, `${PM2RUN}\n${pm2Users.map((u) => `pm2run ${shq(u)} 'save --force' >/dev/null`).join('\n')}`), { quiet: true }).catch(() => {});
    }

    let from = os.version;
    for (const to of plan.steps) {
      ctx.log(`══ ${os.id === 'ubuntu' ? 'Ubuntu' : 'Debian'} ${from} → ${to} ══`);
      await runDetached(ctx, server, getConn, setConn, `Update ${from} to its latest packages`, PREP);
      if ((await facts(ctx, conn, server)).rebootRequired) await reboot(ctx, server, getConn, setConn, os);
      await runDetached(ctx, server, getConn, setConn, `Upgrade ${from} → ${to} (this is the long part)`, hopScript(os, from, to), { hours: 4 });
      await reboot(ctx, server, getConn, setConn, os);
      await runDetached(ctx, server, getConn, setConn, `Finish ${to}: re-enable Docker's repository, update, clean up`, POST);
      const now = await facts(ctx, conn, server);
      if (now.version !== to) throw new Error(`Expected ${to} but the server reports ${now.pretty}`);
      ctx.log(`✔ ${server.name} now runs ${now.pretty}`);
      from = to;
    }

    // Bring back what ran before.
    ctx.step('Start Docker, containers and PM2 apps that ran before');
    await runRemote(ctx, conn, asRoot(server, `i=0; until docker info >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && break; (systemctl start docker || service docker start) >/dev/null 2>&1; sleep 2; done; true`), { quiet: true, timeout: 200000 });
    if (containers.length) {
      const out = await runRemote(ctx, conn, asRoot(server, `for c in ${containers.map(shq).join(' ')}; do [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] || { docker start "$c" >/dev/null 2>&1 && echo "started $c" || echo "FAILED $c"; }; done; true`), { quiet: true, timeout: 300000 });
      for (const l of out.stdout.split('\n').filter(Boolean)) (l.startsWith('FAILED') ? ctx.warn : ctx.log)(`  ${l}`);
    }
    for (const u of pm2Users) {
      await runRemote(ctx, conn, asRoot(server, `${PM2RUN}\npm2run ${shq(u)} ping >/dev/null 2>&1; pm2run ${shq(u)} resurrect >/dev/null 2>&1; true`), { quiet: true }).catch(() => {});
    }
    await sleep(5000);

    ctx.step('Health check the projects on this server');
    let bad = 0;
    for (const d of deploymentsOnServer(server.id)) {
      const proj = getProject(d.project_id);
      let r;
      for (let i = 0; i < 10; i++) {
        r = await probe(proj, d);
        if (r.ok) break;
        await sleep(3000);
      }
      if (!r.ok) bad++;
      (r.ok ? ctx.log : ctx.warn)(`  ${proj.name}: ${r.ok ? `HTTP ${r.code}` : r.error}`);
    }

    for (const { project, dep } of drained) {
      ctx.step(`Put ${server.name} back into the load balancer of ${project.name}`);
      await addMember(ctx, project.id, dep.id).catch((e) => ctx.warn(`Not added back (${e.message}) — add it on the Traffic tab once it's healthy`));
    }
    drained.length = 0;
    return { from: os.pretty, to: plan.steps.at(-1), bad };
  } finally {
    if (drained.length) ctx.warn(`${server.name} stays OUT of the load balancer of ${drained.map((x) => x.project.name).join(', ')} — add it back on the Traffic tab when it's fixed`);
    conn?.end();
  }
}

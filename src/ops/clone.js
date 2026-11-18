/**
 * SERVER CLONE — make a new server a copy of an existing one, over SSH only.
 *
 * Copied: Docker (installed if missing), the exact images the containers run, every
 * Docker Compose stack (its folder, outside bind mounts, named volumes) started the same
 * way, and host setup: apt packages, users/groups (+ their SSH keys and crontabs),
 * /etc configs (nginx, letsencrypt, supervisor, sudoers.d, custom systemd units…),
 * timezone, swap and the ufw firewall.
 *
 * NOT copied, on purpose: network config, hostname, SSH host keys, kernel/bootloader,
 * cloud agents. Those are what keep the new machine reachable after a reboot.
 *
 * The source server is only read — except that, with "freeze", each stack's containers
 * are paused (docker pause) while that stack's files/volumes are copied, so databases are
 * copied in a consistent state. They are always unpaused, also on errors and cancel.
 */
import { insert, get, now } from '../db.js';
import { deploymentsOnServer, getServer } from '../models.js';
import { fmtBytes, sleep, isPrivateAddress } from '../util.js';
import { connectTo, runRemote, asRoot, streamCopy, shq, PIPEFAIL } from './remote.js';
import { detectHostApps, appFolders, pm2Dump, publicHostApps, PM2RUN } from './hostapps.js';

/** Host config paths copied when they exist on the source (whole directories or files). */
export const HOST_PATHS = [
  '/etc/nginx',
  '/etc/caddy',
  '/etc/apache2',
  '/etc/letsencrypt',
  '/etc/supervisor',
  '/etc/php',
  '/etc/redis',
  '/etc/mysql',
  '/etc/fail2ban',
  '/etc/logrotate.d',
  '/etc/cron.d',
  '/etc/sysctl.d',
  '/etc/security/limits.d',
  '/etc/docker/daemon.json',
  '/etc/ufw/user.rules',
  '/etc/ufw/user6.rules',
];

/**
 * Certificate/key files the web server configs point to outside the copied folders
 * (e.g. a Cloudflare origin certificate in /etc/ssl/cloudflare). Without them nginx can't load its
 * config on the new server. Prints one path per line (only files that exist).
 */
export const CERT_FILES_SH = `{ grep -rhE '^[[:space:]]*(ssl_certificate|ssl_certificate_key|ssl_trusted_certificate|ssl_client_certificate|ssl_dhparam|ssl_password_file)[[:space:]]' /etc/nginx 2>/dev/null | awk '{print $2}' | tr -d "\\"';"
  grep -rhiE '^[[:space:]]*SSL(CertificateFile|CertificateKeyFile|CertificateChainFile|CACertificateFile)[[:space:]]' /etc/apache2 2>/dev/null | awk '{print $2}' | tr -d "\\"'"
} | sort -u | while read -r f; do case "$f" in /etc/nginx/*|/etc/apache2/*|/etc/letsencrypt/*) ;; /*) [ -f "$f" ] && echo "$f" ;; esac; done`;

/** Packages that describe the machine itself (kernel, boot, cloud, network) — never copied. */
const PKG_SKIP =
  /^(linux-|grub|shim|efibootmgr|os-prober|cloud-|ubuntu-|snapd|lxd|netplan|ifupdown|initramfs|.*-microcode|systemd|udev|openssh-server|openssh-client|mdadm|lvm2|xfsprogs|btrfs|qemu-guest-agent|open-vm-tools|hyperv|walinuxagent|google-|amazon-|aws-|digitalocean|do-agent|droplet-agent|hetzner|docker|containerd|runc|moby)/;

/** systemd units that belong to the machine/provider — never copied. */
const UNIT_SKIP = /^(cloud|snap|docker|containerd|getty|serial-getty|ssh|sshd|netplan|systemd-|network|dbus|display-manager|.*@)/;

/** Bind-mount sources that are part of the OS/Docker itself, not app data. */
const BIND_SKIP =
  /^\/(proc|sys|dev|run|var\/run|tmp)(\/|$)|^\/etc\/(localtime|timezone|hosts|hostname|resolv\.conf|machine-id)$|docker\.sock$|^\/var\/lib\/docker(\/|$)|^\/$/;

const ANON_VOLUME = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_TZ = /^[A-Za-z0-9_+\/-]{1,64}$/;

/** docker command to use inside a script that already runs as root ("sudo docker" → "docker"). */
export const rootDocker = (server) =>
  String(server.docker_cmd || 'docker')
    .trim()
    .replace(/^sudo(\s+-\S+)*\s+/, '') || 'docker';

const isUnder = (p, dir) => !!dir && (p === dir || p.startsWith(dir.replace(/\/+$/, '') + '/'));
const rel = (p) => p.replace(/^\/+/, '');

function sections(out) {
  const s = {};
  let cur = null;
  for (const line of String(out).split('\n')) {
    const m = line.match(/^@@(\w+)$/);
    if (m) {
      cur = m[1];
      s[cur] = [];
    } else if (cur) s[cur].push(line);
  }
  for (const k of Object.keys(s)) s[k] = s[k].join('\n').trim();
  return s;
}

const lines = (s) =>
  String(s || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function parseOsRelease(text) {
  const o = {};
  for (const l of lines(text)) {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) o[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return { id: o.ID || '', like: o.ID_LIKE || '', version: o.VERSION_ID || '', pretty: o.PRETTY_NAME || o.ID || 'unknown' };
}

/** Run a root script, return stdout. */
async function root(ctx, conn, server, script, opts = {}) {
  const r = await runRemote(ctx, conn, asRoot(server, script), { quiet: true, timeout: 120000, ...opts });
  return r.stdout;
}

/* ------------------------------------------------------------------ scan */

/** Read everything the clone needs to know about one server. Changes nothing. */
export async function scanServer(ctx, conn, server) {
  const D = rootDocker(server);
  const hostList = HOST_PATHS.map(shq).join(' ');
  const script = `
echo @@whoami; id -u
echo @@arch; uname -m
echo @@os; cat /etc/os-release 2>/dev/null
echo @@tz; (timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||') | head -1
echo @@swap; tail -n +2 /proc/swaps 2>/dev/null
echo @@docker; ${D} version --format '{{.Server.Version}}' 2>/dev/null || echo none
echo @@compose; ${D} compose version --short 2>/dev/null || echo none
echo @@disk; df -Pk / | tail -1
echo @@pkgmgr; if command -v apt-get >/dev/null 2>&1; then echo apt; elif command -v dnf >/dev/null 2>&1; then echo dnf; elif command -v apk >/dev/null 2>&1; then echo apk; else echo none; fi
echo @@manual; command -v apt-mark >/dev/null 2>&1 && apt-mark showmanual 2>/dev/null
echo @@installed; command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f='\${binary:Package}\\n' 2>/dev/null
echo @@users; getent passwd 2>/dev/null | awk -F: '$3>=1000 && $3<60000'
echo @@groups; getent group 2>/dev/null | awk -F: '$3>=1000 && $3<60000'
echo @@members; for u in $(getent passwd 2>/dev/null | awk -F: '$3>=1000 && $3<60000 {print $1}'); do echo "$u:$(id -nG "$u" 2>/dev/null)"; done
echo @@cron; for u in root $(getent passwd 2>/dev/null | awk -F: '$3>=1000 && $3<60000 {print $1}'); do c=$(crontab -u "$u" -l 2>/dev/null | base64 | tr -d '\\n'); [ -n "$c" ] && echo "$u $c"; done
echo @@keys; for u in root $(getent passwd 2>/dev/null | awk -F: '$3>=1000 && $3<60000 {print $1}'); do h=$(getent passwd "$u" | cut -d: -f6); [ -f "$h/.ssh/authorized_keys" ] && echo "$u $(base64 < "$h/.ssh/authorized_keys" | tr -d '\\n')"; done
echo @@ufw; if command -v ufw >/dev/null 2>&1; then ufw status 2>/dev/null | head -1; else echo none; fi
echo @@hostpaths; for p in ${hostList}; do [ -e "$p" ] && echo "$p"; done
${CERT_FILES_SH}
echo @@aptsrc; for f in /etc/apt/sources.list.d/* /etc/apt/trusted.gpg.d/*; do [ -f "$f" ] && echo "$f"; done; grep -rhoE 'signed-by=[^] ]+|^Signed-By: *[^ ]+' /etc/apt/sources.list.d 2>/dev/null | sed -E 's/^(signed-by=|Signed-By: *)//' | while read -r k; do [ -f "$k" ] && echo "$k"; done
echo @@ips; (hostname -I 2>/dev/null || ip -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1) | tr ' ' '\\n'
echo @@units; for f in /etc/systemd/system/*.service /etc/systemd/system/*.timer; do [ -f "$f" ] && [ ! -L "$f" ] && n=$(basename "$f") && echo "$n $(systemctl is-enabled "$n" 2>/dev/null || echo unknown)"; done
echo @@end
true`;
  const s = sections(await root(ctx, conn, server, script));
  const scan = {
    uid: Number(s.whoami),
    arch: s.arch,
    os: parseOsRelease(s.os),
    timezone: s.tz || '',
    swapKb: lines(s.swap).reduce((n, l) => n + (Number(l.split(/\s+/)[2]) || 0), 0),
    docker: s.docker || 'none',
    compose: s.compose || 'none',
    diskFreeKb: Number(String(s.disk).split(/\s+/)[3]) || 0,
    pkgmgr: s.pkgmgr,
    manual: lines(s.manual),
    installed: new Set(lines(s.installed).map((p) => p.replace(/:.*$/, ''))),
    users: lines(s.users).map((l) => {
      const [name, , uid, gid, , home, shell] = l.split(':');
      return { name, uid: Number(uid), gid: Number(gid), home, shell };
    }),
    groups: lines(s.groups).map((l) => {
      const [name, , gid] = l.split(':');
      return { name, gid: Number(gid) };
    }),
    members: Object.fromEntries(lines(s.members).map((l) => [l.split(':')[0], (l.split(':')[1] || '').split(/\s+/).filter(Boolean)])),
    crontabs: lines(s.cron).map((l) => ({ user: l.split(' ')[0], b64: l.split(' ')[1] || '' })),
    keys: lines(s.keys).map((l) => ({ user: l.split(' ')[0], b64: l.split(' ')[1] || '' })),
    ufw: /active/i.test(s.ufw) && !/inactive/i.test(s.ufw) ? 'active' : s.ufw === 'none' ? 'none' : 'inactive',
    hostPaths: lines(s.hostpaths),
    aptSources: [...new Set(lines(s.aptsrc))],
    ips: [...new Set(lines(s.ips).filter((x) => /^[0-9a-f.:]+$/i.test(x)))],
    units: lines(s.units).map((l) => ({ name: l.split(' ')[0], enabled: l.split(' ')[1] === 'enabled' })),
    containers: [],
    volumes: [],
    images: new Map(),
  };
  if (scan.docker !== 'none') await scanDocker(ctx, conn, server, scan);
  scan.hostApps = await detectHostApps(ctx, conn, server);
  return scan;
}

async function scanDocker(ctx, conn, server, scan) {
  const D = rootDocker(server);
  const out = await root(
    ctx,
    conn,
    server,
    `ids=$(${D} ps -aq); if [ -n "$ids" ]; then ${D} inspect $ids; else echo '[]'; fi; echo @@vol; v=$(${D} volume ls -q); if [ -n "$v" ]; then ${D} volume inspect $v; else echo '[]'; fi`,
    { timeout: 60000 },
  );
  const [c, v] = out.split('\n@@vol\n');
  scan.containers = JSON.parse(c || '[]');
  scan.volumes = JSON.parse(v || '[]');
  const ids = [...new Set(scan.containers.map((x) => x.Image).filter(Boolean))];
  if (ids.length) {
    const img = await root(ctx, conn, server, `for i in ${ids.map(shq).join(' ')}; do ${D} image inspect --format '{{.Id}}|{{.Size}}|{{join .RepoTags ","}}' "$i" 2>/dev/null; done; true`);
    for (const l of lines(img)) {
      const [id, size, tags] = l.split('|');
      scan.images.set(id, { id, size: Number(size) || 0, tags: (tags || '').split(',').filter(Boolean) });
    }
  }
}

/** Sizes (bytes) of paths on a server, via du. */
export async function sizes(ctx, conn, server, paths) {
  const res = {};
  if (!paths.length) return res;
  const out = await root(ctx, conn, server, `du -sk -- ${paths.map(shq).join(' ')} 2>/dev/null; true`, { timeout: 600000 });
  for (const l of lines(out)) {
    const i = l.indexOf('\t');
    if (i > 0) res[l.slice(i + 1)] = Number(l.slice(0, i)) * 1024;
  }
  return res;
}

/* ------------------------------------------------------------------ plan */

/** Group containers into compose stacks and work out what must be copied. */
export function buildStacks(scan) {
  const stacks = new Map();
  const standalone = [];
  const volByName = new Map(scan.volumes.map((v) => [v.Name, v]));
  for (const c of scan.containers) {
    const name = String(c.Name || '').replace(/^\//, '');
    const labels = c.Config?.Labels || {};
    const project = labels['com.docker.compose.project'];
    if (!project) {
      standalone.push(name);
      continue;
    }
    if (!stacks.has(project)) {
      stacks.set(project, {
        project,
        dir: labels['com.docker.compose.project.working_dir'] || '',
        configFiles: (labels['com.docker.compose.project.config_files'] || '').split(',').filter(Boolean),
        containers: [],
        volumes: new Set(),
        binds: new Set(),
        anon: [],
        bindIps: new Set(),
      });
    }
    const st = stacks.get(project);
    for (const arr of Object.values(c.HostConfig?.PortBindings || {})) for (const b of arr || []) if (b.HostIp) st.bindIps.add(b.HostIp);
    const state = c.State?.Status || '';
    st.containers.push({ name, service: labels['com.docker.compose.service'] || name, state, running: state === 'running' || state === 'paused', imageId: c.Image, ref: c.Config?.Image || '' });
    for (const m of c.Mounts || []) {
      if (m.Type === 'volume' && m.Name) {
        if (ANON_VOLUME.test(m.Name)) st.anon.push(`${name}:${m.Destination}`);
        else st.volumes.add(m.Name);
      } else if (m.Type === 'bind' && m.Source && !BIND_SKIP.test(m.Source) && !isUnder(m.Source, st.dir)) {
        st.binds.add(m.Source);
      }
    }
  }
  // Compose volumes of a stack that no container mounts right now still belong to it.
  for (const v of scan.volumes) {
    const p = v.Labels?.['com.docker.compose.project'];
    if (p && stacks.has(p)) stacks.get(p).volumes.add(v.Name);
  }
  for (const st of stacks.values()) {
    for (const f of st.configFiles) if (!isUnder(f, st.dir)) st.binds.add(f);
    st.running = st.containers.some((c) => c.running);
    st.volumes = [...st.volumes].filter((n) => volByName.has(n)).map((n) => volByName.get(n));
    st.binds = [...st.binds];
    st.bindIps = [...st.bindIps];
  }
  const used = new Set([...stacks.values()].flatMap((s) => s.volumes.map((v) => v.Name)));
  const mountedElsewhere = new Set(scan.containers.flatMap((c) => (c.Mounts || []).filter((m) => m.Type === 'volume').map((m) => m.Name)));
  const looseVolumes = scan.volumes.filter((v) => !used.has(v.Name) && !mountedElsewhere.has(v.Name) && !ANON_VOLUME.test(v.Name));
  return { stacks: [...stacks.values()], standalone, looseVolumes };
}

const ANY_IP = /^(0\.0\.0\.0|::|127\.|::1$|localhost$)/;

/**
 * Ports bound to one address of the source (e.g. the database server's "104.1.2.3:6379:6379")
 * can't be opened on the target, which has other addresses. For each such address pick the
 * target's matching one (public ↔ public, private ↔ private) and remember it on the stack as
 * st.ipMap; startStack() writes it into the compose files. Never falls back to 0.0.0.0, which
 * would open e.g. a database to the internet.
 */
export function planBindIps({ stacks, src, dst, srcScan, dstScan, problems, warnings }) {
  const owned = new Set(dstScan.ips || []);
  const ownedList = [...owned];
  const pick = (priv) => {
    const want = priv ? [dst.private_ip, ...ownedList.filter((x) => isPrivateAddress(x) && !x.startsWith('127.') && x !== '::1' && !x.startsWith('172.17.'))] : [dst.ip, ...ownedList.filter((x) => !isPrivateAddress(x))];
    return want.find((x) => x && owned.has(x)) || null;
  };
  for (const st of stacks) {
    st.ipMap = {};
    for (const ip of st.bindIps || []) {
      if (ANY_IP.test(ip) || owned.has(ip) || !dstScan.ips?.length) continue;
      const priv = isPrivateAddress(ip) || ip === src.private_ip;
      const to = pick(priv);
      if (to) {
        st.ipMap[ip] = to;
        warnings.push(`${st.project}: its ports listen on ${ip} (an address of ${src.name}); on ${dst.name} they will listen on ${to}`);
      } else {
        problems.push(
          `${st.project}: its ports listen only on ${ip}, an address of ${src.name}. ${dst.name} has no matching ${priv ? 'private' : 'public'} address (it has: ${ownedList.join(', ') || 'none found'})` +
            (priv ? ` — set ${dst.name}'s private IP in its server settings (Servers → Edit), then scan again.` : ` — check ${dst.name}'s IP in its server settings, then scan again.`),
        );
      }
    }
  }
}

/**
 * Compare source and target and decide what the clone will do.
 * `problems` block the clone; `warnings` are shown but don't.
 */
export async function makePlan(ctx, { src, dst, srcConn, srcScan, dstScan, opts }) {
  const problems = [];
  const warnings = [];
  if (srcScan.uid !== 0) problems.push(`${src.name}: needs root or passwordless sudo for ${src.ssh_user}`);
  if (dstScan.uid !== 0) problems.push(`${dst.name}: needs root or passwordless sudo for ${dst.ssh_user}`);
  if (srcScan.docker === 'none') problems.push(`${src.name} has no working Docker — nothing to clone`);
  if (srcScan.arch !== dstScan.arch) problems.push(`CPU types differ (${src.name} is ${srcScan.arch}, ${dst.name} is ${dstScan.arch}) — the copied images would not run`);
  if (dstScan.docker === 'none' && !opts.installDocker) problems.push(`${dst.name} has no Docker — tick "Install Docker" or install it first`);
  if (dstScan.docker === 'none' && dstScan.os.id === 'alpine') problems.push(`${dst.name} runs Alpine — Docker's installer doesn't support it; install Docker there first`);

  const { stacks, standalone, looseVolumes } = buildStacks(srcScan);
  if (!stacks.length) warnings.push(`No Docker Compose stacks found on ${src.name}`);
  if (standalone.length) warnings.push(`Not cloned (not started by Docker Compose): ${standalone.join(', ')} — recreate those by hand`);
  for (const st of stacks) {
    if (!st.dir) warnings.push(`${st.project}: no compose folder recorded — only its volumes are copied, it can't be started automatically`);
    if (st.anon.length) warnings.push(`${st.project}: anonymous volumes are not copied (${st.anon.join(', ')}) — give them a name in docker-compose.yml if they hold data`);
  }

  planBindIps({ stacks, src, dst, srcScan, dstScan, problems, warnings });

  // Stacks that already exist on the target.
  const dstProjects = new Set(dstScan.containers.map((c) => c.Config?.Labels?.['com.docker.compose.project']).filter(Boolean));
  const clash = stacks.filter((s) => dstProjects.has(s.project)).map((s) => s.project);
  if (clash.length && !opts.replace) problems.push(`${dst.name} already runs: ${clash.join(', ')}. Tick "Replace existing stacks" to overwrite them there.`);

  // Images: what the containers actually run, minus what the target already has.
  const neededIds = [...new Set(stacks.flatMap((s) => s.containers.map((c) => c.imageId)))];
  const images = neededIds.map((id) => srcScan.images.get(id)).filter(Boolean);
  const missingImgs = neededIds.filter((id) => !srcScan.images.has(id));
  if (missingImgs.length) warnings.push(`${missingImgs.length} image(s) used by containers were not found on ${src.name}`);
  const toCopy = images.filter((i) => !dstScan.images.has(i.id));

  // Apps outside Docker (PM2 / systemd / nginx sites) and the Node.js they need.
  const ha = srcScan.hostApps;
  const appDirs = opts.hostApps ? appFolders(ha, { exclude: stacks.map((s) => s.dir).filter(Boolean) }) : [];
  const nodePaths = [];
  let npmGlobals = [];
  if (opts.hostApps) {
    for (const n of ha.nvm) nodePaths.push(`${n.home}/.nvm`);
    if (ha.node?.kind === 'manual') nodePaths.push('/usr/local/bin', '/usr/local/lib/node_modules', '/usr/local/include/node');
    if (ha.node && ha.node.kind !== 'manual') {
      const have = new Set((dstScan.hostApps?.npmGlobals || []).map((g) => `${g.name}@${g.version}`));
      npmGlobals = ha.npmGlobals.filter((g) => !have.has(`${g.name}@${g.version}`));
    }
    for (const u of ha.pm2) if (!u.alive) nodePaths.push(`${u.home}/.pm2/dump.pm2`);
    if (ha.node?.kind === 'apt' && ha.node.pkg && !opts.host) warnings.push(`Node.js on ${src.name} comes from apt (${ha.node.pkg}) — tick "Copy host setup" so it gets installed`);
    if (ha.node && ha.node.kind === 'other') warnings.push(`Node.js on ${src.name} is at ${ha.node.path} (not apt, nvm or /usr/local) — install it on ${dst.name} by hand`);
    for (const u of ha.pm2) if (!u.alive) warnings.push(`PM2 of ${u.user} is not running on ${src.name} — only its saved list is copied (start it with "pm2 resurrect")`);
  }

  // Sizes on the source.
  const allVolumes = [...stacks.flatMap((s) => s.volumes), ...looseVolumes];
  const pathList = [
    ...stacks.map((s) => s.dir).filter(Boolean),
    ...stacks.flatMap((s) => s.binds),
    ...allVolumes.map((v) => v.Mountpoint).filter(Boolean),
    ...(opts.host ? srcScan.hostPaths : []),
    ...opts.extraPaths,
    ...appDirs,
    ...nodePaths.filter((p) => !p.endsWith('dump.pm2')),
  ];
  const sz = await sizes(ctx, srcConn, src, [...new Set(pathList)]);
  const imgBytes = toCopy.reduce((n, i) => n + i.size, 0);
  const dataBytes = Object.values(sz).reduce((n, b) => n + b, 0);
  const need = imgBytes + dataBytes;
  const free = dstScan.diskFreeKb * 1024;
  if (free && need * 1.15 > free) problems.push(`${dst.name} has ${fmtBytes(free)} free but the clone needs about ${fmtBytes(need * 1.15)}`);

  // Host packages.
  let packages = [];
  if (opts.host) {
    if (srcScan.pkgmgr === 'apt' && dstScan.pkgmgr === 'apt') {
      packages = srcScan.manual.filter((p) => !PKG_SKIP.test(p) && !dstScan.installed.has(p));
      if (srcScan.ufw === 'active' && !dstScan.installed.has('ufw') && !packages.includes('ufw')) packages.push('ufw');
      if (srcScan.crontabs.length && !dstScan.installed.has('cron') && !packages.includes('cron')) packages.push('cron');
      const nodePkg = opts.hostApps && ha.node?.kind === 'apt' ? ha.node.pkg : null;
      if (nodePkg && !dstScan.installed.has(nodePkg) && !packages.includes(nodePkg)) packages.push(nodePkg);
      if (ha.sites.length && srcScan.installed.has('nginx') && !dstScan.installed.has('nginx') && !packages.some((p) => p.startsWith('nginx'))) packages.push('nginx');
    } else if (srcScan.pkgmgr !== 'none') {
      warnings.push(`Packages are only copied between apt-based systems (Ubuntu/Debian). ${src.name}: ${srcScan.os.pretty}, ${dst.name}: ${dstScan.os.pretty} — install extra packages by hand`);
    }
    if (srcScan.os.id && dstScan.os.id && (srcScan.os.id !== dstScan.os.id || srcScan.os.version !== dstScan.os.version)) {
      warnings.push(`Different OS versions (${srcScan.os.pretty} → ${dstScan.os.pretty}). Extra apt repositories (e.g. NodeSource) are not copied, and config files for a different version may need a look.`);
      const major = (o) => parseFloat(o.version) || 0;
      if (srcScan.os.id === dstScan.os.id && major(dstScan.os) < major(srcScan.os)) {
        warnings.push(`${dst.name} runs an OLDER ${dstScan.os.pretty}. Best: upgrade it first (${dst.name} → Upgrade OS) to ${srcScan.os.pretty}, then clone — packages and configs from a newer system often don't work on an old one.`);
      }
    }
  }

  return {
    problems,
    warnings,
    stacks,
    looseVolumes,
    standalone,
    images,
    toCopy,
    packages,
    aptRepos: opts.host && srcScan.os.id === dstScan.os.id && srcScan.os.version === dstScan.os.version ? srcScan.aptSources : [],
    appDirs,
    nodePaths,
    npmGlobals,
    sizes: sz,
    bytes: { images: imgBytes, data: dataBytes, total: need, free },
  };
}

/** Plain summary for the browser (preview before starting). */
export function planSummary(plan, srcScan, dstScan, src, dst, opts) {
  const vsize = (v) => plan.sizes[v.Mountpoint] || 0;
  return {
    source: { name: src.name, os: srcScan.os.pretty, arch: srcScan.arch, docker: srcScan.docker },
    target: { name: dst.name, os: dstScan.os.pretty, arch: dstScan.arch, docker: dstScan.docker, free: plan.bytes.free },
    problems: plan.problems,
    warnings: plan.warnings,
    stacks: plan.stacks.map((s) => ({
      project: s.project,
      dir: s.dir,
      running: s.running,
      containers: s.containers.map((c) => c.name),
      volumes: s.volumes.map((v) => v.Name),
      binds: s.binds,
      bytes: (plan.sizes[s.dir] || 0) + s.binds.reduce((n, b) => n + (plan.sizes[b] || 0), 0) + s.volumes.reduce((n, v) => n + vsize(v), 0),
    })),
    looseVolumes: plan.looseVolumes.map((v) => v.Name),
    hostApps: opts.hostApps
      ? (() => {
          const pub = publicHostApps(srcScan.hostApps);
          return {
            node: pub.node,
            nvm: pub.nvm,
            npmGlobals: plan.npmGlobals.map((g) => `${g.name}@${g.version}`),
            pm2: pub.pm2.map((p) => ({ user: p.user, name: p.name, status: p.status })),
            services: pub.services.map((x) => x.name),
            sites: pub.sites.map((x) => ({ names: x.names, kind: x.kind })),
            folders: plan.appDirs,
            bytes: plan.appDirs.reduce((n, d) => n + (plan.sizes[d] || 0), 0),
          };
        })()
      : null,
    images: { count: plan.images.length, toCopy: plan.toCopy.length, bytes: plan.bytes.images },
    host: opts.host
      ? {
          packages: plan.packages,
          users: srcScan.users.map((u) => u.name),
          timezone: srcScan.timezone,
          swap: srcScan.swapKb * 1024,
          ufw: srcScan.ufw,
          crontabs: srcScan.crontabs.map((c) => c.user),
          paths: [...srcScan.hostPaths, ...opts.extraPaths],
          units: srcScan.units.filter((u) => !UNIT_SKIP.test(u.name)).map((u) => u.name),
        }
      : null,
    bytes: plan.bytes,
  };
}

/* ------------------------------------------------------------------ steps */

async function waitDocker(ctx, conn, server, seconds = 90) {
  const D = rootDocker(server);
  await root(ctx, conn, server, `i=0; until ${D} info >/dev/null 2>&1; do i=$((i+1)); [ $i -gt ${seconds} ] && exit 1; sleep 1; done`, { timeout: (seconds + 30) * 1000 }).catch(() => {
    throw new Error(`Docker did not come up on ${server.name}`);
  });
}

async function startDockerService(ctx, conn, server) {
  await root(ctx, conn, server, `(systemctl enable --now docker >/dev/null 2>&1 && systemctl is-active --quiet docker) || service docker start >/dev/null 2>&1 || (nohup dockerd >/var/log/dockerd.log 2>&1 &); true`);
  await waitDocker(ctx, conn, server);
}

/** Install Docker (official get.docker.com script) when missing. Returns a usable connection. */
export async function ensureDocker(ctx, conn, server, scan) {
  if (scan.docker !== 'none' && scan.compose !== 'none') {
    ctx.log(`Docker ${scan.docker} with Compose ${scan.compose} already installed on ${server.name}`);
    return conn;
  }
  if (scan.docker === 'none') {
    ctx.step(`Install Docker on ${server.name} (official get.docker.com script)`);
    await runRemote(
      ctx,
      conn,
      asRoot(
        server,
        `set -e
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q curl ca-certificates;
  elif command -v dnf >/dev/null 2>&1; then dnf install -y curl; fi
fi
if command -v curl >/dev/null 2>&1; then curl -fsSL https://get.docker.com -o /tmp/sb-get-docker.sh; else wget -qO /tmp/sb-get-docker.sh https://get.docker.com; fi
if sh /tmp/sb-get-docker.sh; then rm -f /tmp/sb-get-docker.sh; exit 0; fi
rm -f /tmp/sb-get-docker.sh
# The script can fail on older releases only because of optional extras that don't exist there
# (e.g. docker-model-plugin on Ubuntu 18.04). Install the parts Docker really needs ourselves.
command -v apt-get >/dev/null 2>&1 || { echo 'Docker install failed and this is not an apt-based system — install Docker by hand' >&2; exit 1; }
echo '>>> get.docker.com failed — installing the required Docker packages directly'
. /etc/os-release
DIST="$ID"; case "$ID" in ubuntu|debian) ;; *) case "$ID_LIKE" in *ubuntu*) DIST=ubuntu;; *) DIST=debian;; esac;; esac
CODE="\${VERSION_CODENAME:-\${UBUNTU_CODENAME:-}}"
export DEBIAN_FRONTEND=noninteractive
if ! grep -rqs download.docker.com /etc/apt/sources.list.d/; then
  apt-get update -q && apt-get install -y -q ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$DIST/gpg" -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$DIST $CODE stable" > /etc/apt/sources.list.d/docker.list
fi
apt-get update -q
apt-get install -y -q docker-ce docker-ce-cli containerd.io
for p in docker-compose-plugin docker-buildx-plugin; do apt-get install -y -q "$p" || echo "(optional package $p not available — skipped)"; done`,
      ),
      { timeout: 20 * 60000 },
    );
  } else {
    ctx.step(`Install the Docker Compose plugin on ${server.name}`);
    await runRemote(ctx, conn, asRoot(server, `(command -v apt-get >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker-compose-plugin) || (command -v dnf >/dev/null && dnf install -y docker-compose-plugin)`), { timeout: 10 * 60000 });
  }
  await startDockerService(ctx, conn, server);
  const D = rootDocker(server);
  const v = (await root(ctx, conn, server, `${D} version --format '{{.Server.Version}}'; ${D} compose version --short`)).split('\n');
  ctx.log(`Docker ${v[0]} with Compose ${v[1] || '?'} is running`);
  const user = server.ssh_user || 'root';
  if (user !== 'root') {
    // Let the SSH user run docker like on a normal setup; a new login picks up the group.
    await root(ctx, conn, server, `usermod -aG docker ${shq(user)} 2>/dev/null || true`);
    conn.end();
    return connectTo(ctx, server);
  }
  return conn;
}

export async function installPackages(ctx, conn, server, packages) {
  if (!packages.length) {
    ctx.log('No extra packages to install');
    return;
  }
  ctx.step(`Install ${packages.length} package(s) on ${server.name}: ${packages.join(' ')}`);
  const list = packages.map(shq).join(' ');
  const env = 'export DEBIAN_FRONTEND=noninteractive;';
  try {
    await runRemote(ctx, conn, asRoot(server, `${env} apt-get update -q && apt-get install -y -q --no-install-recommends ${list}`), { timeout: 45 * 60000 });
  } catch {
    ctx.warn('Installing all at once failed — trying them one by one');
    const out = await root(ctx, conn, server, `${env} for p in ${list}; do apt-get install -y -q --no-install-recommends "$p" >/dev/null 2>&1 || echo "$p"; done; true`, { timeout: 60 * 60000 });
    const failed = lines(out);
    if (failed.length) ctx.warn(`Could not install (not available on ${server.name}?): ${failed.join(', ')}`);
  }
}

export async function copyUsers(ctx, conn, server, srcScan, dstScan) {
  const haveGroups = new Set(dstScan.groups.map((g) => g.name));
  const haveUsers = new Set(dstScan.users.map((u) => u.name));
  const script = [];
  for (const g of srcScan.groups) {
    if (haveGroups.has(g.name) || !SAFE_NAME.test(g.name)) continue;
    script.push(`groupadd -g ${g.gid} ${shq(g.name)} 2>/dev/null || groupadd ${shq(g.name)}`);
  }
  for (const u of srcScan.users) {
    if (!SAFE_NAME.test(u.name)) continue;
    const grp = srcScan.groups.find((g) => g.gid === u.gid);
    if (!haveUsers.has(u.name)) {
      script.push(
        `useradd -u ${u.uid} ${grp ? `-g ${shq(grp.name)} ` : ''}-m -d ${shq(u.home)} -s ${shq(u.shell || '/bin/sh')} ${shq(u.name)} 2>/dev/null || useradd -m -d ${shq(u.home)} -s ${shq(u.shell || '/bin/sh')} ${shq(u.name)}`,
      );
    }
    const extra = (srcScan.members[u.name] || []).filter((g) => SAFE_NAME.test(g) && g !== u.name);
    // Only groups that exist on the target (sudo, docker, www-data…).
    for (const g of extra) script.push(`getent group ${shq(g)} >/dev/null && usermod -aG ${shq(g)} ${shq(u.name)}`);
  }
  if (!script.length) return;
  ctx.step(`Create ${srcScan.users.filter((u) => !haveUsers.has(u.name)).length} user(s) and ${srcScan.groups.filter((g) => !haveGroups.has(g.name)).length} group(s) on ${server.name} (same IDs as the source)`);
  await root(ctx, conn, server, `${script.join('\n')}\ntrue`);
}

/** Merge each user's authorized_keys (keeps the keys the target already has). */
async function copyKeys(ctx, conn, server, srcScan) {
  for (const k of srcScan.keys) {
    if (!SAFE_NAME.test(k.user) || !k.b64) continue;
    await root(
      ctx,
      conn,
      server,
      `u=${shq(k.user)}; h=$(getent passwd "$u" | cut -d: -f6); [ -n "$h" ] || exit 0
mkdir -p "$h/.ssh"; touch "$h/.ssh/authorized_keys"
base64 -d | while IFS= read -r line; do [ -n "$line" ] && ! grep -qxF "$line" "$h/.ssh/authorized_keys" && printf '%s\\n' "$line" >> "$h/.ssh/authorized_keys"; done
chown -R "$u" "$h/.ssh"; chmod 700 "$h/.ssh"; chmod 600 "$h/.ssh/authorized_keys"`,
      { stdin: k.b64 },
    );
  }
  if (srcScan.keys.length) ctx.log(`SSH authorized keys merged for: ${srcScan.keys.map((k) => k.user).join(', ')}`);
}

async function copyCrontabs(ctx, conn, server, srcScan) {
  for (const c of srcScan.crontabs) {
    if (!SAFE_NAME.test(c.user) || !c.b64) continue;
    try {
      await root(ctx, conn, server, `command -v crontab >/dev/null || { echo 'crontab is not installed' >&2; exit 3; }; base64 -d > /tmp/sb-cron; (crontab -u ${shq(c.user)} -l 2>/dev/null; cat /tmp/sb-cron) | awk '!seen[$0]++' | crontab -u ${shq(c.user)} -; rc=$?; rm -f /tmp/sb-cron; exit $rc`, { stdin: c.b64 });
      ctx.log(`Crontab of ${c.user} copied`);
    } catch (e) {
      ctx.warn(`Crontab of ${c.user} not copied: ${e.message}`);
    }
  }
}

/** Copy host files (configs + extra paths) with owner names kept. sudoers.d is validated first. */
export async function copyHostFiles(ctx, { src, dst, srcConn, dstConn, paths, quiet = false, title }) {
  const list = [...new Set(paths)].filter((p) => p.startsWith('/') && p !== '/');
  if (!list.length) return false;
  if (!quiet) ctx.step(title || `Copy host files to ${dst.name}: ${list.join(', ')}`);
  const exist = lines(await root(ctx, srcConn, src, `for p in ${list.map(shq).join(' ')}; do [ -e "$p" ] && echo "$p"; done; true`));
  if (!exist.length) return false;
  const r = await streamCopy(ctx, {
    srcConn,
    srcCmd: asRoot(src, `tar -C / -cpzf - ${exist.map((p) => shq(rel(p))).join(' ')}`),
    dstConn,
    dstCmd: asRoot(dst, 'tar -C / -xpzf -'),
    srcName: src.name,
    dstName: dst.name,
    okSrcCodes: [0, 1],
  });
  ctx.log(`Host files copied (${fmtBytes(r.bytes)} compressed)`);
  return exist;
}

/** sudoers.d separately: only files that pass `visudo -c` are installed (a broken sudoers locks you out). */
async function copySudoers(ctx, { src, dst, srcConn, dstConn }) {
  const has = (await root(ctx, srcConn, src, '[ -d /etc/sudoers.d ] && ls -A /etc/sudoers.d | head -1; true')).trim();
  if (!has) return;
  await streamCopy(ctx, {
    srcConn,
    srcCmd: asRoot(src, 'tar -C /etc/sudoers.d -cpzf - .'),
    dstConn,
    dstCmd: asRoot(dst, 'rm -rf /tmp/sb-sudoers && mkdir -p /tmp/sb-sudoers && tar -C /tmp/sb-sudoers -xpzf -'),
    srcName: src.name,
    dstName: dst.name,
  });
  const out = await root(
    ctx,
    dstConn,
    dst,
    `mkdir -p /etc/sudoers.d; for f in /tmp/sb-sudoers/*; do [ -f "$f" ] || continue; n=$(basename "$f"); [ -e "/etc/sudoers.d/$n" ] && continue
  if command -v visudo >/dev/null 2>&1 && ! visudo -cf "$f" >/dev/null 2>&1; then echo "BAD $n"; continue; fi
  install -m 0440 -o root -g root "$f" "/etc/sudoers.d/$n" && echo "OK $n"; done; rm -rf /tmp/sb-sudoers; true`,
  );
  const ok = lines(out).filter((l) => l.startsWith('OK ')).map((l) => l.slice(3));
  const badList = lines(out).filter((l) => l.startsWith('BAD ')).map((l) => l.slice(4));
  if (ok.length) ctx.log(`sudoers.d copied: ${ok.join(', ')}`);
  if (badList.length) ctx.warn(`sudoers.d skipped (failed visudo check): ${badList.join(', ')}`);
}

async function setTimezone(ctx, conn, server, tz, current) {
  if (!tz || tz === current || !SAFE_TZ.test(tz)) return;
  try {
    await root(ctx, conn, server, `timedatectl set-timezone ${shq(tz)} 2>/dev/null || { [ -f /usr/share/zoneinfo/${tz} ] && ln -sf /usr/share/zoneinfo/${tz} /etc/localtime && echo ${shq(tz)} > /etc/timezone; }`);
    ctx.log(`Timezone set to ${tz}`);
  } catch (e) {
    ctx.warn(`Could not set timezone ${tz}: ${e.message}`);
  }
}

async function addSwap(ctx, conn, server, srcKb, dstKb) {
  if (!srcKb || dstKb) return;
  const mb = Math.max(256, Math.round(srcKb / 1024));
  ctx.step(`Create ${mb} MB swap file on ${server.name} (same size as the source)`);
  try {
    await root(
      ctx,
      conn,
      server,
      `[ -e /swapfile ] && { echo '/swapfile already exists' >&2; exit 3; }
(fallocate -l ${mb}M /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=${mb} status=none) && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile || { rm -f /swapfile; exit 4; }
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab`,
      { timeout: 10 * 60000 },
    );
    ctx.log('Swap is on');
  } catch (e) {
    ctx.warn(`Swap not created: ${e.message}`);
  }
}

async function enableUnits(ctx, conn, server, units) {
  const list = units.filter((u) => u.enabled && SAFE_NAME.test(u.name) && !UNIT_SKIP.test(u.name)).map((u) => u.name);
  if (!list.length) return;
  try {
    await root(ctx, conn, server, `command -v systemctl >/dev/null && [ -d /run/systemd/system ] || { echo 'no systemd' >&2; exit 3; }; systemctl daemon-reload; for u in ${list.map(shq).join(' ')}; do systemctl enable --now "$u" || echo "could not start $u" >&2; done`, { timeout: 5 * 60000 });
    ctx.log(`systemd units enabled: ${list.join(', ')}`);
  } catch (e) {
    ctx.warn(`Custom systemd units copied but not enabled (${e.message}): ${list.join(', ')}`);
  }
}

async function reloadHostServices(ctx, conn, server) {
  const out = await root(
    ctx,
    conn,
    server,
    `if command -v nginx >/dev/null 2>&1; then if nginx -t >/dev/null 2>&1; then (systemctl restart nginx 2>/dev/null || service nginx restart >/dev/null 2>&1) && echo "nginx restarted"; else echo "WARN nginx config test failed — check it with: nginx -t"; fi; fi
if command -v supervisorctl >/dev/null 2>&1; then (systemctl restart supervisor 2>/dev/null || service supervisor restart >/dev/null 2>&1) && echo "supervisor restarted"; fi
if command -v sysctl >/dev/null 2>&1; then sysctl --system >/dev/null 2>&1 || true; fi
true`,
  );
  for (const l of lines(out)) (l.startsWith('WARN ') ? ctx.warn(l.slice(5)) : ctx.log(l));
}

/** Turn ufw on with the copied rules — the target's SSH port is always allowed first. */
async function enableFirewall(ctx, conn, server) {
  const port = Number(server.ssh_port) || 22;
  ctx.step(`Enable the ufw firewall on ${server.name} (SSH port ${port} allowed first)`);
  try {
    await root(ctx, conn, server, `command -v ufw >/dev/null || { echo 'ufw is not installed' >&2; exit 3; }; ufw allow ${port}/tcp >/dev/null && ufw --force enable`);
    ctx.log('Firewall is on');
  } catch (e) {
    ctx.warn(`Firewall not enabled: ${e.message}`);
  }
}

export async function copyImages(ctx, { src, dst, srcConn, dstConn, plan }) {
  const D1 = rootDocker(src);
  const D2 = rootDocker(dst);
  if (plan.toCopy.length) {
    const names = [...new Set(plan.toCopy.flatMap((i) => (i.tags.length ? i.tags : [i.id])))];
    ctx.step(`Copy ${plan.toCopy.length} Docker image(s) ${src.name} → ${dst.name} (${fmtBytes(plan.bytes.images)} before compression)`);
    for (const i of plan.toCopy) ctx.log(`  ${i.tags.join(', ') || i.id.slice(7, 19)} — ${fmtBytes(i.size)}`);
    const r = await streamCopy(ctx, {
      srcConn,
      srcCmd: asRoot(src, `${PIPEFAIL}${D1} save ${names.map(shq).join(' ')} | gzip -1`),
      dstConn,
      dstCmd: asRoot(dst, `${PIPEFAIL}gunzip | ${D2} load`),
      srcName: src.name,
      dstName: dst.name,
    });
    ctx.log(`Images copied (${fmtBytes(r.bytes)} compressed)`);
  } else ctx.log(`All ${plan.images.length} image(s) already on ${dst.name}`);
  // Containers can name an image by a tag that now points elsewhere; tag the exact ID they run.
  const tags = [];
  for (const st of plan.stacks) {
    for (const c of st.containers) if (c.ref && !c.ref.startsWith('sha256:')) tags.push(`${D2} tag ${shq(c.imageId)} ${shq(c.ref)}`);
  }
  if (tags.length) await root(ctx, dstConn, dst, `${[...new Set(tags)].join(' 2>/dev/null; ')} 2>/dev/null; true`);
}

/** Copy one named volume's data (owner IDs kept as numbers — they're container users). */
async function copyVolume(ctx, { src, dst, srcConn, dstConn, vol, live }) {
  const D2 = rootDocker(dst);
  const labels = Object.entries(vol.Labels || {})
    .map(([k, v]) => `--label ${shq(`${k}=${v}`)}`)
    .join(' ');
  const opts = Object.entries(vol.Options || {})
    .map(([k, v]) => `--opt ${shq(`${k}=${v}`)}`)
    .join(' ');
  const name = shq(vol.Name);
  const inUse = (await root(ctx, dstConn, dst, `${D2} ps -aq --filter volume=${name}`)).trim();
  if (inUse) throw new Error(`Volume ${vol.Name} is in use by a container on ${dst.name}`);
  const mount = (
    await root(ctx, dstConn, dst, `${D2} volume inspect ${name} >/dev/null 2>&1 || ${D2} volume create --driver ${shq(vol.Driver || 'local')} ${labels} ${opts} ${name} >/dev/null; ${D2} volume inspect --format '{{.Mountpoint}}' ${name}`)
  ).trim();
  if (vol.Options && Object.keys(vol.Options).length) {
    ctx.log(`  volume ${vol.Name}: created with the same driver options (data lives outside the server — not copied)`);
    return 0;
  }
  if (!vol.Mountpoint || !mount) throw new Error(`Volume ${vol.Name}: no mount point`);
  const r = await streamCopy(ctx, {
    srcConn,
    srcCmd: asRoot(src, `tar -C ${shq(vol.Mountpoint)} --numeric-owner -cpzf - .`),
    dstConn,
    dstCmd: asRoot(dst, `find ${shq(mount)} -mindepth 1 -delete && tar -C ${shq(mount)} --numeric-owner -xpzf -`),
    srcName: src.name,
    dstName: dst.name,
    okSrcCodes: live ? [0, 1] : [0],
  });
  ctx.log(`  volume ${vol.Name}: ${fmtBytes(r.bytes)} compressed`);
  return r.bytes;
}

async function removeStack(ctx, conn, server, project) {
  const D = rootDocker(server);
  ctx.log(`Removing the existing "${project}" containers on ${server.name} (volumes are replaced next)`);
  await root(ctx, conn, server, `ids=$(${D} ps -aq --filter label=com.docker.compose.project=${shq(project)}); [ -n "$ids" ] && ${D} rm -f $ids >/dev/null; true`);
}

export async function copyStack(ctx, { src, dst, srcConn, dstConn, st, freeze, replace, dstHas }) {
  const D1 = rootDocker(src);
  ctx.step(`Stack "${st.project}"${st.dir ? ` (${st.dir})` : ''}: ${st.containers.length} container(s), ${st.volumes.length} volume(s)`);
  if (dstHas && replace) await removeStack(ctx, dstConn, dst, st.project);
  const wanted = freeze ? st.containers.filter((c) => c.state === 'running').map((c) => c.name) : [];
  // One by one: a container that is restarting (crash loop) or stopped since the scan can't be
  // paused — skip it instead of failing, and never leave the ones already paused frozen.
  let toPause = [];
  let skipped = [];
  if (wanted.length) {
    ctx.log(`Pausing ${wanted.join(', ')} on ${src.name} so the data is copied in one consistent state`);
    let out;
    try {
      out = await root(
        ctx,
        srcConn,
        src,
        `for c in ${wanted.map(shq).join(' ')}; do s=$(${D1} inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
  if [ "$s" = running ] && ${D1} pause "$c" >/dev/null 2>&1; then echo "PAUSED $c"; else echo "SKIP $c $s"; fi; done; true`,
      );
    } catch (e) {
      // Unknown how far it got: unpause all of them (unpausing a running container is harmless).
      await runRemote(ctx, srcConn, asRoot(src, `for c in ${wanted.map(shq).join(' ')}; do ${D1} unpause "$c" >/dev/null 2>&1; done; true`), { quiet: true, signal: null, timeout: 60000 }).catch(() =>
        ctx.warn(`Could not make sure ${wanted.join(', ')} are unpaused on ${src.name} — check with "docker ps" there NOW`),
      );
      throw e;
    }
    toPause = lines(out).filter((l) => l.startsWith('PAUSED ')).map((l) => l.slice(7));
    skipped = lines(out).filter((l) => l.startsWith('SKIP ')).map((l) => l.slice(5).split(' '));
    for (const [name, state] of skipped) {
      ctx.warn(`${name} on ${src.name} could not be paused (it is ${state === 'restarting' ? 'restarting — probably crashing in a loop, check its logs' : state}) — its data is copied live`);
    }
  }
  const live = (!toPause.length || skipped.length > 0) && st.running;
  try {
    if (st.dir) {
      const r = await streamCopy(ctx, {
        srcConn,
        srcCmd: asRoot(src, `[ -d ${shq(st.dir)} ] || { echo 'Folder not found: '${shq(st.dir)} >&2; exit 3; }; tar -C ${shq(st.dir)} --numeric-owner -cpzf - .`),
        dstConn,
        dstCmd: asRoot(dst, `mkdir -p ${shq(st.dir)} && tar -C ${shq(st.dir)} --numeric-owner -xpzf -`),
        srcName: src.name,
        dstName: dst.name,
        okSrcCodes: [0, 1],
      });
      ctx.log(`  folder ${st.dir}: ${fmtBytes(r.bytes)} compressed`);
    }
    if (st.binds.length) {
      const exist = lines(await root(ctx, srcConn, src, `for p in ${st.binds.map(shq).join(' ')}; do [ -e "$p" ] && echo "$p"; done; true`));
      if (exist.length) {
        const r = await streamCopy(ctx, {
          srcConn,
          srcCmd: asRoot(src, `tar -C / --numeric-owner -cpzf - ${exist.map((p) => shq(rel(p))).join(' ')}`),
          dstConn,
          dstCmd: asRoot(dst, 'tar -C / --numeric-owner -xpzf -'),
          srcName: src.name,
          dstName: dst.name,
          okSrcCodes: [0, 1],
        });
        ctx.log(`  outside paths ${exist.join(', ')}: ${fmtBytes(r.bytes)} compressed`);
      }
    }
    for (const vol of st.volumes) await copyVolume(ctx, { src, dst, srcConn, dstConn, vol, live });
  } finally {
    if (toPause.length) {
      try {
        await runRemote(ctx, srcConn, asRoot(src, `${D1} unpause ${toPause.map(shq).join(' ')} >/dev/null`), { quiet: true, signal: null, timeout: 60000 });
        ctx.log(`Unpaused ${toPause.join(', ')} on ${src.name}`);
      } catch (e) {
        ctx.warn(`Could not unpause ${toPause.join(', ')} on ${src.name}: ${e.message} — run "docker unpause" there NOW`);
      }
    }
  }
}

/**
 * Swap listen addresses in one file: compose port bindings ("IP:host:container", host_ip: IP)
 * and, in .env, only variables named like *BIND* / *LISTEN* / *HOST_IP* / *PUBLISH* — never e.g.
 * DB_HOST, which may point to another server on purpose.
 */
export function bindIpText(file, text, ipMap) {
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isEnv = /(^|\/)\.env$/.test(file);
  let t = String(text);
  let n = 0;
  for (const [from, to] of Object.entries(ipMap)) {
    const re = isEnv
      ? new RegExp(`^([A-Za-z0-9_]*(?:BIND|LISTEN|HOST_IP|PUBLISH)[A-Za-z0-9_]*=["']?)${esc(from)}(?=["']?\\s*$)`, 'gm')
      : new RegExp(`(^|[\\s"'\\[,]|host_ip:\\s*["']?)${esc(from)}(?=(:\\d|["']?\\s*$))`, 'gm');
    t = t.replace(re, (_, a) => {
      n++;
      return `${a}${to}`;
    });
  }
  return { text: t, n };
}

/** Put the target's addresses into the compose files where the source's were bound (see planBindIps). */
async function rewriteBindIps(ctx, conn, server, st) {
  const files = st.configFiles.length ? st.configFiles : [`${st.dir}/docker-compose.yml`];
  const list = [...files, `${st.dir}/.env`];
  const out = await root(ctx, conn, server, `for f in ${list.map(shq).join(' ')}; do [ -f "$f" ] && { echo "@@file $f"; base64 < "$f" | tr -d '\\n'; echo; }; done; true`);
  const got = {};
  let cur = null;
  for (const l of String(out).split('\n')) {
    const m = l.match(/^@@file (.+)$/);
    if (m) cur = m[1];
    else if (cur && l.trim()) got[cur] = Buffer.from(l.trim(), 'base64').toString('utf8');
  }
  const writes = [];
  for (const [f, text] of Object.entries(got)) {
    const { text: t, n } = bindIpText(f, text, st.ipMap);
    if (n) {
      writes.push(`printf %s ${shq(Buffer.from(t).toString('base64'))} | base64 -d > ${shq(`${f}.sb-tmp`)} && cat ${shq(`${f}.sb-tmp`)} > ${shq(f)} && rm -f ${shq(`${f}.sb-tmp`)}`);
      ctx.log(`  ${f}: listen address ${Object.entries(st.ipMap).map(([a, b]) => `${a} → ${b}`).join(', ')} (${n} place(s))`);
    }
  }
  if (writes.length) await root(ctx, conn, server, `set -e\n${writes.join('\n')}`);
  else ctx.warn(`${st.project}: could not find ${Object.keys(st.ipMap).join(', ')} in its compose files — if it fails to start, change the listen address there by hand`);
}

/** Start the stack on the target the way it was on the source (running services up, stopped ones created). */
export async function startStack(ctx, conn, server, st) {
  const D = rootDocker(server);
  if (!st.dir) return;
  if (st.ipMap && Object.keys(st.ipMap).length) await rewriteBindIps(ctx, conn, server, st);
  const files = st.configFiles.map((f) => `-f ${shq(f)}`).join(' ');
  const base = `cd ${shq(st.dir)} && ${D} compose -p ${shq(st.project)} ${files}`;
  ctx.step(`Start "${st.project}" on ${server.name}`);
  const mode = st.running ? 'up -d' : 'up --no-start';
  try {
    await runRemote(ctx, conn, asRoot(server, `${base} ${mode} --no-build --pull never`), { timeout: 15 * 60000 });
  } catch (e) {
    if (!/unknown flag|pull/i.test(e.message)) throw e;
    await runRemote(ctx, conn, asRoot(server, `${base} ${mode} --no-build`), { timeout: 15 * 60000 });
  }
  const stopped = [...new Set(st.containers.filter((c) => !c.running).map((c) => c.service))];
  if (st.running && stopped.length) {
    await root(ctx, conn, server, `${base} stop ${stopped.map(shq).join(' ')} >/dev/null 2>&1; true`);
    ctx.log(`Kept stopped like on the source: ${stopped.join(', ')}`);
  }
}

export async function verifyStacks(ctx, conn, server, stacks) {
  const D = rootDocker(server);
  await sleep(8000);
  let bad = 0;
  for (const st of stacks) {
    if (!st.dir) continue;
    const out = await root(ctx, conn, server, `${D} ps -a --filter label=com.docker.compose.project=${shq(st.project)} --format '{{.Names}}|{{.State}}|{{.Status}}'`);
    const want = new Map(st.containers.map((c) => [c.name, c.running]));
    for (const l of lines(out)) {
      const [name, state, status] = l.split('|');
      const shouldRun = want.get(name);
      const ok = shouldRun === undefined || (shouldRun ? state === 'running' : state !== 'running');
      if (!ok) bad++;
      (ok ? ctx.log : ctx.warn)(`  ${name}: ${status}`);
    }
  }
  return bad;
}

/** Add the new server to every project the source server is part of, as a standby. */
function addToProjects(ctx, src, dst) {
  const added = [];
  for (const d of deploymentsOnServer(src.id)) {
    if (get('SELECT id FROM deployments WHERE project_id = ? AND server_id = ?', d.project_id, dst.id)) {
      ctx.log(`Project #${d.project_id}: ${dst.name} is already part of it — left as is`);
      continue;
    }
    insert('deployments', {
      project_id: d.project_id,
      server_id: dst.id,
      priority: d.priority + 1,
      app_dir: d.app_dir,
      app_container: d.app_container,
      db_type: d.db_type,
      db_container: d.db_container,
      db_name: d.db_name,
      db_user: d.db_user,
      db_password: d.db_password,
      health: 'unknown',
      maintenance: 0,
      data_at: now(),
      data_note: `Cloned from ${src.name}`,
      created_at: now(),
    });
    added.push(d.project_id);
  }
  return added;
}

/** Same Node.js setup as the source: nvm folders / manual /usr/local install, then global npm packages. */
export async function copyNodeRuntime(ctx, { src, dst, srcConn, dstConn, plan }) {
  if (plan.nodePaths.length) {
    // nvm needs its lines in the shell startup files too.
    const rc = [];
    for (const n of plan.nodePaths.filter((p) => p.endsWith('/.nvm'))) {
      const home = n.slice(0, -5);
      const found = lines(await root(ctx, srcConn, src, `for f in .bashrc .profile .bash_profile .zshrc; do grep -qs NVM_DIR ${shq(home)}/"$f" && echo ${shq(home)}/"$f"; done; true`));
      rc.push(...found);
    }
    ctx.step(`Copy Node.js from ${src.name}: ${plan.nodePaths.join(', ')}`);
    await copyHostFiles(ctx, { src, dst, srcConn, dstConn, paths: [...plan.nodePaths, ...rc], quiet: true });
  }
  if (plan.npmGlobals.length) {
    const list = plan.npmGlobals.map((g) => shq(`${g.name}@${g.version}`)).join(' ');
    ctx.step(`Install global npm packages on ${dst.name}: ${plan.npmGlobals.map((g) => `${g.name}@${g.version}`).join(' ')}`);
    try {
      await runRemote(ctx, dstConn, asRoot(dst, `command -v npm >/dev/null || { echo 'npm is not installed' >&2; exit 3; }; npm install -g --no-fund --no-audit ${list}`), { timeout: 20 * 60000 });
    } catch (e) {
      ctx.warn(`Global npm packages not installed: ${e.message}`);
    }
  }
}

/** Bring back each user's PM2 apps from the source's live list, in the same state (online/stopped). */
async function restorePm2(ctx, { dst, dstConn, srcScan }) {
  for (const u of srcScan.hostApps.pm2) {
    if (!u.alive || !u.list.length) continue;
    const dump = JSON.stringify(pm2Dump(u.list));
    const stopped = u.list.filter((p) => p.pm2_env?.status === 'stopped').map((p) => p.name);
    ctx.step(`Start PM2 apps of ${u.user} on ${dst.name}: ${u.list.map((p) => p.name).join(', ')}`);
    const stopCmds = [...new Set(stopped)].map((n) => `pm2run ${shq(u.user)} ${shq(`stop ${shq(n)}`)} >/dev/null`).join('\n');
    try {
      await runRemote(
        ctx,
        dstConn,
        asRoot(
          dst,
          `${PM2RUN}
u=${shq(u.user)}; h=$(getent passwd "$u" | cut -d: -f6); [ -n "$h" ] || { echo "user $u does not exist" >&2; exit 3; }
mkdir -p "$h/.pm2" && cat > "$h/.pm2/dump.pm2" && chown -R "$u" "$h/.pm2"
pm2run "$u" resurrect
${stopCmds}
pm2run "$u" 'save --force' >/dev/null`,
        ),
        { stdin: dump, timeout: 5 * 60000 },
      );
      if (stopped.length) ctx.log(`Kept stopped like on the source: ${stopped.join(', ')}`);
    } catch (e) {
      ctx.warn(`PM2 apps of ${u.user} not started: ${e.message}`);
    }
  }
}

async function verifyPm2(ctx, conn, server, srcScan) {
  let bad = 0;
  for (const u of srcScan.hostApps.pm2) {
    if (!u.alive || !u.list.length) continue;
    const out = await root(ctx, conn, server, `${PM2RUN}\npm2run ${shq(u.user)} jlist 2>/dev/null | grep '^\\[' | tail -1`).catch(() => '');
    let now = [];
    try {
      now = JSON.parse(out.trim() || '[]');
    } catch {}
    for (const p of u.list) {
      const t = now.find((x) => x.name === p.name);
      const want = p.pm2_env?.status;
      const got = t?.pm2_env?.status || 'missing';
      const ok = got === want || (want !== 'online' && got !== 'online');
      if (!ok) bad++;
      (ok ? ctx.log : ctx.warn)(`  pm2 ${u.user}/${p.name}: ${got}`);
    }
  }
  return bad;
}

/* ------------------------------------------------------------------ job */

export function cloneOptions(p = {}) {
  return {
    installDocker: p.installDocker !== false,
    host: p.host !== false,
    hostApps: p.hostApps !== false,
    freeze: p.freeze !== false,
    replace: !!p.replace,
    addToProjects: p.addToProjects !== false,
    extraPaths: (Array.isArray(p.extraPaths) ? p.extraPaths : String(p.extraPaths || '').split('\n'))
      .map((x) => String(x).trim())
      .filter((x) => /^\/[^\0\n\r]+$/.test(x) && x !== '/'),
  };
}

/** Preview: scan both servers, change nothing. */
export async function previewClone(src, dst, raw) {
  const opts = cloneOptions(raw);
  const quiet = { log() {}, warn() {}, step() {}, output() {}, signal: new AbortController().signal };
  const [srcConn, dstConn] = await Promise.all([connectTo(null, src), connectTo(null, dst)]);
  try {
    const [srcScan, dstScan] = await Promise.all([scanServer(null, srcConn, src), scanServer(null, dstConn, dst)]);
    const plan = await makePlan(quiet, { src, dst, srcConn, srcScan, dstScan, opts });
    return planSummary(plan, srcScan, dstScan, src, dst, opts);
  } finally {
    srcConn.end();
    dstConn.end();
  }
}

export async function runClone(ctx, p, { onProjectsAdded } = {}) {
  const src = getServer(Number(p.source));
  const dst = getServer(Number(p.target));
  if (!src || !dst) throw new Error('Server not found (was it removed?)');
  if (src.id === dst.id) throw new Error('Source and target are the same server');
  const opts = cloneOptions(p);
  ctx.log(`Clone ${src.name} (${src.ip}) → ${dst.name} (${dst.ip})`);

  let srcConn = await connectTo(ctx, src);
  let dstConn = null;
  try {
    dstConn = await connectTo(ctx, dst);
    ctx.step('Scan both servers');
    const [srcScan, dstScan] = await Promise.all([scanServer(ctx, srcConn, src), scanServer(ctx, dstConn, dst)]);
    ctx.log(`${src.name}: ${srcScan.os.pretty}, ${srcScan.arch}, Docker ${srcScan.docker}`);
    ctx.log(`${dst.name}: ${dstScan.os.pretty}, ${dstScan.arch}, Docker ${dstScan.docker}, ${fmtBytes(dstScan.diskFreeKb * 1024)} free`);
    const plan = await makePlan(ctx, { src, dst, srcConn, srcScan, dstScan, opts });
    for (const w of plan.warnings) ctx.warn(w);
    if (plan.problems.length) throw new Error(plan.problems.join(' · '));
    ctx.log(`Plan: ${plan.stacks.length} stack(s), ${plan.toCopy.length} image(s) to copy, about ${fmtBytes(plan.bytes.total)} of data`);
    ctx.throwIfCancelled();

    // 1. Docker
    dstConn = await ensureDocker(ctx, dstConn, dst, dstScan);
    ctx.throwIfCancelled();

    // 2. Host setup
    if (opts.host) {
      if (plan.aptRepos.length) {
        ctx.step(`Copy extra apt repositories (same OS on both): ${plan.aptRepos.map((p) => p.split('/').pop()).join(', ')}`);
        await copyHostFiles(ctx, { src, dst, srcConn, dstConn, paths: plan.aptRepos, quiet: true });
      }
      await installPackages(ctx, dstConn, dst, plan.packages);
      await copyUsers(ctx, dstConn, dst, srcScan, dstScan);
      await copyKeys(ctx, dstConn, dst, srcScan);
      await setTimezone(ctx, dstConn, dst, srcScan.timezone, dstScan.timezone);
      const unitPaths = srcScan.units.filter((u) => !UNIT_SKIP.test(u.name)).map((u) => `/etc/systemd/system/${u.name}`);
      const copied = await copyHostFiles(ctx, { src, dst, srcConn, dstConn, paths: [...srcScan.hostPaths, ...unitPaths, ...opts.extraPaths] });
      await copySudoers(ctx, { src, dst, srcConn, dstConn });
      if (opts.hostApps) await copyNodeRuntime(ctx, { src, dst, srcConn, dstConn, plan });
      if (copied && copied.includes('/etc/docker/daemon.json')) {
        ctx.log('Docker daemon.json copied — restarting Docker to apply it');
        await root(ctx, dstConn, dst, '(systemctl restart docker 2>/dev/null || service docker restart >/dev/null 2>&1); true');
        await waitDocker(ctx, dstConn, dst);
      }
      await addSwap(ctx, dstConn, dst, srcScan.swapKb, dstScan.swapKb);
      ctx.throwIfCancelled();
    }

    // 3. Images
    await copyImages(ctx, { src, dst, srcConn, dstConn, plan });
    ctx.throwIfCancelled();

    // 4. Stacks (folders, outside paths, volumes)
    const dstProjects = new Set(dstScan.containers.map((c) => c.Config?.Labels?.['com.docker.compose.project']).filter(Boolean));
    for (const st of plan.stacks) {
      await copyStack(ctx, { src, dst, srcConn, dstConn, st, freeze: opts.freeze, replace: opts.replace, dstHas: dstProjects.has(st.project) });
      ctx.throwIfCancelled();
    }
    if (plan.looseVolumes.length) {
      ctx.step(`Copy ${plan.looseVolumes.length} volume(s) not used by any container`);
      for (const vol of plan.looseVolumes) await copyVolume(ctx, { src, dst, srcConn, dstConn, vol, live: true });
    }

    // 5. Start everything
    for (const st of plan.stacks) await startStack(ctx, dstConn, dst, st);
    ctx.step(`Check containers on ${dst.name}`);
    const bad = await verifyStacks(ctx, dstConn, dst, plan.stacks);
    if (bad) ctx.warn(`${bad} container(s) are not in the same state as on ${src.name} — check their logs`);

    // 6. Apps outside Docker: folders, then PM2 lists
    let badApps = 0;
    if (opts.hostApps) {
      if (!opts.host && plan.nodePaths.length) await copyNodeRuntime(ctx, { src, dst, srcConn, dstConn, plan });
      if (plan.appDirs.length) {
        await copyHostFiles(ctx, { src, dst, srcConn, dstConn, paths: plan.appDirs, title: `Copy app folders (not in Docker): ${plan.appDirs.join(', ')}` });
      }
      await restorePm2(ctx, { dst, dstConn, srcScan });
    }

    // 7. Host services that depend on the apps (cron, units, nginx, firewall last)
    if (opts.host) {
      await copyCrontabs(ctx, dstConn, dst, srcScan);
      await enableUnits(ctx, dstConn, dst, srcScan.units);
      await reloadHostServices(ctx, dstConn, dst);
      if (srcScan.ufw === 'active') await enableFirewall(ctx, dstConn, dst);
    }
    if (opts.hostApps && srcScan.hostApps.pm2.some((u) => u.alive && u.list.length)) {
      ctx.step(`Check PM2 apps on ${dst.name}`);
      await sleep(3000);
      badApps = await verifyPm2(ctx, dstConn, dst, srcScan);
      if (badApps) ctx.warn(`${badApps} PM2 app(s) are not in the same state as on ${src.name} — check their logs`);
    }

    // 8. Projects
    let added = [];
    if (opts.addToProjects) {
      added = addToProjects(ctx, src, dst);
      if (added.length) {
        ctx.step(`Added ${dst.name} as a standby to ${added.length} project(s)`);
        await onProjectsAdded?.(added);
      }
    }
    ctx.log(`Done. ${dst.name} is a copy of ${src.name}. Traffic was NOT moved — use Switch on each project when you're ready.`);
    ctx.log('Tip: if an app config (.env) contains the old server IP, update it on the new server.');
    return { stacks: plan.stacks.length, images: plan.toCopy.length, bytes: plan.bytes.total, added, bad: bad + badApps };
  } finally {
    srcConn?.end();
    dstConn?.end();
  }
}


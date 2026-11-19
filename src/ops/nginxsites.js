import { connect, exec } from '../ssh.js';
import { asRoot, shq } from './remote.js';

/**
 * Nginx sites on a server's own nginx (the Debian/Ubuntu "sites-available" layout):
 * list, read, write, turn on/off and delete site files. Every change is checked with
 * `nginx -t` first and put back as it was when nginx rejects it, so a typo never takes
 * the web server down. Files in /etc/nginx/conf.d are listed and editable too.
 */

export const AVAIL = '/etc/nginx/sites-available';
export const ENABLED = '/etc/nginx/sites-enabled';
export const CONFD = '/etc/nginx/conf.d';
export const CERT = '/etc/nginx/ssl/switchboard-selfsigned.pem';
export const KEY = '/etc/nginx/ssl/switchboard-selfsigned.key';
export const MAX_SIZE = 64 * 1024;

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const DIRS = { sites: AVAIL, confd: CONFD };

/** The full path of a site file, or '' when the name or folder is not allowed. */
export function sitePath(dir, name) {
  if (!DIRS[dir] || !NAME_RE.test(name || '') || name.includes('..')) return '';
  if (dir === 'confd' && !name.endsWith('.conf')) return '';
  return `${DIRS[dir]}/${name}`;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const clean = (s) => String(s || '').replace(/\x1eSBPGID \d+\n?/g, '').trim();

async function run(server, script, timeout = 30000) {
  const conn = await connect(server, { timeout: 15000 });
  try {
    return await exec(conn, asRoot(server, script), { timeout });
  } finally {
    conn.end();
  }
}

// Shell: test the config, reload nginx when it passes. Prints "OK" or "BAD <reason>".
const TEST_RELOAD = `if nginx -t >/dev/null 2>&1; then
  { systemctl reload nginx 2>/dev/null || service nginx reload >/dev/null 2>&1 || nginx -s reload; } && echo OK || echo "BAD nginx accepted the config but did not reload"
else
  R=$(nginx -t 2>&1 | grep -v 'test failed' | tail -2 | tr '\\n' ' ')
  restore
  echo "BAD $R"
fi`;

function result(r, what) {
  const line = r.stdout.split('\n').map((l) => l.trim()).find((l) => l === 'OK' || l.startsWith('BAD ') || l.startsWith('NO '));
  if (line === 'OK') return { ok: true };
  if (line) return { ok: false, error: line.replace(/^(BAD|NO) /, '') };
  return { ok: false, error: clean(r.stderr).split('\n').pop() || `Could not ${what}` };
}

/** Parse the listing script's output (exported for tests). */
export function parseListing(out) {
  const res = { nginx: false, version: '', layout: 'none', cert: false, sites: [] };
  let cur = null;
  for (const raw of out.split('\n')) {
    const l = raw.trimEnd();
    if (l.startsWith('@nginx ')) {
      res.nginx = true;
      res.version = l.slice(7).replace(/^nginx version:\s*/, '').trim();
    } else if (l.startsWith('@layout ')) res.layout = l.slice(8).trim();
    else if (l === '@cert') res.cert = true;
    else if (l.startsWith('@file ')) {
      const [, dir, enabled, ...rest] = l.split(' ');
      cur = { dir, name: rest.join(' '), enabled: enabled === '1', hosts: [], locations: [], ports: [] };
      res.sites.push(cur);
    } else if (cur && /^\s*server_name\s/.test(l)) {
      for (const h of l.replace(/^\s*server_name\s+/, '').replace(/;.*$/, '').split(/\s+/)) if (h && !cur.hosts.includes(h)) cur.hosts.push(h);
    } else if (cur && /^\s*location\s/.test(l)) {
      const loc = l.replace(/^\s*location\s+/, '').replace(/\s*\{.*$/, '').trim();
      if (loc && !cur.locations.includes(loc)) cur.locations.push(loc);
    } else if (cur && /^\s*listen\s/.test(l)) {
      const p = l.match(/(?:^|[\s:])(\d{2,5})(?=[\s;])/);
      if (p && !cur.ports.includes(p[1])) cur.ports.push(p[1]);
    }
  }
  // Switchboard writes sb-*.conf itself (Connect domain / new app): editing them by hand is undone.
  for (const s of res.sites) s.managed = s.dir === 'confd' && (s.name.startsWith('sb-') || s.name === '00-switchboard.conf');
  return res;
}

/** Everything on the Nginx sites tab: is nginx there, which layout, and each site file. */
export async function listSites(server) {
  const script = `
if ! command -v nginx >/dev/null 2>&1; then echo @layout none; exit 0; fi
echo "@nginx $(nginx -v 2>&1)"
if [ -d ${AVAIL} ] && [ -d ${ENABLED} ] && grep -qsE '^[^#]*include[^;]*sites-enabled' /etc/nginx/nginx.conf; then echo @layout sites; else echo @layout confd; fi
[ -s ${CERT} ] && [ -s ${KEY} ] && echo @cert
show() { grep -E '^[[:space:]]*(server_name|location|listen)[[:space:]]' "$1" 2>/dev/null | head -n 60; }
if [ -d ${AVAIL} ]; then for f in ${AVAIL}/*; do [ -f "$f" ] || continue; n=$(basename "$f"); e=0
  for l in ${ENABLED}/*; do [ -e "$l" ] && [ "$(readlink -f "$l")" = "$(readlink -f "$f")" ] && e=1; done
  echo "@file sites $e $n"; show "$f"; done; fi
for f in ${CONFD}/*.conf; do [ -f "$f" ] || continue; echo "@file confd 1 $(basename "$f")"; show "$f"; done
true`;
  const r = await run(server, script);
  if (r.code) throw new Error(clean(r.stderr).split('\n').pop() || 'Could not read the nginx sites');
  return parseListing(r.stdout);
}

/** The text of one site file. */
export async function readSite(server, dir, name) {
  const p = sitePath(dir, name);
  if (!p) throw new Error('Unknown site file');
  const r = await run(server, `[ -f ${shq(p)} ] || { echo "NO such file" >&2; exit 4; }; head -c ${MAX_SIZE + 1} ${shq(p)}`);
  if (r.code) throw new Error(clean(r.stderr).split('\n').pop() || `Could not read ${p}`);
  if (r.stdout.length > MAX_SIZE) throw new Error(`${p} is bigger than ${MAX_SIZE / 1024} KB — edit it on the server`);
  return r.stdout;
}

/**
 * Set up the sites-available layout: the two folders, the include line in nginx.conf
 * (inside the http block, after the conf.d include) and a self-signed certificate for
 * port 443 behind Cloudflare (SSL mode "Full"). nginx.conf is put back if nginx rejects it.
 */
export async function setupSites(server) {
  const script = `set -u
command -v nginx >/dev/null 2>&1 || { echo "NO nginx is not installed on this server"; exit 0; }
C=/etc/nginx/nginx.conf
[ -f "$C" ] || { echo "NO $C not found"; exit 0; }
mkdir -p ${AVAIL} ${ENABLED} /etc/nginx/ssl
if [ ! -s ${CERT} ] || [ ! -s ${KEY} ]; then
  command -v openssl >/dev/null 2>&1 || { DEBIAN_FRONTEND=noninteractive apt-get install -y -q openssl >/dev/null 2>&1 || dnf install -y -q openssl >/dev/null 2>&1 || true; }
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -subj '/CN=switchboard' -keyout ${KEY} -out ${CERT} >/dev/null 2>&1 && chmod 600 ${KEY}
fi
cp -p "$C" /tmp/nginx.conf.sb-bak
restore() { cp -p /tmp/nginx.conf.sb-bak "$C"; }
if ! grep -qsE '^[^#]*include[^;]*sites-enabled' "$C"; then
  if grep -qE '^[^#]*include[[:space:]]+/etc/nginx/conf\\.d/\\*\\.conf;' "$C"; then
    sed -i '0,/^\\([^#]*\\)include[[:space:]]\\+\\/etc\\/nginx\\/conf\\.d\\/\\*\\.conf;/s//&\\n    include ${ENABLED.replace(/\//g, '\\/')}\\/*;/' "$C"
  else
    sed -i '0,/^[[:space:]]*http[[:space:]]*{/s//&\\n    include ${ENABLED.replace(/\//g, '\\/')}\\/*;/' "$C"
  fi
  grep -qsE '^[^#]*include[^;]*sites-enabled' "$C" || { restore; echo "NO could not find the http { } block in $C"; exit 0; }
fi
${TEST_RELOAD}`;
  return result(await run(server, script, 120000), 'set up sites-available');
}

/**
 * Write a site file. With `enable`, also links it into sites-enabled. The old file (if any)
 * is kept as a backup and put back when nginx rejects the new one.
 */
export async function saveSite(server, { dir, name, text, enable }) {
  const p = sitePath(dir, name);
  if (!p) throw new Error('Name: letters, numbers, dot, - and _ (files in conf.d end with .conf)');
  const body = String(text || '').replace(/\r\n/g, '\n');
  if (!body.trim()) throw new Error('The file is empty');
  if (Buffer.byteLength(body) > MAX_SIZE) throw new Error(`Keep it under ${MAX_SIZE / 1024} KB`);
  const link = `${ENABLED}/${name}`;
  const script = `set -u
F=${shq(p)}; L=${shq(link)}; B=/tmp/sb-site-$$.bak; HAD=0; LINKED=0
mkdir -p "$(dirname "$F")"
[ -f "$F" ] && { cp -p "$F" "$B"; HAD=1; }
[ -L "$L" ] && LINKED=1
restore() { if [ "$HAD" = 1 ]; then mv "$B" "$F"; else rm -f "$F"; fi; [ "$LINKED" = 0 ] && [ -L "$L" ] && rm -f "$L"; true; }
printf %s ${shq(b64(body))} | base64 -d > "$F.sb-new" && mv "$F.sb-new" "$F" || { echo "NO could not write $F"; exit 0; }
${dir === 'sites' && enable ? `mkdir -p ${ENABLED}; ln -sfn "$F" "$L"` : ''}
${TEST_RELOAD}
rm -f "$B"`;
  return result(await run(server, script, 60000), `save ${p}`);
}

/** Turn a sites-available file on (link in sites-enabled) or off (remove the link). */
export async function enableSite(server, name, on) {
  const p = sitePath('sites', name);
  if (!p) throw new Error('Unknown site');
  const link = `${ENABLED}/${name}`;
  const script = `set -u
F=${shq(p)}; L=${shq(link)}
[ -f "$F" ] || { echo "NO $F does not exist"; exit 0; }
${on
    ? `[ -e "$L" ] && { echo OK; exit 0; }
restore() { rm -f "$L"; }
mkdir -p ${ENABLED}; ln -sfn "$F" "$L"`
    : `[ -L "$L" ] || [ -e "$L" ] || { echo OK; exit 0; }
T=$(readlink "$L" || echo "$F")
restore() { ln -sfn "$T" "$L"; }
rm -f "$L"`}
${TEST_RELOAD}`;
  return result(await run(server, script), on ? 'turn the site on' : 'turn the site off');
}

/** Delete a site file (and its sites-enabled link). Put back if nginx would not start without it. */
export async function deleteSite(server, dir, name) {
  const p = sitePath(dir, name);
  if (!p) throw new Error('Unknown site');
  const link = `${ENABLED}/${name}`;
  const script = `set -u
F=${shq(p)}; L=${shq(link)}; B=/tmp/sb-site-$$.bak; LINKED=0
[ -f "$F" ] || { echo OK; exit 0; }
cp -p "$F" "$B"
${dir === 'sites' ? '[ -L "$L" ] && LINKED=1; rm -f "$L"' : ''}
restore() { mv "$B" "$F"; [ "$LINKED" = 1 ] && ln -sfn "$F" "$L"; true; }
rm -f "$F"
${TEST_RELOAD}
rm -f "$B"`;
  return result(await run(server, script), `delete ${p}`);
}

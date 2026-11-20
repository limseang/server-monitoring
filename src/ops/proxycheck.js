import { shq } from './remote.js';

// The pure parts of the project web proxy (src/ops/proxy.js): domain names, folders, the check script and its output.
// No database here, so tests can import it.

export const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
export const proxySiteName = (projectId) => `proj-${projectId}`;
export const OUR_FILE = (projectId) => `sb-${proxySiteName(projectId)}.conf`;

/** "Example.com  www.example.com," → ['example.com', 'www.example.com'] (deduped), or throws. */
export function parseHosts(input) {
  const list = String(input || '').toLowerCase().split(/[\s,]+/).map((h) => h.replace(/\.+$/, '')).filter(Boolean);
  const out = [...new Set(list)];
  if (!out.length) throw new Error('Type the domain visitors use, for example shop.example.com');
  if (out.length > 10) throw new Error('At most 10 domains');
  for (const h of out) if (!HOST_RE.test(h)) throw new Error(`"${h}" is not a domain name (letters, numbers, dots and -)`);
  return out;
}

// Folders nginx must never hand to the internet (the server helper refuses them too).
const BLOCKED_EXACT = new Set(['/etc', '/root', '/proc', '/sys', '/dev', '/boot', '/bin', '/sbin', '/usr', '/lib', '/lib64', '/var', '/home', '/srv']);

/** A website folder (built files: dist, build…): a clean absolute path, or throws. */
export function cleanSiteFolder(input) {
  const d = String(input || '').trim().replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9._/@+-]+$/.test(d) || /(^|\/)\.\.?(\/|$)/.test(d) || d.includes('//')) throw new Error(`"${input}" is not a folder path (for example /var/www/shop/dist)`);
  if (BLOCKED_EXACT.has(d) || /^\/(?:etc|proc|sys|dev|boot)(?:\/|$)/.test(d) || d.startsWith('/etc/switchboard')) throw new Error(`${d} can't be served to the internet — choose the folder with the built website (for example …/dist)`);
  return d;
}

/**
 * Shell: is the app there (port listening / folder with index.html), and which other enabled nginx sites already
 * serve these hosts. target: { port } or { folder }.
 */
export function checkScript(projectId, target, hosts) {
  const pat = hosts.map((h) => h.replace(/\./g, '\\.')).join('|');
  const here = target.folder
    ? `if [ -d ${shq(target.folder)} ]; then echo "@folder ok"; [ -f ${shq(`${target.folder}/index.html`)} ] && echo "@index yes" || echo "@index no"; else echo "@folder missing"; fi`
    : `ss -ltn "sport = :${Number(target.port)}" 2>/dev/null | tail -n +2 | grep -q . && echo "@port open" || echo "@port closed"`;
  return `${here}
for f in $( { grep -rlE ${shq(`server_name[^;]*[[:space:]](${pat})([[:space:];]|$)`)} /etc/nginx/conf.d /etc/switchboard/edge/conf.d 2>/dev/null; grep -RlE ${shq(`server_name[^;]*[[:space:]](${pat})([[:space:];]|$)`)} /etc/nginx/sites-enabled 2>/dev/null; } | sort -u); do
  case "$f" in */${OUR_FILE(projectId)}) continue ;; esac
  echo "@site $f"
  grep -hE '^[[:space:]]*(server_name|proxy_pass|root)[[:space:]]' "$f" | sed 's/^[[:space:]]*/  /'
done
true`;
}

/**
 * Parse checkScript's output (exported for tests). target: { port } or { folder } (a bare number = port).
 * → { open (app there), index (folder has index.html), same: [file] (sites that already send these hosts to the
 *     same app), other: [{ file, to }] (sites that send them elsewhere) }
 */
export function parseCheck(out, target, hosts) {
  const t = typeof target === 'object' ? target : { port: target };
  const text = String(out || '');
  const res = t.folder
    ? { open: /@folder ok/.test(text), index: /@index yes/.test(text), same: [], other: [] }
    : { open: /@port open/.test(text), same: [], other: [] };
  let cur = null;
  const local = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${Number(t.port)}(/|;|$)`);
  const flush = () => {
    if (!cur) return;
    if (!cur.names.some((n) => hosts.includes(n))) return; // the grep can match a longer name in a comment
    const same = t.folder
      ? !cur.proxies.length && cur.roots.length && cur.roots.every((r) => r.replace(/\/+$/, '') === t.folder)
      : cur.proxies.length && cur.proxies.every((p) => local.test(p));
    if (same) res.same.push(cur.file);
    else res.other.push({ file: cur.file, to: [...cur.proxies, ...cur.roots.map((r) => `folder ${r}`)].join(', ') || 'nginx' });
  };
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('@site ')) {
      flush();
      cur = { file: l.slice(6), names: [], proxies: [], roots: [] };
    } else if (cur) {
      const m = l.match(/^(server_name|proxy_pass|root)\s+([^;]*);?/);
      if (!m) continue;
      const args = m[2].trim().split(/\s+/).filter(Boolean);
      if (m[1] === 'server_name') cur.names.push(...args.map((a) => a.toLowerCase()));
      else if (m[1] === 'proxy_pass') cur.proxies.push(args[0]);
      else cur.roots.push(args[0]);
    }
  }
  flush();
  return res;
}

/**
 * Shell: built website folders on a server — the project's folder and its usual build outputs, and folders under
 * /var/www, /srv, /home and /opt that hold an index.html (dist, build, out, public…). Prints one folder per line.
 */
export function findFoldersScript(appDirs = []) {
  const dirs = appDirs.filter((d) => /^\/[A-Za-z0-9._/@+-]+$/.test(d || ''));
  const guesses = dirs.flatMap((d) => ['', '/dist', '/build', '/out', '/public', '/.output/public', '/dist/spa', '/www'].map((s) => d.replace(/\/+$/, '') + s));
  return `for d in ${guesses.map(shq).join(' ')}; do [ -f "$d/index.html" ] && echo "$d"; done
find /var/www /srv /home /opt -maxdepth 5 -type f -name index.html -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/vendor/*' 2>/dev/null | head -n 60 | while read -r f; do dirname "$f"; done
true`;
}

/** Parse findFoldersScript's output: unique folders, build outputs first, at most 25. */
export function parseFolders(out) {
  const seen = new Set();
  const list = [];
  for (const l of String(out || '').split('\n')) {
    const d = l.trim().replace(/\/+$/, '');
    if (!d.startsWith('/') || seen.has(d)) continue;
    seen.add(d);
    list.push(d);
  }
  const rank = (d) => (/\/(dist|build|out|\.output\/public|spa)$/.test(d) ? 0 : /\/(public|www|html)$/.test(d) ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b)).slice(0, 25);
}

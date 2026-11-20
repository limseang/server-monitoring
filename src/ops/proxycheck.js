import { shq } from './remote.js';

// The pure parts of the project web proxy (src/ops/proxy.js): domain names, the check script and its output.
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

/** Shell: does something listen on the port, and which other enabled nginx sites already serve these hosts. */
export function checkScript(projectId, port, hosts) {
  const pat = hosts.map((h) => h.replace(/\./g, '\\.').replace(/\*/g, '\\*')).join('|');
  return `ss -ltn "sport = :${port}" 2>/dev/null | tail -n +2 | grep -q . && echo "@port open" || echo "@port closed"
for f in $( { grep -rlE ${shq(`server_name[^;]*[[:space:]](${pat})([[:space:];]|$)`)} /etc/nginx/conf.d /etc/switchboard/edge/conf.d 2>/dev/null; grep -RlE ${shq(`server_name[^;]*[[:space:]](${pat})([[:space:];]|$)`)} /etc/nginx/sites-enabled 2>/dev/null; } | sort -u); do
  case "$f" in */${OUR_FILE(projectId)}) continue ;; esac
  echo "@site $f"
  grep -hE '^[[:space:]]*(server_name|proxy_pass|root)[[:space:]]' "$f" | sed 's/^[[:space:]]*/  /'
done
true`;
}

/**
 * Parse checkScript's output (exported for tests).
 * → { open, same: [file] (sites that already send these hosts to this port), other: [{ file, to }] (sites that send them elsewhere) }
 */
export function parseCheck(out, port, hosts) {
  const res = { open: /@port open/.test(out), same: [], other: [] };
  let cur = null;
  const flush = () => {
    if (!cur) return;
    if (!cur.names.some((n) => hosts.includes(n))) return; // the grep can match a longer name in a comment
    const local = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}(/|;|$)`);
    if (cur.proxies.length && cur.proxies.every((p) => local.test(p))) res.same.push(cur.file);
    else res.other.push({ file: cur.file, to: [...cur.proxies, ...cur.roots].join(', ') || 'nginx' });
  };
  for (const raw of String(out || '').split('\n')) {
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
      else cur.roots.push(`folder ${args[0]}`);
    }
  }
  flush();
  return res;
}


import crypto from 'node:crypto';
import * as cf from '../cloudflare.js';
import { getSetting } from '../settings.js';
import { parseJSON } from '../models.js';
import { connectTo, runRemote, asRoot, shq } from './remote.js';
import { installHelper, projectHosts } from './stack.js';
import { certHostnames } from './origincert.js';
import { parseServerBlocks, blockServes, nameMatches, absPath, planSiteEdit, certInfo, serverStatus } from './sslconf.js';

/**
 * SSL on a project's servers, in two steps:
 *
 * 1. Scan — read the server's nginx config (its own nginx and Switchboard's web proxy), find the server
 *    blocks for the project's host names and check the certificate files they use (there? which issuer?
 *    expiry? names? key matches?).
 * 2. Set up — get a certificate one of three ways and point those server blocks at it:
 *    - cloudflare: Cloudflare Origin Certificate (key made on the server, Cloudflare signs it — for "Full (strict)")
 *    - own:        a certificate + key the user pastes (bought, from another provider…)
 *    - acme:       Let's Encrypt or ZeroSSL with acme.sh (renews itself), checked over DNS (Cloudflare) or http
 *    Every config change is tested with `nginx -t`; files and config are put back when nginx says no.
 */

export const EDGE_SSL = '/etc/switchboard/edge/ssl';
const DIRS = { cloudflare: '/etc/ssl/cloudflare', own: '/etc/ssl/switchboard', acme: '/etc/ssl/acme' };
const EDGE_RELOAD = 'docker exec switchboard-edge nginx -t -q && docker exec switchboard-edge nginx -s reload >/dev/null';
const HOST_RELOAD = 'nginx -t -q && { systemctl reload nginx 2>/dev/null || service nginx reload >/dev/null 2>&1 || nginx -s reload; }';
// acme.sh 3.1.7, pinned to the commit (not the tag) so the download cannot change under us.
export const ACME_REF = '5567d7fe7298fd37aca53194885ba444c6678669';
export const ACME_CAS = { letsencrypt: "Let's Encrypt", zerossl: 'ZeroSSL' };

/** Host names a project's HTTPS must cover (no wildcards): its domain, extra hosts and linked records. */
export function sslHosts(project) {
  const out = [];
  for (const h of [...projectHosts(project), ...parseJSON(project.dns_records, []).map((r) => r.name)]) {
    const x = String(h || '').toLowerCase().trim();
    if (x && !x.includes('*') && !out.includes(x)) out.push(x);
  }
  return out.slice(0, 50);
}

const fileBase = (project) => (project.domain || parseJSON(project.dns_records, [])[0]?.zone_name || project.slug).replace(/[^A-Za-z0-9._-]/g, '_');

/* ------------------------------------------------------------------ scan */

const DUMP_SH = `m=$(cat /etc/switchboard/edge/mode 2>/dev/null || true)
echo "@edge $m"
command -v nginx >/dev/null 2>&1 && echo "@nginx $(nginx -v 2>&1 | head -n 1)"
command -v openssl >/dev/null 2>&1 && echo @openssl
dump() { [ -f "$2" ] || return 0; [ "$(wc -c < "$2")" -le 262144 ] || return 0; echo "@file $1 $(base64 < "$2" | tr -d '\\n') $2"; }
if command -v nginx >/dev/null 2>&1; then
  dump host /etc/nginx/nginx.conf
  for f in /etc/nginx/conf.d/*.conf; do dump host "$f"; done
  for f in /etc/nginx/sites-enabled/*; do [ -e "$f" ] && dump host "$(readlink -f "$f")"; done
fi
if [ "$m" = container ]; then for f in /etc/switchboard/edge/conf.d/*.conf; do dump edge "$f"; done; fi
true`;

/** Parse the dump script's output (exported for tests). */
export function parseDump(out) {
  const res = { edge: '', nginx: '', openssl: false, files: [] };
  const seen = new Set();
  for (const l of out.split('\n')) {
    if (l.startsWith('@edge')) res.edge = l.slice(5).trim();
    else if (l.startsWith('@nginx ')) res.nginx = l.slice(7).replace(/^nginx version:\s*/, '').trim();
    else if (l === '@openssl') res.openssl = true;
    else if (l.startsWith('@file ')) {
      const [, scope, b64, ...rest] = l.split(' ');
      const path = rest.join(' ');
      if (seen.has(path)) continue;
      seen.add(path);
      res.files.push({ scope, path, text: Buffer.from(b64 || '', 'base64').toString('utf8') });
    }
  }
  return res;
}

function certScript(certs, keys, pairs, openssl) {
  const L = [];
  for (const p of certs) L.push(`p=${shq(p)}; if [ -f "$p" ]; then echo "@cert $(head -c 65536 "$p" | base64 | tr -d '\\n') $p"; else echo "@missing $p"; fi`);
  for (const p of keys) if (!certs.includes(p)) L.push(`p=${shq(p)}; [ -f "$p" ] && echo "@have $p" || echo "@missing $p"`);
  if (openssl)
    pairs.forEach(([c, k], i) =>
      L.push(`if [ -f ${shq(c)} ] && [ -f ${shq(k)} ]; then a=$(openssl x509 -noout -pubkey -in ${shq(c)} 2>/dev/null | openssl sha256); b=$(openssl pkey -pubout -in ${shq(k)} 2>/dev/null | openssl sha256); [ -n "$a" ] && [ "$a" = "$b" ] && echo "@match ${i} 1" || echo "@match ${i} 0"; fi`),
    );
  L.push('true');
  return L.join('\n');
}

/** Scan one server over an open connection. */
export async function scanOn(ctx, conn, server, project) {
  const hosts = sslHosts(project);
  const dump = parseDump((await runRemote(ctx, conn, asRoot(server, DUMP_SH), { quiet: true, timeout: 60000 })).stdout);
  const all = [];
  for (const f of dump.files) for (const b of parseServerBlocks(f.text)) all.push({ ...b, file: f.path, scope: f.scope });
  const certs = [...new Set(all.map((b) => absPath(b.cert)).filter(Boolean))];
  const keys = [...new Set(all.map((b) => absPath(b.key)).filter(Boolean))];
  const mine = all.filter((b) => blockServes(b, hosts));
  const pairs = [...new Set(mine.filter((b) => absPath(b.cert) && absPath(b.key)).map((b) => `${absPath(b.cert)}\n${absPath(b.key)}`))].map((s) => s.split('\n'));
  const have = new Map(); // path → true | PEM text
  const missing = new Set();
  const match = new Map();
  if (certs.length || keys.length) {
    const out = (await runRemote(ctx, conn, asRoot(server, certScript(certs, keys, pairs, dump.openssl)), { quiet: true, timeout: 60000 })).stdout;
    for (const l of out.split('\n')) {
      const [tag, a, ...rest] = l.split(' ');
      if (tag === '@cert') have.set(rest.join(' '), Buffer.from(a, 'base64').toString('utf8'));
      else if (tag === '@have') have.set([a, ...rest].join(' '), true);
      else if (tag === '@missing') missing.add([a, ...rest].join(' '));
      else if (tag === '@match') match.set(pairs[Number(a)].join('\n'), rest[0] === '1');
    }
  }
  const sites = mine.map((b) => {
    const cert = absPath(b.cert);
    const key = absPath(b.key);
    const pem = typeof have.get(cert) === 'string' ? have.get(cert) : '';
    return {
      file: b.file,
      scope: b.scope,
      names: b.names,
      ports: b.ports,
      ssl: b.ssl,
      redirect: b.redirectsToHttps,
      managed: /\/sb-[^/]+\.conf$/.test(b.file),
      cert,
      key,
      cert_missing: !!cert && missing.has(cert),
      key_missing: !!key && missing.has(key),
      cert_info: pem ? certInfo(pem, hosts.filter((h) => b.names.some((n) => nameMatches(n, h)))) : null,
      key_match: cert && key ? (match.has(`${cert}\n${key}`) ? match.get(`${cert}\n${key}`) : null) : null,
    };
  });
  const broken = all
    .filter((b) => !blockServes(b, hosts))
    .flatMap((b) => [absPath(b.cert), absPath(b.key)].filter((p) => p && missing.has(p)).map((p) => ({ file: b.file, path: p })));
  const res = { hosts, edge: dump.edge, nginx: dump.nginx, openssl: dump.openssl, sites, broken, files: dump.files };
  return { ...res, ...serverStatus(res) };
}

/** Scan every server of the project (for the page). Never throws: a server that fails gets `error`. */
export async function scanProject(project, deps, getServer) {
  return Promise.all(
    deps.map(async (d) => {
      const base = { deployment_id: d.id, server_id: d.server_id, server: d.server_name, is_active: !!d.is_active };
      let conn;
      try {
        const server = getServer(d.server_id);
        conn = await connectTo(null, server);
        const { files, ...scan } = await scanOn(null, conn, server, project);
        return { ...base, ...scan };
      } catch (e) {
        return { ...base, status: 'error', message: e.message, sites: [], broken: [], hosts: sslHosts(project) };
      } finally {
        conn?.end();
      }
    }),
  );
}

/* ------------------------------------------------------------------ set up */

// Secrets (own private key, acme DNS token) are kept in memory only, never in the jobs table.
const secrets = new Map();
export function keepSecret(value) {
  const ref = crypto.randomBytes(12).toString('hex');
  secrets.set(ref, value);
  setTimeout(() => secrets.delete(ref), 3600e3).unref?.();
  return ref;
}
export function takeSecret(ref) {
  const v = secrets.get(ref);
  secrets.delete(ref);
  return v;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

async function ensureOpenssl(ctx, conn, server) {
  await runRemote(
    ctx,
    conn,
    asRoot(server, 'command -v openssl >/dev/null 2>&1 && exit 0; if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -q openssl >/dev/null; elif command -v dnf >/dev/null 2>&1; then dnf install -y -q openssl >/dev/null; elif command -v apk >/dev/null 2>&1; then apk add -q openssl; else echo "please install openssl" >&2; exit 1; fi'),
    { timeout: 5 * 60000, quiet: true },
  );
}

/** Cloudflare Origin Certificate: key + request made on the server, Cloudflare signs → $D/$B.pem.new/.key.new */
async function makeCloudflare(ctx, conn, server, D, B, project) {
  const hostnames = certHostnames(project);
  if (!hostnames.length) throw new Error('Link the Cloudflare DNS records to this project first');
  const csr = (await runRemote(ctx, conn, asRoot(server, `set -e; mkdir -p ${D}; chmod 755 ${D}; umask 077; openssl req -new -newkey rsa:2048 -nodes -keyout ${D}/${B}.key.new -subj ${shq(`/CN=${hostnames[0]}`)} 2>/dev/null`), { quiet: true })).stdout.trim();
  if (!/BEGIN CERTIFICATE REQUEST/.test(csr)) throw new Error('could not make a certificate request');
  let cert;
  try {
    cert = await cf.createOriginCert(csr, hostnames);
  } catch (e) {
    throw new Error(`${e.message}${/auth|permission|9109|10000|1016/i.test(e.message) ? ' — your Cloudflare token needs "Zone · SSL and Certificates · Edit"' : ''}`);
  }
  ctx.log(`Cloudflare signed the certificate for ${hostnames.join(', ')} (until ${String(cert.expires_on || '').slice(0, 10) || '?'})`);
  await runRemote(ctx, conn, asRoot(server, `base64 -d > ${D}/${B}.pem.new`), { stdin: b64(cert.certificate), quiet: true });
}

/** A certificate the user pasted → $D/$B.pem.new/.key.new (the key goes over stdin, never on a command line). */
async function makeOwn(ctx, conn, server, D, B, own) {
  await runRemote(ctx, conn, asRoot(server, `set -e; mkdir -p ${D}; chmod 755 ${D}; umask 077; base64 -d > ${D}/${B}.key.new`), { stdin: b64(own.key), quiet: true });
  await runRemote(ctx, conn, asRoot(server, `base64 -d > ${D}/${B}.pem.new`), { stdin: b64(own.cert), quiet: true });
  ctx.log(`Your certificate: ${own.info.issuer} — ${own.info.names.join(', ')} (until ${own.info.not_after.slice(0, 10)})`);
}

/** acme.sh script for one server (exported for tests). The DNS token comes in on stdin. */
export function acmeScript({ hosts, ca, email, challenge, D, B }) {
  const ds = hosts.map((h) => `-d ${shq(h)}`).join(' ');
  const main = shq(hosts[0]);
  return `set -e
A=/root/.acme.sh/acme.sh
if [ ! -x "$A" ]; then
  command -v curl >/dev/null 2>&1 || { DEBIAN_FRONTEND=noninteractive apt-get install -y -q curl >/dev/null 2>&1 || dnf install -y -q curl >/dev/null 2>&1 || apk add -q curl; }
  command -v crontab >/dev/null 2>&1 || { DEBIAN_FRONTEND=noninteractive apt-get install -y -q cron >/dev/null 2>&1 || dnf install -y -q cronie >/dev/null 2>&1 || true; }
  T=$(mktemp -d); curl -fsSL https://github.com/acmesh-official/acme.sh/archive/${ACME_REF}.tar.gz | tar -xz -C "$T"
  (cd "$T"/acme.sh-* && ./acme.sh --install --home /root/.acme.sh ${email ? `--accountemail ${shq(email)}` : ''} >/dev/null)
  rm -rf "$T"
  echo "acme.sh installed (renews certificates from cron)"
fi
${ca === 'zerossl' ? `"$A" --register-account --server zerossl ${email ? `-m ${shq(email)}` : ''} >/dev/null 2>&1 || true` : ''}
${challenge === 'dns' ? 'read -r CF_Token; export CF_Token' : ''}
rc=0; "$A" --issue --server ${ca} ${challenge === 'dns' ? '--dns dns_cf' : '--nginx'} ${ds} || rc=$?
# 2 = a valid certificate is already there and not due for renewal: use it
[ "$rc" = 0 ] || [ "$rc" = 2 ] || { echo "the certificate authority did not give a certificate (acme.sh exit $rc)" >&2; exit 1; }
H=/root/.acme.sh/${hosts[0]}_ecc; E=--ecc; [ -f "$H/fullchain.cer" ] || { H=/root/.acme.sh/${hosts[0]}; E=; }
[ -f "$H/fullchain.cer" ] || { echo "acme.sh did not save a certificate" >&2; exit 1; }
mkdir -p ${D}; chmod 755 ${D}; umask 077
cp "$H/fullchain.cer" ${D}/${B}.pem.new; cp "$H/"${main}.key ${D}/${B}.key.new
echo "ecc=$E"`;
}

/** After the files are in place: tell acme.sh where to copy renewed certificates and how to reload. */
const acmeInstallScript = ({ main, ecc, D, B, reload }) =>
  `/root/.acme.sh/acme.sh --install-cert -d ${shq(main)} ${ecc} --key-file ${D}/${B}.key --fullchain-file ${D}/${B}.pem --reloadcmd ${shq(reload)} >/dev/null`;

/**
 * Swap in $D/$B.pem.new + .key.new (must match), write the edited site files, test + reload nginx.
 * Everything is put back if any of it fails. Exported for tests.
 */
export function finalizeScript({ D, B, edits, reload }) {
  const files = edits.map((e, i) => `F${i}=${shq(e.path)}; cp -p "$F${i}" "$F${i}.sb-bak"; printf %s ${shq(b64(e.text))} | base64 -d > "$F${i}.sb-new" && mv "$F${i}.sb-new" "$F${i}"`).join('\n');
  const undo = edits.map((e, i) => `[ -f "$F${i}.sb-bak" ] && mv "$F${i}.sb-bak" "$F${i}"`).join('; ');
  const clean = edits.map((e, i) => `rm -f "$F${i}.sb-bak"`).join('; ');
  return `set -e
D=${D}; B=${B}
a=$(openssl x509 -noout -pubkey -in "$D/$B.pem.new" | openssl sha256)
b=$(openssl pkey -pubout -in "$D/$B.key.new" | openssl sha256)
[ "$a" = "$b" ] || { rm -f "$D/$B.pem.new" "$D/$B.key.new"; echo "certificate does not match the key" >&2; exit 1; }
for x in pem key; do [ -f "$D/$B.$x" ] && cp -p "$D/$B.$x" "$D/$B.$x.old" || true; done
mv "$D/$B.pem.new" "$D/$B.pem"; mv "$D/$B.key.new" "$D/$B.key"; chmod 644 "$D/$B.pem"; chmod 600 "$D/$B.key"
restore() { for x in pem key; do if [ -f "$D/$B.$x.old" ]; then mv "$D/$B.$x.old" "$D/$B.$x"; else rm -f "$D/$B.$x"; fi; done; ${undo || 'true'}; }
${files}
${reload ? `if ! out=$( { ${reload}; } 2>&1); then
  restore; { ${reload}; } >/dev/null 2>&1 || true
  echo "nginx did not accept it, everything is back as it was: $(echo "$out" | grep -v 'test failed' | tail -n 2 | tr '\\n' ' ')" >&2; exit 1
fi` : ''}
${clean}
rm -f "$D/$B.pem.old" "$D/$B.key.old"
echo done`;
}

/** Set up SSL on one server of the project. Returns { where, path, notes }. */
export async function setupServer(ctx, project, server, opts) {
  const conn = await connectTo(ctx, server);
  try {
    ctx.log('Reading the nginx config…');
    const scan = await scanOn(ctx, conn, server, project);
    ctx.log(`Before: ${scan.message}`);
    for (const b of scan.broken) ctx.warn(`${b.file} points to ${b.path}, which is not on this server — nginx cannot reload until that is fixed (another site)`);
    const hosts = scan.hosts;
    // Switchboard's web proxy site for this project wins; else the server's own nginx sites.
    const edgeFile = scan.files.find((f) => f.path.endsWith(`/sb-${project.slug}.conf`) && parseServerBlocks(f.text).length);
    const scope = edgeFile ? edgeFile.scope : 'host';
    const D = edgeFile ? EDGE_SSL : DIRS[opts.method];
    const B = edgeFile ? `site-${project.slug}` : fileBase(project);
    const reload = scope === 'edge' ? EDGE_RELOAD : scan.nginx ? HOST_RELOAD : '';
    const files = scan.files.filter((f) => f.scope === scope && (edgeFile ? f.path === edgeFile.path : true));
    const sslElsewhere = (f) => files.some((o) => o !== f && parseServerBlocks(o.text).some((b) => blockServes(b, hosts) && (b.ssl || b.cert)));
    const edits = [];
    const notes = [];
    for (const f of files) {
      const r = planSiteEdit(f.text, hosts, `${D}/${B}.pem`, `${D}/${B}.key`, { anySslElsewhere: sslElsewhere(f) });
      for (const n of r.notes) notes.push(`${f.path}: ${n}`);
      if (r.changed) edits.push({ path: f.path, text: r.text });
    }
    if (opts.method === 'acme' && opts.challenge === 'http' && scope !== 'host') throw new Error('The http check needs the server\'s own nginx — use the DNS check (Cloudflare) here');

    await ensureOpenssl(ctx, conn, server);
    const Dq = shq(D);
    const Bq = shq(B);
    let ecc = '';
    if (opts.method === 'cloudflare') await makeCloudflare(ctx, conn, server, Dq, Bq, project);
    else if (opts.method === 'own') await makeOwn(ctx, conn, server, Dq, Bq, opts.own);
    else if (opts.method === 'acme') {
      ctx.log(`Asking ${ACME_CAS[opts.ca]} for a certificate for ${hosts.join(', ')} (${opts.challenge === 'dns' ? 'DNS check through Cloudflare' : 'http check through nginx'})…`);
      const r = await runRemote(ctx, conn, asRoot(server, acmeScript({ hosts, ca: opts.ca, email: opts.email, challenge: opts.challenge, D: Dq, B: Bq })), {
        stdin: opts.challenge === 'dns' ? `${opts.token}\n` : undefined,
        timeout: 10 * 60000,
      });
      ecc = (r.stdout.match(/ecc=(\S*)/) || [])[1] || '';
    } else throw new Error(`Unknown method ${opts.method}`);

    for (const e of edits) ctx.log(`Updating ${e.path}`);
    for (const n of notes) ctx.log(n);
    const served = !!edgeFile || edits.length > 0 || scan.sites.some((s) => s.cert === `${D}/${B}.pem`);
    await runRemote(ctx, conn, asRoot(server, finalizeScript({ D: Dq, B: Bq, edits, reload: served ? reload : '' })), { quiet: true, timeout: 2 * 60000 });
    if (opts.method === 'acme') await runRemote(ctx, conn, asRoot(server, acmeInstallScript({ main: hosts[0], ecc, D: Dq, B: Bq, reload: reload || 'true' })), { quiet: true, timeout: 2 * 60000 });
    if (edgeFile) await installHelper(ctx, conn, server); // newer helper keeps site-<slug>.pem on later setups
    const where = edgeFile ? 'edge' : served ? 'nginx' : 'files';
    if (where === 'files') {
      ctx.log(`Certificate saved — no nginx site for ${hosts.join(', ')} was found on ${server.name}, so point your web server at it:`);
      ctx.log(`    ssl_certificate     ${D}/${B}.pem;`);
      ctx.log(`    ssl_certificate_key ${D}/${B}.key;`);
    } else ctx.log(`${server.name}: nginx now serves ${hosts.join(', ')} with the new certificate`);
    return { where, path: `${D}/${B}.pem`, notes };
  } finally {
    conn.end();
  }
}

/** Options for the job from the request body; throws a plain Error with a user message. */
export function setupOptions(body, project, checkOwnCert) {
  const method = ['cloudflare', 'own', 'acme'].includes(body?.method) ? body.method : '';
  if (!method) throw new Error('Pick how to get the certificate: Cloudflare, your own, or Let\'s Encrypt / ZeroSSL');
  const hosts = sslHosts(project);
  if (!hosts.length) throw new Error('Set the project\'s domain (or link its Cloudflare DNS records) first');
  const out = { method, strict: !!body.strict };
  if (method === 'cloudflare') {
    if (!parseJSON(project.dns_records, []).length) throw new Error('Link the Cloudflare DNS records to this project first');
    if (!getSetting('cf_token')) throw new Error('Add your Cloudflare token in Settings first');
  }
  if (method === 'own') {
    const own = checkOwnCert(body.cert, body.key, hosts);
    out.own_ref = keepSecret(own);
    out.own_summary = { issuer: own.info.issuer, names: own.info.names, not_after: own.info.not_after, missing_hosts: own.info.missing_hosts };
  }
  if (method === 'acme') {
    out.ca = ACME_CAS[body.ca] ? body.ca : 'letsencrypt';
    out.challenge = body.challenge === 'http' ? 'http' : 'dns';
    const email = String(body.email || '').trim();
    if (email && !/^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/.test(email)) throw new Error('Email does not look right');
    if (out.ca === 'zerossl' && !email) throw new Error('ZeroSSL needs an email address');
    out.email = email;
    if (out.challenge === 'dns') {
      const token = String(body.token || '').trim() || getSetting('cf_token') || '';
      if (!token) throw new Error('The DNS check needs a Cloudflare API token (Zone · DNS · Edit)');
      if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new Error('That Cloudflare token does not look right');
      out.token_ref = keepSecret(token);
      out.own_token = !!String(body.token || '').trim();
    }
  }
  return out;
}

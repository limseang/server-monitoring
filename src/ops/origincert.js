import * as cf from '../cloudflare.js';
import { parseJSON } from '../models.js';
import { connectTo, runRemote, asRoot, shq } from './remote.js';
import { installHelper, projectHosts } from './stack.js';

/**
 * Cloudflare Origin Certificate on a project's servers — what SSL mode "Full (strict)" needs.
 *
 * 1. The server makes a new private key + certificate request (the key never leaves the server).
 * 2. Cloudflare's Origin CA signs the request (15 years, trusted by Cloudflare only).
 * 3. The certificate is written next to the key.
 *    - Switchboard's web proxy serves this project (site sb-<slug>): the site uses the new certificate
 *      at once, and keeps it on later setups (switchboard-helper picks up site-<slug>.pem).
 *    - Otherwise (your own nginx / Docker setup): the files go to /etc/ssl/cloudflare/ and the job log
 *      shows the two nginx lines to use. Switchboard does not edit your web server config.
 */

const EDGE_SSL = '/etc/switchboard/edge/ssl';
const OWN_SSL = '/etc/ssl/cloudflare';

/** Host names the certificate covers: each zone + *.zone, and any deeper name the project uses. */
export function certHostnames(project) {
  const recs = parseJSON(project.dns_records, []);
  const zones = [...new Set(recs.map((r) => r.zone_name).filter(Boolean))];
  const out = [];
  for (const z of zones) out.push(z, `*.${z}`);
  const covered = (n) => zones.some((z) => n === z || (n.endsWith(`.${z}`) && !n.slice(0, -z.length - 1).includes('.')));
  for (const n of [...projectHosts(project), ...recs.map((r) => r.name)]) {
    const h = String(n || '').toLowerCase();
    if (h && !covered(h) && !out.includes(h)) out.push(h);
  }
  return out.slice(0, 50);
}

const fileBase = (project) => project.domain || parseJSON(project.dns_records, [])[0]?.zone_name || project.slug;

/** Install a new Origin Certificate on one server of the project. Returns { where, path }. */
export async function installOriginCert(ctx, project, dep, server, hostnames) {
  const conn = await connectTo(ctx, server);
  try {
    // Where does this project's web traffic end on this server?
    const probe = await runRemote(
      ctx,
      conn,
      asRoot(
        server,
        `m=$(cat /etc/switchboard/edge/mode 2>/dev/null || true)
if [ "$m" = host ]; then d=/etc/nginx/conf.d; else d=/etc/switchboard/edge/conf.d; fi
if [ -n "$m" ] && [ -f "$d/sb-${project.slug}.conf" ]; then echo "edge $m $d/sb-${project.slug}.conf"; else echo own; fi
command -v openssl >/dev/null 2>&1 && echo openssl-ok || true`,
      ),
      { quiet: true },
    );
    const lines = probe.stdout.trim().split('\n');
    const [kind, edgeMode, siteConf] = lines[0].split(' ');
    const edge = kind === 'edge';
    if (!lines.includes('openssl-ok')) {
      ctx.log(`Installing openssl on ${server.name}`);
      await runRemote(ctx, conn, asRoot(server, 'if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -q openssl >/dev/null; elif command -v dnf >/dev/null 2>&1; then dnf install -y -q openssl >/dev/null; elif command -v apk >/dev/null 2>&1; then apk add -q openssl; else echo "please install openssl" >&2; exit 1; fi'), { timeout: 5 * 60000 });
    }
    const dir = edge ? EDGE_SSL : OWN_SSL;
    const base = edge ? `site-${project.slug}` : fileBase(project);
    const D = shq(dir);
    const B = shq(base);

    // 1. key + request, made on the server
    const csrOut = await runRemote(
      ctx,
      conn,
      asRoot(server, `set -e; mkdir -p ${D}; chmod 755 ${D}; umask 077; openssl req -new -newkey rsa:2048 -nodes -keyout ${D}/${B}.key.new -subj ${shq(`/CN=${hostnames[0]}`)} 2>/dev/null`),
      { quiet: true },
    );
    const csr = csrOut.stdout.trim();
    if (!/BEGIN CERTIFICATE REQUEST/.test(csr)) throw new Error(`${server.name}: could not make a certificate request`);

    // 2. Cloudflare signs it
    let cert;
    try {
      cert = await cf.createOriginCert(csr, hostnames);
    } catch (e) {
      await runRemote(ctx, conn, asRoot(server, `rm -f ${D}/${B}.key.new`), { quiet: true }).catch(() => {});
      throw new Error(`${e.message}${/auth|permission|9109|10000|1016/i.test(e.message) ? ' — your Cloudflare token needs "Zone · SSL and Certificates · Edit"' : ''}`);
    }
    ctx.log(`Cloudflare signed the certificate for ${server.name}: ${hostnames.join(', ')} (until ${String(cert.expires_on || '').slice(0, 10) || '?'})`);

    // 3. write it, check it matches the key, switch the web proxy site, roll back on any error
    const reload =
      edgeMode === 'host'
        ? 'nginx -t -q && { systemctl reload nginx 2>/dev/null || nginx -s reload; }'
        : 'docker exec switchboard-edge nginx -t -q && docker exec switchboard-edge nginx -s reload >/dev/null';
    const script = `set -e
D=${D}; B=${B}; F=${shq(siteConf || '')}
printf %s ${shq(Buffer.from(cert.certificate).toString('base64'))} | base64 -d > "$D/$B.pem.new"
a=$(openssl x509 -noout -pubkey -in "$D/$B.pem.new" | openssl sha256)
b=$(openssl pkey -pubout -in "$D/$B.key.new" | openssl sha256)
[ "$a" = "$b" ] || { rm -f "$D/$B.pem.new" "$D/$B.key.new"; echo "certificate does not match the key" >&2; exit 1; }
for x in pem key; do [ -f "$D/$B.$x" ] && cp -p "$D/$B.$x" "$D/$B.$x.old" || true; done
mv "$D/$B.pem.new" "$D/$B.pem"; mv "$D/$B.key.new" "$D/$B.key"; chmod 644 "$D/$B.pem"; chmod 600 "$D/$B.key"
restore() { for x in pem key; do if [ -f "$D/$B.$x.old" ]; then mv "$D/$B.$x.old" "$D/$B.$x"; else rm -f "$D/$B.$x"; fi; done; }
if [ -n "$F" ]; then
  cp -p "$F" "$F.bak"
  sed -i "s#^\\([[:space:]]*\\)ssl_certificate .*#\\1ssl_certificate $D/$B.pem;#; s#^\\([[:space:]]*\\)ssl_certificate_key .*#\\1ssl_certificate_key $D/$B.key;#" "$F"
  if ! { ${reload}; }; then
    mv "$F.bak" "$F"; restore; { ${reload}; } || true
    echo "nginx did not accept the new certificate — the old one is back" >&2; exit 1
  fi
  rm -f "$F.bak"
fi
rm -f "$D/$B.pem.old" "$D/$B.key.old"
echo done`;
    await runRemote(ctx, conn, asRoot(server, script), { quiet: true });
    if (edge) {
      // Newer switchboard-helper keeps this certificate when the site is set up again.
      await installHelper(ctx, conn, server);
      ctx.log(`${server.name}: Switchboard's web proxy now serves ${project.domain || project.name} with the Origin Certificate`);
    } else {
      ctx.log(`${server.name}: certificate saved — Switchboard's web proxy does not serve this project here, so point your web server at it:`);
      ctx.log(`    ssl_certificate     ${dir}/${base}.pem;`);
      ctx.log(`    ssl_certificate_key ${dir}/${base}.key;`);
      ctx.warn(`${server.name}: until your web server uses these files, keep the SSL mode on "Full" (not strict).`);
    }
    return { where: edge ? 'edge' : 'files', path: `${dir}/${base}.pem` };
  } finally {
    conn.end();
  }
}

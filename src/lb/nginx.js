/**
 * Your own load balancer: nginx on a server Switchboard manages over SSH.
 * One file per project: /etc/nginx/conf.d/switchboard-<slug>.conf
 *
 * Changes are applied with `nginx -t` first (the old file is put back if the test fails)
 * and then a graceful reload: requests that are already running finish on the old
 * workers, so adding or draining a server never cuts visitors off.
 */
import { parseJSON } from '../models.js';
import { runRemote, asRoot, shq } from '../ops/remote.js';

export const confPath = (project) => `/etc/nginx/conf.d/switchboard-${project.slug.replace(/[^a-z0-9-]/g, '-')}.conf`;
const upstreamName = (project) => `sb_${project.slug.replace(/[^a-z0-9]/g, '_')}`;
const SAFE_PATH = /^\/[A-Za-z0-9._\/-]+$/;
export const METHODS = { least_conn: 'least_conn;', round_robin: '', ip_hash: 'ip_hash;' };

/** Which members get visitors: active ones that Switchboard doesn't see as down (all active ones if every one is down). */
export function inRotation(members) {
  const active = members.filter((m) => m.lb_state === 'active');
  const healthy = active.filter((m) => m.health !== 'down');
  return healthy.length ? healthy : active;
}

export function hostnames(project) {
  const names = parseJSON(project.dns_records, []).map((r) => r.name);
  if (project.domain) names.unshift(project.domain);
  return [...new Set(names.filter((n) => /^[A-Za-z0-9.*-]+$/.test(n)))];
}

/** Address nginx uses for a member: private IP when both sides have one and that's enabled. */
function addressOf(m, lbServer, cfg) {
  if (cfg.use_private !== false && lbServer.private_ip && m.server_private_ip) return m.server_private_ip;
  return m.server_ip;
}

export function nginxConfig(project, members, lbServer, cfg = {}) {
  const https = project.health_scheme !== 'http';
  const port = Number(project.health_port) || (https ? 443 : 80);
  const on = new Set(inRotation(members).map((m) => m.id));
  const up = upstreamName(project);
  const names = hostnames(project);
  const method = METHODS[cfg.method] ?? METHODS.least_conn;
  const lines = [
    `# Managed by Switchboard — project "${project.name}". Edits here are overwritten.`,
    `upstream ${up} {`,
  ];
  if (method) lines.push(`    ${method}`);
  for (const m of members) {
    const addr = `${addressOf(m, lbServer, cfg)}:${port}`;
    const w = Math.max(1, Math.min(100, Number(m.lb_weight) || 1));
    const why = on.has(m.id) ? '' : m.lb_state === 'active' ? '  # unhealthy' : `  # ${m.lb_state}`;
    lines.push(`    server ${addr} weight=${w} max_fails=2 fail_timeout=10s${on.has(m.id) ? '' : ' down'}; # ${m.server_name}${why}`);
  }
  if (!members.length) lines.push('    server 127.0.0.1:9 down; # no servers yet');
  lines.push('    keepalive 32;', '}', '');
  lines.push(`map $http_x_forwarded_proto $${up}_proto { default $http_x_forwarded_proto; "" $scheme; }`, '');

  const location = [
    '    location = /__switchboard_lb { access_log off; return 200 "ok"; }',
    '    location / {',
    `        proxy_pass ${https ? 'https' : 'http'}://${up};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Connection "";',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    `        proxy_set_header X-Forwarded-Proto $${up}_proto;`,
    '        proxy_set_header X-Forwarded-Host $host;',
    '        proxy_next_upstream error timeout http_502 http_503 http_504;',
    '        proxy_next_upstream_tries 3;',
    '        proxy_connect_timeout 5s;',
    // Large uploads (multi-GB media): no size cap, stream the body to the server as it
    // arrives (no buffering the whole POST first), long timeouts between reads/writes.
    '        client_max_body_size 0;',
    '        client_body_timeout 1h;',
    '        proxy_request_buffering off;',
    '        proxy_send_timeout 1h;',
    '        proxy_read_timeout 1h;',
  ];
  if (https) location.push('        proxy_ssl_server_name on;', '        proxy_ssl_name $host;');
  location.push('    }');

  const serverName = names.length ? names.join(' ') : '_';
  lines.push('server {', '    listen 80;', '    listen [::]:80;', `    server_name ${serverName};`, ...location, '}');
  if (cfg.tls_cert && cfg.tls_key) {
    lines.push(
      '',
      'server {',
      '    listen 443 ssl;',
      '    listen [::]:443 ssl;',
      `    server_name ${serverName};`,
      `    ssl_certificate ${cfg.tls_cert};`,
      `    ssl_certificate_key ${cfg.tls_key};`,
      '    ssl_protocols TLSv1.2 TLSv1.3;',
      ...location,
      '}',
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Install and start nginx on the LB server if needed. */
export async function ensureNginx(ctx, conn, server) {
  const r = await runRemote(ctx, conn, asRoot(server, 'command -v nginx >/dev/null 2>&1 && echo yes || echo no'), { quiet: true });
  if (r.stdout.trim() !== 'yes') {
    ctx?.step(`Install nginx on ${server.name}`);
    await runRemote(
      ctx,
      conn,
      asRoot(server, `export DEBIAN_FRONTEND=noninteractive; if command -v apt-get >/dev/null; then apt-get update -q && apt-get install -y -q nginx; elif command -v dnf >/dev/null; then dnf install -y nginx; else echo 'Install nginx on this server first (no apt/dnf)' >&2; exit 3; fi`),
      { timeout: 15 * 60000 },
    );
  }
  await runRemote(
    ctx,
    conn,
    asRoot(server, `pgrep -x nginx >/dev/null 2>&1 || (systemctl enable --now nginx 2>/dev/null || service nginx start 2>/dev/null || nginx)`),
    { quiet: true, timeout: 60000 },
  );
}

/** Write the project's config, test it, reload gracefully. Puts the old file back if the test fails. */
export async function applyNginx(ctx, conn, server, project, members, cfg) {
  for (const p of [cfg.tls_cert, cfg.tls_key]) if (p && !SAFE_PATH.test(p)) throw new Error(`Invalid certificate path: ${p}`);
  const file = confPath(project);
  const text = nginxConfig(project, members, server, cfg);
  await runRemote(
    ctx,
    conn,
    asRoot(
      server,
      `f=${shq(file)}
[ -f "$f" ] && cp "$f" "$f.sb-prev"
cat > "$f.sb-new" && mv "$f.sb-new" "$f"
if ! out=$(nginx -t 2>&1); then
  if [ -f "$f.sb-prev" ]; then mv "$f.sb-prev" "$f"; else rm -f "$f"; fi
  echo "nginx config test failed (old config kept): $out" >&2; exit 4
fi
rm -f "$f.sb-prev"
nginx -s reload 2>/dev/null || service nginx reload 2>/dev/null || systemctl reload nginx`,
    ),
    { stdin: text, quiet: true, timeout: 60000 },
  );
  return text;
}

export async function removeNginx(ctx, conn, server, project) {
  await runRemote(ctx, conn, asRoot(server, `rm -f ${shq(confPath(project))} && (nginx -t >/dev/null 2>&1 && (nginx -s reload 2>/dev/null || service nginx reload)); true`), { quiet: true, timeout: 60000 });
}

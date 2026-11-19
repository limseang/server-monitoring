// Builds a new nginx site file from a few answers (used by the Nginx sites tab; no Vue here so tests can import it).

const CERT = '/etc/nginx/ssl/switchboard-selfsigned.pem';
const KEY = '/etc/nginx/ssl/switchboard-selfsigned.key';

/** "minio:9000" / "http://127.0.0.1:9000/" / "https://s3.example.com" → { url, host, https } or null. */
export function parseUpstream(s) {
  const t = String(s || '').trim().replace(/\/+$/, '');
  if (!t) return null;
  const m = t.match(/^(?:(https?):\/\/)?([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?$/);
  if (!m) return null;
  const scheme = m[1] || 'http';
  const host = m[3] ? `${m[2]}:${m[3]}` : m[2];
  return { url: `${scheme}://${host}`, host, https: scheme === 'https' };
}

/** A safe file name for the site from its first domain. */
export const siteFileName = (hosts) => (String(hosts || '').trim().split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 100);

/**
 * opts: hosts "a.com www.a.com", target "app" (proxy to port) | "root" (static folder), port, root,
 *       ssl (self-signed cert exists), stream: { path: "/stream-proxy/", upstream: "127.0.0.1:9000", signedHost }
 */
export function buildSite(opts) {
  const hosts = String(opts.hosts || '').trim().split(/\s+/).filter(Boolean);
  const L = [];
  L.push(`# ${hosts.join(' ') || 'site'} — made in Switchboard`);
  L.push('server {');
  L.push('    listen 80;');
  if (opts.ssl) {
    L.push('    listen 443 ssl;');
    L.push(`    ssl_certificate ${CERT};`);
    L.push(`    ssl_certificate_key ${KEY};`);
    L.push('    # Self-signed: fine behind Cloudflare with SSL mode "Full".');
  }
  L.push(`    server_name ${hosts.join(' ') || '_'};`);
  L.push('');
  L.push('    client_max_body_size 0;');
  L.push('    client_body_timeout 1h;');

  const st = opts.stream && parseUpstream(opts.stream.upstream);
  if (st) {
    let path = String(opts.stream.path || '/stream-proxy/').trim() || '/stream-proxy/';
    if (!path.startsWith('/')) path = `/${path}`;
    if (!path.endsWith('/')) path += '/';
    const signed = String(opts.stream.signedHost || '').trim() || st.host;
    L.push('');
    L.push(`    # Video: ${path}<bucket>/<file>?X-Amz-... → S3 / MinIO at ${st.url}`);
    L.push('    # The link is signed for one host name: Host below must be exactly that host (with :port if it has one).');
    L.push(`    location ${path} {`);
    L.push(`        proxy_pass ${st.url}/;`);
    L.push(`        proxy_set_header Host ${signed};`);
    if (st.https) {
      L.push('        proxy_ssl_server_name on;');
      L.push(`        proxy_ssl_name ${signed.replace(/:\d+$/, '')};`);
    }
    L.push('        proxy_http_version 1.1;');
    L.push('        proxy_set_header Connection "";');
    L.push('        proxy_set_header Authorization "";');
    L.push('        proxy_buffering off;');
    L.push('        proxy_request_buffering off;');
    L.push('        proxy_read_timeout 1h;');
    L.push('        proxy_send_timeout 1h;');
    L.push('        # Players on other domains (apps, embeds) may load the video too.');
    L.push('        proxy_hide_header Access-Control-Allow-Origin;');
    L.push('        add_header Access-Control-Allow-Origin * always;');
    L.push('        add_header Access-Control-Allow-Headers "Range, Origin, Content-Type" always;');
    L.push('        add_header Access-Control-Expose-Headers "Content-Length, Content-Range" always;');
    L.push("        if ($request_method = OPTIONS) { return 204; }");
    L.push('    }');
  }

  L.push('');
  if (opts.target === 'root') {
    L.push(`    root ${String(opts.root || '/var/www/html').trim()};`);
    L.push('    index index.html index.htm index.php;');
    L.push('    location / {');
    L.push('        try_files $uri $uri/ /index.html;');
    L.push('    }');
  } else {
    L.push('    location / {');
    L.push(`        proxy_pass http://127.0.0.1:${Number(opts.port) || 8000};`);
    L.push('        proxy_http_version 1.1;');
    L.push('        proxy_request_buffering off;');
    L.push('        proxy_set_header Host $host;');
    L.push('        proxy_set_header X-Real-IP $remote_addr;');
    L.push('        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
    L.push('        proxy_set_header X-Forwarded-Proto $scheme;');
    L.push('        proxy_set_header Upgrade $http_upgrade;');
    L.push('        proxy_set_header Connection "upgrade";');
    L.push('        proxy_read_timeout 1h;');
    L.push('        proxy_send_timeout 1h;');
    L.push('    }');
  }
  L.push('}');
  return `${L.join('\n')}\n`;
}

/** Just the stream-proxy location block, to paste into a site that already exists. */
export function streamBlock(stream) {
  const full = buildSite({ hosts: 'x', target: 'app', port: 1, stream });
  const m = full.match(/\n( {4}# Video:[\s\S]*?\n {4}\}\n)/);
  return m ? m[1].replace(/^ {4}/gm, '') : '';
}

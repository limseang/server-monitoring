import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { getSetting } from './settings.js';

/** "200-399" | "200" | "200,204,301-302" */
export function matchExpect(code, expect) {
  const spec = String(expect || '200-399');
  return spec.split(',').some((part) => {
    const [a, b] = part.trim().split('-').map(Number);
    if (!Number.isFinite(a)) return false;
    return Number.isFinite(b) ? code >= a && code <= b : code === a;
  });
}

function describeNetError(e) {
  const map = {
    ECONNREFUSED: 'Connection refused',
    ETIMEDOUT: 'Timed out',
    EHOSTUNREACH: 'Host unreachable',
    ENETUNREACH: 'Network unreachable',
    ECONNRESET: 'Connection reset',
    EPROTO: 'TLS/protocol error',
    ERR_SSL_WRONG_VERSION_NUMBER: 'TLS error (is this port HTTP, not HTTPS?)',
  };
  return map[e.code] ? `${map[e.code]} (${e.code})` : e.message;
}

/**
 * HTTP(S) check sent straight to a server IP (bypassing Cloudflare),
 * with the project's domain as Host header and TLS SNI.
 */
export function httpCheck({ ip, host, scheme = 'https', port, path = '/', expect, keyword, timeoutMs = 10000 }) {
  return new Promise((resolve) => {
    const started = performance.now();
    let done = false;
    let hard = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      resolve({ ...r, ms: Math.round(performance.now() - started) });
    };
    const isHttps = scheme !== 'http';
    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        host: ip,
        port: port || (isHttps ? 443 : 80),
        path: path || '/',
        method: 'GET',
        agent: false,
        headers: { Host: host || ip, 'User-Agent': 'Switchboard-HealthCheck/1.0', Accept: '*/*', 'Cache-Control': 'no-cache' },
        ...(isHttps ? { servername: host && !net.isIP(host) ? host : undefined, rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          if (keyword && size < 262144) {
            chunks.push(c);
            size += c.length;
          }
        });
        res.on('end', () => {
          const code = res.statusCode;
          if (!matchExpect(code, expect)) return finish({ ok: false, code, error: `HTTP ${code}` });
          if (keyword && !Buffer.concat(chunks).toString('utf8').includes(keyword)) {
            return finish({ ok: false, code, error: `Keyword "${keyword}" not found in response` });
          }
          finish({ ok: true, code, error: null });
        });
        res.on('error', (e) => finish({ ok: false, code: res.statusCode, error: e.message }));
      },
    );
    hard = setTimeout(() => {
      req.destroy();
      finish({ ok: false, code: null, error: `Timeout after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    req.on('error', (e) => finish({ ok: false, code: null, error: describeNetError(e) }));
    req.end();
  });
}

/** Run the project's health check against one deployment (project on a server). */
export function probe(project, dep) {
  return httpCheck({
    ip: dep.server_ip,
    host: project.domain || '',
    scheme: project.health_scheme,
    port: project.health_port || undefined,
    path: project.health_path || '/',
    expect: project.health_expect,
    keyword: project.health_keyword || '',
    timeoutMs: (Number(getSetting('check_timeout')) || 10) * 1000,
  });
}

/** Read the TLS certificate a host presents (for expiry warnings). */
export function certCheck({ host, servername, port = 443, timeoutMs = 10000 }) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let sock = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock?.destroy();
      } catch {}
      resolve(r);
    };
    sock = tls.connect(
      { host, port, servername: servername && !net.isIP(servername) ? servername : undefined, rejectUnauthorized: false },
      () => {
        const c = sock.getPeerCertificate();
        if (!c || !c.valid_to) return finish({ ok: false, error: 'No certificate presented' });
        const validTo = new Date(c.valid_to);
        finish({
          ok: true,
          valid_to: validTo.toISOString(),
          days_left: Math.floor((validTo.getTime() - Date.now()) / 864e5),
          issuer: c.issuer?.O || c.issuer?.CN || '',
          subject: c.subject?.CN || '',
          trusted: sock.authorized,
          trust_error: sock.authorizationError ? String(sock.authorizationError) : null,
        });
      },
    );
    timer = setTimeout(() => finish({ ok: false, error: 'Timeout' }), timeoutMs);
    sock.on('error', (e) => finish({ ok: false, error: describeNetError(e) }));
  });
}

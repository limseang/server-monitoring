/**
 * Pure helpers for the SSL setup (no SSH, so they are unit tested):
 *  - parse nginx config text into server { } blocks with their direct directives
 *  - which blocks serve a project's host names
 *  - rewrite those blocks so they serve HTTPS with a given certificate + key
 *  - read a PEM certificate (issuer, expiry, names) with Node's crypto
 */
import crypto from 'node:crypto';

/** Tokenise nginx config; returns server blocks with their own (not nested) directives and offsets. */
export function parseServerBlocks(text) {
  const blocks = [];
  const stack = []; // { name, block? }
  let tokens = []; // { v, start }
  let i = 0;
  const n = text.length;
  const endStatement = (endIdx, opens) => {
    if (!tokens.length) return;
    const name = tokens[0].v;
    if (opens) {
      const inside = stack.some((s) => s.name === 'server' || s.name === 'stream' || s.name === 'mail');
      const entry = { name };
      if (name === 'server' && tokens.length === 1 && !inside) {
        entry.block = { start: tokens[0].start, bodyStart: endIdx + 1, end: -1, directives: [] };
        blocks.push(entry.block);
      }
      stack.push(entry);
    } else {
      const top = stack[stack.length - 1];
      if (top?.block) top.block.directives.push({ name, args: tokens.slice(1).map((t) => t.v), start: tokens[0].start, end: endIdx + 1 });
    }
    tokens = [];
  };
  while (i < n) {
    const c = text[i];
    if (c === '#') {
      while (i < n && text[i] !== '\n') i++;
    } else if (/\s/.test(c)) i++;
    else if (c === ';') {
      endStatement(i, false);
      i++;
    } else if (c === '{') {
      endStatement(i, true);
      i++;
    } else if (c === '}') {
      tokens = [];
      const top = stack.pop();
      if (top?.block) top.block.end = i;
      i++;
    } else if (c === '"' || c === "'") {
      const start = i;
      let v = '';
      i++;
      while (i < n && text[i] !== c) {
        if (text[i] === '\\' && i + 1 < n) i++;
        v += text[i++];
      }
      i++;
      tokens.push({ v, start });
    } else {
      const start = i;
      while (i < n && !/[\s;{}#]/.test(text[i])) i++;
      tokens.push({ v: text.slice(start, i), start });
    }
  }
  return blocks.filter((b) => b.end > 0).map((b) => describe(b, text));
}

function describe(b, text) {
  // (a location for /.well-known/acme-challenge/ next to the redirect does not count as content)
  const body = text.slice(b.bodyStart, b.end).replace(/location[^{]*well-known[^{]*\{[^}]*\}/g, '');
  const all = (name) => b.directives.filter((d) => d.name === name);
  const names = all('server_name').flatMap((d) => d.args).map((h) => h.toLowerCase());
  const listens = all('listen').map((d) => d.args);
  const port = (args) => {
    const m = String(args[0] || '').match(/(?:^|:)(\d+)$/);
    return m ? Number(m[1]) : /^\d+$/.test(args[0]) ? Number(args[0]) : 80;
  };
  const sslOn = all('ssl').some((d) => d.args[0] === 'on');
  return {
    ...b,
    names,
    ports: listens.map(port),
    ssl: sslOn || listens.some((a) => a.includes('ssl')) || listens.some((a) => port(a) === 443),
    cert: all('ssl_certificate')[0]?.args[0] || '',
    key: all('ssl_certificate_key')[0]?.args[0] || '',
    // only sends visitors to https:// (adding port 443 to it would make an endless redirect)
    redirectsToHttps: /(^|[\s;{])return\s+30[1278]\s+["']?https:\/\//.test(body) && !/(^|[\s;{])(proxy_pass|fastcgi_pass|root|try_files|uwsgi_pass)\s/.test(body),
  };
}

/** Does a server_name entry (exact, *.zone, .zone, ~regex) cover this host? */
export function nameMatches(entry, host) {
  const h = host.toLowerCase();
  const e = entry.toLowerCase();
  if (e === h) return true;
  if (e.startsWith('*.')) return h.endsWith(e.slice(1)) && !h.slice(0, -e.length + 1).includes('.');
  if (e.startsWith('.')) return h === e.slice(1) || h.endsWith(e);
  if (e.startsWith('~')) {
    try {
      return new RegExp(e.slice(1), 'i').test(h);
    } catch {
      return false;
    }
  }
  return false;
}

export const blockServes = (b, hosts) => hosts.some((h) => b.names.some((e) => nameMatches(e, h)));

/** nginx resolves relative paths against its prefix (/etc/nginx). */
export const absPath = (p) => (!p || p.includes('$') ? '' : p.startsWith('/') ? p : `/etc/nginx/${p}`);

function indentAt(text, idx) {
  const ls = text.lastIndexOf('\n', idx - 1) + 1;
  return text.slice(ls, idx).match(/^[ \t]*/)[0] || '    ';
}

/**
 * Rewrite one config file so every server block for these hosts serves HTTPS with cert/key.
 * - blocks that already do HTTPS: point ssl_certificate(_key) at the new files (add them when missing,
 *   add "ssl" to a bare "listen 443")
 * - when no block does HTTPS yet: add "listen 443 ssl" (and [::]:443 when it listens on IPv6) to the
 *   http blocks, except pure "return 301 https://…" blocks
 * Returns { text, changed, notes }. `anySslElsewhere`: another file already has an HTTPS block for these hosts.
 */
export function planSiteEdit(text, hosts, cert, key, { anySslElsewhere = false } = {}) {
  const blocks = parseServerBlocks(text).filter((b) => blockServes(b, hosts));
  const edits = []; // { at, del, ins }
  const notes = [];
  const sslBlocks = blocks.filter((b) => b.ssl || b.cert);
  const setCertLines = (b) => {
    const ind = indentAt(text, b.directives[0]?.start ?? b.bodyStart);
    for (const [name, value] of [['ssl_certificate', cert], ['ssl_certificate_key', key]]) {
      const ds = b.directives.filter((d) => d.name === name);
      if (ds.length) for (const d of ds) edits.push({ at: d.start, del: d.end - d.start, ins: `${name} ${value};` });
    }
    const missing = [['ssl_certificate', cert], ['ssl_certificate_key', key]].filter(([name]) => !b.directives.some((d) => d.name === name));
    if (missing.length) {
      const after = b.directives.filter((d) => d.name === 'server_name').pop() || b.directives.filter((d) => d.name === 'listen').pop();
      const at = after ? after.end : b.bodyStart;
      edits.push({ at, del: 0, ins: missing.map(([name, value]) => `\n${ind}${name} ${value};`).join('') });
    }
  };
  if (sslBlocks.length) {
    for (const b of sslBlocks) {
      for (const d of b.directives.filter((x) => x.name === 'listen')) {
        const p = String(d.args[0] || '');
        if (/(^|:)443$/.test(p) && !d.args.includes('ssl') && !b.directives.some((x) => x.name === 'ssl' && x.args[0] === 'on')) {
          edits.push({ at: d.end - 1, del: 0, ins: ' ssl' });
          notes.push(`turned on ssl for "listen ${d.args.join(' ')}"`);
        }
      }
      setCertLines(b);
    }
  } else if (!anySslElsewhere) {
    const plain = blocks.filter((b) => !b.redirectsToHttps);
    if (blocks.length && !plain.length) notes.push('only a redirect to https:// was found — add a server block for port 443 by hand');
    for (const b of plain) {
      const listens = b.directives.filter((d) => d.name === 'listen');
      const last = listens.pop() || b.directives.find((d) => d.name === 'server_name');
      const ind = indentAt(text, last ? last.start : b.bodyStart);
      const v6 = b.directives.some((d) => d.name === 'listen' && /^\[/.test(d.args[0] || ''));
      const ins = `\n${ind}listen 443 ssl;${v6 ? `\n${ind}listen [::]:443 ssl;` : ''}\n${ind}ssl_certificate ${cert};\n${ind}ssl_certificate_key ${key};`;
      edits.push({ at: last ? last.end : b.bodyStart, del: 0, ins });
      notes.push(`added HTTPS (port 443) to the server block for ${b.names.join(' ')}`);
    }
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.ins + out.slice(e.at + e.del);
  return { text: out, changed: out !== text, notes, blocks: blocks.length };
}

/** What a PEM certificate says. `hosts`: the names it should cover. */
export function certInfo(pem, hosts = []) {
  try {
    const x = new crypto.X509Certificate(pem);
    const names = String(x.subjectAltName || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('DNS:'))
      .map((s) => s.slice(4).toLowerCase());
    const cn = (x.subject.match(/CN=([^\n,]+)/) || [])[1];
    if (!names.length && cn) names.push(cn.toLowerCase());
    const issuer = x.issuer.replace(/\n/g, ', ');
    const daysLeft = Math.floor((Date.parse(x.validTo) - Date.now()) / 86400e3);
    const selfSigned = x.issuer === x.subject;
    const kind = /CloudFlare Origin/i.test(issuer)
      ? 'cloudflare-origin'
      : /Let's Encrypt/i.test(issuer)
        ? 'letsencrypt'
        : /ZeroSSL/i.test(issuer)
          ? 'zerossl'
          : selfSigned
            ? 'self-signed'
            : 'other';
    const covers = (h) => names.some((n) => nameMatches(n, h));
    return {
      ok: true,
      issuer,
      subject: x.subject.replace(/\n/g, ', '),
      names,
      not_after: new Date(x.validTo).toISOString(),
      days_left: daysLeft,
      kind,
      missing_hosts: hosts.filter((h) => !covers(h)),
    };
  } catch (e) {
    return { ok: false, error: `not a valid certificate (${e.message})` };
  }
}

/** Own certificate pasted by a user: valid PEM, key matches, not expired. Returns { info } or throws. */
export function checkOwnCert(certPem, keyPem, hosts) {
  const cert = String(certPem || '').trim();
  const key = String(keyPem || '').trim();
  if (!/-----BEGIN CERTIFICATE-----/.test(cert)) throw new Error('Paste the certificate (it starts with -----BEGIN CERTIFICATE-----)');
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) throw new Error('Paste the private key (it starts with -----BEGIN PRIVATE KEY-----)');
  if (/ENCRYPTED/.test(key)) throw new Error('The private key has a password — nginx needs it without one (openssl pkey -in key.pem -out plain.pem)');
  if (cert.length > 64 * 1024 || key.length > 16 * 1024) throw new Error('That is too big for a certificate');
  const info = certInfo(cert, hosts);
  if (!info.ok) throw new Error(`Certificate: ${info.error}`);
  let priv;
  try {
    priv = crypto.createPrivateKey(key);
  } catch (e) {
    throw new Error(`Private key: not valid (${e.message})`);
  }
  if (!new crypto.X509Certificate(cert).checkPrivateKey(priv)) throw new Error('The private key does not belong to this certificate');
  if (info.days_left < 0) throw new Error(`This certificate expired on ${info.not_after.slice(0, 10)}`);
  return { info, cert: `${cert}\n`, key: `${key}\n` };
}

/** One server's summary from its scanned sites: { status, message }. */
export function serverStatus(scan) {
  if (!scan.nginx && !scan.edge) return { status: 'no-nginx', message: 'No nginx on this server (an app container may serve HTTPS itself)' };
  const sites = scan.sites;
  if (!sites.length) return { status: 'no-site', message: `No nginx site on this server serves ${scan.hosts.join(', ') || 'this project'}` };
  const sslSites = sites.filter((s) => s.ssl);
  const missing = sslSites.filter((s) => s.cert_missing || s.key_missing);
  if (missing.length) return { status: 'missing', message: `nginx points to certificate files that are not on this server: ${[...new Set(missing.flatMap((s) => [s.cert_missing && s.cert, s.key_missing && s.key].filter(Boolean)))].join(', ')}` };
  if (!sslSites.length) return { status: 'no-ssl', message: 'The site only serves http (port 80) — no SSL yet' };
  const info = sslSites.map((s) => s.cert_info).filter((c) => c?.ok);
  if (!info.length) return { status: 'unknown', message: 'Could not read the certificate' };
  const worst = info.sort((a, b) => a.days_left - b.days_left)[0];
  if (worst.days_left < 0) return { status: 'expired', message: `The certificate expired on ${worst.not_after.slice(0, 10)}` };
  if (sslSites.some((s) => s.key_match === false)) return { status: 'bad-key', message: 'The private key does not match the certificate' };
  if (worst.missing_hosts.length) return { status: 'wrong-host', message: `The certificate does not cover ${worst.missing_hosts.join(', ')}` };
  if (worst.kind === 'self-signed') return { status: 'self-signed', message: 'Self-signed certificate — works with Cloudflare SSL "Full", not "Full (strict)"' };
  return { status: 'ok', message: `${KIND_LABEL[worst.kind] || worst.issuer}, valid until ${worst.not_after.slice(0, 10)} (${worst.days_left} days)` };
}

export const KIND_LABEL = {
  'cloudflare-origin': 'Cloudflare Origin Certificate',
  letsencrypt: "Let's Encrypt",
  zerossl: 'ZeroSSL',
  'self-signed': 'Self-signed',
  other: 'Certificate',
};

// Minimal fake of the Cloudflare v4 API endpoints Switchboard uses. In-memory, test lab only.
import http from 'node:http';
import crypto from 'node:crypto';

const TOKEN = process.env.CF_TOKEN || 'test-token';
const IP = process.env.INITIAL_IP || '172.30.0.11';
const hid = (s) => crypto.createHash('md5').update(s).digest('hex');

const zone = { id: hid('zone:shop.test'), name: 'shop.test', status: 'active', plan: { name: 'Free Website' } };
const zone2 = { id: hid('zone:other.test'), name: 'other.test', status: 'active', plan: { name: 'Free Website' } };
const records = [
  { name: 'shop.test', type: 'A', content: IP, proxied: true, ttl: 1 },
  { name: 'www.shop.test', type: 'A', content: IP, proxied: true, ttl: 1 },
  { name: 'mail.shop.test', type: 'A', content: '172.30.0.99', proxied: false, ttl: 3600 },
  { name: 'api.shop.test', type: 'CNAME', content: 'shop.test', proxied: true, ttl: 1 },
].map((r) => ({ id: hid(`rec:${r.name}`), zone_id: zone.id, zone_name: zone.name, ...r }));
let purges = 0;
// Zone settings (SSL mode, Always Use HTTPS) per zone id.
const SETTINGS0 = { ssl: 'flexible', always_use_https: 'off' };
const settings = {};
const zoneSettings = (id) => (settings[id] ||= { ...SETTINGS0 });
// Load Balancing add-on (account-level monitors/pools, zone-level load balancers).
const ACCOUNT = 'acc0123456789abcdef';
const lb = { monitors: [], pools: [], lbs: [] };
let lbSeq = 0;
const lbId = () => hid(`lb:${++lbSeq}:${Date.now()}`);
const telegram = []; // messages "sent" to Telegram (the lab points TELEGRAM_API_BASE here)


// ---- Origin CA: sign a CSR with a throwaway CA key (tiny DER encoder, no openssl needed) ----
const caKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const originCerts = [];
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  for (let x = n; x > 0; x >>= 8) b.unshift(x & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag, ...parts) => {
  const v = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLen(v.length), v]);
};
const seq = (...p) => tlv(0x30, ...p);
function oid(str) {
  const [a, b, ...rest] = str.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const bytes = [n & 0x7f];
    for (let x = n >> 7; x > 0; x >>= 7) bytes.unshift(0x80 | (x & 0x7f));
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
}
const utf8 = (s) => tlv(0x0c, Buffer.from(s));
const name = (pairs) => seq(...pairs.map(([o, v]) => tlv(0x31, seq(oid(o), utf8(v)))));
const utc = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
function readTlv(buf, off) {
  let len = buf[off + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
    hdr += n;
  }
  return { start: off, value: off + hdr, end: off + hdr + len };
}
function signCsr(csrPem, hostnames, days) {
  const der = Buffer.from(csrPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  const info = readTlv(der, readTlv(der, 0).value);
  const version = readTlv(der, info.value);
  const subject = readTlv(der, version.end);
  const spki = readTlv(der, subject.end);
  const spkiRaw = der.subarray(spki.start, spki.end);
  const sha256rsa = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const from = new Date();
  const to = new Date(from.getTime() + days * 864e5);
  const san = seq(oid('2.5.29.17'), tlv(0x04, seq(...hostnames.map((h) => tlv(0x82, Buffer.from(h))))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    sha256rsa,
    name([['2.5.4.6', 'US'], ['2.5.4.10', 'CloudFlare, Inc.'], ['2.5.4.11', 'CloudFlare Origin SSL Certificate Authority']]),
    seq(utc(from), utc(to)),
    name([['2.5.4.10', 'CloudFlare, Inc.'], ['2.5.4.11', 'CloudFlare Origin CA'], ['2.5.4.3', 'CloudFlare Origin Certificate']]),
    spkiRaw,
    tlv(0xa3, seq(san)),
  );
  const sig = crypto.sign('sha256', tbs, caKey);
  const cert = seq(tbs, sha256rsa, tlv(0x03, Buffer.from([0]), sig));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { pem, expires: to };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
const ok = (res, result, info) => send(res, 200, { success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) });
const fail = (res, status, code, message) => send(res, status, { success: false, errors: [{ code, message }], messages: [], result: null });

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__state') return send(res, 200, { records, purges, telegram, lb, settings, origin_certs: originCerts });
    if (url.pathname === '/__reset') {
      lb.monitors.length = 0;
      lb.pools.length = 0;
      lb.lbs.length = 0;
      for (let i = records.length - 1; i >= 4; i--) records.splice(i, 1); // records made by tests
      for (const r of records) if (r.type === 'A' && r.name !== 'mail.shop.test') r.content = IP;
      for (const r of records) r.proxied = r.name !== 'mail.shop.test';
      for (const k of Object.keys(settings)) delete settings[k];
      originCerts.length = 0;
      purges = 0;
      telegram.length = 0;
      return send(res, 200, { ok: true });
    }
    // Fake bot: getMe / getUpdates (one private chat wrote to it); chat 404404 does not exist.
    if (/^\/bot[^/]+\/getMe$/.test(url.pathname)) return send(res, 200, { ok: true, result: { id: 999, is_bot: true, username: 'lab_switchboard_bot' } });
    if (/^\/bot[^/]+\/getUpdates$/.test(url.pathname)) {
      return send(res, 200, { ok: true, result: [{ update_id: 1, message: { message_id: 1, text: '/start', chat: { id: 111222333, type: 'private', first_name: 'Lab', last_name: 'User', username: 'labuser' } } }] });
    }
    if (/^\/bot[^/]+\/sendMessage$/.test(url.pathname) && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const msg = JSON.parse(b || '{}');
        if (String(msg.chat_id) === '404404') return send(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
        telegram.push({ chat_id: msg.chat_id, text: msg.text, at: new Date().toISOString() });
        console.log(`TELEGRAM → ${msg.chat_id}: ${String(msg.text).split('\n')[0]}`);
        send(res, 200, { ok: true, result: { message_id: telegram.length } });
      });
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return fail(res, 403, 9109, 'Invalid access token');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = url.pathname.replace(/^\/client\/v4/, '');
      let m;
      if (req.method === 'GET' && p === '/zones') return ok(res, [zone, zone2], { page: 1, total_pages: 1 });
      if ((m = p.match(/^\/zones\/([^/]+)\/dns_records$/)) && req.method === 'GET') {
        const name = url.searchParams.get('name');
        return ok(res, records.filter((r) => r.zone_id === m[1] && (!name || r.name === name)), { page: 1, total_pages: 1 });
      }
      if ((m = p.match(/^\/zones\/([^/]+)\/dns_records$/)) && req.method === 'POST') {
        const z = [zone, zone2].find((x) => x.id === m[1]);
        if (!z) return fail(res, 404, 7003, 'Zone not found');
        const b = JSON.parse(body || '{}');
        if (records.some((r) => r.zone_id === z.id && r.name === b.name && r.type === b.type)) return fail(res, 400, 81057, 'An identical record already exists.');
        const r = { id: hid(`rec:${b.name}:${Date.now()}`), zone_id: z.id, zone_name: z.name, name: b.name, type: b.type || 'A', content: b.content, proxied: !!b.proxied, ttl: b.ttl || 1 };
        records.push(r);
        console.log(`DNS created ${r.type} ${r.name} -> ${r.content}`);
        return ok(res, r);
      }
      if ((m = p.match(/^\/zones\/([^/]+)\/dns_records\/([^/]+)$/))) {
        const r = records.find((x) => x.zone_id === m[1] && x.id === m[2]);
        if (!r) return fail(res, 404, 81044, 'Record does not exist.');
        if (req.method === 'GET') return ok(res, r);
        if (req.method === 'DELETE') {
          records.splice(records.indexOf(r), 1);
          console.log(`DNS deleted ${r.name}`);
          return ok(res, { id: r.id });
        }
        if (req.method === 'PATCH') {
          const patch = JSON.parse(body || '{}');
          if (patch.content) r.content = patch.content;
          if (typeof patch.proxied === 'boolean') r.proxied = patch.proxied;
          if (patch.ttl) r.ttl = patch.ttl;
          console.log(`PATCH ${r.name} -> ${r.content}${r.proxied ? ' (proxied)' : ''}`);
          return ok(res, r);
        }
      }
      const json = () => JSON.parse(body || '{}');
      if (p === '/certificates' && req.method === 'POST') {
        const b = json();
        if (!/BEGIN CERTIFICATE REQUEST/.test(b.csr || '')) return fail(res, 400, 1010, 'Invalid CSR');
        if (!Array.isArray(b.hostnames) || !b.hostnames.length) return fail(res, 400, 1011, 'hostnames required');
        if (!['origin-rsa', 'origin-ecc'].includes(b.request_type)) return fail(res, 400, 1012, 'Invalid request_type');
        let signed;
        try {
          signed = signCsr(b.csr, b.hostnames, b.requested_validity || 5475);
        } catch (e) {
          return fail(res, 400, 1010, `Invalid CSR: ${e.message}`);
        }
        const item = { id: hid(`cert:${Date.now()}:${originCerts.length}`), certificate: signed.pem, hostnames: b.hostnames, expires_on: signed.expires.toISOString(), request_type: b.request_type, requested_validity: b.requested_validity || 5475, csr: b.csr };
        originCerts.push(item);
        console.log(`ORIGIN CERT for ${b.hostnames.join(', ')}`);
        return ok(res, item);
      }
      if ((m = p.match(/^\/zones\/([^/]+)\/settings\/(ssl|always_use_https)$/))) {
        if (![zone, zone2].some((x) => x.id === m[1])) return fail(res, 404, 7003, 'Zone not found');
        const zs = zoneSettings(m[1]);
        if (req.method === 'PATCH') {
          const v = json().value;
          const allowed = m[2] === 'ssl' ? ['off', 'flexible', 'full', 'strict'] : ['on', 'off'];
          if (!allowed.includes(v)) return fail(res, 400, 1007, `Invalid value for zone setting ${m[2]}`);
          zs[m[2]] = v;
          console.log(`ZONE ${m[1].slice(0, 6)} ${m[2]} = ${v}`);
        }
        return ok(res, { id: m[2], value: zs[m[2]], editable: true, modified_on: new Date().toISOString() });
      }
      if ((m = p.match(/^\/zones\/([^/]+)$/)) && req.method === 'GET') {
        const z = [zone, zone2].find((x) => x.id === m[1]);
        return z ? ok(res, { ...z, account: { id: ACCOUNT, name: 'Lab account' } }) : fail(res, 404, 7003, 'Zone not found');
      }
      // monitors + pools (account)
      if ((m = p.match(/^\/accounts\/([^/]+)\/load_balancers\/(monitors|pools)(?:\/([^/]+))?(\/health)?$/))) {
        if (m[1] !== ACCOUNT) return fail(res, 403, 10000, 'Authentication error');
        const list = lb[m[2]];
        if (!m[3] && req.method === 'GET') return ok(res, list);
        if (!m[3] && req.method === 'POST') {
          const item = { id: lbId(), ...json() };
          list.push(item);
          console.log(`LB ${m[2]} created ${item.id}${item.origins ? ' ' + JSON.stringify(item.origins.map((o) => [o.address, o.enabled])) : ''}`);
          return ok(res, item);
        }
        const i = list.findIndex((x) => x.id === m[3]);
        if (i < 0) return fail(res, 404, 1002, 'Not found');
        if (m[4] && m[2] === 'pools') {
          // Fake health: every enabled origin healthy, seen from two data centers.
          const origins = (list[i].origins || []).map((o) => ({ [o.address]: { healthy: !!o.enabled, response_code: o.enabled ? 200 : 0 } }));
          return ok(res, { pool_id: list[i].id, pop_health: { 'Singapore, SG': { healthy: true, origins }, 'Bangkok, TH': { healthy: true, origins } } });
        }
        if (req.method === 'GET') return ok(res, list[i]);
        if (req.method === 'PUT') {
          list[i] = { ...json(), id: list[i].id };
          if (list[i].origins) console.log(`LB pool updated ${JSON.stringify(list[i].origins.map((o) => [o.address, o.enabled]))}`);
          return ok(res, list[i]);
        }
        if (req.method === 'DELETE') {
          list.splice(i, 1);
          return ok(res, { id: m[3] });
        }
      }
      // load balancers (zone)
      if ((m = p.match(/^\/zones\/([^/]+)\/load_balancers(?:\/([^/]+))?$/))) {
        const zl = lb.lbs.filter((x) => x.zone_id === m[1]);
        if (!m[2] && req.method === 'GET') return ok(res, zl);
        if (!m[2] && req.method === 'POST') {
          const item = { id: lbId(), zone_id: m[1], ...json() };
          lb.lbs.push(item);
          console.log(`LB created for ${item.name}`);
          return ok(res, item);
        }
        const i = lb.lbs.findIndex((x) => x.id === m[2] && x.zone_id === m[1]);
        if (i < 0) return fail(res, 404, 1002, 'Not found');
        if (req.method === 'PUT') {
          lb.lbs[i] = { ...json(), id: m[2], zone_id: m[1] };
          return ok(res, lb.lbs[i]);
        }
        if (req.method === 'DELETE') {
          lb.lbs.splice(i, 1);
          return ok(res, { id: m[2] });
        }
        if (req.method === 'GET') return ok(res, lb.lbs[i]);
      }
      if ((m = p.match(/^\/zones\/([^/]+)\/purge_cache$/)) && req.method === 'POST') {
        purges++;
        return ok(res, { id: m[1] });
      }
      fail(res, 404, 7003, `No route for ${req.method} ${p}`);
    });
  })
  .listen(8787, () => console.log('fake Cloudflare API on :8787'));

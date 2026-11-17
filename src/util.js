import { Transform } from 'node:stream';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pass-through stream that reports progress without forcing the stream into flowing mode
 * (a plain 'data' listener would start the flow before the consumer is attached and lose bytes).
 */
export function byteCounter(onProgress, everyMs = 5000) {
  let total = 0;
  let last = Date.now();
  const t = new Transform({
    transform(chunk, enc, cb) {
      total += chunk.length;
      if (onProgress && Date.now() - last > everyMs) {
        last = Date.now();
        onProgress(total);
      }
      cb(null, chunk);
    },
  });
  Object.defineProperty(t, 'total', { get: () => total });
  return t;
}

export function fmtBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function slugify(s) {
  return (
    String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}

export const stripAnsi = (s) =>
  String(s)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');

const NOISE = /Using a password on the command line interface can be insecure|Deprecated program name/i;

/** Last few meaningful lines of command output, for error messages. */
export function lastLines(s, n = 4) {
  return String(s || '')
    .split('\n')
    .map((l) => stripAnsi(l).trim())
    .filter((l) => l && !NOISE.test(l))
    .slice(-n)
    .join(' | ')
    .slice(0, 1200);
}

export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.round(h / 24)} days`;
}

export const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

export const localTime = (d = new Date()) => d.toLocaleTimeString('en-GB', { hour12: false });

/** True for addresses the internet can't reach (LAN, carrier NAT, loopback, link-local). */
export function isPrivateAddress(ip) {
  const v = String(ip || '').trim().toLowerCase();
  const m = v.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || a === 0;
  }
  return v === '::1' || /^f[cd][0-9a-f]{2}:/.test(v) || /^fe[89ab][0-9a-f]:/.test(v);
}

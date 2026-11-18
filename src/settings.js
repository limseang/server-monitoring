import { get, run } from './db.js';
import { encrypt, decrypt } from './crypto.js';

export const SECRET_SETTINGS = ['cf_token', 'telegram_token', 'webhook_url', 'github_token', 's3_access_key', 's3_secret_key'];

export const DEFAULTS = {
  cf_token: '',
  github_token: '',
  telegram_token: '',
  telegram_chat_id: '',
  webhook_url: '',
  dashboard_url: '',
  notify_jobs: [], // job types that send a message when they finish
  notify_jobs_failed_only: 0, // 1 = only when such a job fails or is cancelled
  billing_reminders: 1, // remind before a server's payment is due
  billing_remind_days: '7,3,1,0', // days before the due date to send a reminder
  billing_overdue_daily: 1, // 1 = remind every day while a payment is overdue
  billing_remind_hour: 9, // don't send reminders before this hour (Switchboard's time zone)
  check_interval: 60, // seconds between HTTP health checks
  check_timeout: 10, // seconds
  metrics_interval: 300, // seconds between SSH metrics collection
  dns_interval: 300, // seconds between Cloudflare DNS drift checks
  disk_alert_pct: 90,
  ssl_alert_days: 14,
  stale_alert_hours: 24,
  history_days: 14,
  busy_cpu_pct: 80, // a server is "busy" when CPU or memory stays above these…
  busy_mem_pct: 90,
  busy_minutes: 10, // …for this long
  s3_enabled: 0, // keep backups in S3 (any S3-compatible storage)
  s3_endpoint: '',
  s3_region: 'us-east-1',
  s3_bucket: '',
  s3_access_key: '',
  s3_secret_key: '',
  s3_path_style: 1, // https://endpoint/bucket/key (MinIO, most S3-compatible); 0 = https://bucket.endpoint/key (AWS)
  s3_prefix: 'switchboard-backups',
  s3_keep_local: 0, // 1 = also keep a copy on the Switchboard machine
  traffic_enabled: 1, // read nginx access logs every minute (Traffic tab + unusual-activity alerts)
  traffic_spike_x: 5, // alert when requests/min reach this many times the usual rate…
  traffic_min_rpm: 60, // …and at least this many per minute
  traffic_5xx_pct: 5, // alert when this % of requests (≥20 in 5 min) are server errors
  traffic_ip_pct: 40, // alert when one IP makes this % of requests (≥300 in 5 min)
  traffic_ssh_fails: 50, // alert on this many failed SSH logins in 5 min
};

export function getSetting(key) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return DEFAULTS[key];
  let v;
  try {
    v = JSON.parse(row.value);
  } catch {
    v = row.value;
  }
  if (SECRET_SETTINGS.includes(key) && v) {
    try {
      v = decrypt(v);
    } catch {
      v = '';
    }
  }
  return v;
}

export function setSetting(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`);
  let v = value;
  if (SECRET_SETTINGS.includes(key)) v = value ? encrypt(String(value)) : '';
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(v));
}

const mask = (v) => (v.length <= 10 ? '••••••' : `${v.slice(0, 4)}…${v.slice(-4)}`);

/** Settings for the UI: secrets are never sent back, only whether they are set. */
export function publicSettings() {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (SECRET_SETTINGS.includes(key)) {
      const v = getSetting(key);
      out[key] = '';
      out[`has_${key}`] = !!v;
      out[`${key}_hint`] = v ? mask(v) : '';
    } else {
      out[key] = getSetting(key);
    }
  }
  return out;
}

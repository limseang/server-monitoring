import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'switchboard.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    totp_secret TEXT,
    last_login_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    seen_at TEXT,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    ipv6 TEXT,
    ssh_host TEXT,
    ssh_port INTEGER NOT NULL DEFAULT 22,
    ssh_user TEXT NOT NULL DEFAULT 'root',
    auth_type TEXT NOT NULL DEFAULT 'key',
    ssh_key TEXT,
    ssh_key_path TEXT,
    ssh_passphrase TEXT,
    ssh_password TEXT,
    host_key TEXT,
    docker_cmd TEXT NOT NULL DEFAULT 'docker',
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    status_error TEXT,
    metrics TEXT,
    checked_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    domain TEXT,
    dns_records TEXT NOT NULL DEFAULT '[]',
    active_deployment_id INTEGER,
    health_path TEXT NOT NULL DEFAULT '/up',
    health_scheme TEXT NOT NULL DEFAULT 'https',
    health_port INTEGER,
    health_expect TEXT NOT NULL DEFAULT '200-399',
    health_keyword TEXT,
    auto_failover INTEGER NOT NULL DEFAULT 0,
    failover_threshold INTEGER NOT NULL DEFAULT 3,
    failover_cooldown INTEGER NOT NULL DEFAULT 30,
    last_failover_at TEXT,
    last_switch_at TEXT,
    maintenance_on_cmd TEXT NOT NULL DEFAULT 'php artisan down --retry=60',
    maintenance_off_cmd TEXT NOT NULL DEFAULT 'php artisan up',
    deploy_script TEXT,
    sync_paths TEXT,
    sync_schedule TEXT,
    sync_files_scheduled INTEGER NOT NULL DEFAULT 0,
    backup_schedule TEXT,
    backup_keep INTEGER NOT NULL DEFAULT 7,
    purge_cache INTEGER NOT NULL DEFAULT 0,
    dns_state TEXT,
    ssl_state TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE deployments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    priority INTEGER NOT NULL DEFAULT 10,
    app_dir TEXT,
    app_container TEXT,
    db_type TEXT NOT NULL DEFAULT 'mysql',
    db_container TEXT,
    db_name TEXT,
    db_user TEXT,
    db_password TEXT,
    health TEXT NOT NULL DEFAULT 'unknown',
    health_detail TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0,
    checked_at TEXT,
    down_since TEXT,
    maintenance INTEGER NOT NULL DEFAULT 0,
    data_at TEXT,
    data_note TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, server_id)
  );
  CREATE TABLE checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    ok INTEGER NOT NULL,
    code INTEGER,
    ms INTEGER,
    error TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX idx_checks_dep_at ON checks (deployment_id, at);
  CREATE INDEX idx_checks_at ON checks (at);
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    project_id INTEGER,
    server_id INTEGER,
    params TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    log TEXT NOT NULL DEFAULT '',
    error TEXT,
    user TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX idx_jobs_project ON jobs (project_id, id);
  CREATE INDEX idx_jobs_status ON jobs (status);
  CREATE TABLE backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    deployment_id INTEGER,
    server_name TEXT,
    db_type TEXT,
    db_name TEXT,
    kind TEXT NOT NULL,
    file TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    tables INTEGER,
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_backups_project ON backups (project_id, id);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    project_id INTEGER,
    server_id INTEGER,
    job_id INTEGER,
    user TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX idx_events_at ON events (at);
  `,
  // v2: load balancing, shared database servers
  `
  ALTER TABLE servers ADD COLUMN private_ip TEXT;
  ALTER TABLE projects ADD COLUMN traffic_mode TEXT NOT NULL DEFAULT 'single';
  ALTER TABLE projects ADD COLUMN lb_provider TEXT NOT NULL DEFAULT 'own';
  ALTER TABLE projects ADD COLUMN lb_server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL;
  ALTER TABLE projects ADD COLUMN lb_config TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE projects ADD COLUMN lb_state TEXT;
  ALTER TABLE projects ADD COLUMN db_server_id INTEGER;
  ALTER TABLE projects ADD COLUMN shared_db TEXT;
  ALTER TABLE projects ADD COLUMN drain_seconds INTEGER NOT NULL DEFAULT 30;
  ALTER TABLE deployments ADD COLUMN lb_state TEXT NOT NULL DEFAULT 'off';
  ALTER TABLE deployments ADD COLUMN lb_weight INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE db_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    engine TEXT NOT NULL,
    dir TEXT NOT NULL,
    container TEXT NOT NULL,
    port INTEGER NOT NULL,
    bind_ip TEXT NOT NULL,
    root_password TEXT NOT NULL,
    redis INTEGER NOT NULL DEFAULT 1,
    redis_container TEXT,
    redis_port INTEGER,
    redis_password TEXT,
    allowed TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL
  );
  `,
  // v3: per-server "no safety backup needed" (just overwrite when copying data in)
  `
  ALTER TABLE deployments ADD COLUMN skip_backup INTEGER NOT NULL DEFAULT 0;
  `,
  // v4: user roles, project templates, GitHub CI/CD (self-hosted runners), staging, PR previews
  `
  ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
  ALTER TABLE projects ADD COLUMN parent_id INTEGER REFERENCES projects(id) ON DELETE CASCADE;
  ALTER TABLE projects ADD COLUMN env TEXT NOT NULL DEFAULT 'production';
  ALTER TABLE projects ADD COLUMN template TEXT;
  ALTER TABLE projects ADD COLUMN template_opts TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE projects ADD COLUMN git_repo TEXT;
  ALTER TABLE projects ADD COLUMN git_branch TEXT NOT NULL DEFAULT 'main';
  ALTER TABLE projects ADD COLUMN ci_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE projects ADD COLUMN ci_test_on TEXT NOT NULL DEFAULT 'github';
  ALTER TABLE projects ADD COLUMN ci_test_cmd TEXT;
  ALTER TABLE projects ADD COLUMN ci_state TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE projects ADD COLUMN preview_server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL;
  ALTER TABLE projects ADD COLUMN preview_zone TEXT;
  ALTER TABLE deployments ADD COLUMN runner_state TEXT;
  ALTER TABLE deployments ADD COLUMN app_port INTEGER;
  CREATE TABLE ci_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id INTEGER NOT NULL,
    run_number INTEGER,
    event TEXT,
    branch TEXT,
    sha TEXT,
    title TEXT,
    actor TEXT,
    status TEXT,
    conclusion TEXT,
    html_url TEXT,
    created_at TEXT,
    updated_at TEXT,
    UNIQUE (project_id, run_id)
  );
  CREATE INDEX idx_ci_runs_project ON ci_runs (project_id, run_id);
  CREATE TABLE runners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    label TEXT NOT NULL,
    version TEXT,
    status TEXT NOT NULL DEFAULT 'installed',
    error TEXT,
    installed_at TEXT,
    UNIQUE (repo, server_id)
  );
  CREATE TABLE previews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    pr INTEGER NOT NULL,
    title TEXT,
    branch TEXT,
    sha TEXT,
    author TEXT,
    host TEXT NOT NULL,
    zone_id TEXT,
    record_id TEXT,
    status TEXT NOT NULL DEFAULT 'waiting',
    created_at TEXT NOT NULL,
    updated_at TEXT,
    UNIQUE (project_id, pr)
  );
  `,
  // v5: domains connected to a port on a server (Cloudflare record + web proxy site)
  `
  CREATE TABLE domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    zone_id TEXT,
    zone_name TEXT,
    record_id TEXT,
    record_created INTEGER NOT NULL DEFAULT 0,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    UNIQUE (host)
  );
  `,
  // v6: traffic per server per minute (from nginx access logs) + where the log reader is
  `
  CREATE TABLE traffic (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    minute TEXT NOT NULL,
    req INTEGER NOT NULL DEFAULT 0,
    s2 INTEGER NOT NULL DEFAULT 0,
    s3 INTEGER NOT NULL DEFAULT 0,
    s4 INTEGER NOT NULL DEFAULT 0,
    s5 INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    rt_sum REAL NOT NULL DEFAULT 0,
    rt_n INTEGER NOT NULL DEFAULT 0,
    ssh_fail INTEGER NOT NULL DEFAULT 0,
    top TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (server_id, minute)
  );
  ALTER TABLE servers ADD COLUMN traffic_state TEXT;
  `,
  // v7: backups kept in S3
  `
  ALTER TABLE backups ADD COLUMN s3_key TEXT;
  ALTER TABLE backups ADD COLUMN s3_at TEXT;
  ALTER TABLE backups ADD COLUMN s3_error TEXT;
  `,
  // v8: CI/CD deploy mode — 'runner' (GitHub self-hosted runner) or 'pull' (Switchboard deploys new commits itself)
  `
  ALTER TABLE projects ADD COLUMN ci_mode TEXT NOT NULL DEFAULT 'runner';
  `,
  // v9: server billing (when each rented server must be paid) + payment history
  `
  CREATE TABLE billing (
    server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    provider TEXT,
    provider_url TEXT,
    price REAL,
    currency TEXT NOT NULL DEFAULT 'USD',
    cycle_months INTEGER NOT NULL DEFAULT 1,
    due_date TEXT,
    anchor_day INTEGER,
    auto_renew INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    reminded TEXT,
    updated_at TEXT
  );
  CREATE TABLE payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    paid_on TEXT NOT NULL,
    amount REAL,
    currency TEXT,
    months INTEGER NOT NULL DEFAULT 1,
    period_from TEXT,
    period_to TEXT,
    user TEXT,
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_payments_server ON payments (server_id, id);
  `,
  // v10: outside database access (another service uses the project's database via one host name)
  `
  ALTER TABLE projects ADD COLUMN db_access TEXT;
  `,
  // v11: SSH protection per server (fail2ban / password login off), so repeated alerts can be quieter
  `
  ALTER TABLE servers ADD COLUMN ssh_guard TEXT;
  `,
  // v12: usage history (CPU / memory / GPU / network per stats check) + a record of every busy time
  `
  CREATE TABLE server_stats (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    cpu REAL,
    mem REAL,
    swap REAL,
    load1 REAL,
    disk REAL,
    gpu REAL,
    gpu_mem REAL,
    net_rx REAL,
    net_tx REAL,
    PRIMARY KEY (server_id, at)
  );
  CREATE TABLE busy_periods (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    peak_cpu REAL,
    peak_mem REAL,
    peak_gpu REAL,
    peak_rpm REAL,
    avg_rpm REAL,
    baseline_rpm REAL,
    requests INTEGER,
    cause TEXT
  );
  CREATE INDEX idx_busy_server ON busy_periods (server_id, started_at);
  `,
  // v13: CI/CD with your own workflow file (Switchboard never rewrites it) and a runner that may run it
  //      ('restricted' = only Switchboard's deploy commands as sb-runner, 'full' = as the SSH user: Docker, files…)
  `
  ALTER TABLE projects ADD COLUMN ci_workflow_path TEXT;
  ALTER TABLE projects ADD COLUMN ci_runner_access TEXT NOT NULL DEFAULT 'restricted';
  `,
  // v14: choose which servers get a deploy now and which later (e.g. the live server at a quiet time).
  //      ci_live_policy: what the live server does when CI/CD brings a new commit — 'now' | 'hold' | 'quiet'
  //      ci_quiet_time:  'HH:MM|<minutes east of UTC>' (the time as the person who set it meant it)
  `
  ALTER TABLE projects ADD COLUMN ci_live_policy TEXT NOT NULL DEFAULT 'now';
  ALTER TABLE projects ADD COLUMN ci_quiet_time TEXT;
  CREATE TABLE held_deploys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    deployment_id INTEGER NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
    commit_sha TEXT,
    run_at TEXT,
    reason TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // v15: live progress of a job (JSON, e.g. a deploy: each server's phase and commits) for the job views
  `
  ALTER TABLE jobs ADD COLUMN progress TEXT;
  `,
  // v16: a held deploy that your own GitHub workflow runs (Switchboard starts it with workflow_dispatch) instead of SSH
  `
  ALTER TABLE held_deploys ADD COLUMN via TEXT;
  `,
  // v17: workflow templates for the visual flow editor (save a flow once, start other projects from it)
  `
  CREATE TABLE flow_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    content TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // v18: web proxy (nginx) for a project: its domains, and per server where it sends them and the last check
  `
  ALTER TABLE projects ADD COLUMN proxy TEXT;
  ALTER TABLE deployments ADD COLUMN proxy_state TEXT;
  `,
];

const current = db.prepare('PRAGMA user_version').get().user_version;
for (let v = current; v < MIGRATIONS.length; v++) {
  db.exec('BEGIN');
  try {
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}
const norm = (args) => args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

export const all = (sql, ...args) => stmt(sql).all(...norm(args));
export const get = (sql, ...args) => stmt(sql).get(...norm(args));

export function run(sql, ...args) {
  const r = stmt(sql).run(...norm(args));
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
}

// Table/column names always come from code, never from user input.
export function insert(table, row) {
  const keys = Object.keys(row);
  return run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => row[k])).id;
}

export function update(table, id, row) {
  const keys = Object.keys(row);
  if (!keys.length) return 0;
  return run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => row[k]), id).changes;
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const now = () => new Date().toISOString();

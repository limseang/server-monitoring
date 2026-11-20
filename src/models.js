import { all, get } from './db.js';

export function parseJSON(s, fallback = null) {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

export const getServer = (id) => get('SELECT * FROM servers WHERE id = ?', id);
export const getProject = (id) => get('SELECT * FROM projects WHERE id = ?', id);

const DEP_SQL = `SELECT d.*, s.name AS server_name, s.ip AS server_ip, s.ipv6 AS server_ipv6, s.private_ip AS server_private_ip, s.status AS server_status
  FROM deployments d JOIN servers s ON s.id = d.server_id`;

export const deploymentsOf = (projectId) => all(`${DEP_SQL} WHERE d.project_id = ? ORDER BY d.priority, d.id`, projectId);
export const deploymentsOnServer = (serverId) => all(`${DEP_SQL} WHERE d.server_id = ? ORDER BY d.id`, serverId);
export const getDeployment = (id) => get(`${DEP_SQL} WHERE d.id = ?`, id);

/** Strip secrets before sending to the browser. */
export function serverPublic(s) {
  if (!s) return null;
  const { ssh_key, ssh_passphrase, ssh_password, metrics, ...rest } = s;
  return {
    ...rest,
    has_key: !!ssh_key,
    has_passphrase: !!ssh_passphrase,
    has_password: !!ssh_password,
    metrics: parseJSON(metrics),
    ssh_guard: parseJSON(s.ssh_guard, null),
    tools: parseJSON(s.tools, null),
  };
}

export function deploymentPublic(d, project) {
  const { db_password, health_detail, ...rest } = d;
  return {
    ...rest,
    has_db_password: !!db_password,
    health_detail: parseJSON(health_detail),
    proxy_state: parseJSON(rest.proxy_state),
    is_active: project ? project.active_deployment_id === d.id : undefined,
  };
}

export function projectPublic(p) {
  if (!p) return null;
  const shared = parseJSON(p.shared_db);
  if (shared) delete shared.password; // never sent to the browser
  return {
    ...p,
    dns_records: parseJSON(p.dns_records, []),
    dns_state: parseJSON(p.dns_state),
    ssl_state: parseJSON(p.ssl_state),
    lb_config: parseJSON(p.lb_config, {}),
    lb_state: parseJSON(p.lb_state, {}),
    shared_db: shared,
    db_access: parseJSON(p.db_access, null),
    proxy: parseJSON(p.proxy, null),
  };
}

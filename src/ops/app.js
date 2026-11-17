import { update } from '../db.js';
import { bus } from '../bus.js';
import { getServer } from '../models.js';
import { dockerExec, runRemote, shq } from './remote.js';

/**
 * Turn maintenance mode on/off for a project on one server.
 * Runs the project's maintenance command inside the app container
 * (default: `php artisan down` / `php artisan up`), or on the host in the app dir.
 */
export async function setMaintenance(ctx, conn, project, dep, on, { signal } = {}) {
  const server = getServer(dep.server_id);
  const cmdText = String((on ? project.maintenance_on_cmd : project.maintenance_off_cmd) || '').trim();
  if (!cmdText) {
    ctx?.warn(`No maintenance ${on ? 'on' : 'off'} command configured — skipped`);
    return false;
  }
  if (!dep.app_container && !dep.app_dir) {
    ctx?.warn(`${dep.server_name}: no app container or app directory set — can't run "${cmdText}", skipped`);
    return false;
  }
  const cmd = dep.app_container ? dockerExec(server, dep.app_container, cmdText) : `cd ${shq(dep.app_dir)} && ${cmdText}`;
  ctx?.log(`${dep.server_name}: ${cmdText}`);
  try {
    await runRemote(ctx, conn, cmd, { timeout: 120000, signal });
  } catch (e) {
    // Typical setup mistake: "php artisan …" run on the server itself, where PHP isn't installed (it's in a container).
    if (!dep.app_container && e.result?.code === 127) {
      const prog = cmdText.split(/\s+/)[0];
      throw new Error(
        `"${prog}" is not installed on ${dep.server_name} itself — it is probably inside your app container. ` +
          `Set the App container (for example laravel-api-app) in the project → ${dep.server_name} card → ⋯ → Edit containers / database, then try again.`,
      );
    }
    throw e;
  }
  update('deployments', dep.id, { maintenance: on ? 1 : 0 });
  bus.emit('state', { projectId: project.id });
  return true;
}

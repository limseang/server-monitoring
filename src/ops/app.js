import { update } from '../db.js';
import { bus } from '../bus.js';
import { getServer } from '../models.js';
import { dockerExec, runRemote, shq } from './remote.js';
import { findContainerScript, pickAppContainer, isSwitchboardDir } from './appcontainer.js';

/**
 * No app container set, and the command's program (php, node…) is not on the server itself: look for it in the
 * Docker Compose containers of the app folder. Found → saved on the server card, so it is set from now on.
 */
async function findAppContainer(ctx, conn, server, dep, cmdText) {
  const prog = cmdText.split(/\s+/)[0];
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(prog)) return null;
  const host = await runRemote(null, conn, `command -v ${shq(prog)} >/dev/null 2>&1 && echo yes || echo no`, { quiet: true, okCodes: [0, 1] }).catch(() => null);
  if (host?.stdout?.trim() !== 'no') return null;
  const r = await runRemote(null, conn, findContainerScript(server, prog), { quiet: true, okCodes: [0, 1], timeout: 60000 }).catch(() => null);
  const { name, all } = pickAppContainer(r?.stdout, dep.app_dir);
  if (!name) return null;
  update('deployments', dep.id, { app_container: name });
  ctx?.log(`${dep.server_name}: "${prog}" is not on the server itself — found it in the app container ${name}${all.length > 1 ? ` (also: ${all.slice(1).join(', ')})` : ''}. Saved on the server card for next time.`);
  if (isSwitchboardDir(dep.app_dir)) ctx?.warn(`${dep.server_name}: the App folder on the server card is ${dep.app_dir}, Switchboard's own database folder, not your app — fix it in ⋯ → Edit containers / database.`);
  return name;
}

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
  const container = dep.app_container || (await findAppContainer(ctx, conn, server, dep, cmdText));
  const cmd = container ? dockerExec(server, container, cmdText) : `cd ${shq(dep.app_dir)} && ${cmdText}`;
  ctx?.log(`${dep.server_name}: ${cmdText}`);
  try {
    await runRemote(ctx, conn, cmd, { timeout: 120000, signal });
  } catch (e) {
    // Typical setup mistake: "php artisan …" run on the server itself, where PHP isn't installed (it's in a container).
    if (!container && e.result?.code === 127) {
      const prog = cmdText.split(/\s+/)[0];
      if (isSwitchboardDir(dep.app_dir))
        throw new Error(
          `"${prog}" is not installed on ${dep.server_name} itself, and the App folder on its card is ${dep.app_dir} — that is Switchboard's own database folder, not your app. ` +
            `Set the App folder and App container (for example laravel-api-app) in the project → ${dep.server_name} card → ⋯ → Edit containers / database, then try again.`,
        );
      throw new Error(
        `"${prog}" is not installed on ${dep.server_name} itself, and no running container of ${dep.app_dir} has it. ` +
          `Is the app running? Or set the App container (for example laravel-api-app) in the project → ${dep.server_name} card → ⋯ → Edit containers / database, then try again.`,
      );
    }
    throw e;
  }
  update('deployments', dep.id, { maintenance: on ? 1 : 0 });
  bus.emit('state', { projectId: project.id });
  return true;
}

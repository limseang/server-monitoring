import { dockerBin, shq } from './remote.js';

/*
 * Find a project's app container on a server when none is set (e.g. maintenance mode's "php artisan down" would
 * otherwise run on the server itself, where PHP is not installed). No database here, so tests can import it.
 *
 * Candidates: running containers of the Docker Compose project in the app folder (or a folder inside / above it,
 * like /var/www/api/docker for /var/www/api) that have the program (php, node…). The web app wins over its
 * helpers (queue, scheduler, worker…).
 */

/** Shell: running containers with their compose folder, and whether each has the program. */
export function findContainerScript(server, prog) {
  const d = dockerBin(server);
  return `${d} ps --format '{{.Names}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.service"}}' 2>/dev/null | while IFS="$(printf '\\t')" read -r n w s; do
  [ -n "$w" ] || continue
  if ${d} exec "$n" sh -c ${shq(`command -v ${prog} >/dev/null 2>&1`)} 2>/dev/null; then h=1; else h=0; fi
  printf '%s\\t%s\\t%s\\t%s\\n' "$n" "$w" "$s" "$h"
done
true`;
}

const HELPERS = /(^|[-_])(queue|worker|workers|scheduler|schedule|cron|horizon|reverb|websockets?|db|mysql|mariadb|postgres|redis|nginx|proxy|minio|mailpit|meilisearch)([-_]\d+)?$/i;
const norm = (p) => String(p || '').replace(/\/+$/, '');

/**
 * Parse findContainerScript's output and pick the app container for appDir (exported for tests).
 * → { name, all } — name is null when none fits; all lists the containers of that app that have the program.
 */
export function pickAppContainer(out, appDir) {
  const dir = norm(appDir);
  const rows = String(out || '')
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((c) => c.length >= 4 && c[0])
    .map(([name, wd, service, has]) => ({ name, wd: norm(wd), service, has: has.trim() === '1' }));
  const mine = rows.filter((r) => dir && r.wd && (r.wd === dir || r.wd.startsWith(`${dir}/`) || dir.startsWith(`${r.wd}/`)));
  const able = mine.filter((r) => r.has);
  const score = (r) => (HELPERS.test(r.service || r.name) ? 2 : 0) + (/(^|[-_])(app|api|web|php|laravel|backend)([-_]\d+)?$/i.test(r.service || r.name) ? -1 : 0);
  const sorted = [...able].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
  return { name: sorted[0]?.name || null, all: sorted.map((r) => r.name) };
}

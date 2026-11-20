// Ready-made deploy scripts (project → Settings → Deploy script) for apps that don't run in Docker.
// They run in the app folder with bash, as root over SSH; the real work runs as the folder's owner, so files keep
// their owner and that user's Node.js (nvm) is used. SB_COMMIT is the commit to deploy (empty = newest).

const OWNER_RUN = `set -e
# Run as the folder's owner (e.g. deploy), not root: files keep their owner and that user's Node.js (nvm) is used
OWNER=$(stat -c %U .)
GROUP=$(stat -c %G .)
DIR=$(pwd)
as_owner() {
  if [ "$(id -u)" = 0 ] && [ "$OWNER" != root ]; then su - "$OWNER" -s /bin/bash -c "set -e; cd '$DIR'; $1"; else bash -c "set -e; $1"; fi
}
NODE='[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null && { nvm use -s >/dev/null 2>&1 || true; }; command -v npm >/dev/null || { echo "npm not found for $(whoami) — install Node.js on this server first"; exit 1; }'
# Get the code: the exact commit when one was chosen (newer, or older for a rollback), else the newest.
# Git runs as the SSH user, like Switchboard's own git steps; then every file it touched goes back to the owner.
if [ -n "\${SB_COMMIT:-}" ]; then git fetch -q origin && git reset -q --keep "$SB_COMMIT"; else git pull -q --ff-only; fi
if [ "$OWNER" != "$(id -un)" ] && [ "$(id -u)" = 0 ]; then
  find "$DIR" -path "$DIR/node_modules" -prune -o ! -user "$OWNER" -exec chown -h "$OWNER:$GROUP" {} +
fi
# Install exactly what the lock file says (npm, pnpm or yarn), then build
INSTALL='if [ -f pnpm-lock.yaml ]; then corepack enable >/dev/null 2>&1 || true; pnpm install --frozen-lockfile; elif [ -f yarn.lock ]; then corepack enable >/dev/null 2>&1 || true; yarn install --frozen-lockfile; else npm ci --no-audit --no-fund; fi'`;

/** Vue / React / Vite / Angular: build the site; nginx serves the built folder (Web proxy tab → Website files). */
export const FRONTEND_SCRIPT = `${OWNER_RUN}
as_owner "$NODE; $INSTALL; npm run build"
# Done: nginx serves the new files at once (Web proxy → Website files → the build folder, usually dist)
echo "Build done: $(ls -d "$DIR"/dist "$DIR"/build "$DIR"/out 2>/dev/null | head -1)"`;

/** Nuxt / Next / Express… running with PM2: build, then reload the PM2 app(s) started from this folder. */
export const PM2_SCRIPT = `${OWNER_RUN}
as_owner "$NODE; $INSTALL; npm run build --if-present"
# Reload the PM2 app(s) that run from this folder (no downtime in cluster mode), or start the ecosystem file
R=$(mktemp /tmp/sb-pm2-XXXXXX.sh)
cat > "$R" <<'SH'
PM2=$(command -v pm2 || echo "npx --no-install pm2")
NAMES=$($PM2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=s.indexOf("[");const j=i<0?[]:JSON.parse(s.slice(i));console.log([...new Set(j.filter(p=>p.pm2_env.pm_cwd===process.cwd()).map(p=>p.name))].join(" "))})')
if [ -n "$NAMES" ]; then
  for n in $NAMES; do $PM2 reload "$n" --update-env; done
elif ls ecosystem.config.* >/dev/null 2>&1; then
  $PM2 startOrReload "$(ls ecosystem.config.* | head -1)" --update-env
else
  echo "No PM2 app runs from this folder yet — start it once on the server: pm2 start npm --name my-app -- start && pm2 save"
  exit 1
fi
$PM2 save >/dev/null
SH
chmod 755 "$R"
trap 'rm -f "$R"' EXIT
as_owner "$NODE; bash $R"`;

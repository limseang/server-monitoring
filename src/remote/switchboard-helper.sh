#!/usr/bin/env bash
# Switchboard helper (version __VERSION__) — installed and kept up to date by Switchboard.
# Don't edit this file on the server: Switchboard overwrites it.
#
# Switchboard runs it over SSH to set up projects, and the GitHub Actions runner runs a few
# commands through sudo (deploy / preview-up / preview-down — nothing else is allowed).
#
#   switchboard-helper setup <project>                  clone/start the app, web proxy site
#   switchboard-helper init-repo <project>              first commit + push of a new project
#   switchboard-helper scaffold-laravel <project>       fresh Laravel app in the project folder
#   switchboard-helper deploy <project> [commit]        run the deploy script, then health check
#   switchboard-helper preview-up <project> <pr> <sha>  build + start a pull request preview
#   switchboard-helper preview-down <project> <pr>      remove a pull request preview
#   switchboard-helper preview-list <project>
#   switchboard-helper edge-site <name> <port> <host...>    web proxy: domain → 127.0.0.1:<port>
#   switchboard-helper edge-rm <name>
#   switchboard-helper version
set -euo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ETC=/etc/switchboard
EDGE_IMAGE='__EDGE_IMAGE__'
PORT_MIN=18000
PORT_MAX=18999

say() { printf '>>> %s\n' "$*"; }
die() { printf 'switchboard-helper: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die 'must run as root (sudo)'

# ---------------------------------------------------------------- project config
load() {
  [[ "${1:-}" =~ ^[a-z0-9][a-z0-9-]{0,79}$ ]] || die "bad project name: ${1:-}"
  local f="$ETC/projects/$1.conf"
  [ -f "$f" ] || die "project '$1' is not set up on this server (Switchboard → project → CI/CD → Update servers)"
  SB_SLUG='' SB_NAME='' SB_DIR='' SB_USER=root SB_REPO_URL='' SB_BRANCH=main SB_GIT_SSH='' SB_TEMPLATE='' SB_DB=none
  SB_ENV=production SB_HOSTS='' SB_URL='' SB_HEALTH_PATH=/ SB_HEALTH_URL='' SB_HEALTH_HOST='' SB_PREVIEW=0 SB_PREVIEW_ZONE=''
  SB_PREVIEW_BASE=/srv/previews SB_APP_PORT=''
  # shellcheck disable=SC1090
  . "$f"
  [ -n "$SB_GIT_SSH" ] && export GIT_SSH_COMMAND="$SB_GIT_SSH"
  return 0
}

user_home() { getent passwd "$SB_USER" | cut -d: -f6; }

# Run a command in a directory as the app's user (owner of the files).
as_user() {
  local dir=$1
  shift
  if [ "$SB_USER" = root ]; then
    (cd "$dir" && "$@")
  else
    (cd "$dir" && runuser -u "$SB_USER" -- env HOME="$(user_home)" "$@")
  fi
}

git_u() { local dir=$1; shift; as_user "$dir" git -c safe.directory='*' "$@"; }

pkg_install() {
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@" >/dev/null
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q "$@" >/dev/null
  else die "please install: $*"; fi
}

# ---------------------------------------------------------------- web proxy ("edge")
# One nginx in front of all apps on this server, on ports 80/443, routing by domain name to
# each app's local port (127.0.0.1:18xxx). Uses the server's own nginx when it already runs one,
# otherwise a small nginx container named switchboard-edge.
edge_mode() { cat "$ETC/edge/mode" 2>/dev/null || true; }
edge_dir() { if [ "$(edge_mode)" = host ]; then echo /etc/nginx/conf.d; else echo "$ETC/edge/conf.d"; fi; }

edge_reload() {
  if [ "$(edge_mode)" = host ]; then
    nginx -t -q && { systemctl reload nginx 2>/dev/null || nginx -s reload; }
  else
    docker exec switchboard-edge nginx -t -q && docker exec switchboard-edge nginx -s reload >/dev/null
  fi
}

edge_init() {
  mkdir -p "$ETC/edge/ssl" "$ETC/edge/conf.d" "$ETC/ports"
  if [ ! -s "$ETC/edge/ssl/cert.pem" ]; then
    command -v openssl >/dev/null 2>&1 || pkg_install openssl
    # Self-signed: fine behind Cloudflare (SSL mode "Full"). Visitors see Cloudflare's certificate.
    openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -subj '/CN=switchboard-edge' \
      -keyout "$ETC/edge/ssl/key.pem" -out "$ETC/edge/ssl/cert.pem" >/dev/null 2>&1
    chmod 600 "$ETC/edge/ssl/key.pem"
  fi
  local mode
  mode=$(edge_mode)
  if [ -z "$mode" ]; then
    local p holder nginx_ok=1 busy=''
    for p in 80 443; do
      holder=$(ss -ltnp "sport = :$p" 2>/dev/null | tail -n +2 | head -n1 || true)
      [ -z "$holder" ] && continue
      busy="$busy port $p: $(echo "$holder" | grep -o 'users:.*' || echo "$holder");"
      echo "$holder" | grep -q '"nginx"' || nginx_ok=0
    done
    if [ -z "$busy" ]; then
      mode=container
    elif [ "$nginx_ok" = 1 ] && [ -d /etc/nginx/conf.d ] && command -v nginx >/dev/null 2>&1; then
      mode=host
    else
      die "web ports are already in use ($busy). Switchboard needs ports 80/443 for its web proxy — stop that service or put nginx on the server."
    fi
    echo "$mode" >"$ETC/edge/mode"
    say "Web proxy: $([ "$mode" = host ] && echo "the server's own nginx (/etc/nginx/conf.d)" || echo "nginx container switchboard-edge")"
  fi
  cat >"$(edge_dir)/00-switchboard.conf" <<'EOF'
# Switchboard web proxy — shared settings
map $http_upgrade $sb_upgrade { default upgrade; '' close; }
map $http_x_forwarded_proto $sb_proto { default $http_x_forwarded_proto; '' $scheme; }
EOF
  if [ "$mode" = container ] && ! docker ps --format '{{.Names}}' | grep -qx switchboard-edge; then
    docker rm -f switchboard-edge >/dev/null 2>&1 || true
    docker run -d --name switchboard-edge --restart unless-stopped --network host \
      -v "$ETC/edge/conf.d:/etc/nginx/conf.d:ro" -v "$ETC/edge/ssl:$ETC/edge/ssl:ro" "$EDGE_IMAGE" >/dev/null
    sleep 1
  fi
}

# edge_site <name> <port> <host...>
edge_site() {
  local name=$1 port=$2
  shift 2
  [ $# -gt 0 ] || return 0
  local f
  f="$(edge_dir)/sb-$name.conf"
  cat >"$f.tmp" <<EOF
# Switchboard: $name → 127.0.0.1:$port
server {
  listen 80;
  listen 443 ssl;
  server_name $*;
  ssl_certificate $ETC/edge/ssl/cert.pem;
  ssl_certificate_key $ETC/edge/ssl/key.pem;
  client_max_body_size 100m;
  location / {
    proxy_pass http://127.0.0.1:$port;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$sb_proto;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$sb_upgrade;
    proxy_read_timeout 300s;
  }
}
EOF
  mv "$f.tmp" "$f"
  if ! edge_reload; then
    rm -f "$f"
    edge_reload || true
    die "nginx rejected the site config for $name"
  fi
  say "Web proxy: $* → 127.0.0.1:$port"
}

edge_rm() {
  local f
  f="$(edge_dir)/sb-$1.conf"
  [ -f "$f" ] || return 0
  rm -f "$f"
  edge_reload || true
}

# A local port for an app, remembered in /etc/switchboard/ports/<name>.
port_for() {
  local f="$ETC/ports/$1" p used
  mkdir -p "$ETC/ports"
  if [ -s "$f" ]; then cat "$f"; return; fi
  used=$(cat "$ETC"/ports/* 2>/dev/null || true)
  for p in $(seq "$PORT_MIN" "$PORT_MAX"); do
    echo "$used" | grep -qx "$p" && continue
    ss -ltn "sport = :$p" 2>/dev/null | tail -n +2 | grep -q . && continue
    echo "$p" >"$f"
    echo "$p"
    return
  done
  die "no free port between $PORT_MIN and $PORT_MAX"
}

# ---------------------------------------------------------------- app files
set_env() { # set_env <file> <KEY> <value>
  if grep -q "^$2=" "$1"; then sed -i "s|^$2=.*|$2=$3|" "$1"; else printf '%s=%s\n' "$2" "$3" >>"$1"; fi
}

# write_env <dir> <app env> <url> <port> <compose project>
write_env() {
  local dir=$1 env=$2 url=$3 port=$4 project=$5 f="$1/.env"
  if [ ! -f "$f" ]; then
    command -v openssl >/dev/null 2>&1 || pkg_install openssl
    local pw rootpw debug=false
    pw=$(openssl rand -hex 16)
    rootpw=$(openssl rand -hex 16)
    [ "$env" = production ] || debug=true
    {
      echo "# Made by Switchboard — edit freely. Only COMPOSE_PROJECT_NAME, COMPOSE_FILE and APP_PORT are managed."
      case "$SB_TEMPLATE" in
        laravel)
          printf 'APP_NAME="%s"\nAPP_ENV=%s\nAPP_KEY=base64:%s\nAPP_DEBUG=%s\nAPP_URL=%s\n' "$SB_NAME" "$env" "$(openssl rand -base64 32)" "$debug" "$url"
          printf 'LOG_CHANNEL=stderr\nLOG_LEVEL=info\nCACHE_STORE=redis\nSESSION_DRIVER=redis\nQUEUE_CONNECTION=redis\nREDIS_HOST=redis\n'
          ;;
        node) printf 'NODE_ENV=production\nHOST=0.0.0.0\nPORT=3000\nNITRO_PORT=3000\nAPP_URL=%s\n' "$url" ;;
      esac
      case "$SB_DB" in
        mysql)
          printf 'DB_CONNECTION=mysql\nDB_HOST=db\nDB_PORT=3306\nDB_DATABASE=app\nDB_USERNAME=app\nDB_PASSWORD=%s\nDB_ROOT_PASSWORD=%s\n' "$pw" "$rootpw"
          [ "$SB_TEMPLATE" = node ] && printf 'DATABASE_URL=mysql://app:%s@db:3306/app\n' "$pw"
          ;;
        postgres)
          printf 'DB_CONNECTION=pgsql\nDB_HOST=db\nDB_PORT=5432\nDB_DATABASE=app\nDB_USERNAME=app\nDB_PASSWORD=%s\n' "$pw"
          [ "$SB_TEMPLATE" = node ] && printf 'DATABASE_URL=postgres://app:%s@db:5432/app\n' "$pw"
          ;;
      esac
    } >"$f"
    chown "$SB_USER": "$f"
    chmod 640 "$f"
    say "Wrote $f (new passwords and keys)"
  fi
  set_env "$f" COMPOSE_PROJECT_NAME "$project"
  set_env "$f" COMPOSE_FILE compose.switchboard.yml
  set_env "$f" APP_PORT "$port"
}

# Dockerfile + compose file of the template, unless the repo has its own.
stack_files() {
  local dir=$1 t="$ETC/templates/$SB_TEMPLATE" x
  [ -d "$t" ] || die "template '$SB_TEMPLATE' is missing on this server — use Update servers in Switchboard"
  mkdir -p "$dir/.switchboard"
  for x in Dockerfile Dockerfile.dockerignore; do [ -f "$dir/.switchboard/$x" ] || cp "$t/$x" "$dir/.switchboard/$x"; done
  [ -f "$dir/compose.switchboard.yml" ] || cp "$t/compose-$SB_DB.yml" "$dir/compose.switchboard.yml"
  chown -R "$SB_USER": "$dir/.switchboard" "$dir/compose.switchboard.yml"
  if [ -d "$dir/.git" ]; then
    # Files only on the server (not in the repo): hide them from git so deploys never touch them.
    local ex="$dir/.git/info/exclude"
    mkdir -p "$dir/.git/info"
    touch "$ex"
    for x in .switchboard compose.switchboard.yml; do
      if ! (cd "$dir" && git -c safe.directory='*' ls-files --error-unmatch "$x" >/dev/null 2>&1); then
        grep -qxF "/$x" "$ex" || echo "/$x" >>"$ex"
      fi
    done
  fi
}

compose_up() {
  say "Build and start the containers in $1 (the first build can take a few minutes)"
  if ! (cd "$1" && docker compose up -d --build --remove-orphans --quiet-pull); then
    say 'Starting failed — trying once more in 15s (a busy server can time out while the database starts)'
    sleep 15
    (cd "$1" && docker compose up -d --build --remove-orphans --quiet-pull)
  fi
}

# wait_healthy <host header> <url> <tries (3s apart)>
wait_healthy() {
  local host=$1 url=$2 tries=${3:-60} code='' _
  command -v curl >/dev/null 2>&1 || pkg_install curl
  for _ in $(seq 1 "$tries"); do
    code=$(curl -ks -o /dev/null -m 10 -w '%{http_code}' ${host:+-H "Host: $host"} "$url" 2>/dev/null || true)
    case "$code" in 2?? | 3??)
      say "Healthy: HTTP $code from $url${host:+ (Host: $host)}"
      return 0
      ;;
    esac
    sleep 3
  done
  say "NOT healthy after $((tries * 3))s: last answer HTTP ${code:-none} from $url${host:+ (Host: $host)}"
  return 1
}

app_port() { local p; p=$(grep -E '^APP_PORT=' "$1/.env" 2>/dev/null | tail -n1 | cut -d= -f2); echo "${p:-}"; }

# ---------------------------------------------------------------- commands
cmd_setup() {
  load "$1"
  local port
  mkdir -p "$(dirname "$SB_DIR")"
  if [ -n "$SB_REPO_URL" ] && [ ! -d "$SB_DIR/.git" ]; then
    if [ -d "$SB_DIR" ] && [ -n "$(ls -A "$SB_DIR")" ]; then die "$SB_DIR already has files but no git checkout — empty it or pick another folder"; fi
    mkdir -p "$SB_DIR"
    chown "$SB_USER": "$SB_DIR"
    say "Clone $SB_REPO_URL (branch $SB_BRANCH) into $SB_DIR"
    git_u "$SB_DIR" clone -q --branch "$SB_BRANCH" "$SB_REPO_URL" "$SB_DIR"
    [ -z "$SB_GIT_SSH" ] || git_u "$SB_DIR" config core.sshCommand "$SB_GIT_SSH"
  fi
  [ -d "$SB_DIR" ] || die "$SB_DIR does not exist"
  [ -n "$SB_TEMPLATE" ] || { say "No template: nothing to start"; return 0; }
  if [ "$SB_TEMPLATE" = compose ]; then
    # The repo's own docker-compose.yml: Switchboard only starts it (and puts a domain in front).
    if [ ! -f "$SB_DIR/.env" ] && [ -f "$SB_DIR/.env.example" ]; then
      cp "$SB_DIR/.env.example" "$SB_DIR/.env" && chown "$SB_USER": "$SB_DIR/.env"
      say 'Created .env from .env.example — edit it on the server if the app needs settings'
    fi
    say "Build and start the containers in $SB_DIR (docker compose up -d --build)"
    (cd "$SB_DIR" && docker compose up -d --build --remove-orphans --quiet-pull)
    if [ -n "$SB_HOSTS" ] && [ -n "$SB_APP_PORT" ]; then edge_init; edge_site "$SB_SLUG" "$SB_APP_PORT" $SB_HOSTS; fi
    echo "SB_PORT=$SB_APP_PORT"
    echo "SB_CONTAINER=$(cd "$SB_DIR" && docker compose ps --format '{{.Name}}' 2>/dev/null | head -n 1)"
    if [ -n "$SB_HEALTH_URL" ]; then wait_healthy "$SB_HEALTH_HOST" "$SB_HEALTH_URL" 60 || die 'the app did not become healthy — see the container logs on the server page'; fi
    return 0
  fi
  [ -z "$SB_HOSTS" ] || edge_init
  stack_files "$SB_DIR"
  port=$(port_for "$SB_SLUG")
  write_env "$SB_DIR" "$SB_ENV" "$SB_URL" "$port" "$SB_SLUG"
  compose_up "$SB_DIR"
  [ -z "$SB_HOSTS" ] || edge_site "$SB_SLUG" "$port" $SB_HOSTS
  echo "SB_PORT=$port"
  if [ -n "$SB_HEALTH_URL" ]; then wait_healthy "$SB_HEALTH_HOST" "$SB_HEALTH_URL" 60 || die 'the app did not become healthy — see the container logs on the server page'; fi
}

cmd_scaffold_laravel() {
  load "$1"
  mkdir -p "$SB_DIR"
  [ -z "$(ls -A "$SB_DIR")" ] || die "$SB_DIR is not empty"
  say 'Create a fresh Laravel app (composer create-project laravel/laravel)'
  docker run --rm -v "$SB_DIR:/app" -w /app composer:2 create-project --no-interaction --prefer-dist --no-progress laravel/laravel /app
  rm -f "$SB_DIR/.env" "$SB_DIR/database/database.sqlite"
  chown -R "$SB_USER": "$SB_DIR"
}

cmd_init_repo() {
  load "$1"
  [ -n "$SB_REPO_URL" ] || die 'no repository set'
  [ ! -d "$SB_DIR/.git" ] || { say 'Already a git checkout'; return 0; }
  [ -z "$SB_TEMPLATE" ] || stack_files "$SB_DIR"
  chown -R "$SB_USER": "$SB_DIR"
  say "First commit and push to $SB_REPO_URL ($SB_BRANCH)"
  git_u "$SB_DIR" init -q -b "$SB_BRANCH"
  git_u "$SB_DIR" add -A
  git_u "$SB_DIR" -c user.name=Switchboard -c user.email=switchboard@localhost commit -q -m 'New project (Switchboard template)'
  git_u "$SB_DIR" remote add origin "$SB_REPO_URL"
  [ -z "$SB_GIT_SSH" ] || git_u "$SB_DIR" config core.sshCommand "$SB_GIT_SSH"
  git_u "$SB_DIR" push -q -u origin "$SB_BRANCH"
}

cmd_deploy() {
  load "$1"
  local commit=${2:-} script="$ETC/projects/$SB_SLUG.deploy.sh"
  [ -z "$commit" ] || [[ "$commit" =~ ^[0-9a-f]{7,40}$ ]] || die "bad commit: $commit"
  [ -s "$script" ] || die "no deploy script for $SB_SLUG (project Settings → Deploy script)"
  [ -d "$SB_DIR" ] || die "$SB_DIR does not exist"
  # Only commits that are on the project's branch: a pull request's code can never be deployed here.
  if [ -n "$commit" ] && [ -n "$SB_REPO_URL" ] && [ -d "$SB_DIR/.git" ]; then
    git_u "$SB_DIR" fetch -q origin "+refs/heads/$SB_BRANCH:refs/remotes/origin/$SB_BRANCH"
    git_u "$SB_DIR" merge-base --is-ancestor "$commit" "origin/$SB_BRANCH" 2>/dev/null || die "commit ${commit:0:7} is not on branch $SB_BRANCH — refusing to deploy it"
  fi
  say "Deploy $SB_NAME${commit:+ at ${commit:0:7}} in $SB_DIR (as $SB_USER)"
  # The script is passed on stdin, so the app user never needs to read /etc/switchboard.
  # (GIT_SSH_COMMAND, when set, is exported by load and passed on to the script.)
  as_user "$SB_DIR" env SB_COMMIT="$commit" SB_BRANCH="$SB_BRANCH" bash -ex -o pipefail -s <"$script"
  if [ -n "$SB_HEALTH_URL" ]; then
    wait_healthy "$SB_HEALTH_HOST" "$SB_HEALTH_URL" 40 || die "$SB_NAME is not healthy after the deploy"
  fi
  say "Deployed $SB_NAME on $(hostname)"
}

preview_vars() {
  [[ "${2:-}" =~ ^[0-9]{1,7}$ ]] || die "bad pull request number: ${2:-}"
  PR=$2
  P_NAME="$SB_SLUG-pr-$PR"
  P_DIR="$SB_PREVIEW_BASE/$SB_SLUG/pr-$PR"
  P_HOST="pr-$PR-$SB_SLUG.$SB_PREVIEW_ZONE"
}

cmd_preview_up() {
  load "$1"
  [ "$SB_PREVIEW" = 1 ] || die "pull request previews are turned off for $SB_SLUG"
  [ -n "$SB_TEMPLATE" ] && [ -n "$SB_REPO_URL" ] && [ -n "$SB_PREVIEW_ZONE" ] || die 'previews need a template project with a GitHub repository and a preview domain'
  preview_vars "$@"
  local sha=${3:-} port
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "bad commit: $sha"
  edge_init
  mkdir -p "$P_DIR"
  chown "$SB_USER": "$SB_PREVIEW_BASE" "$SB_PREVIEW_BASE/$SB_SLUG" "$P_DIR" 2>/dev/null || true
  if [ ! -d "$P_DIR/.git" ]; then
    git_u "$P_DIR" init -q
    git_u "$P_DIR" remote add origin "$SB_REPO_URL"
    [ -z "$SB_GIT_SSH" ] || git_u "$P_DIR" config core.sshCommand "$SB_GIT_SSH"
  fi
  say "Fetch pull request #$PR (${sha:0:7})"
  git_u "$P_DIR" fetch -q origin "+refs/pull/$PR/head:refs/remotes/origin/pr-$PR"
  git_u "$P_DIR" checkout -qf --detach "$sha" 2>/dev/null || git_u "$P_DIR" checkout -qf --detach "origin/pr-$PR"
  stack_files "$P_DIR"
  port=$(port_for "$P_NAME")
  write_env "$P_DIR" preview "https://$P_HOST" "$port" "$P_NAME"
  compose_up "$P_DIR"
  if [ "$SB_TEMPLATE" = laravel ] && [ "$SB_DB" != none ] && [ ! -f "$P_DIR/.switchboard/seeded" ]; then
    say 'Fill the preview database (migrate --seed)'
    sleep 5
    (cd "$P_DIR" && docker compose exec -T app php artisan migrate --force --seed) && touch "$P_DIR/.switchboard/seeded" || say 'Seeding failed (the preview still runs)'
  fi
  edge_site "$P_NAME" "$port" "$P_HOST"
  wait_healthy "$P_HOST" "http://127.0.0.1$SB_HEALTH_PATH" 60 || die "preview of #$PR is not healthy"
  say "Preview of pull request #$PR: https://$P_HOST"
}

cmd_preview_down() {
  load "$1"
  preview_vars "$@"
  if [ -d "$P_DIR" ]; then
    (cd "$P_DIR" && docker compose down -v --remove-orphans) || true
    docker image rm "$P_NAME-app" >/dev/null 2>&1 || true
    rm -rf "$P_DIR"
  fi
  edge_rm "$P_NAME"
  rm -f "$ETC/ports/$P_NAME"
  say "Preview of pull request #$PR removed"
}

cmd_preview_list() {
  load "$1"
  local d
  for d in "$SB_PREVIEW_BASE/$SB_SLUG"/pr-*; do
    [ -d "$d" ] || continue
    echo "${d##*/pr-} $(git -c safe.directory='*' -C "$d" rev-parse HEAD 2>/dev/null || echo -)"
  done
}

# A domain → local port, outside any project (Switchboard → server → Connect a domain).
cmd_edge_site() {
  [[ "${1:-}" =~ ^[a-z0-9][a-z0-9.-]{0,120}$ ]] || die "bad site name: ${1:-}"
  [[ "${2:-}" =~ ^[0-9]{1,5}$ ]] && [ "$2" -ge 1 ] && [ "$2" -le 65535 ] || die "bad port: ${2:-}"
  [ $# -ge 3 ] || die 'give at least one host name'
  local h
  for h in "${@:3}"; do [[ "$h" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || die "bad host name: $h"; done
  edge_init
  edge_site "$@"
}

cmd_edge_rm() {
  [[ "${1:-}" =~ ^[a-z0-9][a-z0-9.-]{0,120}$ ]] || die "bad site name: ${1:-}"
  [ -n "$(edge_mode)" ] || { say 'No web proxy on this server'; return 0; }
  edge_rm "$1"
  say "Web proxy site $1 removed"
}

case "${1:-}" in
  setup) shift; cmd_setup "$@" ;;
  edge-site) shift; cmd_edge_site "$@" ;;
  edge-rm) shift; cmd_edge_rm "$@" ;;
  scaffold-laravel) shift; cmd_scaffold_laravel "$@" ;;
  init-repo) shift; cmd_init_repo "$@" ;;
  deploy) shift; cmd_deploy "$@" ;;
  preview-up) shift; cmd_preview_up "$@" ;;
  preview-down) shift; cmd_preview_down "$@" ;;
  preview-list) shift; cmd_preview_list "$@" ;;
  version) echo '__VERSION__' ;;
  *) sed -n '2,17p' "$0"; exit 2 ;;
esac

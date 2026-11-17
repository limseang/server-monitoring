#!/bin/sh
# Test pair for "Clone server": vps-src (Docker + a sample Laravel-like stack + host setup)
# and vps-new (blank Debian, no Docker). Each has its own Docker daemon — your Mac's
# containers are never touched.
#   ./dev/clone-setup.sh            build, start and seed both (run ./dev/setup.sh first)
#   ./dev/clone-setup.sh reset-new  wipe vps-new back to a blank server
#   ./dev/clone-setup.sh reset-lb   also wipe vps-db / vps-lb (load balancer test) back to blank
set -e
cd "$(dirname "$0")"
DC="docker compose --profile clone"

reset_new() {
  $DC rm -sf vps-new >/dev/null 2>&1 || true
  docker volume rm -f switchboard-dev_vps-new-docker >/dev/null 2>&1 || true
  $DC up -d vps-new
  echo "vps-new is a blank server again (172.30.0.22)"
}

reset_lb() {
  $DC rm -sf vps-db vps-lb >/dev/null 2>&1 || true
  docker volume rm -f switchboard-dev_vps-db-docker >/dev/null 2>&1 || true
  $DC up -d vps-db vps-lb
  i=0; until docker exec vps-db docker info >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && { echo "Docker did not start in vps-db"; exit 1; }; sleep 1; done
  for img in mysql:8.4 redis:7-alpine; do
    docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img"
    docker save "$img" | docker exec -i vps-db docker load -q
  done
  echo "vps-db (172.30.0.23, Docker, images preloaded) and vps-lb (172.30.0.24, blank) are ready"
}

if [ "$1" = "reset-new" ]; then reset_new; exit 0; fi
if [ "$1" = "reset-lb" ]; then reset_new; reset_lb; exit 0; fi

[ -f .keys/id_ed25519 ] || { echo "Run ./dev/setup.sh first"; exit 1; }
$DC build vps-src vps-new
$DC up -d vps-src
reset_new
reset_lb

echo "Waiting for Docker inside vps-src…"
i=0; until docker exec vps-src docker info >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && { echo "Docker did not start in vps-src"; docker exec vps-src cat /var/log/dockerd.log | tail -20; exit 1; }; sleep 1; done

echo "Loading images into vps-src (from your Mac, no download)…"
for img in alpine:3.22 mysql:8.4 node:24-alpine; do
  docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img"
  docker save "$img" | docker exec -i vps-src docker load -q
done

echo "Creating the sample stack /srv/shop on vps-src…"
docker exec -i vps-src sh -s <<'IN'
set -e
mkdir -p /srv/shop/www /srv/shared-uploads /opt/tools /etc/logrotate.d
cat > /srv/shop/docker-compose.yml <<'YML'
name: shop
services:
  app:
    # Tiny web server: answers "ok <server name>" (many requests at once, like a real app behind a load balancer).
    image: node:24-alpine
    command: ["node", "-e", "const fs=require('fs');require('http').createServer((q,r)=>r.end('ok '+fs.readFileSync('/host-hostname','utf8').trim())).listen(80)"]
    ports: ["8080:80"]
    env_file: .env
    volumes: [./www:/www:ro, storage:/var/www/html/storage/app/public, /srv/shared-uploads:/uploads, /etc/hostname:/host-hostname:ro]
    restart: unless-stopped
  db:
    image: mysql:8.4
    environment: { MYSQL_ROOT_PASSWORD: rootpass-c, MYSQL_DATABASE: shop }
    volumes: [mysql:/var/lib/mysql]
    restart: unless-stopped
  worker:
    image: alpine:3.22
    command: ["sleep", "infinity"]
volumes:
  storage: {}
  mysql: {}
YML
[ -f /srv/shop/.env ] || printf 'APP_NAME=shop\nAPP_KEY=base64:clonetestkey\nDB_CONNECTION=mysql\nDB_HOST=db\nDB_PORT=3306\nDB_DATABASE=shop\nDB_USERNAME=root\nDB_PASSWORD=rootpass-c\n' > /srv/shop/.env
echo ok > /srv/shop/www/up
echo "logo" > /srv/shared-uploads/logo.txt
printf '#!/bin/sh\necho hello from tools\n' > /opt/tools/hello.sh && chmod +x /opt/tools/hello.sh
cd /srv/shop && docker compose up -d --quiet-pull --remove-orphans && docker compose stop worker
# host setup the clone must carry over
ln -sf /usr/share/zoneinfo/Asia/Phnom_Penh /etc/localtime && echo Asia/Phnom_Penh > /etc/timezone
getent group deployers >/dev/null || groupadd -g 1500 deployers
id deploy >/dev/null 2>&1 || useradd -u 1001 -m -s /bin/bash deploy
usermod -aG deployers,sudo deploy
mkdir -p /home/deploy/.ssh && echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDeployKeyForCloneTestOnly000000000000000 deploy@laptop" > /home/deploy/.ssh/authorized_keys && chown -R deploy /home/deploy/.ssh
echo 'deploy ALL=(ALL) NOPASSWD: /usr/bin/docker' > /etc/sudoers.d/deploy && chmod 440 /etc/sudoers.d/deploy
printf '/srv/shop/storage/logs/*.log {\n  daily\n  rotate 7\n}\n' > /etc/logrotate.d/shop
DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends jq cron >/dev/null
echo '*/5 * * * * cd /srv/shop && docker compose exec -T app true # schedule' | crontab -
echo '17 3 * * * echo deploy-cron' | crontab -u deploy -
IN

echo "Adding apps outside Docker on vps-src (nvm + PM2 Nuxt-style app, static Vue site, nginx)…"
docker exec -i vps-src sh -s <<'IN'
set -e
export DEBIAN_FRONTEND=noninteractive
command -v nginx >/dev/null || apt-get install -y -q --no-install-recommends nginx >/dev/null
mkdir -p /var/www/vue-site/dist && echo 'vue ok' > /var/www/vue-site/dist/index.html
cat > /etc/nginx/sites-available/apps <<'NG'
server {
    listen 80;
    server_name vue.test;
    root /var/www/vue-site/dist;
    location / { try_files $uri /index.html; }
}
server {
    listen 80;
    server_name nuxt.test;
    location / { proxy_pass http://127.0.0.1:3000; }
}
NG
ln -sf /etc/nginx/sites-available/apps /etc/nginx/sites-enabled/apps
nginx -t >/dev/null 2>&1 && (nginx -s reload 2>/dev/null || nginx)
su - deploy -c 'set -e
if [ ! -d ~/.nvm ]; then curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash >/dev/null; fi
. ~/.nvm/nvm.sh
nvm install 22 >/dev/null 2>&1
command -v pm2 >/dev/null || npm install -g --no-fund --no-audit pm2 >/dev/null
mkdir -p ~/apps/nuxt-site
cat > ~/apps/nuxt-site/server.mjs <<JS
import http from "node:http";
http.createServer((q, r) => r.end("nuxt ok")).listen(3000);
JS
cat > ~/apps/nuxt-site/worker.mjs <<JS
setInterval(() => console.log("worker tick"), 60000);
JS
echo "{\"name\":\"nuxt-site\",\"private\":true}" > ~/apps/nuxt-site/package.json
cd ~/apps/nuxt-site
pm2 describe nuxt-site >/dev/null 2>&1 || pm2 start server.mjs --name nuxt-site >/dev/null
pm2 describe nuxt-worker >/dev/null 2>&1 || pm2 start worker.mjs --name nuxt-worker >/dev/null
pm2 stop nuxt-worker >/dev/null
pm2 save >/dev/null'
IN

echo "Waiting for MySQL in vps-src…"
i=0; until docker exec vps-src docker exec shop-db-1 mysql -uroot -prootpass-c -e 'SELECT 1' >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 90 ] && { echo "MySQL did not start"; exit 1; }; sleep 2; done
if [ "$(docker exec vps-src docker exec shop-db-1 mysql -uroot -prootpass-c -N -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='shop'" 2>/dev/null)" = "0" ]; then
  docker exec -i vps-src docker exec -i shop-db-1 mysql -uroot -prootpass-c --default-character-set=utf8mb4 shop < seed.sql 2>/dev/null
  docker exec vps-src docker exec shop-app-1 sh -c 'mkdir -p /var/www/html/storage/app/public/products && echo "fan photo" > /var/www/html/storage/app/public/products/fan.jpg'
fi

cat <<OUT

Clone test pair is up.
  vps-src : 172.30.0.21  root  (Docker + stack "shop" in /srv/shop, app on port 8080, MySQL root pw rootpass-c;
            outside Docker: PM2 apps nuxt-site (port 3000) + nuxt-worker (stopped) as user deploy via nvm,
            nginx sites vue.test (static) and nuxt.test (proxy))
  vps-new : 172.30.0.22  root  (blank Debian, no Docker)
  SSH key : $(pwd)/.keys/id_ed25519
Run the test: node dev/e2e-clone.mjs
OUT

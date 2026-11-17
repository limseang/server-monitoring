#!/bin/sh
# Start the local test lab and load sample data into "server A".
set -e
cd "$(dirname "$0")"
chmod +x fake-app/php
mkdir -p .keys
[ -f .keys/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -C switchboard-dev -f .keys/id_ed25519
chmod 644 .keys/id_ed25519.pub

docker compose up -d --build

echo "Waiting for MySQL on a-db and b-db…"
for db in a-db:rootpass-a b-db:rootpass-b; do
  name=${db%%:*}; pass=${db#*:}
  i=0
  until docker exec "$name" mysql -uroot -p"$pass" -e 'SELECT 1' >/dev/null 2>&1; do
    i=$((i + 1)); [ $i -gt 90 ] && { echo "$name did not start"; exit 1; }
    sleep 2
  done
done

if [ "$(docker exec a-db mysql -uroot -prootpass-a -N -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='shop'" 2>/dev/null)" = "0" ]; then
  echo "Seeding sample shop data on server A…"
  docker exec -i a-db mysql -uroot -prootpass-a --default-character-set=utf8mb4 shop < seed.sql 2>/dev/null
  docker exec a-app sh -c 'mkdir -p /var/www/html/storage/app/public/products && echo "fan photo" > /var/www/html/storage/app/public/products/fan.jpg && echo "bulb photo" > /var/www/html/storage/app/public/products/bulb.jpg'
fi

cat <<EOF

Test lab is up.
  Dashboard : http://localhost:8090   (admin / admin-password-123)
  SSH key   : $(pwd)/.keys/id_ed25519   (paste it when adding the servers)
  Server A  : IP 172.30.0.11, user root, DB container a-db, app container a-app
  Server B  : IP 172.30.0.12, user root, DB container b-db, app container b-app
  Cloudflare: API token "test-token" (fake API with zone shop.test)
  Project   : domain shop.test, health check http /up, files: app:/var/www/html/storage/app/public
Simulate an outage:  docker compose -f dev/docker-compose.yml exec srv-a touch /shared/broken
Recover:             docker compose -f dev/docker-compose.yml exec srv-a rm /shared/broken
EOF

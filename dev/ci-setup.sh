#!/bin/sh
# CI/CD test server: vps-ci (172.30.0.25), a blank Debian with its own Docker (your Mac's containers are
# never touched), plus the fake GitHub (gh-mock). Run ./dev/setup.sh first.
#   ./dev/ci-setup.sh          (re)create vps-ci from scratch and preload the images it needs
set -e
cd "$(dirname "$0")"
[ -f .keys/id_ed25519 ] || { echo "Run ./dev/setup.sh first"; exit 1; }
docker image inspect switchboard-dev-vps:docker >/dev/null 2>&1 || docker compose --profile clone build vps-src
docker compose up -d --build gh-mock
docker compose up -d --force-recreate cf-mock   # load the newest fake Cloudflare code
docker compose --profile ci rm -sf vps-ci >/dev/null 2>&1 || true
docker volume rm -f switchboard-dev_vps-ci-docker >/dev/null 2>&1 || true
docker compose --profile ci up -d vps-ci
i=0; until docker exec vps-ci docker info >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && { echo "Docker did not start in vps-ci"; exit 1; }; sleep 1; done
echo "Loading images into vps-ci (from your Mac, no download inside)…"
for img in node:24-alpine nginx:1.27-alpine mysql:8.4; do
  docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img"
  docker save "$img" | docker exec -i vps-ci docker load -q
done
echo "vps-ci (172.30.0.25) and gh-mock (172.30.0.6) are ready"

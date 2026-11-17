#!/bin/sh
set -e
# Make sure the data folder is writable by the unprivileged "node" user, then drop root.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR:-/data}"
  find "${DATA_DIR:-/data}" ! -user node -exec chown node:node {} + 2>/dev/null || true
  exec su-exec node "$@"
fi
exec "$@"

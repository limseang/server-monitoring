#!/bin/sh
cp /keys/id_ed25519.pub /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
mkdir -p /shared
python3 /health.py &
exec /usr/sbin/sshd -D -e

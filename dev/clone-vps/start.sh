#!/bin/sh
cp /keys/id_ed25519.pub /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
# No systemd in a container: start services the SysV way when they are installed (also after a clone installed them).
if command -v dockerd >/dev/null 2>&1; then service docker start >/dev/null 2>&1 || (dockerd >/var/log/dockerd.log 2>&1 &); fi
if command -v cron >/dev/null 2>&1; then cron; fi
if command -v nginx >/dev/null 2>&1; then nginx; fi
exec /usr/sbin/sshd -D -e

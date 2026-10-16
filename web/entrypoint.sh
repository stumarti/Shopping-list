#!/bin/sh
# Started as root: give /data to PUID:PGID (99:100 on Unraid), then run the app as that user.
# Started as some other user (compose `user:`): just run.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R "${PUID}:${PGID}" /data
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid="${PUID}" --regid="${PGID}" --clear-groups "$@"
  fi
  echo "setpriv not found; running as root" >&2
fi
exec "$@"

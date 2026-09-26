#!/bin/sh
# Arranca la API como usuario sin privilegios (vyntra, uid 10001).
set -e

APP_UID="${APP_UID:-10001}"
APP_GID="${APP_GID:-10001}"
export APP_UID APP_GID

if [ "$(id -u)" = "0" ]; then
    dir="${STORAGE_DIR:-/data/evidence}"
    mkdir -p "$dir"
    if [ "$(stat -c %u "$dir")" != "$APP_UID" ]; then
        echo "docker-entrypoint: ajustando propietario de $dir a uid $APP_UID"
        chown -R "$APP_UID:$APP_GID" "$dir"
    fi
    exec python -c 'import os, sys
gid = int(os.environ["APP_GID"])
uid = int(os.environ["APP_UID"])
os.setgroups([])
os.setgid(gid)
os.setuid(uid)
os.environ["HOME"] = "/app"
os.execvp(sys.argv[1], sys.argv[1:])' "$@"
fi

exec "$@"

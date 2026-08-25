#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/vyntra}"
BACKEND_DIR="$APP_ROOT/backend"
ENV_FILE="${VYNTRA_ENV_FILE:-.env.production}"
BACKUP_DIR="${BACKUP_DIR:-$APP_ROOT/backups/postgres}"
DOWNLOADS_DIR="${DOWNLOADS_DIR:-$APP_ROOT/downloads}"
LOG_DIR="${LOG_DIR:-/var/log/vyntra}"
CRON_FILE="${CRON_FILE:-/etc/cron.d/vyntra-ops}"

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root on the production server." >&2
  exit 1
fi

if [[ ! -d "$BACKEND_DIR" ]]; then
  echo "Missing backend directory: $BACKEND_DIR" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR" "$DOWNLOADS_DIR" "$LOG_DIR"
chmod 700 "$BACKUP_DIR"
chmod 755 "$DOWNLOADS_DIR" "$LOG_DIR"
chmod +x "$BACKEND_DIR/scripts/backup_postgres.sh" "$BACKEND_DIR/scripts/healthcheck_vyntra.sh" "$BACKEND_DIR/scripts/publish_downloads.sh" "$BACKEND_DIR/scripts/check_production_env.sh"

cat > "$CRON_FILE" <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

15 2 * * * root cd $BACKEND_DIR && VYNTRA_ENV_FILE=$ENV_FILE BACKUP_DIR=$BACKUP_DIR ./scripts/backup_postgres.sh >> $LOG_DIR/backup.log 2>&1
*/5 * * * * root cd $BACKEND_DIR && ./scripts/healthcheck_vyntra.sh >> $LOG_DIR/health.log 2>&1
EOF

chmod 644 "$CRON_FILE"

echo "Production ops installed:"
echo "- Backups: $BACKUP_DIR"
echo "- Downloads: $DOWNLOADS_DIR"
echo "- Logs: $LOG_DIR"
echo "- Cron: $CRON_FILE"

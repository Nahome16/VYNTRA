#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${VYNTRA_ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-/opt/vyntra/backups/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

cd "$BACKEND_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $BACKEND_DIR/$ENV_FILE" >&2
  exit 1
fi

env_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-
}

POSTGRES_DB_VALUE="$(env_value POSTGRES_DB)"
POSTGRES_USER_VALUE="$(env_value POSTGRES_USER)"

if [[ -z "$POSTGRES_DB_VALUE" || -z "$POSTGRES_USER_VALUE" ]]; then
  echo "POSTGRES_DB or POSTGRES_USER is missing in $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$BACKUP_DIR/vyntra-${timestamp}.dump"

VYNTRA_ENV_FILE="$ENV_FILE" docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T db \
  pg_dump -U "$POSTGRES_USER_VALUE" -d "$POSTGRES_DB_VALUE" -Fc > "$backup_file"

chmod 600 "$backup_file"
find "$BACKUP_DIR" -type f -name "vyntra-*.dump" -mtime +"$RETENTION_DAYS" -delete

echo "Backup created: $backup_file"

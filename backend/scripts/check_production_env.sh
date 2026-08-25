#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${VYNTRA_ENV_FILE:-.env.production}"
APP_ROOT="${APP_ROOT:-/opt/vyntra}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

env_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-
}

failures=()

require_value() {
  local key="$1"
  if [[ -z "$(env_value "$key")" ]]; then
    failures+=("$key is required")
  fi
}

require_equals() {
  local key="$1"
  local expected="$2"
  local actual
  actual="$(env_value "$key")"
  if [[ "$actual" != "$expected" ]]; then
    failures+=("$key must be $expected")
  fi
}

require_value ENVIRONMENT
require_value DATABASE_URL
require_value POSTGRES_DB
require_value POSTGRES_USER
require_value POSTGRES_PASSWORD
require_value ADMIN_API_TOKEN
require_value JWT_SECRET
require_value CORS_ALLOWED_ORIGINS
require_value SMTP_HOST
require_value SMTP_USERNAME
require_value SMTP_PASSWORD
require_equals ALLOW_BOOTSTRAP false
require_equals ALLOW_LEGACY_ADMIN_TOKEN false

if [[ ! -d "$APP_ROOT/downloads" ]]; then
  failures+=("$APP_ROOT/downloads directory is missing")
fi

if [[ ! -d "$APP_ROOT/backups/postgres" ]]; then
  failures+=("$APP_ROOT/backups/postgres directory is missing")
fi

if (( ${#failures[@]} > 0 )); then
  printf 'Production env check failed:\n' >&2
  printf -- '- %s\n' "${failures[@]}" >&2
  exit 1
fi

echo "Production env check OK"

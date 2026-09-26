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

reject_placeholder() {
  local key="$1"
  local value lowered
  value="$(env_value "$key")"
  lowered="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  case "$lowered" in
    *replace_with_*|*changeme*|*change_me*|*example*|*yourdomain*)
      failures+=("$key still has a placeholder value")
      ;;
  esac
}

require_min_length() {
  local key="$1"
  local min="$2"
  local value
  value="$(env_value "$key")"
  if (( ${#value} < min )); then
    failures+=("$key must have at least $min characters")
  fi
}

require_equals ENVIRONMENT production
require_value DATABASE_URL
require_value APP_DOMAIN
require_value API_DOMAIN
require_value STATION_DOMAIN
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
require_min_length JWT_SECRET 32
require_min_length ADMIN_API_TOKEN 32

for key in DATABASE_URL APP_DOMAIN API_DOMAIN STATION_DOMAIN ACME_EMAIL POSTGRES_PASSWORD   ADMIN_API_TOKEN JWT_SECRET CORS_ALLOWED_ORIGINS SMTP_HOST SMTP_USERNAME SMTP_PASSWORD   SMTP_FROM_EMAIL APP_PUBLIC_URL STATION_PUBLIC_URL; do
  reject_placeholder "$key"
done

forwarded="$(env_value FORWARDED_ALLOW_IPS)"
if [[ -n "$forwarded" && "$forwarded" != "*" ]]; then
  echo "Note: FORWARDED_ALLOW_IPS=$forwarded (must include the Caddy container network)." >&2
fi

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

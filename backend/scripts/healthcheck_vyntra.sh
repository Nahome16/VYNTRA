#!/usr/bin/env bash
set -euo pipefail

API_HEALTH_URL="${API_HEALTH_URL:-https://api.vyntralab.com/health}"
APP_HEALTH_URL="${APP_HEALTH_URL:-https://app.vyntralab.com}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-12}"
ALERT_EMAIL="${ALERT_EMAIL:-}"

failures=()

if ! curl -fsS --max-time "$TIMEOUT_SECONDS" "$API_HEALTH_URL" >/dev/null; then
  failures+=("API health failed: $API_HEALTH_URL")
fi

if ! curl -fsS --max-time "$TIMEOUT_SECONDS" "$APP_HEALTH_URL" >/dev/null; then
  failures+=("Web health failed: $APP_HEALTH_URL")
fi

if (( ${#failures[@]} > 0 )); then
  message="$(printf '%s\n' "${failures[@]}")"
  echo "$message" >&2
  if [[ -n "$ALERT_EMAIL" ]] && command -v mail >/dev/null 2>&1; then
    printf '%s\n' "$message" | mail -s "VYNTRA production health alert" "$ALERT_EMAIL" || true
  fi
  exit 1
fi

echo "VYNTRA health OK: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

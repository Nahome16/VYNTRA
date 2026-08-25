#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-/opt/vyntra/release}"
DOWNLOADS_DIR="${DOWNLOADS_DIR:-/opt/vyntra/downloads}"

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Source directory not found: $SOURCE_DIR" >&2
  exit 1
fi

mkdir -p "$DOWNLOADS_DIR"

shopt -s nullglob
files=(
  "$SOURCE_DIR"/VYNTRAAgent-*-Windows-Setup-v*.exe
  "$SOURCE_DIR"/VYNTRAAgent-*-Windows-Setup-v*.zip
  "$SOURCE_DIR"/VYNTRAAgent-*-macOS-*.zip
  "$SOURCE_DIR"/VYNTRAAgent-*-macOS-*.dmg
  "$SOURCE_DIR"/VYNTRAAgent-*-macOS-*.pkg
)

if (( ${#files[@]} == 0 )); then
  echo "No release installers found in $SOURCE_DIR" >&2
  exit 1
fi

find "$DOWNLOADS_DIR" -maxdepth 1 -type f -name "VYNTRAAgent-*" -delete
for file in "${files[@]}"; do
  install -m 0644 "$file" "$DOWNLOADS_DIR/$(basename "$file")"
done

echo "Published installers:"
find "$DOWNLOADS_DIR" -maxdepth 1 -type f -name "VYNTRAAgent-*" -printf "- %f\n" | sort

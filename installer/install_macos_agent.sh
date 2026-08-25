#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_SOURCE="$ROOT/VYNTRAAgent.app"
INSTALL_DIR="$HOME/Applications"
APP_TARGET="$INSTALL_DIR/VYNTRAAgent.app"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS/com.vyntralab.agent.plist"

if [[ ! -d "$APP_SOURCE" ]]; then
  echo "VYNTRAAgent.app was not found next to this installer."
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$LAUNCH_AGENTS"
rm -rf "$APP_TARGET"
cp -R "$APP_SOURCE" "$APP_TARGET"

if [[ -d "$ROOT/legal" ]]; then
  rm -rf "$INSTALL_DIR/VYNTRAAgentLegal"
  cp -R "$ROOT/legal" "$INSTALL_DIR/VYNTRAAgentLegal"
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.vyntralab.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP_TARGET/Contents/MacOS/VYNTRAAgent</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
PLIST

launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load "$PLIST"

open "$APP_TARGET"

cat <<'INFO'
VYNTRA Agent was installed.

macOS may ask for permissions:
- Screen Recording, for screenshots during an active shift.
- Accessibility, for click/activity signals.

Open System Settings > Privacy & Security and allow VYNTRA Agent if prompted.
INFO

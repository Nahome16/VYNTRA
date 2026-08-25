#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPANY_NAME="${COMPANY_NAME:-InsureMeBetter}"
CONTACT_EMAIL="${CONTACT_EMAIL:-carlos@insuremebetter.com}"
API_URL="${API_URL:-https://api.vyntralab.com}"
LANGUAGE="${LANGUAGE:-es}"
AGENT_VERSION="${AGENT_VERSION:-1.2.1}"
PACKAGE_NAME="${PACKAGE_NAME:-VYNTRAAgent-${COMPANY_NAME// /-}-macOS-v$AGENT_VERSION}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This builder must run on macOS because PyInstaller creates native .app bundles per OS."
  exit 1
fi

python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt pyinstaller

if [[ ! -f config.ini ]]; then
  cp installer/config.production.template.ini config.ini
fi

python3 - <<PY
from pathlib import Path
path = Path("config.ini")
text = path.read_text(encoding="utf-8")
def set_value(section, key, value):
    global text
    marker = f"[{section}]"
    if marker not in text:
        text = text.rstrip() + f"\n\n{marker}\n{key} = {value}\n"
        return
    lines = text.splitlines()
    output = []
    in_section = False
    written = False
    for line in lines:
        if line.strip().startswith("[") and line.strip().endswith("]"):
            if in_section and not written:
                output.append(f"{key} = {value}")
                written = True
            in_section = line.strip() == marker
        if in_section and line.lower().startswith(f"{key.lower()}"):
            if not written:
                output.append(f"{key} = {value}")
                written = True
            continue
        output.append(line)
    if in_section and not written:
        output.append(f"{key} = {value}")
    text = "\n".join(output) + "\n"

set_value("Server", "Url", "$API_URL")
set_value("General", "Empresa", "$COMPANY_NAME")
set_value("General", "CorreoContacto", "$CONTACT_EMAIL")
set_value("EvidenceBackend", "Url", "$API_URL")
set_value("EvidenceBackend", "DeviceToken", "")
set_value("Interface", "Language", "$LANGUAGE")
path.write_text(text, encoding="utf-8")
PY

python3 -m PyInstaller installer/vyntra_agent_macos.spec --clean --noconfirm

STAGE=".installer_macos_build/$PACKAGE_NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R dist/VYNTRAAgent.app "$STAGE/"
cp -R docs/legal "$STAGE/legal"
cp installer/install_macos_agent.sh "$STAGE/Install VYNTRA Agent.command"
chmod +x "$STAGE/Install VYNTRA Agent.command"

mkdir -p release
ditto -c -k --sequesterRsrc --keepParent "$STAGE" "release/$PACKAGE_NAME.zip"
echo "macOS package ready: release/$PACKAGE_NAME.zip"

"""
agent_updater.py - Automatic agent update checks for VYNTRA.

The updater preserves local state such as config.ini, DeviceToken, queues,
consent files and captures. It only replaces packaged application files.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urljoin

import requests


CHECK_INTERVAL_SECONDS = 6 * 60 * 60
STATE_FILE = "update_state.json"
UPDATES_DIR = "updates"


def _version_tuple(value: str) -> tuple[int, ...]:
    parts = []
    for piece in str(value or "").replace("-", ".").split("."):
        digits = "".join(char for char in piece if char.isdigit())
        if digits:
            parts.append(int(digits))
    return tuple(parts[:4]) if parts else (0,)


def _notify(callback, message: str):
    if callback:
        try:
            callback(message)
        except Exception:
            pass


class AgentUpdater:
    def __init__(self, cfg, current_version: str, on_event=None):
        self.cfg = cfg
        self.current_version = current_version or getattr(cfg, "agent_version", "0.0.0")
        self.on_event = on_event
        self.base_url = str(getattr(cfg, "evidence_backend_url", "") or "").rstrip("/")
        self.device_token = str(getattr(cfg, "evidence_device_token", "") or "").strip()
        self.timeout = int(getattr(cfg, "evidence_request_timeout", 30) or 30)
        self.base_dir = str(getattr(cfg, "base_dir", "") or os.getcwd())
        self.state_path = os.path.join(self.base_dir, STATE_FILE)
        self.updates_dir = os.path.join(self.base_dir, UPDATES_DIR)

    def start_background(self):
        if not self._can_update():
            return
        thread = threading.Thread(target=self._background_loop, daemon=True)
        thread.start()

    def _background_loop(self):
        while True:
            try:
                if self.check_download_and_apply():
                    time.sleep(1)
                    os._exit(0)
            except Exception as exc:
                self._save_state(
                    {
                        "last_check_at": time.time(),
                        "status": "error",
                        "error": str(exc)[:240],
                    }
                )
                _notify(self.on_event, f"Actualizacion pendiente: {exc}")
            time.sleep(min(15 * 60, CHECK_INTERVAL_SECONDS))

    def check_download_and_apply(self) -> bool:
        if not self._can_update() or not self._check_due():
            return False
        self._save_state({"last_check_at": time.time(), "status": "checking"})
        manifest = self._fetch_manifest()
        if not manifest.get("update_available"):
            self._save_state({"last_check_at": time.time(), "status": "current"})
            return False

        package = manifest.get("package") or {}
        latest_version = str(package.get("version") or manifest.get("latest_version") or "")
        if _version_tuple(latest_version) <= _version_tuple(self.current_version):
            self._save_state({"last_check_at": time.time(), "status": "current"})
            return False

        _notify(self.on_event, f"Actualizacion VYNTRA disponible: {latest_version}")
        zip_path = self._download_package(package)
        self._launch_installer(zip_path, latest_version)
        self._save_state(
            {
                "last_check_at": time.time(),
                "status": "installing",
                "version": latest_version,
                "package": os.path.basename(zip_path),
            }
        )
        return True

    def _can_update(self) -> bool:
        if not sys.platform.startswith("win"):
            return False
        if not self.base_url or not self.device_token:
            return False
        return bool(getattr(self.cfg, "agent_auto_update_enabled", True))

    def _check_due(self) -> bool:
        try:
            with open(self.state_path, "r", encoding="utf-8") as handle:
                state = json.load(handle)
            last_check = float(state.get("last_check_at") or 0)
            return time.time() - last_check >= CHECK_INTERVAL_SECONDS
        except Exception:
            return True

    def _save_state(self, state: dict):
        try:
            with open(self.state_path, "w", encoding="utf-8") as handle:
                json.dump(state, handle, ensure_ascii=False, indent=2)
        except Exception:
            pass

    def _headers(self) -> dict:
        return {"X-Device-Token": self.device_token}

    def _fetch_manifest(self) -> dict:
        response = requests.get(
            f"{self.base_url}/api/agent/update",
            headers=self._headers(),
            params={"platform": "windows", "current_version": self.current_version},
            timeout=self.timeout,
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or not payload.get("ok"):
            raise RuntimeError("Manifest de actualizacion invalido")
        return payload

    def _download_package(self, package: dict) -> str:
        download_url = str(package.get("download_url") or "")
        expected_sha = str(package.get("sha256") or "").strip().lower()
        filename = os.path.basename(str(package.get("filename") or "vyntra-update.zip"))
        if not download_url or len(expected_sha) != 64:
            raise RuntimeError("Paquete de actualizacion incompleto")

        os.makedirs(self.updates_dir, exist_ok=True)
        final_path = os.path.join(self.updates_dir, filename)
        temp_path = f"{final_path}.tmp"
        digest = hashlib.sha256()

        url = urljoin(f"{self.base_url}/", download_url.lstrip("/"))
        with requests.get(url, headers=self._headers(), stream=True, timeout=self.timeout) as response:
            response.raise_for_status()
            with open(temp_path, "wb") as handle:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    digest.update(chunk)
                    handle.write(chunk)

        actual_sha = digest.hexdigest()
        if actual_sha != expected_sha:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
            raise RuntimeError("Hash SHA-256 de actualizacion no coincide")

        if os.path.exists(final_path):
            os.unlink(final_path)
        os.replace(temp_path, final_path)
        return final_path

    def _launch_installer(self, zip_path: str, latest_version: str):
        exe_path = sys.executable if getattr(sys, "frozen", False) else os.path.join(self.base_dir, "VYNTRAAgent.exe")
        script_path = os.path.join(tempfile.gettempdir(), f"vyntra-agent-update-{os.getpid()}.ps1")
        install_dir = self.base_dir
        script = _powershell_update_script()
        with open(script_path, "w", encoding="utf-8-sig") as handle:
            handle.write(script)

        subprocess.Popen(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-File",
                script_path,
                "-ZipPath",
                zip_path,
                "-InstallDir",
                install_dir,
                "-ExePath",
                exe_path,
                "-CurrentPid",
                str(os.getpid()),
                "-Version",
                latest_version,
            ],
            cwd=install_dir,
            close_fds=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )


def _powershell_update_script() -> str:
    return r'''
param(
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][int]$CurrentPid,
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"

function Write-UpdateLog {
    param([string]$Message)
    $log = Join-Path $InstallDir "update.log"
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

function Copy-UpdateFiles {
    param([string]$Source, [string]$Destination)
    $preserve = @(
        "config.ini",
        "update_state.json",
        "update.log",
        "evidence_queue.db",
        "rules_cache.json"
    )
    $preservePatterns = @(
        "consent*.json"
    )
    $preserveDirs = @(
        "capturas",
        "updates",
        "legal"
    )
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        if ($preserve -contains $_.Name) { return }
        foreach ($pattern in $preservePatterns) {
            if ($_.Name -like $pattern) { return }
        }
        if ($_.PSIsContainer -and ($preserveDirs -contains $_.Name)) { return }
        $target = Join-Path $Destination $_.Name
        if ($_.PSIsContainer) {
            if (Test-Path -LiteralPath $target) {
                Remove-Item -LiteralPath $target -Recurse -Force
            }
            Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
        } else {
            Copy-Item -LiteralPath $_.FullName -Destination $target -Force
        }
    }
}

function Update-AgentConfigVersion {
    param([string]$ConfigPath, [string]$Version)
    if ([string]::IsNullOrWhiteSpace($Version)) { return }
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return }

    $lines = Get-Content -LiteralPath $ConfigPath -Encoding UTF8
    $result = New-Object System.Collections.Generic.List[string]
    $inAgent = $false
    $updated = $false

    foreach ($line in $lines) {
        if ($line -match '^\s*\[(.+?)\]\s*$') {
            if ($inAgent -and -not $updated) {
                $result.Add("Version = $Version")
                $updated = $true
            }
            $inAgent = ($matches[1] -eq "Agent")
        }

        if ($inAgent -and $line -match '^\s*Version\s*=') {
            $result.Add("Version = $Version")
            $updated = $true
            continue
        }
        $result.Add($line)
    }

    if ($inAgent -and -not $updated) {
        $result.Add("Version = $Version")
    }

    Set-Content -LiteralPath $ConfigPath -Value $result -Encoding UTF8
}

try {
    Write-UpdateLog "Starting update to $Version from $ZipPath"
    $proc = Get-Process -Id $CurrentPid -ErrorAction SilentlyContinue
    if ($proc) {
        Wait-Process -Id $CurrentPid -Timeout 90 -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2

    $extractRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("VYNTRAAgentUpdate-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $extractRoot -Force

    $source = Join-Path $extractRoot "VYNTRAAgent"
    if (-not (Test-Path -LiteralPath (Join-Path $source "VYNTRAAgent.exe"))) {
        $candidate = Get-ChildItem -LiteralPath $extractRoot -Directory -Recurse -ErrorAction SilentlyContinue |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "VYNTRAAgent.exe") } |
            Select-Object -First 1
        if ($candidate) {
            $source = $candidate.FullName
        } elseif (Test-Path -LiteralPath (Join-Path $extractRoot "VYNTRAAgent.exe")) {
            $source = $extractRoot
        } else {
            throw "VYNTRAAgent.exe was not found in update package."
        }
    }

    Copy-UpdateFiles -Source $source -Destination $InstallDir
    Update-AgentConfigVersion -ConfigPath (Join-Path $InstallDir "config.ini") -Version $Version

    if (-not (Test-Path -LiteralPath $ExePath)) {
        throw "Updated executable not found: $ExePath"
    }

    Write-UpdateLog "Update copied successfully. Restarting agent."
    Start-Process -FilePath $ExePath -WorkingDirectory $InstallDir -WindowStyle Hidden
    Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
} catch {
    Write-UpdateLog ("Update failed: " + $_.Exception.Message)
}
'''.strip()


def run_startup_update(cfg, current_version: str, on_event=None) -> bool:
    try:
        updater = AgentUpdater(cfg, current_version, on_event=on_event)
        return updater.check_download_and_apply()
    except Exception as exc:
        _notify(on_event, f"Actualizacion pendiente: {exc}")
        return False

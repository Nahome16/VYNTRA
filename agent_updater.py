"""
agent_updater.py - Automatic agent update checks for VYNTRA.

The updater preserves local state such as config.ini, DeviceToken, queues,
consent files and captures. It only replaces packaged application files.

Safety rules
------------
- Updates are only applied when the shift is FUERA or TERMINADO (and no
  overtime is running). Mid-shift the update is deferred and retried later.
- Packages are only downloaded from the same origin (scheme + host + port) as
  the configured backend URL. Absolute download URLs to another origin are
  rejected and redirects are not followed, so X-Device-Token is never sent
  cross-origin.
- The package SHA-256 must match the manifest.
- Before replacing files, the PowerShell script verifies the Authenticode
  signature of the new VYNTRAAgent.exe (Get-AuthenticodeSignature). If an
  expected signer thumbprint is configured ([Update] SignerThumbprint in
  config.ini), Status must be Valid and the signer thumbprint must match;
  otherwise the update is aborted. If no thumbprint is configured, a warning
  is logged and the update proceeds (so current unsigned builds still update).
- Files are copied to a staging folder first, then swapped in; the previous
  files are kept in a backup folder and restored if the copy fails. The agent
  is always relaunched, after success or rollback.
- The generated script and its log live in %LOCALAPPDATA%\\VYNTRA\\updates
  (not %TEMP%). It runs with -ExecutionPolicy RemoteSigned: a locally created
  script is allowed without disabling policy checks entirely (Bypass).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
import sys
import threading
import time
from urllib.parse import urljoin, urlsplit

import requests

from agent_runtime import data_dir, get_logger

log = get_logger("updater")

CHECK_INTERVAL_SECONDS = 6 * 60 * 60
DEFERRED_RETRY_SECONDS = 15 * 60
STATE_FILE = "update_state.json"
UPDATES_DIR = "updates"
UPDATE_ALLOWED_STATES = ("FUERA", "TERMINADO")


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
            log.exception("Callback del actualizador fallo")


def _origin(url: str) -> tuple[str, str, int | None]:
    parts = urlsplit(url)
    scheme = (parts.scheme or "").lower()
    host = (parts.hostname or "").lower()
    port = parts.port
    if port is None:
        port = {"https": 443, "http": 80}.get(scheme)
    return scheme, host, port


def resolve_same_origin_url(base_url: str, download_url: str) -> str:
    """Resuelve download_url contra base_url y exige el mismo origen."""
    download_url = str(download_url or "").strip()
    if not download_url:
        raise RuntimeError("Paquete de actualizacion sin URL de descarga")
    parts = urlsplit(download_url)
    if parts.scheme or parts.netloc or download_url.startswith("//"):
        candidate = download_url if parts.scheme else f"{urlsplit(base_url).scheme}:{download_url}"
    else:
        candidate = urljoin(f"{base_url.rstrip('/')}/", download_url.lstrip("/"))
    if _origin(candidate) != _origin(base_url):
        raise RuntimeError(
            "URL de descarga rechazada: no pertenece al mismo origen que el backend configurado"
        )
    return candidate


def update_allowed_for_state(estado: str, horas_extra_estado: str = "") -> bool:
    return estado in UPDATE_ALLOWED_STATES and horas_extra_estado != "ACTIVA"


def _persisted_state_provider():
    from shift import persisted_shift_state

    return persisted_shift_state()


class AgentUpdater:
    def __init__(self, cfg, current_version: str, on_event=None, shift_state_provider=None):
        self.cfg = cfg
        self.current_version = current_version or getattr(cfg, "agent_version", "0.0.0")
        self.on_event = on_event
        self.base_url = str(getattr(cfg, "evidence_backend_url", "") or "").rstrip("/")
        self.device_token = str(getattr(cfg, "evidence_device_token", "") or "").strip()
        self.timeout = int(getattr(cfg, "evidence_request_timeout", 30) or 30)
        self.base_dir = str(getattr(cfg, "base_dir", "") or os.getcwd())
        self.signer_thumbprint = str(getattr(cfg, "update_signer_thumbprint", "") or "").strip().upper()
        self.shift_state_provider = shift_state_provider or _persisted_state_provider
        self.state_path = os.path.join(self.base_dir, STATE_FILE)
        self.work_dir = os.path.join(data_dir(), UPDATES_DIR)
        self.updates_dir = self.work_dir
        self._stop = threading.Event()
        self._thread = None

    def start_background(self):
        if not self._can_update():
            return
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._background_loop, name="vyntra-updater", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _background_loop(self):
        while not self._stop.is_set():
            try:
                if self.check_download_and_apply():
                    log.info("Actualizacion lanzada; cerrando el agente para aplicarla.")
                    logging.shutdown()
                    time.sleep(1)
                    os._exit(0)
            except Exception as exc:
                log.warning("Actualizacion pendiente: %s", exc)
                self._save_state(
                    {
                        "last_check_at": time.time(),
                        "status": "error",
                        "error": str(exc)[:240],
                    }
                )
                _notify(self.on_event, f"Actualizacion pendiente: {exc}")
            self._stop.wait(min(DEFERRED_RETRY_SECONDS, CHECK_INTERVAL_SECONDS))

    def _update_allowed_now(self) -> bool:
        try:
            estado, horas_extra = self.shift_state_provider()
        except Exception:
            log.exception("No se pudo leer el estado de la jornada; se pospone la actualizacion")
            return False
        return update_allowed_for_state(str(estado or ""), str(horas_extra or ""))

    def check_download_and_apply(self) -> bool:
        if not self._can_update() or not self._check_due():
            return False
        previous = self._load_state()
        self._save_state({**previous, "last_check_at": time.time(), "status": "checking"})
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

        if not self._update_allowed_now():
            # Nunca en medio de una jornada: se reintenta en el siguiente ciclo
            # (el paquete ya descargado y verificado se reutiliza).
            log.info("Actualizacion %s pospuesta: hay una jornada activa.", latest_version)
            self._save_state(
                {
                    "last_check_at": 0,
                    "status": "deferred",
                    "version": latest_version,
                    "package": os.path.basename(zip_path),
                }
            )
            _notify(self.on_event, "Actualizacion pospuesta hasta finalizar la jornada.")
            return False

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

    def _load_state(self) -> dict:
        try:
            with open(self.state_path, "r", encoding="utf-8-sig") as handle:
                state = json.load(handle)
            return state if isinstance(state, dict) else {}
        except (OSError, ValueError):
            return {}

    def _check_due(self) -> bool:
        state = self._load_state()
        try:
            last_check = float(state.get("last_check_at") or 0)
        except (TypeError, ValueError):
            return True
        return time.time() - last_check >= CHECK_INTERVAL_SECONDS

    def _save_state(self, state: dict):
        try:
            tmp = f"{self.state_path}.tmp"
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(state, handle, ensure_ascii=False, indent=2)
            os.replace(tmp, self.state_path)
        except OSError as exc:
            log.warning("No se pudo guardar el estado del actualizador: %s", exc)

    def _headers(self) -> dict:
        return {"X-Device-Token": self.device_token}

    def _fetch_manifest(self) -> dict:
        response = requests.get(
            f"{self.base_url}/api/agent/update",
            headers=self._headers(),
            params={"platform": "windows", "current_version": self.current_version},
            timeout=self.timeout,
            allow_redirects=False,
        )
        if 300 <= response.status_code < 400:
            raise RuntimeError("El manifest de actualizacion respondio con una redireccion; se rechaza")
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or not payload.get("ok"):
            raise RuntimeError("Manifest de actualizacion invalido")
        return payload

    @staticmethod
    def _sha256_file(path: str) -> str:
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _download_package(self, package: dict) -> str:
        download_url = str(package.get("download_url") or "")
        expected_sha = str(package.get("sha256") or "").strip().lower()
        filename = os.path.basename(str(package.get("filename") or "vyntra-update.zip"))
        if not download_url or len(expected_sha) != 64:
            raise RuntimeError("Paquete de actualizacion incompleto")
        url = resolve_same_origin_url(self.base_url, download_url)

        os.makedirs(self.updates_dir, exist_ok=True)
        final_path = os.path.join(self.updates_dir, filename)
        for name in os.listdir(self.updates_dir):
            # Paquetes de versiones anteriores ya no se necesitan.
            if name.lower().endswith(".zip") and name != filename:
                try:
                    os.remove(os.path.join(self.updates_dir, name))
                except OSError:
                    pass
        if os.path.exists(final_path):
            try:
                if self._sha256_file(final_path) == expected_sha:
                    return final_path
            except OSError:
                pass
        temp_path = f"{final_path}.tmp"
        digest = hashlib.sha256()

        with requests.get(
            url,
            headers=self._headers(),
            stream=True,
            timeout=self.timeout,
            allow_redirects=False,
        ) as response:
            if 300 <= response.status_code < 400:
                raise RuntimeError("La descarga de actualizacion respondio con una redireccion; se rechaza")
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

        os.replace(temp_path, final_path)
        return final_path

    def _launch_installer(self, zip_path: str, latest_version: str):
        exe_path = sys.executable if getattr(sys, "frozen", False) else os.path.join(self.base_dir, "VYNTRAAgent.exe")
        os.makedirs(self.work_dir, exist_ok=True)
        script_path = os.path.join(self.work_dir, "vyntra-agent-update.ps1")
        log_path = os.path.join(self.work_dir, "update.log")
        install_dir = self.base_dir
        with open(script_path, "w", encoding="utf-8-sig") as handle:
            handle.write(_powershell_update_script())

        args = [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "RemoteSigned",
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
            "-WorkDir",
            self.work_dir,
            "-LogPath",
            log_path,
        ]
        if self.signer_thumbprint:
            args += ["-ExpectedThumbprint", self.signer_thumbprint]
        log.info("Lanzando actualizacion %s (script %s)", latest_version, script_path)
        subprocess.Popen(
            args,
            cwd=self.work_dir,
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
    [string]$Version = "",
    [string]$WorkDir = "",
    [string]$LogPath = "",
    [string]$ExpectedThumbprint = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($WorkDir)) { $WorkDir = Join-Path $env:LOCALAPPDATA "VYNTRA\updates" }
if ([string]::IsNullOrWhiteSpace($LogPath)) { $LogPath = Join-Path $WorkDir "update.log" }
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-UpdateLog {
    param([string]$Message)
    $line = "$(Get-Date -Format o) $Message`r`n"
    try { [System.IO.File]::AppendAllText($LogPath, $line, $utf8NoBom) } catch { }
}

# Archivos y carpetas locales que nunca se reemplazan ni se respaldan.
$preserve = @("config.ini", "update_state.json", "update.log", "evidence_queue.db", "rules_cache.json")
$preservePatterns = @("consent*.json", "*.tmp")
$preserveDirs = @("capturas", "updates", "legal")

function Test-Preserved {
    param($Item)
    if ($preserve -contains $Item.Name) { return $true }
    foreach ($pattern in $preservePatterns) {
        if ($Item.Name -like $pattern) { return $true }
    }
    if ($Item.PSIsContainer -and ($preserveDirs -contains $Item.Name)) { return $true }
    return $false
}

function Copy-Tree {
    param([string]$Source, [string]$Destination)
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        if (Test-Preserved $_) { return }
        $target = Join-Path $Destination $_.Name
        if ($_.PSIsContainer) {
            if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
            Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
        } else {
            Copy-Item -LiteralPath $_.FullName -Destination $target -Force
        }
    }
}

function Assert-UpdateSignature {
    param([string]$NewExe)
    $signature = Get-AuthenticodeSignature -LiteralPath $NewExe
    $status = [string]$signature.Status
    $thumb = ""
    if ($signature.SignerCertificate) { $thumb = [string]$signature.SignerCertificate.Thumbprint }
    Write-UpdateLog "Authenticode: status=$status signer=$thumb"
    if ([string]::IsNullOrWhiteSpace($ExpectedThumbprint)) {
        Write-UpdateLog "WARNING: [Update] SignerThumbprint no configurado; se acepta el paquete sin exigir firma (solo verificado por SHA-256)."
        return
    }
    if ($status -ne "Valid") {
        throw "Firma Authenticode invalida ($status). Actualizacion cancelada."
    }
    # Se admiten varias huellas separadas por coma (rotacion de certificados).
    $expected = @($ExpectedThumbprint -split "[,;\s]+" | Where-Object { $_ } | ForEach-Object { $_.ToUpperInvariant() })
    if ($expected -notcontains $thumb.ToUpperInvariant()) {
        throw "El firmante ($thumb) no coincide con los esperados ($($expected -join ', ')). Actualizacion cancelada."
    }
}

function Update-AgentConfigVersion {
    param([string]$ConfigPath, [string]$Version)
    if ([string]::IsNullOrWhiteSpace($Version)) { return }
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return }

    $lines = [System.IO.File]::ReadAllLines($ConfigPath, [System.Text.Encoding]::UTF8)
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
        $result.Add($line.TrimStart([char]0xFEFF))
    }

    if ($inAgent -and -not $updated) {
        $result.Add("Version = $Version")
    }

    # UTF-8 sin BOM (el BOM de Set-Content -Encoding UTF8 rompe configparser).
    $tmp = "$ConfigPath.tmp"
    [System.IO.File]::WriteAllLines($tmp, $result, $utf8NoBom)
    Move-Item -LiteralPath $tmp -Destination $ConfigPath -Force
}

$stamp = Get-Date -Format "yyyyMMddHHmmss"
$extractRoot = Join-Path $WorkDir ("extract-" + $stamp)
$stagingDir = Join-Path $WorkDir ("staging-" + $stamp)
$backupDir = Join-Path $WorkDir ("backup-" + $stamp)
$swapStarted = $false
$success = $false

try {
    Write-UpdateLog "Starting update to $Version from $ZipPath"
    $proc = Get-Process -Id $CurrentPid -ErrorAction SilentlyContinue
    if ($proc) {
        Wait-Process -Id $CurrentPid -Timeout 90 -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2

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

    # 1) Firma del nuevo ejecutable antes de tocar la instalacion.
    Assert-UpdateSignature -NewExe (Join-Path $source "VYNTRAAgent.exe")

    # 2) Copia completa a staging (si falla aqui, la instalacion no se toco).
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
    Copy-Tree -Source $source -Destination $stagingDir
    if (-not (Test-Path -LiteralPath (Join-Path $stagingDir "VYNTRAAgent.exe"))) {
        throw "Staging incompleto: falta VYNTRAAgent.exe"
    }

    # 3) Respaldo de los archivos actuales que seran reemplazados.
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    Get-ChildItem -LiteralPath $InstallDir -Force | ForEach-Object {
        if (Test-Preserved $_) { return }
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $backupDir $_.Name) -Recurse -Force
    }

    # 4) Intercambio: staging -> instalacion.
    $swapStarted = $true
    Copy-Tree -Source $stagingDir -Destination $InstallDir
    if (-not (Test-Path -LiteralPath $ExePath)) {
        throw "Updated executable not found: $ExePath"
    }
    Update-AgentConfigVersion -ConfigPath (Join-Path $InstallDir "config.ini") -Version $Version
    $success = $true
    Write-UpdateLog "Update copied successfully."
} catch {
    Write-UpdateLog ("Update failed: " + $_.Exception.Message)
    if ($swapStarted -and (Test-Path -LiteralPath $backupDir)) {
        try {
            Write-UpdateLog "Rolling back from $backupDir"
            Copy-Tree -Source $backupDir -Destination $InstallDir
            Write-UpdateLog "Rollback completed."
        } catch {
            Write-UpdateLog ("Rollback failed: " + $_.Exception.Message)
        }
    }
} finally {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
    if ($success) {
        # Respaldos de intentos anteriores ya no son necesarios.
        Get-ChildItem -LiteralPath $WorkDir -Directory -Filter "backup-*" -ErrorAction SilentlyContinue |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    }
    # Siempre se vuelve a abrir el agente (actualizado o restaurado).
    try {
        if (Test-Path -LiteralPath $ExePath) {
            Start-Process -FilePath $ExePath -WorkingDirectory $InstallDir
            Write-UpdateLog "Agent relaunched."
        } else {
            Write-UpdateLog "Agent executable missing after update: $ExePath"
        }
    } catch {
        Write-UpdateLog ("Relaunch failed: " + $_.Exception.Message)
    }
}
'''.strip()


def run_startup_update(cfg, current_version: str, on_event=None) -> bool:
    try:
        updater = AgentUpdater(cfg, current_version, on_event=on_event)
        return updater.check_download_and_apply()
    except Exception as exc:
        log.warning("Actualizacion pendiente al iniciar: %s", exc)
        _notify(on_event, f"Actualizacion pendiente: {exc}")
        return False

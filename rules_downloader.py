"""
rules_downloader.py - Descarga y gestiona reglas de productividad desde el backend.

- Cache en %LOCALAPPDATA%\\VYNTRA\\rules_cache.json (misma carpeta que el
  outbox; ya no junto al ejecutable, donde las actualizaciones la borraban).
- Se revalida cada 30 minutos. Si el servidor envia ETag, se usa
  If-None-Match (304 = sin cambios); ademas se registra el `updated_at` mas
  reciente de las reglas para diagnostico.
"""

import json
import os
import sys
import threading
from datetime import datetime, timedelta, timezone

import requests

import capture_policy
from agent_runtime import backoff_delay, data_dir, get_logger

log = get_logger("rules")


def _legacy_cache_path(filename: str) -> str:
    if getattr(sys, "frozen", False):
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, filename)


class RulesDownloader:
    """
    Descarga las reglas de productividad aplicables al dispositivo desde el backend.
    Las guarda localmente para uso offline y las actualiza periodicamente.
    """

    CACHE_FILENAME = "rules_cache.json"
    CACHE_VALIDITY_MINUTES = 30
    CHECK_INTERVAL_SECONDS = 60
    RETRY_BASE_SECONDS = 60
    RETRY_MAX_SECONDS = 30 * 60

    def __init__(self, cfg, on_event=None):
        self.cfg = cfg
        self.on_event = on_event
        self.enabled = bool(getattr(cfg, "evidence_backend_enabled", False))
        self.base_url = getattr(cfg, "evidence_backend_url", "").rstrip("/")
        self.device_token = getattr(cfg, "evidence_device_token", "")
        self.timeout = int(getattr(cfg, "evidence_request_timeout", 30))
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread = None
        self._download_lock = threading.Lock()
        self._failures = 0
        self.cache_path = os.path.join(data_dir(), self.CACHE_FILENAME)
        self.rules = []
        self.last_update = None
        self.etag = ""
        self.rules_updated_at = None
        self._load_cache()

    def _load_cache(self):
        """Carga las reglas desde el archivo local (o desde la ubicacion anterior)."""
        path = self.cache_path
        if not os.path.exists(path):
            legacy = _legacy_cache_path(self.CACHE_FILENAME)
            if os.path.exists(legacy):
                path = legacy
            else:
                return
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
            self.rules = data.get("rules", []) or []
            capture_policy.set_rules(self.rules)
            self.etag = str(data.get("etag") or "")
            self.rules_updated_at = data.get("rules_updated_at")
            last_update_str = data.get("last_update")
            if last_update_str:
                parsed = datetime.fromisoformat(last_update_str)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                self.last_update = parsed
            if path != self.cache_path:
                self._save_cache()
            self._notify(f"Reglas cargadas desde cache: {len(self.rules)} reglas")
        except Exception as exc:
            log.warning("Error al cargar cache de reglas %s: %s", path, exc)
            self._notify(f"Error al cargar cache de reglas: {exc}")

    def _save_cache(self):
        """Guarda las reglas en el archivo local (escritura atomica)."""
        try:
            data = {
                "last_update": (self.last_update or datetime.now(timezone.utc)).isoformat(),
                "etag": self.etag,
                "rules_updated_at": self.rules_updated_at,
                "rules": self.rules,
            }
            tmp = f"{self.cache_path}.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            os.replace(tmp, self.cache_path)
            self._notify(f"Reglas guardadas en cache: {len(self.rules)} reglas")
        except Exception as exc:
            log.warning("Error al guardar cache de reglas: %s", exc)
            self._notify(f"Error al guardar cache de reglas: {exc}")

    def start(self):
        """Inicia el descargador de reglas en segundo plano."""
        self.device_token = getattr(self.cfg, "evidence_device_token", "") or self.device_token
        if not self.enabled or not self.base_url or not self.device_token:
            self._notify("Descargador de reglas no configurado.")
            return
        if self._thread and self._thread.is_alive() and not self._stop.is_set():
            return
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._loop, args=(self._stop,), name="vyntra-rules", daemon=True
        )
        self._thread.start()
        self._notify("Descargador de reglas iniciado.")

    def stop(self):
        """Detiene el descargador de reglas."""
        self._stop.set()
        self._wake.set()

    @property
    def activo(self) -> bool:
        return bool(self._thread and self._thread.is_alive() and not self._stop.is_set())

    def download_now(self) -> bool:
        """Descarga las reglas inmediatamente (peticion de red: usar desde un hilo
        de trabajo). Retorna True si fue exitoso."""
        return self._download_rules(force=True)

    def _loop(self, stop_event: threading.Event):
        """Loop principal que verifica y descarga reglas periodicamente."""
        while not stop_event.is_set():
            wait = self.CHECK_INTERVAL_SECONDS
            try:
                if self._should_update():
                    if self._download_rules():
                        self._failures = 0
                    else:
                        self._failures += 1
                        wait = backoff_delay(
                            self._failures, self.RETRY_BASE_SECONDS, self.RETRY_MAX_SECONDS
                        )
            except Exception as exc:
                log.exception("Error descargando reglas")
                self._notify(f"Error descargando reglas: {exc}")
            if self._wake.wait(wait):
                self._wake.clear()

    def _should_update(self) -> bool:
        """Verifica si es necesario actualizar las reglas."""
        if not self.last_update:
            return True
        elapsed = datetime.now(timezone.utc) - self.last_update
        return elapsed > timedelta(minutes=self.CACHE_VALIDITY_MINUTES) or elapsed < timedelta(0)

    def _download_rules(self, force: bool = False) -> bool:
        """Descarga las reglas desde el backend."""
        with self._download_lock:
            try:
                headers = {"X-Device-Token": self.device_token}
                if self.etag and not force:
                    headers["If-None-Match"] = self.etag
                response = requests.get(
                    f"{self.base_url}/api/agent/rules",
                    headers=headers,
                    timeout=self.timeout,
                )
                if response.status_code == 304:
                    self.last_update = datetime.now(timezone.utc)
                    self._save_cache()
                    return True
                if response.status_code >= 400:
                    raise RuntimeError(f"HTTP {response.status_code}: {response.text[:300]}")

                payload = response.json()
                if not payload.get("ok"):
                    raise RuntimeError(f"Respuesta invalida: {payload}")

                self.rules = payload.get("rules", []) or []
                capture_policy.set_rules(self.rules)
                self.etag = str(response.headers.get("ETag") or "")
                stamps = [str(rule.get("updated_at")) for rule in self.rules if rule.get("updated_at")]
                self.rules_updated_at = max(stamps) if stamps else None
                self.last_update = datetime.now(timezone.utc)
                self._save_cache()
                self._notify(f"Reglas descargadas: {len(self.rules)} reglas")
                return True
            except Exception as exc:
                log.warning("Error al descargar reglas: %s", exc)
                self._notify(f"Error al descargar reglas: {exc}")
                return False

    def get_rules_info(self) -> dict:
        """Retorna informacion sobre las reglas cargadas."""
        return {
            "count": len(self.rules),
            "last_update": self.last_update.astimezone().isoformat() if self.last_update else None,
            "cache_path": self.cache_path,
            "need_update": self._should_update(),
            "rules_updated_at": self.rules_updated_at,
        }

    def _notify(self, msg: str):
        if self.on_event:
            try:
                self.on_event(msg)
            except Exception:
                log.exception("Callback de reglas fallo")

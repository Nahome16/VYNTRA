"""
rules_downloader.py - Descarga y gestiona reglas de productividad desde el backend.
"""

import json
import os
import threading
import time
from datetime import datetime, timedelta

import requests


class RulesDownloader:
    """
    Descarga las reglas de productividad aplicables al dispositivo desde el backend.
    Las guarda localmente para uso offline y las actualiza periodicamente.
    """

    CACHE_FILENAME = "rules_cache.json"
    CACHE_VALIDITY_HOURS = 24  # Revalidar cada 24 horas

    def __init__(self, cfg, on_event=None):
        self.cfg = cfg
        self.on_event = on_event
        self.enabled = bool(getattr(cfg, "evidence_backend_enabled", False))
        self.base_url = getattr(cfg, "evidence_backend_url", "").rstrip("/")
        self.device_token = getattr(cfg, "evidence_device_token", "")
        self.timeout = int(getattr(cfg, "evidence_request_timeout", 30))
        self._running = False
        self._thread = None
        self.cache_path = os.path.join(os.path.dirname(__file__), self.CACHE_FILENAME)
        self.rules = []
        self.last_update = None
        self._load_cache()

    def _load_cache(self):
        """Carga las reglas desde el archivo local."""
        if not os.path.exists(self.cache_path):
            return
        try:
            with open(self.cache_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.rules = data.get("rules", [])
            last_update_str = data.get("last_update")
            if last_update_str:
                self.last_update = datetime.fromisoformat(last_update_str)
            self._notify(f"Reglas cargadas desde cache: {len(self.rules)} reglas")
        except Exception as exc:
            self._notify(f"Error al cargar cache de reglas: {exc}")

    def _save_cache(self):
        """Guarda las reglas en el archivo local."""
        try:
            data = {
                "last_update": datetime.utcnow().isoformat(),
                "rules": self.rules,
            }
            with open(self.cache_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            self._notify(f"Reglas guardadas en cache: {len(self.rules)} reglas")
        except Exception as exc:
            self._notify(f"Error al guardar cache de reglas: {exc}")

    def start(self):
        """Inicia el descargador de reglas en segundo plano."""
        if not self.enabled or not self.base_url or not self.device_token:
            self._notify("Descargador de reglas no configurado.")
            return
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        self._notify("Descargador de reglas iniciado.")

    def stop(self):
        """Detiene el descargador de reglas."""
        self._running = False

    def download_now(self) -> bool:
        """Descarga las reglas inmediatamente. Retorna True si fue exitoso."""
        return self._download_rules()

    def _loop(self):
        """Loop principal que verifica y descarga reglas periodicamente."""
        while self._running:
            try:
                # Descargar cada 24 horas o si el cache es invalido
                if self._should_update():
                    self._download_rules()
            except Exception as exc:
                self._notify(f"Error descargando reglas: {exc}")

            # Verificar cada hora
            for _ in range(3600):
                if not self._running:
                    return
                time.sleep(1)

    def _should_update(self) -> bool:
        """Verifica si es necesario actualizar las reglas."""
        if not self.last_update:
            return True
        elapsed = datetime.utcnow() - self.last_update
        return elapsed > timedelta(hours=self.CACHE_VALIDITY_HOURS)

    def _download_rules(self) -> bool:
        """Descarga las reglas desde el backend."""
        try:
            response = requests.get(
                f"{self.base_url}/api/agent/rules",
                headers={"X-Device-Token": self.device_token},
                timeout=self.timeout,
            )
            if response.status_code >= 400:
                raise RuntimeError(f"HTTP {response.status_code}: {response.text[:300]}")
            
            payload = response.json()
            if not payload.get("ok"):
                raise RuntimeError(f"Respuesta invalida: {payload}")
            
            self.rules = payload.get("rules", [])
            self.last_update = datetime.utcnow()
            self._save_cache()
            self._notify(f"Reglas descargadas: {len(self.rules)} reglas")
            return True
        except Exception as exc:
            self._notify(f"Error al descargar reglas: {exc}")
            return False

    def classify_activity(self, executable_name: str, window_title: str) -> str:
        """
        Clasifica una actividad usando las reglas locales.
        Retorna: 'productive', 'neutral', 'non_productive', o 'uncategorized'
        """
        executable_lower = (executable_name or "").lower()
        title_lower = (window_title or "").lower()

        # Buscar una regla coincidente (en orden de prioridad)
        for rule in self.rules:
            if rule.get("executable_name"):
                if executable_lower != rule.get("executable_name", "").lower():
                    continue
            if rule.get("title_contains"):
                if rule.get("title_contains", "").lower() not in title_lower:
                    continue
            # Si llegamos aqui, la regla coincide
            return rule.get("classification", "uncategorized")

        return "uncategorized"

    def get_rules_info(self) -> dict:
        """Retorna informacion sobre las reglas cargadas."""
        return {
            "count": len(self.rules),
            "last_update": self.last_update.isoformat() if self.last_update else None,
            "cache_path": self.cache_path,
            "need_update": self._should_update(),
        }

    def _notify(self, msg: str):
        if self.on_event:
            try:
                self.on_event(msg)
            except Exception:
                pass

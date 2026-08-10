"""
agent_event_uploader.py - Sincroniza eventos locales del agente con el backend.
"""

import threading
import time

import requests

from outbox import mark_uploaded, read_pending


class AgentEventUploader:
    def __init__(self, cfg, on_event=None):
        self.cfg = cfg
        self.on_event = on_event
        self.enabled = bool(getattr(cfg, "evidence_backend_enabled", False))
        self.base_url = getattr(cfg, "evidence_backend_url", "").rstrip("/")
        self.device_token = getattr(cfg, "evidence_device_token", "")
        self.timeout = int(getattr(cfg, "evidence_request_timeout", 30))
        self._running = False
        self._thread = None

    def start(self):
        if not self.enabled or not self.base_url or not self.device_token:
            return
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        self._notify("Sincronizacion de eventos iniciada.")

    def stop(self):
        self._running = False

    def process_pending(self, limit: int = 50):
        if not self.enabled or not self.base_url or not self.device_token:
            return
        events = read_pending(limit=limit)
        if not events:
            return

        response = requests.post(
            f"{self.base_url}/api/agent/events",
            headers={"X-Device-Token": self.device_token},
            json={"events": events},
            timeout=self.timeout,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"HTTP {response.status_code}: {response.text[:300]}")
        payload = response.json()
        accepted_ids = {
            item.get("id")
            for item in payload.get("accepted", [])
            if item.get("id")
        }
        mark_uploaded(accepted_ids)
        if accepted_ids:
            self._notify(f"Eventos sincronizados: {len(accepted_ids)}")
        rejected = payload.get("rejected") or []
        if rejected:
            self._notify(f"Eventos rechazados: {len(rejected)}")

    def _loop(self):
        while self._running:
            try:
                self.process_pending()
            except Exception as exc:
                self._notify(f"Eventos pendientes: {exc}")
            for _ in range(15):
                if not self._running:
                    return
                time.sleep(1)

    def _notify(self, msg):
        if self.on_event:
            try:
                self.on_event(msg)
            except Exception:
                pass

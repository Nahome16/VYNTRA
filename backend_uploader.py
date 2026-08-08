"""
backend_uploader.py - Subida de evidencias al backend propio VYNTRA.
"""

import os

import requests

from evidence_queue import EvidenceQueue


class BackendEvidenceUploader:
    def __init__(self, cfg, on_event=None):
        self.cfg = cfg
        self.on_event = on_event
        self.enabled = bool(getattr(cfg, "evidence_backend_enabled", False))
        self.base_url = getattr(cfg, "evidence_backend_url", "").rstrip("/")
        self.device_token = getattr(cfg, "evidence_device_token", "")
        self.timeout = int(getattr(cfg, "evidence_request_timeout", 30))
        self.retry_limit = int(getattr(cfg, "evidence_retry_limit", 50))
        queue_db = getattr(cfg, "evidence_queue_db", "") or None
        self.queue = EvidenceQueue(queue_db)

    def enqueue_capture(self, filepath: str, metadata: dict) -> dict | None:
        if not self.enabled:
            return None
        record = self.queue.enqueue(
            filepath=filepath,
            employee=metadata.get("empleado", ""),
            equipment=metadata.get("equipo", ""),
            captured_at=metadata.get("fechaHora", ""),
            agent_version=metadata.get("agent_version", "unknown"),
            monitor_count=metadata.get("monitores", 1),
            metadata=metadata,
        )
        self.process_pending(limit=3)
        return record

    def process_pending(self, limit: int = 5):
        if not self.enabled:
            return
        if not self.base_url or not self.device_token:
            self._notify("Backend de evidencias no configurado.")
            return
        for record in self.queue.pending(limit=limit, retry_limit=self.retry_limit):
            try:
                self._upload_record(record)
                self.queue.mark_uploaded(record["id"])
                self._notify(f"Evidencia subida: {os.path.basename(record['filepath'])}")
            except Exception as exc:
                self.queue.mark_failed(record["id"], str(exc))
                self._notify(f"Evidencia pendiente: {exc}")

    def _upload_record(self, record: dict):
        filepath = record["filepath"]
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"Archivo local no encontrado: {filepath}")

        endpoint = f"{self.base_url}/api/evidence/upload"
        data = {
            "employee": record["employee"],
            "equipment": record["equipment"],
            "captured_at": record["captured_at"],
            "sha256": record["sha256"],
            "file_size": str(record["file_size"]),
            "agent_version": record["agent_version"],
            "monitor_count": str(record["monitor_count"]),
        }
        headers = {"X-Device-Token": self.device_token}
        with open(filepath, "rb") as f:
            files = {"file": (os.path.basename(filepath), f, "image/webp")}
            response = requests.post(
                endpoint,
                headers=headers,
                data=data,
                files=files,
                timeout=self.timeout,
            )
        if response.status_code >= 400:
            raise RuntimeError(f"HTTP {response.status_code}: {response.text[:300]}")
        payload = response.json()
        if not payload.get("ok"):
            raise RuntimeError(f"Respuesta invalida del backend: {payload}")
        return payload

    def _notify(self, msg: str):
        if self.on_event:
            try:
                self.on_event(msg)
            except Exception:
                pass

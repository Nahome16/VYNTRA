"""
backend_uploader.py - Subida de evidencias al backend propio VYNTRA.

Las capturas se encolan en SQLite (evidence_queue.py) y un hilo dedicado las
sube en segundo plano, tambien las que quedaron pendientes de sesiones
anteriores. Politica de reintentos:

- Errores de red, 5xx, 429 y 401/403: no cuentan para RetryLimit; se reintenta
  con espera exponencial con jitter.
- Otros 4xx o respuestas invalidas: cuentan para RetryLimit.
- Archivo local inexistente: se marca como `missing` y no se reintenta.

Tras una subida exitosa el archivo local se elimina (DeleteAfterUpload=true
por defecto) para no acumular capturas en el equipo.
"""

import os
import threading

import requests

from agent_runtime import backoff_delay, get_logger
from evidence_queue import EvidenceQueue

log = get_logger("evidence")

BASE_INTERVAL_SECONDS = 30
MAX_BACKOFF_SECONDS = 900
BATCH_LIMIT = 5


class TransientUploadError(RuntimeError):
    """Error de red o del servidor que no debe consumir el limite de reintentos."""


class BackendEvidenceUploader:
    def __init__(self, cfg, on_event=None):
        self.cfg = cfg
        self.on_event = on_event
        self.enabled = bool(getattr(cfg, "evidence_backend_enabled", False))
        self.base_url = getattr(cfg, "evidence_backend_url", "").rstrip("/")
        self.device_token = getattr(cfg, "evidence_device_token", "")
        self.timeout = int(getattr(cfg, "evidence_request_timeout", 30))
        self.retry_limit = int(getattr(cfg, "evidence_retry_limit", 50))
        self.delete_after_upload = bool(getattr(cfg, "evidence_delete_after_upload", True))
        queue_db = getattr(cfg, "evidence_queue_db", "") or None
        self.queue = EvidenceQueue(queue_db)
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread = None
        self._failures = 0
        self._process_lock = threading.Lock()

    # ---- ciclo de vida -------------------------------------------------
    def start(self):
        if not self.enabled:
            return
        if self._thread and self._thread.is_alive() and not self._stop.is_set():
            return
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._loop, args=(self._stop,), name="vyntra-evidence", daemon=True
        )
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._wake.set()

    @property
    def activo(self) -> bool:
        return bool(self._thread and self._thread.is_alive() and not self._stop.is_set())

    def _loop(self, stop_event: threading.Event):
        cycles = 0
        while not stop_event.is_set():
            try:
                self.process_pending(limit=BATCH_LIMIT)
            except Exception:
                log.exception("Error inesperado subiendo evidencias")
            cycles += 1
            if cycles % 120 == 1:
                try:
                    self.queue.prune_uploaded(days=30)
                except Exception:
                    log.exception("No se pudo depurar la cola de evidencias")
            delay = (
                backoff_delay(self._failures, BASE_INTERVAL_SECONDS, MAX_BACKOFF_SECONDS)
                if self._failures
                else BASE_INTERVAL_SECONDS
            )
            self._wake.wait(delay)
            self._wake.clear()

    # ---- API -----------------------------------------------------------
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
        # El hilo dedicado sube la evidencia; si no esta corriendo se inicia.
        self.start()
        self._wake.set()
        return record

    def process_pending(self, limit: int = BATCH_LIMIT) -> int:
        if not self.enabled:
            return 0
        self.device_token = getattr(self.cfg, "evidence_device_token", "") or self.device_token
        if not self.base_url or not self.device_token:
            self._notify("Backend de evidencias no configurado.")
            return 0
        uploaded = 0
        with self._process_lock:
            for record in self.queue.pending(limit=limit, retry_limit=self.retry_limit):
                try:
                    self._upload_record(record)
                except FileNotFoundError as exc:
                    self.queue.mark_missing(record["id"], str(exc))
                    log.warning("Evidencia sin archivo local: %s", exc)
                    continue
                except TransientUploadError as exc:
                    # Red/servidor: no consume el limite de reintentos.
                    self.queue.mark_failed(record["id"], str(exc), count_attempt=False)
                    self._failures += 1
                    log.info("Evidencia pendiente (intento %s): %s", self._failures, exc)
                    self._notify(f"Evidencia pendiente: {exc}")
                    break
                except Exception as exc:
                    self.queue.mark_failed(record["id"], str(exc), count_attempt=True)
                    log.warning("Evidencia rechazada/fallida %s: %s", record["id"], exc)
                    self._notify(f"Evidencia pendiente: {exc}")
                    continue
                self._failures = 0
                self.queue.mark_uploaded(record["id"])
                uploaded += 1
                self._delete_local(record["filepath"])
                self._notify(f"Evidencia subida: {os.path.basename(record['filepath'])}")
        return uploaded

    def _delete_local(self, filepath: str):
        if not self.delete_after_upload:
            return
        try:
            if filepath and os.path.isfile(filepath) and filepath.lower().endswith(".webp"):
                os.remove(filepath)
        except OSError as exc:
            log.warning("No se pudo eliminar la captura local %s: %s", filepath, exc)

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
        try:
            with open(filepath, "rb") as f:
                files = {"file": (os.path.basename(filepath), f, "image/webp")}
                response = requests.post(
                    endpoint,
                    headers=headers,
                    data=data,
                    files=files,
                    timeout=self.timeout,
                )
        except requests.RequestException as exc:
            raise TransientUploadError(f"Sin conexion: {exc}") from exc
        status = response.status_code
        if status >= 500 or status in (401, 403, 408, 429):
            raise TransientUploadError(f"HTTP {status}: {response.text[:300]}")
        if status >= 400:
            raise RuntimeError(f"HTTP {status}: {response.text[:300]}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise TransientUploadError("Respuesta invalida del backend") from exc
        if not payload.get("ok"):
            raise RuntimeError(f"Respuesta invalida del backend: {payload}")
        return payload

    def _notify(self, msg: str):
        if self.on_event:
            try:
                self.on_event(msg)
            except Exception:
                log.exception("Callback de evidencias fallo")

"""
agent_event_uploader.py - Sincroniza eventos locales del agente con el backend.

- Envia lotes (maximo 200 por peticion segun la API; se usan lotes de 100).
- Eventos aceptados (o duplicados) -> uploaded; rechazados -> rejected (no se
  reintentan ni bloquean la cola).
- Errores de red/servidor -> espera exponencial con jitter antes de reintentar.
"""

import threading

import requests

import outbox
from agent_runtime import backoff_delay, get_logger
from outbox import mark_rejected, mark_uploaded, read_pending

log = get_logger("events")

BATCH_SIZE = 100
MAX_BATCHES_PER_CYCLE = 20
BASE_INTERVAL_SECONDS = 15
MAX_BACKOFF_SECONDS = 600
PRUNE_INTERVAL_CYCLES = 240  # ~1 hora con intervalo base


class TransientSyncError(RuntimeError):
    """Error de red o del servidor: se reintenta con espera exponencial."""


class AgentEventUploader:
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
        self._failures = 0
        self._send_lock = threading.Lock()

    # ---- ciclo de vida -------------------------------------------------
    def start(self):
        if not self._configured():
            return
        if self._thread and self._thread.is_alive() and not self._stop.is_set():
            return
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._loop, args=(self._stop,), name="vyntra-events", daemon=True
        )
        self._thread.start()
        self._notify("Sincronizacion de eventos iniciada.")

    def stop(self, timeout: float = 0):
        self._stop.set()
        self._wake.set()
        thread = self._thread
        if timeout and thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout)

    def wake(self):
        self._wake.set()

    @property
    def activo(self) -> bool:
        return bool(self._thread and self._thread.is_alive() and not self._stop.is_set())

    def is_expected_running(self) -> bool:
        return self._configured()

    def _configured(self) -> bool:
        # Se relee el token por si el enrolamiento lo guardo despues de crear el objeto.
        self.device_token = getattr(self.cfg, "evidence_device_token", "") or self.device_token
        self.enabled = bool(getattr(self.cfg, "evidence_backend_enabled", False))
        return bool(self.enabled and self.base_url and self.device_token)

    # ---- envio ---------------------------------------------------------
    def process_pending(self, limit: int = BATCH_SIZE) -> int:
        """Envia hasta `limit` eventos por lote. Lanza TransientSyncError si hay
        un problema de red/servidor (los eventos siguen pendientes)."""
        if not self._configured():
            return 0
        with self._send_lock:
            sent = 0
            batch_size = max(1, min(int(limit or BATCH_SIZE), 200))
            for _ in range(MAX_BATCHES_PER_CYCLE):
                events = read_pending(limit=batch_size)
                if not events:
                    break
                sent += self._send_batch(events)
                if len(events) < batch_size:
                    break
            return sent

    def _send_batch(self, events: list[dict]) -> int:
        try:
            response = requests.post(
                f"{self.base_url}/api/agent/events",
                headers={"X-Device-Token": self.device_token},
                json={"events": events},
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise TransientSyncError(f"Sin conexion: {exc}") from exc

        status = response.status_code
        if status in (400, 413, 422):
            # Un evento mal formado (o demasiado grande) puede invalidar el lote:
            # se aisla enviandolos de uno en uno; el que falle solo se rechaza.
            if len(events) > 1:
                sent = 0
                for event in events:
                    sent += self._send_batch([event])
                return sent
            error = f"HTTP {status}: {response.text[:300]}"
            mark_rejected({events[0]["id"]: error})
            log.warning("Evento %s (%s) rechazado: %s", events[0]["id"], events[0].get("tipo"), error)
            self._notify("Eventos rechazados: 1")
            return 0
        if status >= 400:
            raise TransientSyncError(f"HTTP {status}: {response.text[:300]}")

        try:
            payload = response.json()
        except ValueError as exc:
            raise TransientSyncError("Respuesta invalida del servidor") from exc
        if not isinstance(payload, dict):
            raise TransientSyncError("Respuesta invalida del servidor")

        accepted_ids = {
            str(item.get("id"))
            for item in payload.get("accepted", []) or []
            if isinstance(item, dict) and item.get("id")
        }
        rejected = {
            str(item.get("id")): str(item.get("error") or "rechazado")
            for item in payload.get("rejected", []) or []
            if isinstance(item, dict) and item.get("id")
        }
        mark_uploaded(accepted_ids)
        if rejected:
            mark_rejected(rejected)
            log.warning("Eventos rechazados por el servidor: %s", rejected)
            self._notify(f"Eventos rechazados: {len(rejected)}")
        if accepted_ids:
            self._notify(f"Eventos sincronizados: {len(accepted_ids)}")
        if not accepted_ids and not rejected:
            # El servidor no confirmo ningun evento del lote: evitar un bucle caliente.
            raise TransientSyncError("El servidor no confirmo los eventos enviados")
        return len(accepted_ids)

    def _loop(self, stop_event: threading.Event):
        cycles = 0
        while not stop_event.is_set():
            try:
                self.process_pending()
                self._failures = 0
            except TransientSyncError as exc:
                self._failures += 1
                log.info("Eventos pendientes (intento %s): %s", self._failures, exc)
                self._notify(f"Eventos pendientes: {exc}")
            except Exception:
                self._failures += 1
                log.exception("Error inesperado sincronizando eventos")
            cycles += 1
            if cycles % PRUNE_INTERVAL_CYCLES == 1:
                try:
                    outbox.prune()
                except Exception:
                    log.exception("No se pudo depurar el outbox")
            delay = (
                backoff_delay(self._failures, BASE_INTERVAL_SECONDS, MAX_BACKOFF_SECONDS)
                if self._failures
                else BASE_INTERVAL_SECONDS
            )
            self._wake.wait(delay)
            self._wake.clear()

    def _notify(self, msg):
        if self.on_event:
            try:
                self.on_event(msg)
            except Exception:
                log.exception("Callback de eventos fallo")

"""
activity_tracker.py - Telemetria del agente VYNTRA.

El agente no clasifica aplicaciones; la plataforma web/backend aplica las reglas
de productividad configuradas por administracion. Antes de guardar cualquier
muestra, el titulo de la ventana se sustituye por un identificador normalizado
conforme a la lista de aplicaciones permitidas (ver capture_policy.py).

El tiempo se mide con deltas de reloj monotono (sin deriva por sleep) y cada
evento enviado al servidor lleva solo las muestras nuevas desde el envio
anterior (envio incremental); en memoria se conserva una ventana acotada para
la interfaz.
"""

import getpass
import socket
import threading
import time

import capture_policy
from agent_runtime import get_logger, local_now, now_iso, parse_iso

log = get_logger("tracker")


def get_idle_seconds() -> float:
    try:
        import ctypes
        from ctypes import wintypes

        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]

        info = LASTINPUTINFO()
        info.cbSize = ctypes.sizeof(info)
        if ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
            tick = ctypes.windll.kernel32.GetTickCount()
            return max(0.0, (tick - info.dwTime) / 1000.0)
    except Exception:
        pass
    return 0.0


def get_foreground_window() -> tuple[int, str, str]:
    """Devuelve (hwnd, titulo_literal, proceso). El titulo no debe persistirse."""
    try:
        import psutil
        import win32gui
        import win32process

        hwnd = win32gui.GetForegroundWindow()
        titulo = win32gui.GetWindowText(hwnd) or "(sin titulo)"
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        proceso = psutil.Process(pid).name()
        return hwnd, titulo, proceso
    except Exception:
        return 0, "(desconocido)", "(desconocido)"


def get_active_window() -> tuple[str, str]:
    _, titulo, proceso = get_foreground_window()
    return titulo, proceso


class ClickCounter:
    def __init__(self):
        self.count = 0
        self._listener = None
        self._lock = threading.Lock()

    def start(self):
        with self._lock:
            if self._listener is not None:
                return
            try:
                from pynput import mouse

                def on_click(x, y, button, pressed):
                    if pressed:
                        self.count += 1

                listener = mouse.Listener(on_click=on_click)
                listener.daemon = True
                listener.start()
                self._listener = listener
            except Exception:
                log.warning("No se pudo iniciar el contador de clics", exc_info=True)
                self._listener = None

    def stop(self):
        with self._lock:
            listener, self._listener = self._listener, None
        if listener:
            try:
                listener.stop()
            except Exception:
                log.warning("No se pudo detener el contador de clics", exc_info=True)


class ActivityTracker:
    TICK = 3
    MAX_MUESTRAS = 120  # ventana en memoria para la interfaz
    MAX_PENDIENTES = 1200  # muestras aun no enviadas (~1 h); se descartan las mas antiguas
    GAP_SECONDS = 120  # suspension / congelamiento: no se cuenta como tiempo

    def __init__(self, cfg, on_update=None, clock=None):
        self.cfg = cfg
        self.on_update = on_update
        self.idle_umbral = getattr(cfg, "idle_umbral_segundos", 60)
        self._monotonic = clock or time.monotonic

        self._stop = threading.Event()
        self._stop.set()
        self._thread = None
        self._lock = threading.Lock()
        self._clicks = ClickCounter()
        self.pausado = False

        self.inicio = None
        self.seg_activo = 0
        self.seg_idle = 0
        self.por_recurso = {}
        self.muestras = []
        self._pendientes = []
        self.cambios_ventana = 0
        self.recurso_actual = "(inactivo)"
        self._ultima_ventana = None
        self._last_mono = None
        self._carry = 0.0

    def start(self):
        with self._lock:
            if not self._stop.is_set() and self._thread and self._thread.is_alive():
                return
            # Evento de parada propio por hilo: si un hilo anterior aun no salio,
            # ya no puede contar tiempo (evita doble conteo al detener/iniciar rapido).
            self._stop.set()
            self._stop = threading.Event()
            if self.inicio is None:
                self.inicio = local_now()
            self._last_mono = self._monotonic()
            self._carry = 0.0
            self._thread = threading.Thread(
                target=self._loop, args=(self._stop,), name="vyntra-tracker", daemon=True
            )
            self._thread.start()
        self._clicks.start()

    def stop(self, join_timeout: float = 0):
        with self._lock:
            self._stop.set()
            thread = self._thread
        self._clicks.stop()
        if join_timeout and thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(join_timeout)

    def reset(self):
        with self._lock:
            self.seg_activo = 0
            self.seg_idle = 0
            self.por_recurso = {}
            self.muestras = []
            self._pendientes = []
            self.cambios_ventana = 0
            self._carry = 0.0
            self._clicks.count = 0
            self.inicio = local_now()

    def restore(self, telemetria: dict | None):
        """Restaura contadores acumulados de una jornada recuperada."""
        if not isinstance(telemetria, dict):
            return
        with self._lock:
            try:
                self.seg_activo = int(telemetria.get("seg_activo") or 0)
                self.seg_idle = int(telemetria.get("seg_idle") or 0)
                self.cambios_ventana = int(telemetria.get("cambios_ventana") or 0)
                self._clicks.count = int(telemetria.get("clics") or 0)
                por_recurso = telemetria.get("tiempo_por_recurso") or {}
                if isinstance(por_recurso, dict):
                    self.por_recurso = {
                        str(key): int(value or 0) for key, value in por_recurso.items()
                    }
                inicio = parse_iso(telemetria.get("inicio"))
                if inicio:
                    self.inicio = inicio
            except (TypeError, ValueError):
                log.warning("Telemetria persistida invalida; se ignora", exc_info=True)

    @property
    def activo(self) -> bool:
        return not self._stop.is_set()

    @property
    def hilo_vivo(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def _loop(self, stop_event: threading.Event):
        while not stop_event.is_set():
            try:
                self._tick(stop_event)
            except Exception:
                log.exception("Error en el ciclo de telemetria")
            if stop_event.wait(self.TICK):
                return

    def _elapsed(self) -> int:
        """Segundos transcurridos desde la ultima muestra (reloj monotono).

        Un salto mayor a GAP_SECONDS (suspension, hibernacion, app congelada)
        no se cuenta como tiempo activo ni inactivo.
        """
        now = self._monotonic()
        last = self._last_mono if self._last_mono is not None else now
        self._last_mono = now
        delta = now - last
        if delta <= 0 or delta > self.GAP_SECONDS:
            self._carry = 0.0
            return 0
        total = delta + self._carry
        whole = int(total)
        self._carry = total - whole
        return whole

    def _tick(self, stop_event: threading.Event | None = None):
        if self.pausado:
            with self._lock:
                self._last_mono = self._monotonic()
                self._carry = 0.0
            return

        now = local_now()
        idle = get_idle_seconds()
        titulo_literal, proceso_literal = get_active_window()
        proceso = capture_policy.normalize_process_name(proceso_literal)
        titulo, en_lista = capture_policy.normalize_title(proceso_literal, titulo_literal)
        recurso_key = f"{proceso} | {titulo}"
        is_idle = idle >= self.idle_umbral

        with self._lock:
            if stop_event is not None and stop_event.is_set():
                return
            segundos = self._elapsed()
            if segundos <= 0:
                return
            if is_idle:
                self.seg_idle += segundos
                self.recurso_actual = "(inactivo)"
            else:
                self.seg_activo += segundos
                self.por_recurso[recurso_key] = self.por_recurso.get(recurso_key, 0) + segundos
                self.recurso_actual = recurso_key
                # La comparacion usa el titulo literal solo en memoria; nunca se guarda.
                if self._ultima_ventana and titulo_literal != self._ultima_ventana:
                    self.cambios_ventana += 1
                self._ultima_ventana = titulo_literal

            muestra = {
                "timestamp": now.isoformat(),
                "proceso": proceso,
                "titulo": titulo,
                "en_lista": en_lista,
                "idle_segundos": round(idle, 2),
                "is_idle": is_idle,
                "duracion_muestra_segundos": segundos,
            }
            self.muestras.append(muestra)
            if len(self.muestras) > self.MAX_MUESTRAS:
                del self.muestras[: len(self.muestras) - self.MAX_MUESTRAS]
            self._pendientes.append(muestra)
            if len(self._pendientes) > self.MAX_PENDIENTES:
                descartadas = len(self._pendientes) - self.MAX_PENDIENTES
                del self._pendientes[:descartadas]
                log.warning("Muestras de actividad sin enviar descartadas: %s", descartadas)

        if self.on_update:
            try:
                self.on_update(self.snapshot())
            except Exception:
                log.exception("Callback de telemetria fallo")

    def tomar_muestras_pendientes(self) -> list[dict]:
        """Entrega (y vacia) las muestras aun no enviadas (envio incremental)."""
        with self._lock:
            pendientes, self._pendientes = self._pendientes, []
        return pendientes

    def snapshot(self, muestras: list[dict] | None = None) -> dict:
        """Resumen de telemetria.

        Por defecto `muestras_recientes` es la ventana acotada en memoria (para la
        interfaz). Los eventos enviados al servidor pasan `muestras` con solo las
        muestras nuevas desde el ultimo envio.
        """
        with self._lock:
            top = sorted(
                self.por_recurso.items(), key=lambda kv: kv[1], reverse=True
            )[:20]
            return {
                "empleado": getpass.getuser(),
                "equipo": socket.gethostname(),
                "inicio": self.inicio.isoformat() if self.inicio else None,
                "seg_activo": self.seg_activo,
                "seg_idle": self.seg_idle,
                "clics": self._clicks.count,
                "cambios_ventana": self.cambios_ventana,
                "recurso_actual": self.recurso_actual,
                "tiempo_por_recurso": dict(top),
                "muestras_recientes": list(self.muestras if muestras is None else muestras),
                "timestamp": now_iso(),
            }

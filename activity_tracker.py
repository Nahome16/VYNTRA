"""
activity_tracker.py - Telemetria cruda del agente VYNTRA.

El agente no clasifica aplicaciones. Solo captura datos brutos. La plataforma
web/backend aplicara reglas de productividad configuradas por administracion.
"""

import datetime
import getpass
import socket
import threading
import time


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


def get_active_window() -> tuple[str, str]:
    try:
        import psutil
        import win32gui
        import win32process

        hwnd = win32gui.GetForegroundWindow()
        titulo = win32gui.GetWindowText(hwnd) or "(sin titulo)"
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        proceso = psutil.Process(pid).name()
        return titulo, proceso
    except Exception:
        return "(desconocido)", "(desconocido)"


class ClickCounter:
    def __init__(self):
        self.count = 0
        self._listener = None

    def start(self):
        try:
            from pynput import mouse

            def on_click(x, y, button, pressed):
                if pressed:
                    self.count += 1

            self._listener = mouse.Listener(on_click=on_click)
            self._listener.daemon = True
            self._listener.start()
        except Exception:
            self._listener = None

    def stop(self):
        if self._listener:
            try:
                self._listener.stop()
            except Exception:
                pass
            self._listener = None


class ActivityTracker:
    TICK = 3
    MAX_MUESTRAS = 120

    def __init__(self, cfg, on_update=None):
        self.cfg = cfg
        self.on_update = on_update
        self.idle_umbral = getattr(cfg, "idle_umbral_segundos", 60)

        self._running = False
        self._thread = None
        self._lock = threading.Lock()
        self._clicks = ClickCounter()
        self.pausado = False

        self.inicio = None
        self.seg_activo = 0
        self.seg_idle = 0
        self.por_recurso = {}
        self.muestras = []
        self.cambios_ventana = 0
        self.recurso_actual = "(inactivo)"
        self._ultima_ventana = None

    def start(self):
        if self._running:
            return
        self._running = True
        if self.inicio is None:
            self.inicio = datetime.datetime.now()
        self._clicks.start()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False
        self._clicks.stop()

    def reset(self):
        with self._lock:
            self.seg_activo = 0
            self.seg_idle = 0
            self.por_recurso = {}
            self.muestras = []
            self.cambios_ventana = 0
            self._clicks.count = 0

    @property
    def activo(self) -> bool:
        return self._running

    def _loop(self):
        while self._running:
            self._tick()
            for _ in range(self.TICK):
                if not self._running:
                    return
                time.sleep(1)

    def _tick(self):
        if self.pausado:
            return

        now = datetime.datetime.now()
        idle = get_idle_seconds()
        titulo, proceso = get_active_window()
        recurso_key = f"{proceso} | {titulo[:120]}"
        is_idle = idle >= self.idle_umbral

        with self._lock:
            if is_idle:
                self.seg_idle += self.TICK
                self.recurso_actual = "(inactivo)"
            else:
                self.seg_activo += self.TICK
                self.por_recurso[recurso_key] = (
                    self.por_recurso.get(recurso_key, 0) + self.TICK
                )
                self.recurso_actual = recurso_key
                if self._ultima_ventana and titulo != self._ultima_ventana:
                    self.cambios_ventana += 1
                self._ultima_ventana = titulo

            self.muestras.append(
                {
                    "timestamp": now.isoformat(),
                    "proceso": proceso,
                    "titulo": titulo,
                    "idle_segundos": round(idle, 2),
                    "is_idle": is_idle,
                    "duracion_muestra_segundos": self.TICK,
                }
            )
            self.muestras = self.muestras[-self.MAX_MUESTRAS:]

        if self.on_update:
            try:
                self.on_update(self.snapshot())
            except Exception:
                pass

    def snapshot(self) -> dict:
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
                "muestras_recientes": list(self.muestras),
                "timestamp": datetime.datetime.now().isoformat(),
            }

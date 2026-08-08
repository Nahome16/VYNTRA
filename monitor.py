"""
monitor.py - Motor simple de monitoreo heredado para VYNTRA.

La estacion principal usa screenshots.py y activity_tracker.py. Este modulo se
mantiene como apoyo para pruebas o integraciones pequeñas: captura pantalla,
lee la ventana activa y registra datos crudos en la cola local.
"""

import datetime
import getpass
import os
import socket
import threading
import time

import mss
from PIL import Image

from outbox import append_event


def get_active_window() -> tuple[str, str]:
    """Devuelve (titulo_ventana, nombre_proceso) de la app en primer plano."""
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


class MonitorEngine:
    """
    Captura pantalla y ventana activa cada N segundos.

    El agente no clasifica el recurso abierto. Solo deja un evento crudo para
    que el backend lo procese despues con reglas configuradas desde la web.
    """

    def __init__(self, config, on_event=None):
        self.config = config
        self.on_event = on_event
        self._running = False
        self._thread = None
        self.ultima_captura = None

    @property
    def activo(self) -> bool:
        return self._running

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        self._notify("Monitoreo iniciado.")

    def stop(self):
        self._running = False
        self._notify("Monitoreo detenido.")

    def _loop(self):
        while self._running:
            try:
                self._capturar_una_vez()
            except Exception as exc:
                self._notify(f"Error al capturar: {exc}")

            for _ in range(max(1, int(self.config.intervalo_segundos))):
                if not self._running:
                    return
                time.sleep(1)

    def _capturar_una_vez(self):
        ts = datetime.datetime.now()
        ruta = self._tomar_screenshot(ts)
        titulo, proceso = get_active_window()

        payload = {
            "empleado": getpass.getuser(),
            "equipo": socket.gethostname(),
            "ventana": titulo,
            "proceso": proceso,
            "fechaHora": ts.isoformat(),
            "rutaCaptura": ruta,
        }

        append_event("activity_sample_created", payload)
        self.ultima_captura = ts
        self._notify(f"{ts:%H:%M:%S} - {proceso}")

    def _tomar_screenshot(self, ts: datetime.datetime) -> str:
        os.makedirs(self.config.carpeta_capturas, exist_ok=True)
        nombre = f"cap_{ts:%Y%m%d_%H%M%S}.webp"
        ruta = os.path.join(self.config.carpeta_capturas, nombre)
        with mss.mss() as sct:
            img = sct.grab(sct.monitors[0])
            imagen = Image.frombytes("RGB", img.size, img.rgb)
            imagen.save(ruta, "WEBP", quality=80, optimize=True)
        return ruta

    def _notify(self, msg: str):
        if self.on_event:
            try:
                self.on_event(msg)
            except Exception:
                pass

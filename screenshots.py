"""
screenshots.py - Evidencia visual durante jornada activa.

Politica de captura minima (RNF-03): solo se captura la ventana activa y solo
cuando pertenece a una aplicacion de la lista permitida clasificada como
productiva, es decir, una herramienta de trabajo. Nunca se captura la
pantalla completa, el escritorio, la barra de tareas ni los avisos emergentes:
la imagen se obtiene con PrintWindow, que dibuja unicamente el contenido de la
ventana, sin lo que haya encima o alrededor de ella.
"""

import datetime
import getpass
import os
import socket
import threading
import time

import capture_policy
from activity_tracker import get_foreground_window
from outbox import append_event

PW_RENDERFULLCONTENT = 0x00000002


def capture_window_image(hwnd: int):
    """Devuelve una imagen PIL con el contenido de la ventana `hwnd`."""
    import ctypes

    import win32gui
    import win32ui
    from PIL import Image

    if not hwnd or not win32gui.IsWindowVisible(hwnd) or win32gui.IsIconic(hwnd):
        raise RuntimeError("La ventana activa no esta visible")
    # Con escalado de pantalla, el tamano debe leerse en pixeles fisicos para que
    # coincida con lo que dibuja PrintWindow; de lo contrario la imagen sale recortada.
    user32 = ctypes.windll.user32
    previous_context = None
    try:
        user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
        user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        previous_context = user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        previous_context = None
    try:
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    finally:
        if previous_context:
            user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(previous_context))
    width, height = right - left, bottom - top
    if width <= 0 or height <= 0:
        raise RuntimeError("La ventana activa no tiene area visible")

    hwnd_dc = win32gui.GetWindowDC(hwnd)
    mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)
    save_dc = mfc_dc.CreateCompatibleDC()
    bitmap = win32ui.CreateBitmap()
    try:
        bitmap.CreateCompatibleBitmap(mfc_dc, width, height)
        save_dc.SelectObject(bitmap)
        if not ctypes.windll.user32.PrintWindow(hwnd, save_dc.GetSafeHdc(), PW_RENDERFULLCONTENT):
            raise RuntimeError("PrintWindow no pudo dibujar la ventana")
        info = bitmap.GetInfo()
        raw = bitmap.GetBitmapBits(True)
        image = Image.frombuffer("RGB", (info["bmWidth"], info["bmHeight"]), raw, "raw", "BGRX", 0, 1)
    finally:
        win32gui.DeleteObject(bitmap.GetHandle())
        save_dc.DeleteDC()
        mfc_dc.DeleteDC()
        win32gui.ReleaseDC(hwnd, hwnd_dc)

    if all(high == 0 for _, high in image.getextrema()):
        raise RuntimeError("La ventana activa se dibujo en negro")
    return image


def nombre_equipo() -> str:
    return socket.gethostname()


class ScreenshotEngine:
    def __init__(self, cfg, on_event=None):
        self.cfg = cfg
        self.on_event = on_event
        self.intervalo = getattr(cfg, "captura_intervalo_segundos", 300)
        self.base = getattr(cfg, "carpeta_capturas", "capturas")
        self._running = False
        self._paused = False
        self._thread = None
        self.ultima = None
        self.drive_uploader = None
        self.backend_uploader = None

    @property
    def activo(self) -> bool:
        return self._running and not self._paused

    def carpeta_dia(self) -> str:
        hoy = datetime.date.today()
        ruta = os.path.join(
            self.base,
            nombre_equipo(),
            f"{hoy.year:04d}",
            f"{hoy.month:02d}",
            f"{hoy.day:02d}",
        )
        os.makedirs(ruta, exist_ok=True)
        return ruta

    def start(self):
        if self._running:
            return
        self._running = True
        self._paused = False
        self.carpeta_dia()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        self._notify("Capturas iniciadas.")

    def pause(self):
        self._paused = True
        self._notify("Capturas pausadas.")

    def resume(self):
        self._paused = False
        self._notify("Capturas reanudadas.")

    def stop(self):
        self._running = False
        self._notify("Capturas detenidas.")

    def _loop(self):
        while self._running:
            if not self._paused:
                try:
                    self._capturar()
                except Exception as exc:
                    self._notify(f"Error de captura: {exc}")
            for _ in range(max(1, int(self.intervalo))):
                if not self._running:
                    return
                time.sleep(1)

    def _capturar(self):
        ts = datetime.datetime.now()
        hwnd, titulo_literal, proceso = get_foreground_window()
        identificador, _ = capture_policy.normalize_title(proceso, titulo_literal)
        if not capture_policy.evidence_allowed(proceso, titulo_literal):
            self._notify("Captura omitida: la aplicacion activa no es una herramienta de trabajo permitida.")
            return

        nombre = f"cap_{ts:%Y%m%d_%H%M%S}.webp"
        ruta = os.path.join(self.carpeta_dia(), nombre)
        try:
            imagen = capture_window_image(hwnd)
        except Exception as exc:
            self._notify(f"Captura omitida: {exc}")
            return
        imagen.save(ruta, "WEBP", quality=80, optimize=True)

        self.ultima = ts
        metadata = {
            "ruta": ruta,
            "fechaHora": ts.isoformat(),
            "empleado": getpass.getuser(),
            "equipo": nombre_equipo(),
            "intervalo_segundos": self.intervalo,
            "monitores": 1,
            "alcance": "ventana_activa",
            "proceso": proceso,
            "identificador": identificador,
            "agent_version": getattr(self.cfg, "agent_version", "unknown"),
        }
        append_event("screenshot_created", metadata)
        self._upload_to_drive(ruta)
        self._upload_to_backend(ruta, metadata)
        self._notify(f"Captura {ts:%H:%M:%S}")

    def _upload_to_drive(self, ruta: str):
        if not self._ensure_drive_uploader():
            return
        try:
            self.drive_uploader.upload_image_backup(ruta, self._drive_folder_parts(ruta))
        except Exception as exc:
            self._notify(f"Drive upload fallo: {exc}")

    def _drive_folder_parts(self, ruta: str) -> list[str]:
        try:
            rel_dir = os.path.dirname(os.path.relpath(ruta, self.base))
            if rel_dir in ("", "."):
                return [nombre_equipo()]
            return [
                part
                for part in rel_dir.split(os.sep)
                if part and part not in (".", "..")
            ]
        except Exception:
            ts = datetime.datetime.now()
            return [
                nombre_equipo(),
                f"{ts.year:04d}",
                f"{ts.month:02d}",
                f"{ts.day:02d}",
            ]

    def _ensure_drive_uploader(self) -> bool:
        if self.drive_uploader:
            return True
        if not getattr(self.cfg, "drive_upload_enabled", False):
            return False
        try:
            from gdrive import DriveUploader

            self.drive_uploader = DriveUploader(self.cfg, on_event=self.on_event)
            return True
        except Exception as exc:
            self._notify(f"Drive no inicializado: {exc}")
            return False

    def _upload_to_backend(self, ruta: str, metadata: dict):
        if not self._ensure_backend_uploader():
            return
        try:
            self.backend_uploader.enqueue_capture(ruta, metadata)
        except Exception as exc:
            self._notify(f"Backend evidencia pendiente: {exc}")

    def _ensure_backend_uploader(self) -> bool:
        if self.backend_uploader:
            return True
        if not getattr(self.cfg, "evidence_backend_enabled", False):
            return False
        try:
            from backend_uploader import BackendEvidenceUploader

            self.backend_uploader = BackendEvidenceUploader(self.cfg, on_event=self.on_event)
            return True
        except Exception as exc:
            self._notify(f"Backend evidencia no inicializado: {exc}")
            return False

    def _notify(self, msg):
        if self.on_event:
            try:
                self.on_event(msg)
            except Exception:
                pass

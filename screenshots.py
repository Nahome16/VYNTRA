"""
screenshots.py - Evidencia visual durante jornada activa.

Politica de captura minima (RNF-03): solo se captura la ventana activa y solo
cuando pertenece a una aplicacion de la lista permitida clasificada como
productiva, es decir, una herramienta de trabajo. Nunca se captura la
pantalla completa, el escritorio, la barra de tareas ni los avisos emergentes:
la imagen se obtiene con PrintWindow, que dibuja unicamente el contenido de la
ventana, sin lo que haya encima o alrededor de ella.

Retencion local: si la subida al backend esta habilitada, cada captura se
elimina del equipo al subirse; en cualquier caso, las capturas locales con mas
de 7 dias se purgan automaticamente.
"""

import datetime
import getpass
import os
import socket
import threading
import time

import capture_policy
from activity_tracker import get_foreground_window
from agent_runtime import get_logger, local_now
from outbox import append_event

log = get_logger("screenshots")

LOCAL_RETENTION_DAYS = 7
PURGE_INTERVAL_SECONDS = 60 * 60

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


def purge_old_captures(base: str, days: int = LOCAL_RETENTION_DAYS, now: float | None = None) -> int:
    """Elimina capturas locales (.webp) con mas de `days` dias y carpetas vacias."""
    if not base or not os.path.isdir(base):
        return 0
    cutoff = (now if now is not None else time.time()) - days * 86400
    removed = 0
    for root, _dirs, files in os.walk(base, topdown=False):
        for name in files:
            if not name.lower().endswith(".webp"):
                continue
            path = os.path.join(root, name)
            try:
                if os.path.getmtime(path) < cutoff:
                    os.remove(path)
                    removed += 1
            except OSError as exc:
                log.warning("No se pudo purgar la captura %s: %s", path, exc)
        if os.path.abspath(root) != os.path.abspath(base):
            try:
                if not os.listdir(root):
                    os.rmdir(root)
            except OSError:
                pass
    if removed:
        log.info("Capturas locales purgadas (> %s dias): %s", days, removed)
    return removed


class ScreenshotEngine:
    def __init__(self, cfg, on_event=None):
        self.cfg = cfg
        self.on_event = on_event
        self.intervalo = getattr(cfg, "captura_intervalo_segundos", 300)
        self.base = getattr(cfg, "carpeta_capturas", "capturas")
        self._stop = threading.Event()
        self._stop.set()
        self._paused = False
        self._thread = None
        self._lock = threading.Lock()
        self._last_purge = 0.0
        self.ultima = None
        self.backend_uploader = None

    @property
    def _running(self) -> bool:
        return not self._stop.is_set()

    @property
    def activo(self) -> bool:
        return self._running and not self._paused

    @property
    def hilo_vivo(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

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
        with self._lock:
            if self._running and self.hilo_vivo:
                return
            # Cada hilo recibe su propio evento de parada: un hilo anterior que
            # aun no termino no puede seguir capturando en paralelo.
            self._stop.set()
            self._stop = threading.Event()
            self._paused = False
            self.carpeta_dia()
            self._thread = threading.Thread(
                target=self._loop, args=(self._stop,), name="vyntra-screenshots", daemon=True
            )
            self._thread.start()
        self.ensure_uploader_started()
        self._notify("Capturas iniciadas.")

    def restart_if_dead(self) -> bool:
        """Reinicia el hilo si deberia estar corriendo y murio. Devuelve True si reinicio."""
        with self._lock:
            if not self._running or self.hilo_vivo:
                return False
            self._stop = threading.Event()
            self._thread = threading.Thread(
                target=self._loop, args=(self._stop,), name="vyntra-screenshots", daemon=True
            )
            self._thread.start()
        return True

    def pause(self):
        self._paused = True
        self._notify("Capturas pausadas.")

    def resume(self):
        self._paused = False
        self._notify("Capturas reanudadas.")

    def stop(self):
        self._stop.set()
        self._notify("Capturas detenidas.")

    def _loop(self, stop_event: threading.Event):
        while not stop_event.is_set():
            self._purge_if_due()
            if not self._paused:
                try:
                    self._capturar(stop_event)
                except Exception as exc:
                    log.exception("Error de captura")
                    self._notify(f"Error de captura: {exc}")
            if stop_event.wait(max(1, int(self.intervalo))):
                return

    def _purge_if_due(self):
        ahora = time.monotonic()
        if self._last_purge and ahora - self._last_purge < PURGE_INTERVAL_SECONDS:
            return
        self._last_purge = ahora
        try:
            purge_old_captures(self.base)
        except Exception:
            log.exception("No se pudieron purgar capturas antiguas")

    def _capturar(self, stop_event: threading.Event | None = None):
        ts = local_now()
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
        if stop_event is not None and stop_event.is_set():
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
            "proceso": capture_policy.normalize_process_name(proceso),
            "identificador": identificador,
            "agent_version": getattr(self.cfg, "agent_version", "unknown"),
        }
        append_event("screenshot_created", metadata)
        self._upload_to_backend(ruta, metadata)
        self._notify(f"Captura {ts:%H:%M:%S}")

    def _upload_to_backend(self, ruta: str, metadata: dict):
        if not self._ensure_backend_uploader():
            return
        try:
            self.backend_uploader.enqueue_capture(ruta, metadata)
        except Exception as exc:
            log.exception("No se pudo encolar la evidencia")
            self._notify(f"Backend evidencia pendiente: {exc}")

    def ensure_uploader_started(self) -> bool:
        """Crea e inicia el hilo de subida de evidencias (incluye pendientes previas)."""
        if not self._ensure_backend_uploader():
            return False
        self.backend_uploader.start()
        return True

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
            log.exception("Backend de evidencias no inicializado")
            self._notify(f"Backend evidencia no inicializado: {exc}")
            return False

    def _notify(self, msg):
        if self.on_event:
            try:
                self.on_event(msg)
            except Exception:
                log.exception("Callback de capturas fallo")

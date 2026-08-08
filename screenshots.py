"""
screenshots.py - Capturas de pantalla durante jornada activa.
"""

import datetime
import getpass
import os
import socket
import threading
import time

from outbox import append_event


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
        nombre = f"cap_{ts:%Y%m%d_%H%M%S}.webp"
        ruta = os.path.join(self.carpeta_dia(), nombre)

        try:
            from PIL import Image
        except Exception as exc:
            self._notify(f"Captura deshabilitada: {exc}")
            return

        monitores_count = 1
        try:
            monitores_count = self._capturar_con_mss(ruta, Image)
        except Exception as exc:
            try:
                monitores_count = self._capturar_con_pillow(ruta)
                self._notify(f"Captura realizada con fallback: {exc}")
            except Exception as fallback_exc:
                self._notify(f"Error de captura: {exc}; fallback: {fallback_exc}")
                return

        self.ultima = ts
        metadata = {
            "ruta": ruta,
            "fechaHora": ts.isoformat(),
            "empleado": getpass.getuser(),
            "equipo": nombre_equipo(),
            "intervalo_segundos": self.intervalo,
            "monitores": monitores_count,
            "agent_version": getattr(self.cfg, "agent_version", "unknown"),
        }
        append_event("screenshot_created", metadata)
        self._upload_to_drive(ruta)
        self._upload_to_backend(ruta, metadata)
        self._notify(f"Captura {ts:%H:%M:%S}")

    def _capturar_con_mss(self, ruta: str, Image) -> int:
        import mss

        with mss.mss() as sct:
            monitores = sct.monitors[1:] or sct.monitors[:1]

            if not monitores:
                raise RuntimeError("No hay monitores disponibles")

            if len(monitores) == 1:
                img = sct.grab(monitores[0])
                imagen = Image.frombytes("RGB", img.size, img.rgb)
                imagen.save(ruta, "WEBP", quality=80, optimize=True)
                return 1

            ancho_total = sum(m["width"] for m in monitores)
            alto_max = max(m["height"] for m in monitores)
            imagen_combinada = Image.new("RGB", (ancho_total, alto_max), color=(0, 0, 0))

            x_offset = 0
            for monitor in monitores:
                img = sct.grab(monitor)
                img_pil = Image.frombytes("RGB", img.size, img.rgb)
                imagen_combinada.paste(img_pil, (x_offset, 0))
                x_offset += monitor["width"]

            imagen_combinada.save(ruta, "WEBP", quality=80, optimize=True)
            return len(monitores)

    @staticmethod
    def _capturar_con_pillow(ruta: str) -> int:
        from PIL import ImageGrab

        imagen = ImageGrab.grab(all_screens=True)
        imagen.save(ruta, "WEBP", quality=80, optimize=True)
        return 1

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

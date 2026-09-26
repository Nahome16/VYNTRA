"""
agent_runtime.py - Utilidades compartidas del agente VYNTRA.

- Carpeta de datos local (%LOCALAPPDATA%\\VYNTRA) para outbox, colas, cache y logs.
- Logger con rotacion (%LOCALAPPDATA%\\VYNTRA\\logs\\agent.log, 1 MB x 5).
- Fechas ISO 8601 con desfase horario local (nunca fechas "naive").
- Modo desarrollo explicito (VYNTRA_DEV_MODE=1, solo ejecutando desde codigo fuente).
- Espera exponencial con jitter para reintentos de red.
"""

from __future__ import annotations

import datetime
import logging
import os
import random
import sys
import threading
from logging.handlers import RotatingFileHandler

APP_DIR_NAME = "VYNTRA"
LOGGER_NAME = "vyntra"
LOG_MAX_BYTES = 1024 * 1024
LOG_BACKUP_COUNT = 5

_setup_lock = threading.Lock()
_configured_path: str | None = None


def data_dir() -> str:
    """Carpeta de datos del agente (fuera de la carpeta de instalacion)."""
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    folder = os.path.join(base, APP_DIR_NAME)
    os.makedirs(folder, exist_ok=True)
    return folder


def logs_dir() -> str:
    folder = os.path.join(data_dir(), "logs")
    os.makedirs(folder, exist_ok=True)
    return folder


def setup_logging() -> logging.Logger:
    """Configura (una sola vez por carpeta de datos) el log rotativo del agente."""
    global _configured_path
    logger = logging.getLogger(LOGGER_NAME)
    with _setup_lock:
        try:
            target = os.path.join(logs_dir(), "agent.log")
        except OSError:
            target = None
        if _configured_path == target and logger.handlers:
            return logger
        for handler in list(logger.handlers):
            logger.removeHandler(handler)
            try:
                handler.close()
            except Exception:
                pass
        logger.setLevel(logging.INFO)
        logger.propagate = False
        if target:
            try:
                handler = RotatingFileHandler(
                    target,
                    maxBytes=LOG_MAX_BYTES,
                    backupCount=LOG_BACKUP_COUNT,
                    encoding="utf-8",
                    delay=True,
                )
                handler.setFormatter(
                    logging.Formatter(
                        "%(asctime)s %(levelname)s [%(threadName)s] %(name)s: %(message)s"
                    )
                )
                logger.addHandler(handler)
            except OSError:
                logger.addHandler(logging.NullHandler())
        else:
            logger.addHandler(logging.NullHandler())
        _configured_path = target
    return logger


def get_logger(name: str | None = None) -> logging.Logger:
    setup_logging()
    if not name:
        return logging.getLogger(LOGGER_NAME)
    return logging.getLogger(f"{LOGGER_NAME}.{name}")


def local_now() -> datetime.datetime:
    """Fecha y hora local con zona horaria (aware)."""
    return datetime.datetime.now().astimezone()


def now_iso() -> str:
    """ISO 8601 con desfase horario local, p. ej. 2026-09-26T08:15:00.123456-06:00."""
    return local_now().isoformat()


def to_local_aware(value: datetime.datetime | None) -> datetime.datetime | None:
    """Convierte fechas "naive" (interpretadas como hora local) a fechas con zona."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.astimezone()
    return value.astimezone()


def parse_iso(value) -> datetime.datetime | None:
    if not value:
        return None
    try:
        return to_local_aware(datetime.datetime.fromisoformat(str(value)))
    except (TypeError, ValueError):
        return None


def is_dev_mode() -> bool:
    """Modo desarrollo: requiere VYNTRA_DEV_MODE=1 y ejecutar desde codigo fuente.

    Un ejecutable empaquetado (PyInstaller) nunca entra en modo desarrollo, aunque
    la variable de entorno exista en el equipo del empleado.
    """
    if getattr(sys, "frozen", False):
        return False
    return os.environ.get("VYNTRA_DEV_MODE", "").strip() == "1"


def backoff_delay(failures: int, base: float = 15.0, cap: float = 600.0) -> float:
    """Espera exponencial con jitter ("equal jitter") para reintentos de red."""
    if failures <= 0:
        return base
    ceiling = min(cap, base * (2 ** min(failures, 12)))
    return ceiling / 2 + random.uniform(0, ceiling / 2)

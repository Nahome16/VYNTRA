"""
outbox.py - Cola local de eventos pendientes de sincronizacion.

Hasta conectar el backend, los eventos se guardan en JSONL dentro de
%LOCALAPPDATA%\\VYNTRA\\outbox.jsonl. Se rota automáticamente si
supera 10 MB, manteniendo los últimos 7 archivos.
"""

import datetime
import getpass
import json
import os
import socket
import threading
import uuid
from pathlib import Path


_LOCK = threading.Lock()
_MAX_SIZE = 10 * 1024 * 1024
_MAX_ARCHIVES = 7


def _base_dir() -> str:
    base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
    carpeta = os.path.join(base, "VYNTRA")
    os.makedirs(carpeta, exist_ok=True)
    return carpeta


def outbox_path() -> str:
    return os.path.join(_base_dir(), "outbox.jsonl")


def _rotate_if_needed():
    """Rota el archivo outbox.jsonl si supera el límite de tamaño."""
    ruta = outbox_path()
    if not os.path.exists(ruta):
        return
    
    try:
        tamaño = os.path.getsize(ruta)
        if tamaño < _MAX_SIZE:
            return
        
        with _LOCK:
            ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            archivo_viejo = f"{ruta}.{ts}.bak"
            os.rename(ruta, archivo_viejo)
            
            base_dir = _base_dir()
            archivos = sorted(Path(base_dir).glob("outbox.jsonl.*.bak"))
            if len(archivos) > _MAX_ARCHIVES:
                for viejo in archivos[:-_MAX_ARCHIVES]:
                    try:
                        viejo.unlink()
                    except Exception:
                        pass
    except Exception:
        pass


def append_event(tipo: str, payload: dict) -> dict:
    _rotate_if_needed()
    event = {
        "id": str(uuid.uuid4()),
        "tipo": tipo,
        "empleado": getpass.getuser(),
        "equipo": socket.gethostname(),
        "created_at": datetime.datetime.now().isoformat(),
        "status": "pending",
        "payload": payload,
    }
    with _LOCK:
        line = json.dumps(event, ensure_ascii=False) + "\n"
        try:
            with open(outbox_path(), "a", encoding="utf-8") as f:
                f.write(line)
        except OSError:
            fallback = os.path.join(_base_dir(), f"outbox_{os.getpid()}.jsonl")
            try:
                with open(fallback, "a", encoding="utf-8") as f:
                    f.write(line)
            except OSError:
                pass
    return event


def read_pending(limit: int = 50) -> list[dict]:
    ruta = outbox_path()
    if not os.path.exists(ruta):
        return []
    events = []
    with _LOCK:
        with open(ruta, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("status") == "pending":
                    events.append(event)
                    if len(events) >= limit:
                        break
    return events


def mark_uploaded(event_ids: set[str]):
    if not event_ids:
        return
    ruta = outbox_path()
    if not os.path.exists(ruta):
        return
    with _LOCK:
        lines = []
        changed = False
        with open(ruta, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    lines.append(line)
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    lines.append(line)
                    continue
                if event.get("id") in event_ids and event.get("status") == "pending":
                    event["status"] = "uploaded"
                    event["uploaded_at"] = datetime.datetime.now().isoformat()
                    changed = True
                    lines.append(json.dumps(event, ensure_ascii=False) + "\n")
                else:
                    lines.append(line)
        if changed:
            tmp = f"{ruta}.{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.writelines(lines)
            os.replace(tmp, ruta)


def count_pending() -> int:
    ruta = outbox_path()
    if not os.path.exists(ruta):
        return 0
    total = 0
    with open(ruta, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("status") == "pending":
                total += 1
    return total

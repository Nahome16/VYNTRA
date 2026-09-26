"""
outbox.py - Cola local (SQLite) de eventos pendientes de sincronizacion.

Los eventos se guardan en %LOCALAPPDATA%\\VYNTRA\\outbox.sqlite (tabla `events`)
con estado pending / uploaded / rejected:

- pending: aun no confirmado por el servidor.
- uploaded: el servidor lo acepto (o lo reconocio como duplicado).
- rejected: el servidor lo rechazo explicitamente; no se reintenta para no
  bloquear la cola, pero se conserva para diagnostico.

Migracion: la version anterior guardaba JSONL (outbox.jsonl, rotaciones
outbox.jsonl.*.bak y respaldos outbox_<pid>.jsonl). Al abrir la cola se
importan una sola vez los eventos pendientes de esos archivos (idempotente:
INSERT OR IGNORE por id + registro de archivos importados) y los archivos se
renombran a *.imported para conservarlos como respaldo.

API publica (compatible con la version anterior): append_event, read_pending,
mark_uploaded, count_pending, mas mark_rejected y prune.
"""

from __future__ import annotations

import datetime
import getpass
import glob
import json
import os
import socket
import sqlite3
import threading
import time
import uuid

from agent_runtime import data_dir, get_logger, now_iso

log = get_logger("outbox")

_LOCK = threading.RLock()
_CONNECTIONS: dict[str, sqlite3.Connection] = {}
_LEGACY_SCAN_INTERVAL = 60.0
_last_legacy_scan: dict[str, float] = {}

UPLOADED_RETENTION_DAYS = 7
REJECTED_RETENTION_DAYS = 30


def _base_dir() -> str:
    return data_dir()


def outbox_db_path() -> str:
    return os.path.join(_base_dir(), "outbox.sqlite")


def outbox_path() -> str:
    """Ruta del outbox JSONL heredado (solo se lee para migrar)."""
    return os.path.join(_base_dir(), "outbox.jsonl")


def _connect() -> sqlite3.Connection:
    path = outbox_db_path()
    conn = _CONNECTIONS.get(path)
    if conn is not None:
        return conn
    conn = sqlite3.connect(path, timeout=30, check_same_thread=False)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.DatabaseError:
        pass
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            tipo TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            empleado TEXT NOT NULL DEFAULT '',
            equipo TEXT NOT NULL DEFAULT '',
            last_error TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            updated_epoch REAL NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_events_status_updated ON events(status, updated_epoch)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS legacy_imports (
            path TEXT PRIMARY KEY,
            size INTEGER NOT NULL,
            mtime REAL NOT NULL,
            imported INTEGER NOT NULL,
            imported_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    _CONNECTIONS[path] = conn
    _import_legacy_locked(conn, force=True)
    return conn


def close():
    """Cierra las conexiones abiertas (usado en pruebas y al salir)."""
    with _LOCK:
        for conn in _CONNECTIONS.values():
            try:
                conn.close()
            except sqlite3.Error:
                pass
        _CONNECTIONS.clear()
        _last_legacy_scan.clear()


# ---------------------------------------------------------------------------
# Migracion desde JSONL
# ---------------------------------------------------------------------------
def _legacy_files() -> list[str]:
    base = _base_dir()
    patterns = [
        os.path.join(base, "outbox.jsonl.*.bak"),
        os.path.join(base, "outbox_*.jsonl"),
        os.path.join(base, "outbox.jsonl"),
    ]
    files: list[str] = []
    for pattern in patterns:
        for path in sorted(glob.glob(pattern)):
            if path.endswith(".imported") or path in files:
                continue
            if os.path.isfile(path):
                files.append(path)
    return files


def _import_legacy_locked(conn: sqlite3.Connection, force: bool = False) -> int:
    db_path = outbox_db_path()
    now_mono = time.monotonic()
    if not force and now_mono - _last_legacy_scan.get(db_path, -1e9) < _LEGACY_SCAN_INTERVAL:
        return 0
    _last_legacy_scan[db_path] = now_mono

    imported_total = 0
    for path in _legacy_files():
        try:
            stat = os.stat(path)
        except OSError:
            continue
        row = conn.execute(
            "SELECT size, mtime FROM legacy_imports WHERE path = ?", (path,)
        ).fetchone()
        if row and int(row[0]) == stat.st_size and abs(float(row[1]) - stat.st_mtime) < 1e-6:
            _rename_imported(path)
            continue

        events = []
        try:
            with open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(event, dict) or event.get("status") != "pending":
                        continue
                    if not event.get("id") or not event.get("tipo"):
                        continue
                    events.append(event)
        except OSError as exc:
            log.warning("No se pudo leer el outbox heredado %s: %s", path, exc)
            continue

        # Los JSONL anteriores usaban fechas locales sin zona: ordenar por fecha
        # conserva el orden original al insertarlos (rowid ascendente).
        events.sort(key=lambda item: str(item.get("created_at") or ""))
        inserted = 0
        now_text = now_iso()
        with conn:
            for event in events:
                cursor = conn.execute(
                    """
                    INSERT OR IGNORE INTO events (
                        id, tipo, payload, created_at, status, attempts,
                        empleado, equipo, last_error, updated_at, updated_epoch
                    ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, '', ?, ?)
                    """,
                    (
                        str(event["id"]),
                        str(event["tipo"]),
                        json.dumps(event.get("payload") or {}, ensure_ascii=False, default=str),
                        str(event.get("created_at") or now_text),
                        str(event.get("empleado") or ""),
                        str(event.get("equipo") or ""),
                        now_text,
                        time.time(),
                    ),
                )
                inserted += cursor.rowcount or 0
            conn.execute(
                """
                INSERT OR REPLACE INTO legacy_imports (path, size, mtime, imported, imported_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (path, stat.st_size, stat.st_mtime, inserted, now_text),
            )
        imported_total += inserted
        if inserted:
            log.info("Outbox heredado importado: %s (%s eventos pendientes)", path, inserted)
        _rename_imported(path)
    return imported_total


def _rename_imported(path: str):
    target = f"{path}.{datetime.datetime.now():%Y%m%d_%H%M%S}.imported"
    try:
        os.replace(path, target)
    except OSError:
        # Si no se puede renombrar (archivo bloqueado), el registro en
        # legacy_imports + INSERT OR IGNORE evita duplicados en el siguiente intento.
        pass


def import_legacy() -> int:
    """Importa eventos pendientes de archivos JSONL heredados (idempotente)."""
    with _LOCK:
        conn = _connect()
        return _import_legacy_locked(conn, force=True)


# ---------------------------------------------------------------------------
# API publica
# ---------------------------------------------------------------------------
def append_event(tipo: str, payload: dict) -> dict:
    event = {
        "id": str(uuid.uuid4()),
        "tipo": tipo,
        "empleado": getpass.getuser(),
        "equipo": socket.gethostname(),
        "created_at": now_iso(),
        "status": "pending",
        "payload": payload,
    }
    payload_json = json.dumps(payload, ensure_ascii=False, default=str)
    with _LOCK:
        try:
            conn = _connect()
            with conn:
                conn.execute(
                    """
                    INSERT INTO events (
                        id, tipo, payload, created_at, status, attempts,
                        empleado, equipo, last_error, updated_at, updated_epoch
                    ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, '', ?, ?)
                    """,
                    (
                        event["id"],
                        tipo,
                        payload_json,
                        event["created_at"],
                        event["empleado"],
                        event["equipo"],
                        event["created_at"],
                        time.time(),
                    ),
                )
        except (sqlite3.Error, OSError) as exc:
            # Respaldo: JSONL que se importa automaticamente al recuperar SQLite.
            log.error("No se pudo guardar el evento %s en SQLite: %s", tipo, exc)
            fallback = os.path.join(_base_dir(), f"outbox_{os.getpid()}.jsonl")
            try:
                with open(fallback, "a", encoding="utf-8") as handle:
                    handle.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
            except OSError as fallback_exc:
                log.error("Evento %s perdido: no se pudo escribir el respaldo: %s", tipo, fallback_exc)
    return event


def read_pending(limit: int = 50) -> list[dict]:
    with _LOCK:
        conn = _connect()
        try:
            _import_legacy_locked(conn)
        except (sqlite3.Error, OSError) as exc:
            log.warning("Importacion de outbox heredado fallida: %s", exc)
        rows = conn.execute(
            """
            SELECT id, tipo, payload, created_at, empleado, equipo
            FROM events
            WHERE status = 'pending'
            ORDER BY rowid ASC
            LIMIT ?
            """,
            (max(1, int(limit)),),
        ).fetchall()
    events = []
    for event_id, tipo, payload_json, created_at, empleado, equipo in rows:
        try:
            payload = json.loads(payload_json)
        except (TypeError, json.JSONDecodeError):
            payload = {}
        events.append(
            {
                "id": event_id,
                "tipo": tipo,
                "empleado": empleado,
                "equipo": equipo,
                "created_at": created_at,
                "status": "pending",
                "payload": payload,
            }
        )
    return events


def _set_status(event_ids, status: str, errors: dict | None = None):
    ids = [str(item) for item in (event_ids or []) if item]
    if not ids:
        return 0
    now_text = now_iso()
    now_epoch = time.time()
    changed = 0
    with _LOCK:
        conn = _connect()
        with conn:
            for event_id in ids:
                error = str((errors or {}).get(event_id) or "")[:1000]
                cursor = conn.execute(
                    """
                    UPDATE events
                    SET status = ?, attempts = attempts + 1, last_error = ?,
                        updated_at = ?, updated_epoch = ?
                    WHERE id = ? AND status = 'pending'
                    """,
                    (status, error, now_text, now_epoch, event_id),
                )
                changed += cursor.rowcount or 0
    return changed


def mark_uploaded(event_ids) -> int:
    return _set_status(event_ids, "uploaded")


def mark_rejected(event_ids, errors: dict | None = None) -> int:
    """Marca eventos rechazados por el servidor para no reintentarlos."""
    if isinstance(event_ids, dict):
        errors = event_ids
        event_ids = list(event_ids.keys())
    return _set_status(event_ids, "rejected", errors)


def count_pending() -> int:
    """Cantidad de eventos pendientes (COUNT indexado, barato)."""
    with _LOCK:
        try:
            conn = _connect()
            row = conn.execute("SELECT COUNT(*) FROM events WHERE status = 'pending'").fetchone()
        except sqlite3.Error as exc:
            log.warning("No se pudo contar el outbox: %s", exc)
            return 0
    return int(row[0] if row else 0)


def count_by_status() -> dict:
    with _LOCK:
        conn = _connect()
        rows = conn.execute("SELECT status, COUNT(*) FROM events GROUP BY status").fetchall()
    return {status: int(total) for status, total in rows}


def prune(
    uploaded_days: int = UPLOADED_RETENTION_DAYS,
    rejected_days: int = REJECTED_RETENTION_DAYS,
) -> int:
    """Elimina eventos subidos (y rechazados) antiguos."""
    now_epoch = time.time()
    with _LOCK:
        conn = _connect()
        with conn:
            removed = conn.execute(
                "DELETE FROM events WHERE status = 'uploaded' AND updated_epoch < ?",
                (now_epoch - uploaded_days * 86400,),
            ).rowcount or 0
            removed += conn.execute(
                "DELETE FROM events WHERE status = 'rejected' AND updated_epoch < ?",
                (now_epoch - rejected_days * 86400,),
            ).rowcount or 0
    return removed

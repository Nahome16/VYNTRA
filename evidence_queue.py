"""
evidence_queue.py - Cola local SQLite para respaldos de evidencia.
"""

import datetime
import hashlib
import json
import os
import sqlite3
import time
import uuid

from agent_runtime import data_dir, now_iso

# Estados: pending (nuevo), failed (reintento pendiente), uploaded, missing
# (el archivo local ya no existe; no se reintenta).


def _base_dir() -> str:
    return data_dir()


def default_queue_path() -> str:
    return os.path.join(_base_dir(), "evidence_queue.sqlite")


def sha256_file(filepath: str) -> str:
    hasher = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


class EvidenceQueue:
    def __init__(self, db_path: str | None = None):
        self.db_path = db_path or default_queue_path()
        folder = os.path.dirname(self.db_path)
        if folder:
            os.makedirs(folder, exist_ok=True)
        self._ensure_schema()

    def _connect(self):
        return sqlite3.connect(self.db_path, timeout=30)

    def _ensure_schema(self):
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS evidence_uploads (
                    id TEXT PRIMARY KEY,
                    filepath TEXT NOT NULL,
                    employee TEXT NOT NULL,
                    equipment TEXT NOT NULL,
                    captured_at TEXT NOT NULL,
                    sha256 TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    agent_version TEXT NOT NULL,
                    monitor_count INTEGER NOT NULL DEFAULT 1,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    status TEXT NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    uploaded_at TEXT
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_evidence_status_attempts
                ON evidence_uploads(status, attempts, created_at)
                """
            )
            conn.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_sha_path
                ON evidence_uploads(sha256, filepath)
                """
            )

    def enqueue(
        self,
        filepath: str,
        employee: str,
        equipment: str,
        captured_at: str,
        agent_version: str,
        monitor_count: int,
        metadata: dict | None = None,
    ) -> dict:
        file_hash = sha256_file(filepath)
        file_size = os.path.getsize(filepath)
        now = now_iso()
        record = {
            "id": str(uuid.uuid4()),
            "filepath": filepath,
            "employee": employee,
            "equipment": equipment,
            "captured_at": captured_at,
            "sha256": file_hash,
            "file_size": file_size,
            "agent_version": agent_version,
            "monitor_count": int(monitor_count or 1),
            "metadata_json": json.dumps(metadata or {}, ensure_ascii=False),
            "status": "pending",
            "attempts": 0,
            "last_error": "",
            "created_at": now,
            "updated_at": now,
            "uploaded_at": None,
        }
        with self._connect() as conn:
            existing = conn.execute(
                "SELECT * FROM evidence_uploads WHERE sha256 = ? AND filepath = ?",
                (record["sha256"], record["filepath"]),
            ).fetchone()
            if existing:
                return self._row_to_dict(existing)
            conn.execute(
                """
                INSERT INTO evidence_uploads (
                    id, filepath, employee, equipment, captured_at, sha256, file_size,
                    agent_version, monitor_count, metadata_json, status, attempts,
                    last_error, created_at, updated_at, uploaded_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["id"],
                    record["filepath"],
                    record["employee"],
                    record["equipment"],
                    record["captured_at"],
                    record["sha256"],
                    record["file_size"],
                    record["agent_version"],
                    record["monitor_count"],
                    record["metadata_json"],
                    record["status"],
                    record["attempts"],
                    record["last_error"],
                    record["created_at"],
                    record["updated_at"],
                    record["uploaded_at"],
                ),
            )
        return record

    def pending(self, limit: int = 5, retry_limit: int = 50) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM evidence_uploads
                WHERE status IN ('pending', 'failed') AND attempts < ?
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (retry_limit, limit),
            ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def mark_uploaded(self, record_id: str):
        now = now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE evidence_uploads
                SET status = 'uploaded', updated_at = ?, uploaded_at = ?, last_error = ''
                WHERE id = ?
                """,
                (now, now, record_id),
            )

    def mark_failed(self, record_id: str, error: str, count_attempt: bool = True):
        """Registra un intento fallido.

        `count_attempt=False` para errores de red/servidor: no consumen el
        limite de reintentos (retry_limit) de la evidencia.
        """
        now = now_iso()
        increment = 1 if count_attempt else 0
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE evidence_uploads
                SET status = 'failed', attempts = attempts + ?, updated_at = ?, last_error = ?
                WHERE id = ?
                """,
                (increment, now, str(error)[:2000], record_id),
            )

    def mark_missing(self, record_id: str, error: str = ""):
        now = now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE evidence_uploads
                SET status = 'missing', updated_at = ?, last_error = ?
                WHERE id = ?
                """,
                (now, str(error)[:2000], record_id),
            )

    def count_pending(self, retry_limit: int = 50) -> int:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) FROM evidence_uploads
                WHERE status IN ('pending', 'failed') AND attempts < ?
                """,
                (retry_limit,),
            ).fetchone()
        return int(row[0] if row else 0)

    def prune_uploaded(self, days: int = 30) -> int:
        """Elimina registros subidos o perdidos con mas de `days` dias."""
        cutoff = time.time() - days * 86400
        removed = 0
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, updated_at FROM evidence_uploads WHERE status IN ('uploaded', 'missing')"
            ).fetchall()
            for record_id, updated_at in rows:
                try:
                    stamp = datetime.datetime.fromisoformat(str(updated_at))
                    if stamp.tzinfo is None:
                        stamp = stamp.astimezone()
                    if stamp.timestamp() < cutoff:
                        conn.execute("DELETE FROM evidence_uploads WHERE id = ?", (record_id,))
                        removed += 1
                except (TypeError, ValueError):
                    continue
        return removed

    @staticmethod
    def _row_to_dict(row) -> dict:
        columns = [
            "id",
            "filepath",
            "employee",
            "equipment",
            "captured_at",
            "sha256",
            "file_size",
            "agent_version",
            "monitor_count",
            "metadata_json",
            "status",
            "attempts",
            "last_error",
            "created_at",
            "updated_at",
            "uploaded_at",
        ]
        return dict(zip(columns, row))

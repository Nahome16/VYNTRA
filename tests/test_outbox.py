import datetime
import json
import os
import time

import outbox


def _write_jsonl(path, events):
    with open(path, "w", encoding="utf-8") as handle:
        for event in events:
            handle.write(json.dumps(event) + "\n")


def _legacy_event(event_id, status="pending", created_at="2026-09-20T08:00:00", tipo="activity_snapshot"):
    return {
        "id": event_id,
        "tipo": tipo,
        "empleado": "ana",
        "equipo": "PC-1",
        "created_at": created_at,
        "status": status,
        "payload": {"estado": "TRABAJANDO", "n": event_id},
    }


def test_append_read_and_count():
    first = outbox.append_event("shift_started", {"estado": "TRABAJANDO"})
    second = outbox.append_event("activity_snapshot", {"estado": "TRABAJANDO"})
    assert outbox.count_pending() == 2
    pending = outbox.read_pending(limit=10)
    assert [event["id"] for event in pending] == [first["id"], second["id"]]
    assert pending[0]["payload"] == {"estado": "TRABAJANDO"}
    assert pending[0]["tipo"] == "shift_started"
    # created_at en ISO 8601 con desfase horario.
    assert datetime.datetime.fromisoformat(pending[0]["created_at"]).tzinfo is not None
    assert outbox.read_pending(limit=1)[0]["id"] == first["id"]


def test_mark_uploaded_and_rejected_leave_queue_unblocked():
    a = outbox.append_event("a", {})
    b = outbox.append_event("b", {})
    c = outbox.append_event("c", {})
    assert outbox.mark_uploaded({a["id"]}) == 1
    assert outbox.mark_rejected({b["id"]: "payload invalido"}) == 1
    assert outbox.count_pending() == 1
    assert [event["id"] for event in outbox.read_pending()] == [c["id"]]
    counts = outbox.count_by_status()
    assert counts == {"uploaded": 1, "rejected": 1, "pending": 1}
    # Marcar de nuevo no cambia nada (solo afecta eventos pendientes).
    assert outbox.mark_uploaded({a["id"]}) == 0


def test_migrates_jsonl_bak_and_pid_files_once(isolated_appdata):
    base = isolated_appdata / "VYNTRA"
    base.mkdir(exist_ok=True)
    _write_jsonl(
        base / "outbox.jsonl",
        [_legacy_event("e3", created_at="2026-09-20T10:00:00"), _legacy_event("done", status="uploaded")],
    )
    _write_jsonl(base / "outbox.jsonl.20260919_120000.bak", [_legacy_event("e1", created_at="2026-09-19T09:00:00")])
    _write_jsonl(base / "outbox_4242.jsonl", [_legacy_event("e2", created_at="2026-09-19T12:00:00")])
    with open(base / "outbox.jsonl", "a", encoding="utf-8") as handle:
        handle.write("{linea corrupta\n")

    assert outbox.count_pending() == 3
    ids = [event["id"] for event in outbox.read_pending(limit=10)]
    assert set(ids) == {"e1", "e2", "e3"}
    # Los archivos importados se conservan renombrados como respaldo.
    assert not (base / "outbox.jsonl").exists()
    assert list(base.glob("outbox.jsonl.*.imported"))

    # Idempotente: reabrir y volver a importar no duplica.
    outbox.close()
    assert outbox.import_legacy() == 0
    assert outbox.count_pending() == 3


def test_reimporting_same_file_is_idempotent(isolated_appdata):
    base = isolated_appdata / "VYNTRA"
    base.mkdir(exist_ok=True)
    _write_jsonl(base / "outbox_1.jsonl", [_legacy_event("x1")])
    assert outbox.count_pending() == 1
    outbox.mark_uploaded({"x1"})
    # Un respaldo nuevo con el mismo id (p. ej. copia) no revive el evento subido.
    _write_jsonl(base / "outbox_2.jsonl", [_legacy_event("x1")])
    assert outbox.import_legacy() == 0
    assert outbox.count_pending() == 0


def test_prune_removes_old_uploaded_rows():
    old = outbox.append_event("old", {})
    recent = outbox.append_event("recent", {})
    outbox.mark_uploaded({old["id"], recent["id"]})
    conn = outbox._connect()
    with conn:
        conn.execute(
            "UPDATE events SET updated_epoch = ? WHERE id = ?",
            (time.time() - 10 * 86400, old["id"]),
        )
    assert outbox.prune(uploaded_days=7) == 1
    assert outbox.count_by_status() == {"uploaded": 1}


def test_fallback_file_is_imported_when_sqlite_fails(isolated_appdata, monkeypatch):
    real_connect = outbox._connect

    def broken():
        raise outbox.sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(outbox, "_connect", broken)
    event = outbox.append_event("shift_finished", {"estado": "TERMINADO"})
    fallback = isolated_appdata / "VYNTRA" / f"outbox_{os.getpid()}.jsonl"
    assert fallback.exists()
    monkeypatch.setattr(outbox, "_connect", real_connect)
    outbox.import_legacy()
    assert outbox.count_pending() == 1
    assert outbox.read_pending()[0]["id"] == event["id"]
    assert not fallback.exists()

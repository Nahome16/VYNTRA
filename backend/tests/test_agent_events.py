"""Integracion de /api/agent/events sobre SQLite (sin evento de arranque)."""

from datetime import datetime, timedelta, timezone
import json
import uuid
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
import pytest

from app.main import MAX_SAMPLES_PER_EVENT, app
from app.models import (
    Activity,
    AgentEventReceipt,
    AuditLog,
    Incident,
    OvertimeAuthorization,
    Shift,
    ShiftEvent,
    WindowTitleCatalog,
)
from tests.factories import DEVICE_TOKEN, create_company_setup

MANAGUA = ZoneInfo("America/Managua")
SECRETS = ("confidencial", "banco.example", "Mi Banco", "claves", "privado", "saldo")


def local_naive(value: datetime) -> str:
    """Formato que envia el agente de escritorio: hora local sin zona."""
    return value.astimezone(MANAGUA).replace(tzinfo=None, microsecond=0).isoformat()


def as_naive_utc(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(tzinfo=None, microsecond=0)


def post_events(client, events):
    response = client.post("/api/agent/events", json={"events": events}, headers={"X-Device-Token": DEVICE_TOKEN})
    assert response.status_code == 200, response.text
    return response.json()


def snapshot_event(start: datetime, samples: list[dict], **payload_overrides) -> dict:
    now = datetime.now(timezone.utc)
    payload = {
        "estado": "TRABAJANDO",
        "fecha": now.astimezone(MANAGUA).date().isoformat(),
        "inicio_jornada": local_naive(start),
        "seg_trabajado": 3000,
        "seg_break": 0,
        "seg_lunch": 0,
        "url_actual": "https://banco.example/cuenta",
        "telemetria": {"seg_idle": 10, "dominio": "banco.example", "muestras_recientes": samples},
    }
    payload.update(payload_overrides)
    return {"id": str(uuid.uuid4()), "tipo": "activity_snapshot", "created_at": local_naive(now), "payload": payload}


@pytest.fixture()
def setup(db):
    return create_company_setup(db)


@pytest.fixture()
def client():
    return TestClient(app)  # sin "with": no ejecuta on_startup


def raw_samples(start: datetime) -> list[dict]:
    return [
        {
            "timestamp": local_naive(start + timedelta(minutes=10)),
            "proceso": "excel.exe",
            "titulo": "Presupuesto 2026 - confidencial.xlsx",
            "duracion_muestra_segundos": 10,
        },
        {
            "timestamp": local_naive(start + timedelta(minutes=11)),
            "proceso": "chrome.exe",
            "titulo": "Mi Banco - saldo 5000",
            "url": "https://banco.example/saldo",
            "duracion_muestra_segundos": 10,
        },
        {
            "timestamp": local_naive(start + timedelta(minutes=12)),
            "proceso": "slack.exe",
            "titulo": "DM con Ana - privado",
            "duracion_muestra_segundos": 10,
        },
        {
            "timestamp": local_naive(start + timedelta(minutes=13)),
            "proceso": "notepad.exe",
            "titulo": "claves.txt",
            "duracion_muestra_segundos": 10,
            "is_idle": True,
        },
    ]


def test_event_stores_only_normalized_identifiers_and_is_idempotent(db, setup, client):
    _company, _department, _position, employee, device = setup
    start = datetime.now(timezone.utc) - timedelta(hours=1)
    event = snapshot_event(start, raw_samples(start))

    body = post_events(client, [event])
    assert body["ok"] is True
    assert body["accepted"][0]["activity_samples_inserted"] == 4

    db.expire_all()
    titles = {row.title_text for row in db.query(WindowTitleCatalog).all()}
    assert titles <= {"Presupuesto", "(aplicacion permitida)", "(fuera de lista)", "(sitio fuera de lista)"}
    stored_payloads = " ".join(row.payload_json for row in db.query(ShiftEvent).all())
    for secret in SECRETS:
        assert secret not in stored_payloads
        assert all(secret not in title for title in titles)

    activities = db.query(Activity).order_by(Activity.started_at).all()
    assert [a.classification for a in activities] == ["productive", "uncategorized", "neutral", "uncategorized"]
    # La hora local sin zona se interpreta en America/Managua (UTC-6).
    assert activities[0].started_at.replace(tzinfo=None) == as_naive_utc(start + timedelta(minutes=10))

    shift = db.query(Shift).one()
    assert shift.employee_id == employee.id and shift.device_id == device.id
    assert shift.started_at.replace(tzinfo=None) == as_naive_utc(start)
    assert shift.work_seconds == 3000

    # Reenvio del mismo evento: duplicado, sin filas nuevas.
    again = post_events(client, [event])
    assert again["accepted"] == [{"id": event["id"], "duplicate": True}]
    db.expire_all()
    assert db.query(Activity).count() == 4
    assert db.query(ShiftEvent).count() == 1
    assert db.query(AgentEventReceipt).count() == 1
    assert db.query(AuditLog).filter(AuditLog.action == "agent_event_received").count() == 0


def test_legacy_audit_receipt_is_still_a_duplicate(db, setup, client):
    _company, _department, _position, _employee, device = setup
    event_id = str(uuid.uuid4())
    db.add(
        AuditLog(
            company_id=device.company_id,
            device_id=device.id,
            action="agent_event_received",
            entity_type="agent_event",
            entity_id=event_id,
        )
    )
    db.commit()
    start = datetime.now(timezone.utc) - timedelta(minutes=30)
    event = snapshot_event(start, raw_samples(start))
    event["id"] = event_id
    body = post_events(client, [event])
    assert body["accepted"] == [{"id": event_id, "duplicate": True}]
    db.expire_all()
    assert db.query(Activity).count() == 0


def test_reported_seconds_are_capped_to_elapsed_time(db, setup, client):
    start = datetime.now(timezone.utc) - timedelta(hours=1)
    event = snapshot_event(start, [], seg_trabajado=999_999, seg_break=500_000)
    body = post_events(client, [event])
    assert body["ok"] is True
    db.expire_all()
    shift = db.query(Shift).one()
    assert 3600 <= shift.work_seconds <= 3600 + 300 + 5
    assert shift.break_seconds <= 3600 + 300 + 5
    stored = json.loads(db.query(ShiftEvent).one().payload_json)
    assert stored["server_adjustments"]["seg_trabajado"]["reported"] == 999_999


def test_future_or_stale_shift_start_is_ignored(db, setup, client):
    now = datetime.now(timezone.utc)
    future = snapshot_event(now + timedelta(hours=3), [])
    post_events(client, [future])
    db.expire_all()
    assert db.query(Shift).one().started_at is None

    stale = snapshot_event(now - timedelta(hours=30), [])
    post_events(client, [stale])
    db.expire_all()
    assert db.query(Shift).one().started_at is None


def test_overtime_is_capped_to_authorized_minutes(db, setup, client):
    company, _department, _position, employee, device = setup
    now = datetime.now(timezone.utc)
    db.add(
        OvertimeAuthorization(
            company_id=company.id,
            employee_id=employee.id,
            device_id=device.id,
            code="OT-TEST",
            status="active",
            assigned_minutes=10,
            valid_from=now - timedelta(hours=1),
            valid_until=now + timedelta(hours=1),
            started_at=now - timedelta(minutes=20),
        )
    )
    db.commit()
    event = snapshot_event(now - timedelta(hours=9), [], seg_horas_extra=3600)
    post_events(client, [event])
    db.expire_all()
    stored = json.loads(db.query(ShiftEvent).one().payload_json)
    assert stored["seg_horas_extra"] == 10 * 60 + 300


def test_samples_are_capped_per_event(db, setup, client):
    start = datetime.now(timezone.utc) - timedelta(hours=2)
    samples = [
        {
            "timestamp": local_naive(start + timedelta(seconds=5 * index)),
            "proceso": "excel.exe",
            "titulo": "Presupuesto",
            "duracion_muestra_segundos": 5,
        }
        for index in range(MAX_SAMPLES_PER_EVENT + 50)
    ]
    body = post_events(client, [snapshot_event(start, samples)])
    assert body["accepted"][0]["activity_samples_inserted"] == MAX_SAMPLES_PER_EVENT


def test_controlled_rejection_keeps_spanish_message(db, setup, client):
    start = datetime.now(timezone.utc) - timedelta(minutes=5)
    event = snapshot_event(start, [], web_station=True, extension_connected=False)
    event["tipo"] = "shift_started"
    body = post_events(client, [event])
    assert body["ok"] is False
    rejection = body["rejected"][0]
    assert rejection["code"] == "extension_required"
    assert "extension" in rejection["error"].lower()
    db.expire_all()
    assert db.query(AgentEventReceipt).count() == 0


def test_unexpected_errors_do_not_leak_details(db, setup, client, monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("psycopg internal detail: password=hunter2")

    monkeypatch.setattr("app.main.process_agent_event", boom)
    start = datetime.now(timezone.utc) - timedelta(minutes=5)
    body = post_events(client, [snapshot_event(start, [])])
    rejection = body["rejected"][0]
    assert rejection["code"] == "internal_error"
    assert "hunter2" not in rejection["error"]
    assert "psycopg" not in rejection["error"]


def test_oversized_event_is_rejected(db, setup, client):
    start = datetime.now(timezone.utc) - timedelta(minutes=5)
    event = snapshot_event(start, [], notas="x" * (300 * 1024))
    body = post_events(client, [event])
    assert body["rejected"][0]["code"] == "event_too_large"


def test_incident_dedupe_uses_source_event_column(db, setup, client):
    event = {
        "id": str(uuid.uuid4()),
        "tipo": "incident_submitted",
        "created_at": local_naive(datetime.now(timezone.utc)),
        "payload": {"tipo": "tiempo_perdido", "motivo": "Se cayo la red", "requested_at": local_naive(datetime.now(timezone.utc))},
    }
    post_events(client, [event])
    db.expire_all()
    incident = db.query(Incident).one()
    assert incident.source_event_id == event["id"]
    assert json.loads(incident.payload_json)["zona_horaria"] == "America/Managua"

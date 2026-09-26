"""Subida y visualizacion de evidencias (sin evento de arranque)."""

from datetime import timedelta
import hashlib

from fastapi.testclient import TestClient

from app.auth import create_admin_access_token, hash_password
from app.main import app
from app.models import AdminSession, AuditLog, EvidenceFile, EvidenceUploadAttempt, Role, User, now_utc
from tests.factories import DEVICE_TOKEN, create_company_setup

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def upload(client, content: bytes, filename: str = "captura.png"):
    return client.post(
        "/api/evidence/upload",
        headers={"X-Device-Token": DEVICE_TOKEN},
        files={"file": (filename, content, "image/png")},
        data={
            "employee": "Empleada",
            "equipment": "PC",
            "captured_at": "2026-09-26T08:00:00",
            "sha256": hashlib.sha256(content).hexdigest(),
            "file_size": str(len(content)),
        },
    )


def stored_files(storage_dir):
    return [path for path in storage_dir.rglob("*") if path.is_file()]


def test_upload_duplicate_and_view_is_audited(db, storage_dir):
    company, _department, _position, _employee, _device = create_company_setup(db)
    client = TestClient(app)

    created = upload(client, PNG_BYTES)
    assert created.status_code == 201, created.text
    evidence_id = created.json()["evidence_id"]
    assert len(stored_files(storage_dir)) == 1

    duplicate = upload(client, PNG_BYTES)
    assert duplicate.status_code == 201
    assert duplicate.json()["duplicate"] is True
    assert len(stored_files(storage_dir)) == 1

    db.expire_all()
    evidence = db.get(EvidenceFile, evidence_id)
    # 08:00 hora de Managua (UTC-6) == 14:00 UTC.
    assert evidence.captured_at.replace(tzinfo=None).hour == 14

    role = Role(company_id=company.id, name="admin")
    db.add(role)
    db.flush()
    user = User(
        company_id=company.id,
        role_id=role.id,
        email="rrhh@example.test",
        full_name="RRHH",
        password_hash=hash_password("Clave-segura-1"),
    )
    db.add(user)
    db.flush()
    session = AdminSession(user_id=user.id, company_id=company.id, expires_at=now_utc() + timedelta(hours=1))
    db.add(session)
    db.commit()
    token = create_admin_access_token(user, "admin", session.id)

    viewed = client.get(f"/api/evidence/{evidence_id}/content", headers={"Authorization": f"Bearer {token}"})
    assert viewed.status_code == 200
    assert viewed.content == PNG_BYTES
    assert viewed.headers["content-disposition"] == f'inline; filename="evidence-{evidence_id}.png"'
    db.expire_all()
    audit = db.query(AuditLog).filter(AuditLog.action == "evidence_viewed").one()
    assert audit.entity_id == evidence_id and audit.user_id == user.id


def test_invalid_image_returns_400_without_leftovers(db, storage_dir):
    create_company_setup(db)
    client = TestClient(app)
    response = upload(client, b"not really a png file")
    assert response.status_code == 400
    assert stored_files(storage_dir) == []
    db.expire_all()
    assert db.query(EvidenceFile).count() == 0
    assert db.query(EvidenceUploadAttempt).filter(EvidenceUploadAttempt.status == "rejected").count() == 1

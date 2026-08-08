"""
main.py - VYNTRA Evidence API.
"""

from datetime import datetime, timezone
import hashlib
import os
import tempfile

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import hash_token, require_device
from app.config import settings
from app.database import Base, engine, get_db, SessionLocal
from app.models import (
    Company,
    Department,
    Device,
    Employee,
    EvidenceFile,
    EvidenceUploadAttempt,
    Role,
    User,
    new_id,
)
from app.storage import (
    IMAGE_CONTENT_TYPES,
    build_storage_path,
    save_from_temp,
    validate_image_name,
    validate_image_signature,
)


app = FastAPI(title=settings.app_name)


def parse_client_datetime(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid captured_at datetime") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def record_attempt(
    db: Session,
    status_value: str,
    message: str,
    device_id: str | None = None,
    sha256_value: str = "",
    ip_address: str = "",
):
    db.add(
        EvidenceUploadAttempt(
            device_id=device_id,
            status=status_value,
            message=message[:2000],
            sha256=sha256_value[:64],
            ip_address=ip_address[:80],
        )
    )
    db.commit()


def bootstrap_data():
    if not settings.allow_bootstrap or not settings.bootstrap_device_token:
        return

    with SessionLocal() as db:
        company = db.execute(
            select(Company).where(Company.name == settings.bootstrap_company_name)
        ).scalar_one_or_none()
        if company is None:
            company = Company(name=settings.bootstrap_company_name)
            db.add(company)
            db.flush()

        admin_role = db.execute(
            select(Role).where(Role.company_id == company.id, Role.name == "admin")
        ).scalar_one_or_none()
        if admin_role is None:
            admin_role = Role(
                company_id=company.id,
                name="admin",
                description="Administrador de plataforma",
            )
            db.add(admin_role)
            db.flush()

        for role_name, description in [
            ("rrhh", "Recursos humanos"),
            ("supervisor", "Supervisor"),
            ("viewer", "Solo lectura"),
        ]:
            exists = db.execute(
                select(Role).where(Role.company_id == company.id, Role.name == role_name)
            ).scalar_one_or_none()
            if exists is None:
                db.add(Role(company_id=company.id, name=role_name, description=description))

        admin_user = db.execute(
            select(User).where(
                User.company_id == company.id,
                User.email == settings.bootstrap_admin_email,
            )
        ).scalar_one_or_none()
        if admin_user is None:
            db.add(
                User(
                    company_id=company.id,
                    role_id=admin_role.id,
                    email=settings.bootstrap_admin_email,
                    full_name=settings.bootstrap_admin_name,
                    status="active",
                )
            )

        department = db.execute(
            select(Department).where(Department.company_id == company.id, Department.name == "General")
        ).scalar_one_or_none()
        if department is None:
            department = Department(company_id=company.id, name="General")
            db.add(department)
            db.flush()

        employee = db.execute(
            select(Employee).where(
                Employee.company_id == company.id,
                Employee.employee_code == settings.bootstrap_employee_code,
            )
        ).scalar_one_or_none()
        if employee is None:
            employee = Employee(
                company_id=company.id,
                department_id=department.id,
                employee_code=settings.bootstrap_employee_code,
                full_name=settings.bootstrap_employee_name,
                email=settings.bootstrap_employee_email,
                status="active",
            )
            db.add(employee)
            db.flush()

        token_hash = hash_token(settings.bootstrap_device_token)
        device = db.execute(
            select(Device).where(Device.token_sha256 == token_hash)
        ).scalar_one_or_none()
        if device is None:
            device_name = settings.bootstrap_device_name or "bootstrap-device"
            db.add(
                Device(
                    company_id=company.id,
                    employee_id=employee.id,
                    name=device_name,
                    hostname=device_name,
                    token_sha256=token_hash,
                    is_active=True,
                )
            )
        db.commit()


@app.on_event("startup")
def on_startup():
    os.makedirs(settings.storage_dir, exist_ok=True)
    Base.metadata.create_all(bind=engine)
    bootstrap_data()


@app.get("/health")
def health():
    return {"ok": True, "environment": settings.environment}


@app.post("/api/evidence/upload", status_code=status.HTTP_201_CREATED)
async def upload_evidence(
    request: Request,
    file: UploadFile = File(...),
    employee: str = Form(...),
    equipment: str = Form(...),
    captured_at: str = Form(...),
    sha256: str = Form(...),
    file_size: int = Form(...),
    agent_version: str = Form("unknown"),
    monitor_count: int = Form(1),
    device: Device = Depends(require_device),
    db: Session = Depends(get_db),
):
    client_ip = request.client.host if request.client else ""
    expected_sha = sha256.strip().lower()
    if len(expected_sha) != 64:
        record_attempt(db, "rejected", "Invalid SHA-256", device.id, expected_sha, client_ip)
        raise HTTPException(status_code=400, detail="Invalid SHA-256")

    try:
        extension = validate_image_name(file.filename or "")
    except ValueError as exc:
        record_attempt(db, "rejected", str(exc), device.id, expected_sha, client_ip)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if (file.content_type or "").lower() not in IMAGE_CONTENT_TYPES:
        record_attempt(db, "rejected", "Invalid image content type", device.id, expected_sha, client_ip)
        raise HTTPException(status_code=400, detail="Invalid image content type")

    captured_dt = parse_client_datetime(captured_at)
    evidence_id = new_id()
    temp_path = ""
    actual_size = 0
    hasher = hashlib.sha256()

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=extension) as temp_file:
            temp_path = temp_file.name
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                actual_size += len(chunk)
                if actual_size > settings.max_upload_bytes:
                    raise HTTPException(status_code=413, detail="Evidence file too large")
                hasher.update(chunk)
                temp_file.write(chunk)

        actual_sha = hasher.hexdigest()
        if actual_size != file_size:
            raise HTTPException(status_code=400, detail="File size mismatch")
        if actual_sha != expected_sha:
            raise HTTPException(status_code=400, detail="SHA-256 mismatch")
        validate_image_signature(temp_path, extension)

        existing = db.execute(
            select(EvidenceFile).where(
                EvidenceFile.device_id == device.id,
                EvidenceFile.sha256 == actual_sha,
            )
        ).scalar_one_or_none()
        if existing:
            record_attempt(db, "duplicate", "Duplicate evidence upload", device.id, actual_sha, client_ip)
            return {
                "ok": True,
                "duplicate": True,
                "evidence_id": existing.id,
                "sha256": existing.sha256,
                "storage_path": existing.storage_path,
            }

        relative_path = build_storage_path(
            company_id=device.company_id,
            device_name=device.name,
            captured_at=captured_dt,
            evidence_id=evidence_id,
            extension=extension,
        )
        save_from_temp(temp_path, relative_path)
        temp_path = ""

        evidence = EvidenceFile(
            id=evidence_id,
            company_id=device.company_id,
            device_id=device.id,
            employee_id=device.employee_id,
            employee=employee.strip()[:160] or "unknown",
            equipment=equipment.strip()[:160] or device.name,
            captured_at=captured_dt,
            original_filename=(file.filename or f"evidence{extension}")[:255],
            storage_path=relative_path,
            content_type=(file.content_type or "application/octet-stream")[:120],
            file_size=actual_size,
            sha256=actual_sha,
            agent_version=agent_version.strip()[:40] or "unknown",
            monitor_count=max(1, int(monitor_count or 1)),
            status="received",
        )
        db.add(evidence)
        db.commit()
        db.refresh(evidence)
        record_attempt(db, "received", "Evidence uploaded", device.id, actual_sha, client_ip)

        return {
            "ok": True,
            "evidence_id": evidence.id,
            "sha256": evidence.sha256,
            "storage_path": evidence.storage_path,
        }
    except HTTPException as exc:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)
        record_attempt(db, "rejected", str(exc.detail), device.id, expected_sha, client_ip)
        raise
    except IntegrityError:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)
        db.rollback()
        existing = db.execute(
            select(EvidenceFile).where(
                EvidenceFile.device_id == device.id,
                EvidenceFile.sha256 == expected_sha,
            )
        ).scalar_one_or_none()
        if existing:
            return {
                "ok": True,
                "duplicate": True,
                "evidence_id": existing.id,
                "sha256": existing.sha256,
                "storage_path": existing.storage_path,
            }
        raise
    finally:
        await file.close()

"""
main.py - VYNTRA Evidence API.
"""

from collections import defaultdict, deque
import csv
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
import base64
import io
import hashlib
import json
import math
import os
import re
import secrets
import smtplib
import tempfile
from time import monotonic
from typing import Literal

from fastapi import BackgroundTasks, Body, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import (
    AdminPrincipal,
    ROLE_PERMISSIONS,
    create_admin_access_token,
    hash_token,
    permissions_for_role,
    require_admin,
    require_device,
    require_permission,
    verify_password_hash,
)
from app.config import settings
from app.database import Base, engine, get_db, SessionLocal
from app.models import (
    Activity,
    AppCatalog,
    AuditLog,
    Company,
    CompanySetting,
    ConsentRecord,
    Department,
    Device,
    Employee,
    EmployeeCredential,
    EmployeeSchedule,
    EvidenceFile,
    EvidenceUploadAttempt,
    Incident,
    LoginAttempt,
    Position,
    ProductivityBlock,
    ProductivityRule,
    Role,
    Shift,
    ShiftEvent,
    OvertimeAuthorization,
    StationRestoreCode,
    StationLoginEvent,
    TimeAdjustment,
    User,
    WindowTitleCatalog,
    new_id,
    now_utc,
)
from app.storage import (
    IMAGE_CONTENT_TYPES,
    build_storage_path,
    save_from_temp,
    validate_image_name,
    validate_image_signature,
)


app = FastAPI(title=settings.app_name)

if settings.cors_allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH"],
        allow_headers=["Authorization", "Content-Type", "X-Admin-Token", "X-Device-Token"],
        max_age=600,
    )


class StrictPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AdminLoginPayload(StrictPayload):
    email: str = Field(..., min_length=3, max_length=180)
    password: str = Field(..., min_length=1, max_length=256)


class StationLoginPayload(StrictPayload):
    email: str | None = Field(default=None, max_length=180)
    correo: str | None = Field(default=None, max_length=180)
    password: str = Field(..., min_length=1, max_length=256)
    occurred_at: str | None = Field(default=None, max_length=40)
    agent_version: str | None = Field(default=None, max_length=40)


class StationPasswordChangePayload(StrictPayload):
    email: str = Field(..., min_length=3, max_length=180)
    current_password: str = Field(..., min_length=1, max_length=256)
    new_password: str = Field(..., min_length=8, max_length=256)


class StationPasswordResetRequestPayload(StrictPayload):
    email: str = Field(..., min_length=3, max_length=180)


class StationPasswordResetConfirmPayload(StrictPayload):
    email: str = Field(..., min_length=3, max_length=180)
    reset_code: str = Field(..., min_length=4, max_length=20)
    new_password: str = Field(..., min_length=8, max_length=256)


class DepartmentPayload(StrictPayload):
    company_id: str | None = Field(default=None, max_length=36)
    name: str = Field(..., min_length=2, max_length=120)


class EmployeeCreatePayload(StrictPayload):
    company_id: str | None = Field(default=None, max_length=36)
    full_name: str | None = Field(default=None, max_length=180)
    name: str | None = Field(default=None, max_length=180)
    email: str = Field(..., min_length=3, max_length=180)
    department_id: str | None = Field(default=None, max_length=36)
    new_department: str | None = Field(default=None, max_length=120)
    employee_code: str | None = Field(default=None, max_length=80)


class EmployeePatchPayload(StrictPayload):
    full_name: str | None = Field(default=None, max_length=180)
    name: str | None = Field(default=None, max_length=180)
    email: str | None = Field(default=None, min_length=3, max_length=180)
    department_id: str | None = Field(default=None, max_length=36)
    new_department: str | None = Field(default=None, max_length=120)
    status: str | None = Field(default=None, max_length=40)


class RestoreCodePayload(StrictPayload):
    employee_id: str = Field(..., min_length=1, max_length=36)
    valid_minutes: int = Field(default=60, ge=5, le=1440)
    reason: str | None = Field(default=None, max_length=180)


class AccessCodePayload(RestoreCodePayload):
    type: Literal["station_reopen", "overtime"]
    assigned_minutes: int | None = Field(default=None, ge=5, le=1440)


class ConsumeAccessCodePayload(StrictPayload):
    code: str = Field(..., min_length=4, max_length=80)
    type: Literal["station_reopen", "overtime"]


class ProductivityRulePayload(StrictPayload):
    company_id: str | None = Field(default=None, max_length=36)
    classification: Literal["productive", "neutral", "non_productive", "uncategorized"]
    department_id: str | None = Field(default=None, max_length=36)
    position_id: str | None = Field(default=None, max_length=36)
    employee_id: str | None = Field(default=None, max_length=36)
    executable_name: str | None = Field(default=None, max_length=160)
    title_contains: str | None = Field(default=None, max_length=255)
    priority: int = Field(default=100, ge=1, le=10000)
    is_active: bool = True
    notes: str | None = Field(default=None, max_length=2000)
    reclassify: bool = True
    rebuild_blocks: bool = True


class ProductivityRulePatchPayload(StrictPayload):
    classification: Literal["productive", "neutral", "non_productive", "uncategorized"] | None = None
    department_id: str | None = Field(default=None, max_length=36)
    position_id: str | None = Field(default=None, max_length=36)
    employee_id: str | None = Field(default=None, max_length=36)
    executable_name: str | None = Field(default=None, max_length=160)
    title_contains: str | None = Field(default=None, max_length=255)
    priority: int | None = Field(default=None, ge=1, le=10000)
    is_active: bool | None = None
    notes: str | None = Field(default=None, max_length=2000)
    reclassify: bool = True
    rebuild_blocks: bool = True


class ReclassifyPayload(StrictPayload):
    company_id: str | None = Field(default=None, max_length=36)
    rebuild_blocks: bool = True


class SchedulePayload(StrictPayload):
    start_time: str = Field(..., min_length=5, max_length=5)
    end_time: str = Field(..., min_length=5, max_length=5)
    effective_from: str | None = Field(default=None, max_length=10)
    timezone: str | None = Field(default=None, max_length=80)


class ShiftCorrectionPayload(StrictPayload):
    correction_reason: str = Field(..., min_length=3, max_length=180)
    started_at: str | None = Field(default=None, max_length=40)
    ended_at: str | None = Field(default=None, max_length=40)
    break_started_at: str | None = Field(default=None, max_length=40)
    break_ended_at: str | None = Field(default=None, max_length=40)
    lunch_started_at: str | None = Field(default=None, max_length=40)
    lunch_ended_at: str | None = Field(default=None, max_length=40)


class ShiftCreatePayload(ShiftCorrectionPayload):
    employee_id: str = Field(..., min_length=1, max_length=36)
    shift_date: str = Field(..., min_length=10, max_length=10)


class AgentEventsPayload(StrictPayload):
    events: list[dict] = Field(..., max_length=200)


class IncidentResolutionPayload(StrictPayload):
    status: Literal["approved", "rejected", "closed"]
    resolution_notes: str | None = Field(default=None, max_length=2000)


class SystemCompanyPayload(StrictPayload):
    name: str = Field(..., min_length=2, max_length=160)
    legal_name: str | None = Field(default=None, max_length=220)
    timezone: str | None = Field(default=None, max_length=80)


class SystemCompanyControlsPayload(StrictPayload):
    employee_limit: int = Field(default=0, ge=0, le=100000)
    subscription_status: Literal["active", "trial", "past_due", "suspended", "cancelled"] = "active"
    subscription_ends_at: str | None = Field(default=None, max_length=10)
    admin_notice: str | None = Field(default=None, max_length=255)


class SystemUserPayload(StrictPayload):
    company_id: str | None = Field(default=None, max_length=36)
    full_name: str = Field(..., min_length=2, max_length=180)
    email: str = Field(..., min_length=3, max_length=180)
    role: Literal["system_admin", "owner", "admin", "rrhh", "supervisor", "viewer"]


class SystemUserPatchPayload(StrictPayload):
    full_name: str | None = Field(default=None, min_length=2, max_length=180)
    role: Literal["system_admin", "owner", "admin", "rrhh", "supervisor", "viewer"] | None = None
    status: Literal["active", "inactive"] | None = None


class SystemUserPasswordResetPayload(StrictPayload):
    reason: str | None = Field(default=None, max_length=180)


class DeviceCreatePayload(StrictPayload):
    company_id: str | None = Field(default=None, max_length=36)
    employee_id: str | None = Field(default=None, max_length=36)
    name: str = Field(..., min_length=2, max_length=160)
    hostname: str | None = Field(default=None, max_length=160)
    location: str | None = Field(default=None, max_length=160)
    agent_version: str | None = Field(default=None, max_length=40)


class DevicePatchPayload(StrictPayload):
    employee_id: str | None = Field(default=None, max_length=36)
    name: str | None = Field(default=None, min_length=2, max_length=160)
    hostname: str | None = Field(default=None, max_length=160)
    location: str | None = Field(default=None, max_length=160)
    agent_version: str | None = Field(default=None, max_length=40)
    is_active: bool | None = None


class DeviceRotateTokenPayload(StrictPayload):
    reason: str | None = Field(default=None, max_length=180)


RATE_LIMITS = {
    ("POST", "/api/admin/login"): (8, 300),
    ("POST", "/api/station/login"): (20, 300),
    ("POST", "/api/station/password/change"): (8, 300),
    ("POST", "/api/station/password-reset/request"): (5, 300),
    ("POST", "/api/station/password-reset/confirm"): (8, 300),
    ("POST", "/api/evidence/upload"): (60, 60),
    ("POST", "/api/agent/events"): (120, 60),
}
_rate_buckets: dict[tuple[str, str, str], deque[float]] = defaultdict(deque)

IP_SCOPES = (
    ("/api/admin", settings.admin_allowed_ips),
    ("/api/audit", settings.admin_allowed_ips),
    ("/api/devices", settings.admin_allowed_ips),
    ("/api/system", settings.admin_allowed_ips),
    ("/api/settings", settings.admin_allowed_ips),
    ("/api/productivity", settings.admin_allowed_ips),
    ("/api/employees", settings.admin_allowed_ips),
    ("/api/attendance", settings.admin_allowed_ips),
    ("/api/incidents", settings.admin_allowed_ips),
    ("/api/station", settings.agent_allowed_ips),
    ("/api/agent", settings.agent_allowed_ips),
    ("/api/evidence", settings.agent_allowed_ips),
)


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def allow_local_testing_secrets() -> bool:
    return settings.environment.strip().lower() != "production"


def smtp_configured() -> bool:
    return bool(settings.smtp_host.strip() and settings.smtp_from_email.strip())


def send_plain_email(to_email: str, subject: str, body: str) -> str:
    recipient = clean_email(to_email)
    if not smtp_configured():
        return "not_configured"

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = f"{settings.smtp_from_name} <{settings.smtp_from_email}>"
    message["To"] = recipient
    message.set_content(body)

    try:
        if settings.smtp_use_ssl:
            with smtplib.SMTP_SSL(
                settings.smtp_host,
                settings.smtp_port,
                timeout=settings.smtp_timeout_seconds,
            ) as smtp:
                if settings.smtp_username:
                    smtp.login(settings.smtp_username, settings.smtp_password)
                smtp.send_message(message)
        else:
            with smtplib.SMTP(
                settings.smtp_host,
                settings.smtp_port,
                timeout=settings.smtp_timeout_seconds,
            ) as smtp:
                if settings.smtp_use_tls:
                    smtp.starttls()
                if settings.smtp_username:
                    smtp.login(settings.smtp_username, settings.smtp_password)
                smtp.send_message(message)
    except Exception:
        return "failed"

    return "sent"


def ip_allowed(path: str, ip_address: str) -> bool:
    for prefix, allowed_ips in IP_SCOPES:
        if path.startswith(prefix) and allowed_ips:
            return ip_address in allowed_ips
    return True


def rate_limit_exceeded(method: str, path: str, ip_address: str) -> tuple[bool, int]:
    limit = RATE_LIMITS.get((method.upper(), path))
    if not limit:
        return False, 0
    max_requests, window_seconds = limit
    bucket = _rate_buckets[(method.upper(), path, ip_address)]
    now = monotonic()
    while bucket and now - bucket[0] > window_seconds:
        bucket.popleft()
    if len(bucket) >= max_requests:
        retry_after = max(1, int(window_seconds - (now - bucket[0])))
        return True, retry_after
    bucket.append(now)
    return False, 0


@app.middleware("http")
async def security_rate_limiter(request: Request, call_next):
    ip_address = client_ip(request)
    if not ip_allowed(request.url.path, ip_address):
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"detail": "IP address is not allowed"},
        )
    limited, retry_after = rate_limit_exceeded(request.method, request.url.path, ip_address)
    if limited:
        return JSONResponse(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            content={"detail": "Too many requests"},
            headers={"Retry-After": str(retry_after)},
        )
    return await call_next(request)


def parse_client_datetime(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid captured_at datetime") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def parse_optional_client_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    return parse_client_datetime(value)


def json_text(value: dict | list | str | None) -> str:
    if value is None:
        return "{}"
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def title_hash(title: str) -> str:
    return hashlib.sha256(title.encode("utf-8")).hexdigest()


def clean_text(value: object, max_len: int = 255) -> str:
    return str(value or "").strip()[:max_len]


def clean_email(value: object) -> str:
    email = clean_text(value, 180).lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise HTTPException(status_code=400, detail="Invalid email")
    return email


def generate_password(length: int = 14) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*?"
    while True:
        password = "".join(secrets.choice(alphabet) for _ in range(length))
        if (
            any(char.islower() for char in password)
            and any(char.isupper() for char in password)
            and any(char.isdigit() for char in password)
            and any(char in "!@#$%*?" for char in password)
        ):
            return password


def generate_device_token() -> str:
    return secrets.token_urlsafe(32)


def validate_password_policy(password: str):
    signs = "!@#$%*?_-."
    if len(password or "") < 8:
        raise HTTPException(status_code=400, detail="Password must have at least 8 characters")
    if not any(char.islower() for char in password):
        raise HTTPException(status_code=400, detail="Password must include a lowercase letter")
    if not any(char.isupper() for char in password):
        raise HTTPException(status_code=400, detail="Password must include an uppercase letter")
    if not any(char.isdigit() for char in password):
        raise HTTPException(status_code=400, detail="Password must include a number")
    if not any(char in signs for char in password):
        raise HTTPException(status_code=400, detail="Password must include a special character")


def generate_reset_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def hash_password(password: str) -> str:
    iterations = 390000
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "pbkdf2_sha256:{}:{}:{}".format(
        iterations,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def generate_restore_code() -> str:
    return "-".join(secrets.token_hex(2).upper() for _ in range(3))


def public_app_line() -> str:
    app_url = settings.app_public_url.strip()
    if not app_url:
        return ""
    return f"\nPanel VYNTRA: {app_url}\n"


def temporary_password_email_body(company: Company, employee: Employee, login_email: str, password: str) -> str:
    return (
        f"Hola {employee.full_name},\n\n"
        f"Se creo tu acceso a VYNTRA para {company.name}.\n\n"
        f"Correo: {login_email}\n"
        f"Contrasena temporal: {password}\n\n"
        "Por seguridad, la estacion te pedira cambiar esta contrasena en el primer ingreso."
        f"{public_app_line()}"
        "\nSi no esperabas este acceso, contacta a RR. HH."
    )


def reset_code_email_body(company: Company, reset_code: str) -> str:
    return (
        f"Recibimos una solicitud para restablecer tu contrasena de VYNTRA en {company.name}.\n\n"
        f"Codigo de verificacion: {reset_code}\n\n"
        "Este codigo vence en 10 minutos. Si no solicitaste este cambio, ignora este mensaje."
    )


def access_code_email_body(
    company: Company,
    employee: Employee,
    access_type: str,
    code_value: str,
    valid_minutes: int,
    assigned_minutes: int | None = None,
) -> str:
    label = "horas extra" if access_type == "overtime" else "reabrir estacion"
    extra = f"\nMinutos asignados: {assigned_minutes}\n" if assigned_minutes else ""
    return (
        f"Hola {employee.full_name},\n\n"
        f"Se genero un codigo de {label} para tu estacion VYNTRA en {company.name}.\n\n"
        f"Codigo: {code_value}\n"
        f"Vigencia: {valid_minutes} minutos\n"
        f"{extra}\n"
        "El codigo es de un solo uso. Si no lo solicitaste, contacta a tu supervisor o RR. HH."
    )


def panel_user_email_body(company: Company, full_name: str, email: str, password: str, role_name: str) -> str:
    role_labels = {
        "system_admin": "Administrador del sistema",
        "owner": "Owner de empresa",
        "admin": "Administrador de empresa",
        "rrhh": "Recursos humanos",
        "supervisor": "Supervisor",
        "viewer": "Solo lectura",
    }
    return (
        f"Hola {full_name},\n\n"
        f"Se creo tu acceso al panel VYNTRA para {company.name}.\n\n"
        f"Rol: {role_labels.get(role_name, role_name)}\n"
        f"Correo: {email}\n"
        f"Contrasena temporal: {password}\n"
        f"{public_app_line()}"
        "\nCambia esta contrasena despues del primer ingreso y no la compartas."
    )


def percent(part: int | float, whole: int | float) -> float:
    if whole <= 0:
        return 0.0
    return round((part / whole) * 100, 2)


def get_default_company(db: Session) -> Company:
    company = db.execute(select(Company).order_by(Company.created_at)).scalars().first()
    if company is None:
        raise HTTPException(status_code=404, detail="No company found")
    return company


def resolve_company(db: Session, company_id: str | None = None) -> Company:
    if company_id:
        company = db.get(Company, company_id)
        if company is None:
            raise HTTPException(status_code=404, detail="Company not found")
        return company
    return get_default_company(db)


def require_company_owned(db: Session, model, row_id: str | None, company_id: str, label: str):
    if not row_id:
        return None
    row = db.get(model, row_id)
    if row is None or getattr(row, "company_id", None) != company_id:
        raise HTTPException(status_code=400, detail=f"{label} not found for company")
    return row


def resolve_admin_company(
    db: Session,
    admin: AdminPrincipal,
    company_id: str | None = None,
) -> Company:
    if admin.auth_method == "legacy_token":
        return resolve_company(db, company_id)
    if admin.role == "system_admin":
        return resolve_company(db, company_id or admin.company_id)
    if company_id and company_id != admin.company_id:
        raise HTTPException(status_code=403, detail="Cannot access another company")
    return resolve_company(db, admin.company_id)


def require_system_admin(admin: AdminPrincipal):
    if admin.role != "system_admin":
        raise HTTPException(status_code=403, detail="System administrator role required")


def serialize_rule(db: Session, rule: ProductivityRule) -> dict:
    department = db.get(Department, rule.department_id) if rule.department_id else None
    position = db.get(Position, rule.position_id) if rule.position_id else None
    employee = db.get(Employee, rule.employee_id) if rule.employee_id else None
    return {
        "id": rule.id,
        "company_id": rule.company_id,
        "department_id": rule.department_id,
        "department": department.name if department else None,
        "position_id": rule.position_id,
        "position": position.name if position else None,
        "employee_id": rule.employee_id,
        "employee": employee.full_name if employee else None,
        "executable_name": rule.executable_name,
        "title_contains": rule.title_contains,
        "classification": rule.classification,
        "priority": rule.priority,
        "is_active": rule.is_active,
        "notes": rule.notes,
        "created_at": rule.created_at.isoformat() if rule.created_at else None,
        "updated_at": rule.updated_at.isoformat() if rule.updated_at else None,
    }


def validate_date(value: str | None, field_name: str = "date") -> str:
    value = clean_text(value, 10)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise HTTPException(status_code=400, detail=f"Invalid {field_name}")
    return value


def validate_time(value: str | None, field_name: str = "time") -> str:
    value = clean_text(value, 5)
    if not re.fullmatch(r"\d{2}:\d{2}", value):
        raise HTTPException(status_code=400, detail=f"Invalid {field_name}")
    hour, minute = [int(part) for part in value.split(":")]
    if hour > 23 or minute > 59:
        raise HTTPException(status_code=400, detail=f"Invalid {field_name}")
    return value


COMPANY_CONTROL_DEFAULTS = {
    "employee_limit": "0",
    "subscription_status": "active",
    "subscription_ends_at": "",
    "admin_notice": "",
}


def get_company_settings_map(db: Session, company_id: str) -> dict[str, str]:
    rows = db.execute(
        select(CompanySetting).where(CompanySetting.company_id == company_id)
    ).scalars().all()
    values = {row.key: row.value for row in rows}
    return {**COMPANY_CONTROL_DEFAULTS, **values}


def set_company_setting(db: Session, company_id: str, key: str, value: str, description: str = ""):
    row = db.execute(
        select(CompanySetting).where(
            CompanySetting.company_id == company_id,
            CompanySetting.key == key,
        )
    ).scalar_one_or_none()
    if row is None:
        db.add(
            CompanySetting(
                company_id=company_id,
                key=key,
                value=value[:255],
                description=description,
                updated_at=now_utc(),
            )
        )
        return
    row.value = value[:255]
    if description:
        row.description = description
    row.updated_at = now_utc()


def company_controls(db: Session, company_id: str) -> dict:
    values = get_company_settings_map(db, company_id)
    try:
        employee_limit = max(0, int(values.get("employee_limit") or "0"))
    except ValueError:
        employee_limit = 0
    return {
        "employee_limit": employee_limit,
        "subscription_status": values.get("subscription_status") or "active",
        "subscription_ends_at": values.get("subscription_ends_at") or "",
        "admin_notice": values.get("admin_notice") or "",
    }


def seconds_between(start: datetime | None, end: datetime | None) -> int:
    if not start or not end or end <= start:
        return 0
    return int((end - start).total_seconds())


def first_event(events: list[ShiftEvent], event_type: str) -> ShiftEvent | None:
    return next((event for event in events if event.event_type == event_type), None)


def latest_employee_schedule(db: Session, employee_id: str, on_date: str | None = None) -> EmployeeSchedule | None:
    query = select(EmployeeSchedule).where(
        EmployeeSchedule.employee_id == employee_id,
        EmployeeSchedule.is_active.is_(True),
    )
    if on_date:
        query = query.where(EmployeeSchedule.effective_from <= on_date)
    return db.execute(query.order_by(EmployeeSchedule.effective_from.desc())).scalars().first()


def serialize_employee_for_attendance(
    employee: Employee,
    departments: dict[str, Department],
    positions: dict[str, Position],
    schedule: EmployeeSchedule | None,
) -> dict:
    return {
        "id": employee.id,
        "employee_code": employee.employee_code,
        "full_name": employee.full_name,
        "email": employee.email,
        "department_id": employee.department_id,
        "department": departments[employee.department_id].name
        if employee.department_id in departments
        else None,
        "position_id": employee.position_id,
        "position": positions[employee.position_id].name
        if employee.position_id in positions
        else None,
        "status": employee.status,
        "schedule": {
            "id": schedule.id if schedule else None,
            "start_time": schedule.start_time if schedule else "08:00",
            "end_time": schedule.end_time if schedule else "17:00",
            "effective_from": schedule.effective_from if schedule else "1970-01-01",
            "timezone": schedule.timezone if schedule else "America/Managua",
        },
    }


def serialize_shift_for_attendance(
    shift: Shift,
    events_by_shift: dict[str, list[ShiftEvent]],
    justified_by_shift: dict[str, int] | None = None,
) -> dict:
    justified_by_shift = justified_by_shift or {}
    return {
        "id": shift.id,
        "company_id": shift.company_id,
        "employee_id": shift.employee_id,
        "device_id": shift.device_id,
        "shift_date": shift.shift_date,
        "status": shift.status,
        "started_at": shift.started_at.isoformat() if shift.started_at else None,
        "ended_at": shift.ended_at.isoformat() if shift.ended_at else None,
        "work_seconds": shift.work_seconds,
        "break_seconds": shift.break_seconds,
        "lunch_seconds": shift.lunch_seconds,
        "idle_seconds": shift.idle_seconds,
        "justified_seconds": int(justified_by_shift.get(shift.id, 0) or 0),
        "events": [
            {
                "id": event.id,
                "event_type": event.event_type,
                "occurred_at": event.occurred_at.isoformat(),
            }
            for event in events_by_shift.get(shift.id, [])
        ],
    }


def serialize_department(department: Department) -> dict:
    return {
        "id": department.id,
        "name": department.name,
        "status": department.status,
    }


def serialize_employee(employee: Employee, department: Department | None = None, position: Position | None = None) -> dict:
    return {
        "id": employee.id,
        "employee_code": employee.employee_code,
        "full_name": employee.full_name,
        "email": employee.email,
        "department_id": employee.department_id,
        "department": department.name if department else None,
        "position_id": employee.position_id,
        "position": position.name if position else None,
        "status": employee.status,
    }


def serialize_restore_code(code: StationRestoreCode, employee: Employee | None = None) -> dict:
    return {
        "id": code.id,
        "employee_id": code.employee_id,
        "employee": employee.full_name if employee else None,
        "email": employee.email if employee else "",
        "code": code.code if allow_local_testing_secrets() else "",
        "status": code.status,
        "reason": code.reason,
        "valid_from": code.valid_from.isoformat(),
        "valid_until": code.valid_until.isoformat(),
        "used_at": code.used_at.isoformat() if code.used_at else None,
        "created_at": code.created_at.isoformat() if code.created_at else None,
    }


def serialize_overtime_authorization(code: OvertimeAuthorization, employee: Employee | None = None) -> dict:
    return {
        "id": code.id,
        "employee_id": code.employee_id,
        "employee": employee.full_name if employee else None,
        "email": employee.email if employee else "",
        "code": code.code if allow_local_testing_secrets() else "",
        "status": code.status,
        "reason": code.reason,
        "assigned_minutes": code.assigned_minutes,
        "valid_from": code.valid_from.isoformat(),
        "valid_until": code.valid_until.isoformat(),
        "used_at": code.started_at.isoformat() if code.started_at else None,
        "created_at": code.created_at.isoformat() if code.created_at else None,
    }


def serialize_access_code(kind: str, code: StationRestoreCode | OvertimeAuthorization, employee: Employee | None = None) -> dict:
    labels = {
        "station_reopen": "Reabrir estacion",
        "overtime": "Horas extra",
    }
    base = (
        serialize_overtime_authorization(code, employee)
        if kind == "overtime"
        else serialize_restore_code(code, employee)
    )
    return {**base, "type": kind, "type_label": labels[kind]}


def serialize_device(device: Device, company: Company | None = None, employee: Employee | None = None) -> dict:
    online_cutoff = now_utc() - timedelta(minutes=10)
    is_online = bool(device.is_active and device.last_seen_at and _as_aware_utc(device.last_seen_at) >= online_cutoff)
    return {
        "id": device.id,
        "company_id": device.company_id,
        "company": company.name if company else "",
        "employee_id": device.employee_id,
        "employee": employee.full_name if employee else "",
        "employee_code": employee.employee_code if employee else "",
        "name": device.name,
        "hostname": device.hostname,
        "location": device.location,
        "is_active": device.is_active,
        "status": "online" if is_online else ("offline" if device.is_active else "revoked"),
        "agent_version": device.agent_version,
        "created_at": device.created_at.isoformat() if device.created_at else None,
        "last_seen_at": device.last_seen_at.isoformat() if device.last_seen_at else None,
    }


def _as_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def serialize_incident(db: Session, incident: Incident) -> dict:
    employee = db.get(Employee, incident.employee_id)
    device = db.get(Device, incident.device_id) if incident.device_id else None
    try:
        payload = json.loads(incident.payload_json or "{}")
    except json.JSONDecodeError:
        payload = {}
    adjustment = db.execute(
        select(TimeAdjustment).where(TimeAdjustment.incident_id == incident.id)
    ).scalar_one_or_none()
    return {
        "id": incident.id,
        "company_id": incident.company_id,
        "employee_id": incident.employee_id,
        "employee": employee.full_name if employee else None,
        "employee_code": employee.employee_code if employee else None,
        "device_id": incident.device_id,
        "device": device.name if device else None,
        "incident_type": incident.incident_type,
        "status": incident.status,
        "title": incident.title,
        "description": incident.description,
        "requested_at": incident.requested_at.isoformat() if incident.requested_at else None,
        "resolved_at": incident.resolved_at.isoformat() if incident.resolved_at else None,
        "resolution_notes": incident.resolution_notes,
        "time_adjustment": serialize_time_adjustment(adjustment) if adjustment else None,
        "payload": payload,
    }


def row_metric(row, key: str) -> int | float:
    if isinstance(row, dict):
        return row.get(key, 0) or 0
    return getattr(row, key, 0) or 0


def productivity_totals(blocks: list[ProductivityBlock | dict]) -> dict:
    totals = {
        "total_seconds": sum(int(row_metric(row, "total_seconds")) for row in blocks),
        "active_seconds": sum(int(row_metric(row, "active_seconds")) for row in blocks),
        "productive_seconds": sum(int(row_metric(row, "productive_seconds")) for row in blocks),
        "neutral_seconds": sum(int(row_metric(row, "neutral_seconds")) for row in blocks),
        "non_productive_seconds": sum(int(row_metric(row, "non_productive_seconds")) for row in blocks),
        "uncategorized_seconds": sum(int(row_metric(row, "uncategorized_seconds")) for row in blocks),
        "idle_seconds": sum(int(row_metric(row, "idle_seconds")) for row in blocks),
        "break_seconds": sum(int(row_metric(row, "break_seconds")) for row in blocks),
        "lunch_seconds": sum(int(row_metric(row, "lunch_seconds")) for row in blocks),
        "break_lunch_seconds": sum(int(row_metric(row, "break_lunch_seconds")) for row in blocks),
        "justified_seconds": sum(int(row_metric(row, "justified_seconds")) for row in blocks),
    }
    active = totals["active_seconds"]
    total = totals["total_seconds"]
    totals.update(
        {
            "productivity_pct": percent(totals["productive_seconds"], active),
            "acceptable_pct": percent(totals["productive_seconds"] + totals["neutral_seconds"], active),
            "non_productive_pct": percent(totals["non_productive_seconds"], active),
            "neutral_pct": percent(totals["neutral_seconds"], active),
            "uncategorized_pct": percent(totals["uncategorized_seconds"], active),
            "idle_pct": percent(totals["idle_seconds"], total),
            "break_pct": percent(totals["break_seconds"], total),
            "lunch_pct": percent(totals["lunch_seconds"], total),
        }
    )
    return totals


def serialize_productivity_block(row: ProductivityBlock) -> dict:
    return {
        "id": row.id,
        "employee_id": row.employee_id,
        "department_id": row.department_id_snapshot,
        "block_date": row.block_date,
        "block_start": row.block_start,
        "total_seconds": row.total_seconds,
        "active_seconds": row.active_seconds,
        "productive_seconds": row.productive_seconds,
        "neutral_seconds": row.neutral_seconds,
        "non_productive_seconds": row.non_productive_seconds,
        "uncategorized_seconds": row.uncategorized_seconds,
        "idle_seconds": row.idle_seconds,
        "break_seconds": row.break_seconds,
        "lunch_seconds": row.lunch_seconds,
        "break_lunch_seconds": row.break_lunch_seconds,
        "justified_seconds": 0,
        "productivity_pct": row.productivity_pct,
        "acceptable_pct": row.acceptable_pct,
        "non_productive_pct": row.non_productive_pct,
        "neutral_pct": row.neutral_pct,
        "uncategorized_pct": row.uncategorized_pct,
        "idle_pct": row.idle_pct,
        "break_pct": row.break_pct,
        "lunch_pct": row.lunch_pct,
    }


def serialize_time_adjustment(row: TimeAdjustment) -> dict:
    return {
        "id": row.id,
        "company_id": row.company_id,
        "employee_id": row.employee_id,
        "device_id": row.device_id,
        "incident_id": row.incident_id,
        "adjustment_type": row.adjustment_type,
        "status": row.status,
        "started_at": row.started_at.isoformat(),
        "ended_at": row.ended_at.isoformat(),
        "seconds": row.seconds,
        "productivity_classification": row.productivity_classification,
        "reason": row.reason,
        "notes": row.notes,
    }


def parse_json_payload(value: str) -> dict | list | str:
    try:
        return json.loads(value or "{}")
    except json.JSONDecodeError:
        return value or ""


def serialize_audit_log(row: AuditLog, company: Company | None = None, actor: User | None = None) -> dict:
    return {
        "id": row.id,
        "company_id": row.company_id,
        "company": company.name if company else "",
        "user_id": row.user_id,
        "actor": actor.full_name if actor else "",
        "actor_email": actor.email if actor else "",
        "device_id": row.device_id,
        "action": row.action,
        "entity_type": row.entity_type,
        "entity_id": row.entity_id,
        "ip_address": row.ip_address,
        "payload": parse_json_payload(row.payload_json),
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def setting_int(db: Session, company_id: str, key: str, default: int) -> int:
    row = db.execute(
        select(CompanySetting).where(
            CompanySetting.company_id == company_id,
            CompanySetting.key == key,
        )
    ).scalar_one_or_none()
    if not row:
        return default
    try:
        return int(row.value)
    except ValueError:
        return default


def block_start_for(ts: datetime, block_minutes: int) -> datetime:
    ts = _as_aware_utc(ts)
    minute = (ts.minute // block_minutes) * block_minutes
    return ts.replace(minute=minute, second=0, microsecond=0)


def incident_adjustment_window(incident: Incident) -> tuple[datetime, datetime, int]:
    try:
        payload = json.loads(incident.payload_json or "{}")
    except json.JSONDecodeError:
        payload = {}
    evidence = payload.get("evidencia_tecnica") or {}
    if not isinstance(evidence, dict):
        evidence = {}
    try:
        minutes = int(evidence.get("minutos_estimados") or payload.get("minutos_estimados") or 0)
    except (TypeError, ValueError):
        minutes = 0
    minutes = max(1, min(minutes or 15, 1440))
    started_at = (
        parse_optional_client_datetime(evidence.get("inicio_sugerido"))
        or parse_optional_client_datetime(payload.get("inicio_sugerido"))
    )
    ended_at = (
        parse_optional_client_datetime(evidence.get("fin_sugerido"))
        or parse_optional_client_datetime(payload.get("fin_sugerido"))
    )
    if not started_at and incident.requested_at:
        started_at = _as_aware_utc(incident.requested_at) - timedelta(minutes=minutes)
    if not started_at:
        started_at = now_utc() - timedelta(minutes=minutes)
    if not ended_at:
        ended_at = started_at + timedelta(minutes=minutes)
    started_at = _as_aware_utc(started_at)
    ended_at = _as_aware_utc(ended_at)
    if ended_at <= started_at:
        ended_at = started_at + timedelta(minutes=minutes)
    seconds = max(60, min(int((ended_at - started_at).total_seconds()), 86400))
    ended_at = started_at + timedelta(seconds=seconds)
    return started_at, ended_at, seconds


def upsert_time_adjustment_for_incident(
    db: Session,
    incident: Incident,
    admin: AdminPrincipal,
    resolution_notes: str,
) -> TimeAdjustment:
    started_at, ended_at, seconds = incident_adjustment_window(incident)
    adjustment = db.execute(
        select(TimeAdjustment).where(TimeAdjustment.incident_id == incident.id)
    ).scalar_one_or_none()
    if adjustment is None:
        adjustment = TimeAdjustment(
            company_id=incident.company_id,
            employee_id=incident.employee_id,
            device_id=incident.device_id,
            incident_id=incident.id,
            created_by_user_id=admin.user_id,
            started_at=started_at,
            ended_at=ended_at,
            seconds=seconds,
        )
        db.add(adjustment)
    adjustment.status = "active"
    adjustment.adjustment_type = "justified_time"
    adjustment.started_at = started_at
    adjustment.ended_at = ended_at
    adjustment.seconds = seconds
    adjustment.productivity_classification = "neutral"
    adjustment.reason = clean_text(incident.title or incident.incident_type, 180)
    adjustment.notes = clean_text(resolution_notes, 2000)
    adjustment.updated_at = now_utc()
    return adjustment


def void_time_adjustment_for_incident(db: Session, incident: Incident) -> TimeAdjustment | None:
    adjustment = db.execute(
        select(TimeAdjustment).where(TimeAdjustment.incident_id == incident.id)
    ).scalar_one_or_none()
    if adjustment:
        adjustment.status = "voided"
        adjustment.updated_at = now_utc()
    return adjustment


def query_active_time_adjustments(
    db: Session,
    company_id: str,
    date_from: str | None = None,
    date_to: str | None = None,
    employee_id: str | None = None,
    department_id: str | None = None,
) -> list[TimeAdjustment]:
    query = select(TimeAdjustment).where(
        TimeAdjustment.company_id == company_id,
        TimeAdjustment.status == "active",
    )
    if employee_id:
        query = query.where(TimeAdjustment.employee_id == employee_id)
    if department_id:
        employee_ids = [
            row.id
            for row in db.execute(
                select(Employee).where(
                    Employee.company_id == company_id,
                    Employee.department_id == department_id,
                )
            ).scalars()
        ]
        query = query.where(TimeAdjustment.employee_id.in_(employee_ids or [""]))
    if date_from:
        query = query.where(TimeAdjustment.ended_at >= parse_client_datetime(f"{date_from}T00:00:00+00:00"))
    if date_to:
        query = query.where(TimeAdjustment.started_at <= parse_client_datetime(f"{date_to}T23:59:59+00:00"))
    return db.execute(query.order_by(TimeAdjustment.started_at)).scalars().all()


def adjustment_virtual_blocks(
    db: Session,
    adjustments: list[TimeAdjustment],
    employees: dict[str, Employee],
) -> list[dict]:
    rows: list[dict] = []
    for adjustment in adjustments:
        block_minutes = setting_int(db, adjustment.company_id, "productivity_block_minutes", 30)
        current = _as_aware_utc(adjustment.started_at)
        interval_end = _as_aware_utc(adjustment.ended_at)
        remaining = max(0, int((interval_end - current).total_seconds()))
        employee = employees.get(adjustment.employee_id)
        department_id = employee.department_id if employee else None
        while remaining > 0:
            block_start = block_start_for(current, block_minutes)
            block_end = block_start + timedelta(minutes=block_minutes)
            seconds_to_boundary = (block_end - current).total_seconds()
            if seconds_to_boundary <= 0:
                current = block_end
                continue
            seconds = min(remaining, max(1, int(math.ceil(seconds_to_boundary))))
            rows.append(
                {
                    "id": f"adjustment:{adjustment.id}:{block_start:%Y%m%d%H%M}",
                    "employee_id": adjustment.employee_id,
                    "department_id": department_id,
                    "block_date": block_start.date().isoformat(),
                    "block_start": block_start.strftime("%H:%M"),
                    "total_seconds": seconds,
                    "active_seconds": seconds,
                    "productive_seconds": 0,
                    "neutral_seconds": seconds,
                    "non_productive_seconds": 0,
                    "uncategorized_seconds": 0,
                    "idle_seconds": 0,
                    "break_seconds": 0,
                    "lunch_seconds": 0,
                    "break_lunch_seconds": 0,
                    "justified_seconds": seconds,
                }
            )
            current += timedelta(seconds=seconds)
            remaining -= seconds
    for row in rows:
        active = row["active_seconds"]
        total = row["total_seconds"]
        row["productivity_pct"] = percent(row["productive_seconds"], active)
        row["acceptable_pct"] = percent(row["productive_seconds"] + row["neutral_seconds"], active)
        row["non_productive_pct"] = percent(row["non_productive_seconds"], active)
        row["neutral_pct"] = percent(row["neutral_seconds"], active)
        row["uncategorized_pct"] = percent(row["uncategorized_seconds"], active)
        row["idle_pct"] = percent(row["idle_seconds"], total)
        row["break_pct"] = percent(row["break_seconds"], total)
        row["lunch_pct"] = percent(row["lunch_seconds"], total)
    return rows


def update_shift_event(
    db: Session,
    shift: Shift,
    events: dict[str, ShiftEvent],
    event_type: str,
    occurred_at: datetime | None,
):
    current = events.get(event_type)
    if occurred_at is None:
        if current:
            db.delete(current)
        return
    if current:
        current.occurred_at = occurred_at
        current.payload_json = json_text({"source": "admin_correction"})
    else:
        db.add(
            ShiftEvent(
                shift_id=shift.id,
                event_type=event_type,
                occurred_at=occurred_at,
                payload_json=json_text({"source": "admin_correction"}),
            )
        )


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


def seed_productivity_rules(db: Session, company_id: str):
    departments = {
        row.name: row
        for row in db.execute(
            select(Department).where(Department.company_id == company_id)
        ).scalars()
    }
    positions = {
        row.name: row
        for row in db.execute(
            select(Position).where(Position.company_id == company_id)
        ).scalars()
    }

    def dep(name: str) -> str | None:
        row = departments.get(name)
        return row.id if row else None

    def pos(name: str) -> str | None:
        row = positions.get(name)
        return row.id if row else None

    seed_rules = [
        # Reglas globales: punto de partida que el admin podra editar.
        ("", "", "msedge.exe", "Netflix", "non_productive", 100, "Global: streaming no productivo."),
        ("", "", "chrome.exe", "Netflix", "non_productive", 100, "Global: streaming no productivo."),
        ("", "", "msedge.exe", "Disney+", "non_productive", 100, "Global: streaming no productivo."),
        ("", "", "chrome.exe", "Disney+", "non_productive", 100, "Global: streaming no productivo."),
        ("", "", "msedge.exe", "Prime Video", "non_productive", 100, "Global: streaming no productivo."),
        ("", "", "chrome.exe", "Prime Video", "non_productive", 100, "Global: streaming no productivo."),
        ("", "", "msedge.exe", "HBO Max", "non_productive", 100, "Global: streaming no productivo."),
        ("", "", "chrome.exe", "HBO Max", "non_productive", 100, "Global: streaming no productivo."),
        ("", "", "msedge.exe", "Twitch", "non_productive", 100, "Global: entretenimiento en vivo."),
        ("", "", "chrome.exe", "Twitch", "non_productive", 100, "Global: entretenimiento en vivo."),
        ("", "", "msedge.exe", "TikTok", "non_productive", 100, "Global: red social no productiva por defecto."),
        ("", "", "chrome.exe", "TikTok", "non_productive", 100, "Global: red social no productiva por defecto."),
        ("", "", "msedge.exe", "Facebook", "non_productive", 90, "Global: red social no productiva por defecto."),
        ("", "", "chrome.exe", "Facebook", "non_productive", 90, "Global: red social no productiva por defecto."),
        ("", "", "msedge.exe", "Instagram", "non_productive", 90, "Global: red social no productiva por defecto."),
        ("", "", "chrome.exe", "Instagram", "non_productive", 90, "Global: red social no productiva por defecto."),
        ("", "", "msedge.exe", "YouTube", "neutral", 80, "Global: YouTube depende del rol/departamento."),
        ("", "", "chrome.exe", "YouTube", "neutral", 80, "Global: YouTube depende del rol/departamento."),
        ("", "", "msedge.exe", "LinkedIn", "neutral", 80, "Global: red profesional depende del area."),
        ("", "", "chrome.exe", "LinkedIn", "neutral", 80, "Global: red profesional depende del area."),
        ("", "", "Discord.exe", "", "neutral", 70, "Global: comunicacion depende del area."),
        ("", "", "Slack.exe", "", "productive", 60, "Global: comunicacion corporativa."),
        ("", "", "Spotify.exe", "", "neutral", 70, "Global: audio en segundo plano, no mide productividad central."),
        ("", "", "WhatsApp.Root.exe", "", "neutral", 70, "Global: mensajeria depende del area."),
        ("", "", "explorer.exe", "", "neutral", 60, "Global: explorador de archivos."),
        ("", "", "SearchHost.exe", "", "neutral", 60, "Global: busqueda de Windows."),
        ("", "", "SystemSettings.exe", "", "neutral", 60, "Global: configuracion de Windows."),
        ("", "", "Taskmgr.exe", "", "neutral", 60, "Global: administrador de tareas."),
        ("", "", "notepad.exe", "", "neutral", 60, "Global: notas simples."),
        ("", "", "Notepad.exe", "", "neutral", 60, "Global: notas simples."),
        ("", "", "CalculatorApp.exe", "", "neutral", 60, "Global: calculadora."),
        ("", "", "SnippingTool.exe", "", "neutral", 60, "Global: recortes/capturas."),
        ("", "", "mspaint.exe", "", "neutral", 60, "Global: edicion simple de imagen."),
        ("", "", "OUTLOOK.EXE", "", "productive", 60, "Global: correo corporativo."),
        ("", "", "EXCEL.EXE", "", "productive", 60, "Global: hojas de calculo."),
        ("", "", "WINWORD.EXE", "", "productive", 60, "Global: documentos."),
        ("", "", "POWERPNT.EXE", "", "productive", 60, "Global: presentaciones."),
        ("", "", "Teams.exe", "", "productive", 60, "Global: comunicacion corporativa."),
        ("", "", "Zoom.exe", "", "productive", 60, "Global: reuniones."),
        ("", "", "chrome.exe", "Google Drive", "neutral", 80, "Global: archivos en la nube."),
        ("", "", "msedge.exe", "Google Drive", "neutral", 80, "Global: archivos en la nube."),
        ("", "", "chrome.exe", "Google Docs", "productive", 90, "Global: documentos en la nube."),
        ("", "", "msedge.exe", "Google Docs", "productive", 90, "Global: documentos en la nube."),
        ("", "", "chrome.exe", "Google Sheets", "productive", 90, "Global: hojas en la nube."),
        ("", "", "msedge.exe", "Google Sheets", "productive", 90, "Global: hojas en la nube."),
        ("", "", "chrome.exe", "Google Slides", "productive", 90, "Global: presentaciones en la nube."),
        ("", "", "msedge.exe", "Google Slides", "productive", 90, "Global: presentaciones en la nube."),
        ("", "", "chrome.exe", "Gmail", "neutral", 80, "Global: correo depende del area."),
        ("", "", "msedge.exe", "Gmail", "neutral", 80, "Global: correo depende del area."),
        ("", "", "chrome.exe", "Google Calendar", "neutral", 80, "Global: agenda."),
        ("", "", "msedge.exe", "Google Calendar", "neutral", 80, "Global: agenda."),
        ("", "", "chrome.exe", "Google Cloud", "productive", 100, "Global: infraestructura cloud."),
        ("", "", "msedge.exe", "Google Cloud", "productive", 100, "Global: infraestructura cloud."),
        ("", "", "chrome.exe", "Google Auth Platform", "productive", 100, "Global: configuracion tecnica."),
        ("", "", "msedge.exe", "Google Auth Platform", "productive", 100, "Global: configuracion tecnica."),
        ("", "", "chrome.exe", "Google Authorization APIs", "productive", 100, "Global: configuracion tecnica."),
        ("", "", "msedge.exe", "Google Authorization APIs", "productive", 100, "Global: configuracion tecnica."),
        ("", "", "chrome.exe", "OneDrive", "neutral", 80, "Global: archivos en la nube."),
        ("", "", "msedge.exe", "OneDrive", "neutral", 80, "Global: archivos en la nube."),
        ("", "", "chrome.exe", "Dropbox", "neutral", 80, "Global: archivos en la nube."),
        ("", "", "msedge.exe", "Dropbox", "neutral", 80, "Global: archivos en la nube."),
        ("", "", "ChatGPT.exe", "", "productive", 100, "Global: asistente de trabajo."),
        ("", "", "chrome.exe", "ChatGPT", "productive", 100, "Global: asistente de trabajo."),
        ("", "", "msedge.exe", "ChatGPT", "productive", 100, "Global: asistente de trabajo."),
        ("", "", "chrome.exe", "Claude", "productive", 100, "Global: asistente de trabajo."),
        ("", "", "msedge.exe", "Claude", "productive", 100, "Global: asistente de trabajo."),
        ("", "", "chrome.exe", "DeepSeek", "productive", 100, "Global: asistente de trabajo."),
        ("", "", "msedge.exe", "DeepSeek", "productive", 100, "Global: asistente de trabajo."),
        ("", "", "python.exe", "VYNTRA", "productive", 60, "Global demo: estacion VYNTRA."),
        ("", "", "python.exe", "Incidencias", "productive", 60, "Global demo: estacion VYNTRA."),
        ("", "", "python.exe", "Restauracion", "productive", 60, "Global demo: estacion VYNTRA."),
        ("", "", "python.exe", "Confirmar", "productive", 60, "Global demo: estacion VYNTRA."),
        ("", "", "python.exe", "Tiempo perdido", "productive", 60, "Global demo: estacion VYNTRA."),
        ("", "", "Code.exe", "VYNTRA", "productive", 100, "Global demo: desarrollo de VYNTRA."),
        ("", "", "chrome.exe", "VYNTRA", "productive", 100, "Global demo: panel VYNTRA."),
        ("", "", "msedge.exe", "VYNTRA", "productive", 100, "Global demo: panel VYNTRA."),
        ("", "", "chrome.exe", "Adminer", "productive", 100, "Global demo: revision de base de datos."),
        ("", "", "msedge.exe", "Adminer", "productive", 100, "Global demo: revision de base de datos."),
        ("", "", "chrome.exe", "Hostinger", "productive", 100, "Global demo: infraestructura VYNTRA."),
        ("", "", "msedge.exe", "Hostinger", "productive", 100, "Global demo: infraestructura VYNTRA."),
        ("", "", "chrome.exe", "Buscar con Google", "neutral", 70, "Global: busqueda puntual."),
        ("", "", "msedge.exe", "Buscar con Google", "neutral", 70, "Global: busqueda puntual."),
        ("", "", "chrome.exe", "Nueva pesta", "neutral", 60, "Global: pestana nueva sin actividad clara."),
        ("", "", "msedge.exe", "Nueva pesta", "neutral", 60, "Global: pestana nueva sin actividad clara."),
        ("", "", "WindowsTerminal.exe", "", "neutral", 80, "Global: terminal depende del area."),
        ("", "", "Photos.exe", "", "neutral", 60, "Global: visor de imagenes."),
        ("", "", "Steam.exe", "", "non_productive", 100, "Global: juegos."),
        ("", "", "EpicGamesLauncher.exe", "", "non_productive", 100, "Global: juegos."),
        ("", "", "RobloxPlayerBeta.exe", "", "non_productive", 100, "Global: juegos."),
        # Marketing.
        ("Marketing", "", "Slack.exe", "", "productive", 250, "Marketing: coordinacion."),
        ("Marketing", "", "chrome.exe", "Google Drive", "productive", 230, "Marketing: archivos creativos."),
        ("Marketing", "", "msedge.exe", "Google Drive", "productive", 230, "Marketing: archivos creativos."),
        ("Marketing", "", "chrome.exe", "Facebook Business", "productive", 250, "Marketing: herramientas de redes."),
        ("Marketing", "", "msedge.exe", "Facebook Business", "productive", 250, "Marketing: herramientas de redes."),
        ("Marketing", "", "chrome.exe", "Meta Business", "productive", 250, "Marketing: herramientas de redes."),
        ("Marketing", "", "msedge.exe", "Meta Business", "productive", 250, "Marketing: herramientas de redes."),
        ("Marketing", "", "chrome.exe", "Instagram", "productive", 250, "Marketing: redes pueden ser trabajo."),
        ("Marketing", "", "msedge.exe", "Instagram", "productive", 250, "Marketing: redes pueden ser trabajo."),
        ("Marketing", "", "chrome.exe", "TikTok", "productive", 240, "Marketing: contenido/redes."),
        ("Marketing", "", "msedge.exe", "TikTok", "productive", 240, "Marketing: contenido/redes."),
        ("Marketing", "", "chrome.exe", "Canva", "productive", 250, "Marketing: diseno."),
        ("Marketing", "", "msedge.exe", "Canva", "productive", 250, "Marketing: diseno."),
        ("Marketing", "", "Photoshop.exe", "", "productive", 250, "Marketing: diseno."),
        ("Marketing", "", "Illustrator.exe", "", "productive", 250, "Marketing: diseno."),
        ("Marketing", "", "InDesign.exe", "", "productive", 240, "Marketing: diseno editorial."),
        ("Marketing", "", "chrome.exe", "YouTube", "productive", 200, "Marketing: investigacion/contenido."),
        ("Marketing", "", "msedge.exe", "YouTube", "productive", 200, "Marketing: investigacion/contenido."),
        ("Marketing", "", "chrome.exe", "Google Ads", "productive", 250, "Marketing: pauta digital."),
        ("Marketing", "", "msedge.exe", "Google Ads", "productive", 250, "Marketing: pauta digital."),
        ("Marketing", "", "chrome.exe", "Google Analytics", "productive", 250, "Marketing: analitica."),
        ("Marketing", "", "msedge.exe", "Google Analytics", "productive", 250, "Marketing: analitica."),
        # Ventas y atencion.
        ("Ventas", "", "WhatsApp.Root.exe", "", "productive", 250, "Ventas: contacto con clientes."),
        ("Ventas", "", "OUTLOOK.EXE", "", "productive", 250, "Ventas: correo comercial."),
        ("Ventas", "", "chrome.exe", "Gmail", "productive", 250, "Ventas: correo comercial."),
        ("Ventas", "", "msedge.exe", "Gmail", "productive", 250, "Ventas: correo comercial."),
        ("Ventas", "", "chrome.exe", "HubSpot", "productive", 260, "Ventas: CRM."),
        ("Ventas", "", "msedge.exe", "HubSpot", "productive", 260, "Ventas: CRM."),
        ("Ventas", "", "chrome.exe", "Salesforce", "productive", 260, "Ventas: CRM."),
        ("Ventas", "", "msedge.exe", "Salesforce", "productive", 260, "Ventas: CRM."),
        ("Ventas", "", "chrome.exe", "Zoho CRM", "productive", 260, "Ventas: CRM."),
        ("Ventas", "", "msedge.exe", "Zoho CRM", "productive", 260, "Ventas: CRM."),
        ("Ventas", "", "chrome.exe", "LinkedIn", "productive", 220, "Ventas: prospeccion."),
        ("Ventas", "", "msedge.exe", "LinkedIn", "productive", 220, "Ventas: prospeccion."),
        ("Atencion al cliente", "", "WhatsApp.Root.exe", "", "productive", 250, "Atencion: soporte por mensajeria."),
        ("Atencion al cliente", "", "Teams.exe", "", "productive", 250, "Atencion: coordinacion de soporte."),
        ("Atencion al cliente", "", "Slack.exe", "", "productive", 250, "Atencion: coordinacion de soporte."),
        ("Atencion al cliente", "", "chrome.exe", "Gmail", "productive", 230, "Atencion: correo y soporte."),
        ("Atencion al cliente", "", "msedge.exe", "Gmail", "productive", 230, "Atencion: correo y soporte."),
        ("Atencion al cliente", "", "chrome.exe", "Zendesk", "productive", 260, "Atencion: mesa de ayuda."),
        ("Atencion al cliente", "", "msedge.exe", "Zendesk", "productive", 260, "Atencion: mesa de ayuda."),
        ("Atencion al cliente", "", "chrome.exe", "Freshdesk", "productive", 260, "Atencion: mesa de ayuda."),
        ("Atencion al cliente", "", "msedge.exe", "Freshdesk", "productive", 260, "Atencion: mesa de ayuda."),
        ("Atencion al cliente", "", "chrome.exe", "Intercom", "productive", 260, "Atencion: soporte chat."),
        ("Atencion al cliente", "", "msedge.exe", "Intercom", "productive", 260, "Atencion: soporte chat."),
        # Contabilidad y administracion.
        ("Contabilidad", "", "EXCEL.EXE", "", "productive", 250, "Contabilidad: herramienta principal."),
        ("Contabilidad", "", "chrome.exe", "Google Sheets", "productive", 250, "Contabilidad: hojas en la nube."),
        ("Contabilidad", "", "msedge.exe", "Google Sheets", "productive", 250, "Contabilidad: hojas en la nube."),
        ("Contabilidad", "", "chrome.exe", "QuickBooks", "productive", 250, "Contabilidad: sistema contable."),
        ("Contabilidad", "", "msedge.exe", "QuickBooks", "productive", 250, "Contabilidad: sistema contable."),
        ("Contabilidad", "", "chrome.exe", "Alegra", "productive", 250, "Contabilidad: sistema contable."),
        ("Contabilidad", "", "msedge.exe", "Alegra", "productive", 250, "Contabilidad: sistema contable."),
        ("Contabilidad", "", "chrome.exe", "Xero", "productive", 250, "Contabilidad: sistema contable."),
        ("Contabilidad", "", "msedge.exe", "Xero", "productive", 250, "Contabilidad: sistema contable."),
        ("Contabilidad", "", "chrome.exe", "SAP", "productive", 250, "Contabilidad: ERP/finanzas."),
        ("Contabilidad", "", "msedge.exe", "SAP", "productive", 250, "Contabilidad: ERP/finanzas."),
        ("Administracion", "", "EXCEL.EXE", "", "productive", 230, "Administracion: control operativo."),
        ("Administracion", "", "WINWORD.EXE", "", "productive", 230, "Administracion: documentos."),
        ("Administracion", "", "chrome.exe", "Google Drive", "productive", 230, "Administracion: archivos operativos."),
        ("Administracion", "", "msedge.exe", "Google Drive", "productive", 230, "Administracion: archivos operativos."),
        ("Administracion", "", "chrome.exe", "Google Docs", "productive", 230, "Administracion: documentos."),
        ("Administracion", "", "msedge.exe", "Google Docs", "productive", 230, "Administracion: documentos."),
        ("Administracion", "", "chrome.exe", "Google Sheets", "productive", 230, "Administracion: reportes."),
        ("Administracion", "", "msedge.exe", "Google Sheets", "productive", 230, "Administracion: reportes."),
        ("Administracion", "", "chrome.exe", "hPanel", "productive", 240, "Administracion: gestion de servicios."),
        ("Administracion", "", "msedge.exe", "hPanel", "productive", 240, "Administracion: gestion de servicios."),
        # Operaciones.
        ("Operaciones", "", "EXCEL.EXE", "", "productive", 230, "Operaciones: control operativo."),
        ("Operaciones", "", "chrome.exe", "Google Sheets", "productive", 230, "Operaciones: control operativo."),
        ("Operaciones", "", "msedge.exe", "Google Sheets", "productive", 230, "Operaciones: control operativo."),
        ("Operaciones", "", "chrome.exe", "Odoo", "productive", 250, "Operaciones: ERP."),
        ("Operaciones", "", "msedge.exe", "Odoo", "productive", 250, "Operaciones: ERP."),
        ("Operaciones", "", "chrome.exe", "Trello", "productive", 230, "Operaciones: gestion de tareas."),
        ("Operaciones", "", "msedge.exe", "Trello", "productive", 230, "Operaciones: gestion de tareas."),
        ("Operaciones", "", "chrome.exe", "Asana", "productive", 230, "Operaciones: gestion de tareas."),
        ("Operaciones", "", "msedge.exe", "Asana", "productive", 230, "Operaciones: gestion de tareas."),
        ("Operaciones", "", "chrome.exe", "Monday", "productive", 230, "Operaciones: gestion de tareas."),
        ("Operaciones", "", "msedge.exe", "Monday", "productive", 230, "Operaciones: gestion de tareas."),
        # RRHH.
        ("RRHH", "", "WINWORD.EXE", "", "productive", 230, "RRHH: documentos."),
        ("RRHH", "", "EXCEL.EXE", "", "productive", 230, "RRHH: controles y nomina."),
        ("RRHH", "", "chrome.exe", "LinkedIn", "productive", 250, "RRHH: reclutamiento."),
        ("RRHH", "", "msedge.exe", "LinkedIn", "productive", 250, "RRHH: reclutamiento."),
        ("RRHH", "", "chrome.exe", "Indeed", "productive", 250, "RRHH: reclutamiento."),
        ("RRHH", "", "msedge.exe", "Indeed", "productive", 250, "RRHH: reclutamiento."),
        ("RRHH", "", "chrome.exe", "BambooHR", "productive", 250, "RRHH: gestion de personal."),
        ("RRHH", "", "msedge.exe", "BambooHR", "productive", 250, "RRHH: gestion de personal."),
        ("RRHH", "", "chrome.exe", "Workday", "productive", 250, "RRHH: gestion de personal."),
        ("RRHH", "", "msedge.exe", "Workday", "productive", 250, "RRHH: gestion de personal."),
        # Tecnologia.
        ("Tecnologia", "", "Code.exe", "", "productive", 250, "Tecnologia: desarrollo."),
        ("Tecnologia", "", "Cursor.exe", "", "productive", 250, "Tecnologia: desarrollo."),
        ("Tecnologia", "", "pycharm64.exe", "", "productive", 250, "Tecnologia: desarrollo."),
        ("Tecnologia", "", "idea64.exe", "", "productive", 250, "Tecnologia: desarrollo."),
        ("Tecnologia", "", "WindowsTerminal.exe", "", "productive", 250, "Tecnologia: terminal."),
        ("Tecnologia", "", "cmd.exe", "", "productive", 230, "Tecnologia: terminal."),
        ("Tecnologia", "", "powershell.exe", "", "productive", 230, "Tecnologia: terminal."),
        ("Tecnologia", "", "Postman.exe", "", "productive", 250, "Tecnologia: pruebas API."),
        ("Tecnologia", "", "Docker Desktop.exe", "", "productive", 250, "Tecnologia: contenedores."),
        ("Tecnologia", "", "chrome.exe", "GitHub", "productive", 250, "Tecnologia: repositorios."),
        ("Tecnologia", "", "msedge.exe", "GitHub", "productive", 250, "Tecnologia: repositorios."),
        ("Tecnologia", "", "chrome.exe", "GitLab", "productive", 250, "Tecnologia: repositorios."),
        ("Tecnologia", "", "msedge.exe", "GitLab", "productive", 250, "Tecnologia: repositorios."),
        ("Tecnologia", "", "chrome.exe", "Bitbucket", "productive", 250, "Tecnologia: repositorios."),
        ("Tecnologia", "", "msedge.exe", "Bitbucket", "productive", 250, "Tecnologia: repositorios."),
        ("Tecnologia", "", "chrome.exe", "Stack Overflow", "productive", 220, "Tecnologia: investigacion tecnica."),
        ("Tecnologia", "", "msedge.exe", "Stack Overflow", "productive", 220, "Tecnologia: investigacion tecnica."),
        ("Tecnologia", "", "chrome.exe", "localhost", "productive", 250, "Tecnologia: desarrollo local."),
        ("Tecnologia", "", "msedge.exe", "localhost", "productive", 250, "Tecnologia: desarrollo local."),
        ("Tecnologia", "", "chrome.exe", "Adminer", "productive", 250, "Tecnologia: base de datos."),
        ("Tecnologia", "", "msedge.exe", "Adminer", "productive", 250, "Tecnologia: base de datos."),
        ("Tecnologia", "", "pgAdmin4.exe", "", "productive", 250, "Tecnologia: base de datos."),
        ("Tecnologia", "", "chrome.exe", "Hostinger", "productive", 240, "Tecnologia: infraestructura."),
        ("Tecnologia", "", "msedge.exe", "Hostinger", "productive", 240, "Tecnologia: infraestructura."),
        ("Tecnologia", "", "chrome.exe", "hPanel", "productive", 240, "Tecnologia: infraestructura."),
        ("Tecnologia", "", "msedge.exe", "hPanel", "productive", 240, "Tecnologia: infraestructura."),
        # Gerencia.
        ("Gerencia", "", "EXCEL.EXE", "", "productive", 230, "Gerencia: indicadores."),
        ("Gerencia", "", "POWERPNT.EXE", "", "productive", 230, "Gerencia: presentaciones."),
        ("Gerencia", "", "OUTLOOK.EXE", "", "productive", 230, "Gerencia: correo."),
        ("Gerencia", "", "chrome.exe", "Google Drive", "productive", 230, "Gerencia: documentos."),
        ("Gerencia", "", "msedge.exe", "Google Drive", "productive", 230, "Gerencia: documentos."),
        ("Gerencia", "", "chrome.exe", "Looker Studio", "productive", 250, "Gerencia: BI."),
        ("Gerencia", "", "msedge.exe", "Looker Studio", "productive", 250, "Gerencia: BI."),
        ("Gerencia", "", "chrome.exe", "Power BI", "productive", 250, "Gerencia: BI."),
        ("Gerencia", "", "msedge.exe", "Power BI", "productive", 250, "Gerencia: BI."),
        # Puesto especifico de prueba.
        ("", "Operador", "python.exe", "VYNTRA", "productive", 300, "Operador: estacion de marcaje."),
    ]

    for department_name, position_name, executable_name, title_contains, classification, priority, notes in seed_rules:
        department_id = dep(department_name) if department_name else None
        position_id = pos(position_name) if position_name else None
        exists = db.execute(
            select(ProductivityRule).where(
                ProductivityRule.company_id == company_id,
                ProductivityRule.department_id == department_id,
                ProductivityRule.position_id == position_id,
                ProductivityRule.employee_id.is_(None),
                ProductivityRule.executable_name == executable_name,
                ProductivityRule.title_contains == title_contains,
            )
        ).scalar_one_or_none()
        if exists:
            continue
        db.add(
            ProductivityRule(
                company_id=company_id,
                department_id=department_id,
                position_id=position_id,
                executable_name=executable_name,
                title_contains=title_contains,
                classification=classification,
                priority=priority,
                notes=notes,
            )
        )


def seed_company_settings(db: Session, company_id: str):
    settings_seed = [
        ("idle_grace_seconds", "300", "Tiempo de gracia antes de contar idle real."),
        ("productivity_block_minutes", "30", "Tamano de bloque para reporteria."),
        ("activity_sample_seconds", "10", "Intervalo recomendado de muestra en produccion."),
        ("employee_limit", "0", "Limite comercial de usuarios monitoreados; 0 significa sin limite."),
        ("subscription_status", "active", "Estado comercial de la suscripcion."),
        ("subscription_ends_at", "", "Fecha de vencimiento comercial en formato YYYY-MM-DD."),
        ("admin_notice", "", "Mensaje visible para administradores de la empresa."),
    ]
    for key, value, description in settings_seed:
        exists = db.execute(
            select(CompanySetting).where(
                CompanySetting.company_id == company_id,
                CompanySetting.key == key,
            )
        ).scalar_one_or_none()
        if exists:
            continue
        db.add(
            CompanySetting(
                company_id=company_id,
                key=key,
                value=value,
                description=description,
            )
        )


def get_or_create_department(db: Session, company_id: str, name: str) -> Department:
    row = db.execute(
        select(Department).where(Department.company_id == company_id, Department.name == name)
    ).scalar_one_or_none()
    if row:
        return row
    row = Department(company_id=company_id, name=name)
    db.add(row)
    db.flush()
    return row


def get_or_create_position(db: Session, company_id: str, name: str, description: str = "") -> Position:
    row = db.execute(
        select(Position).where(Position.company_id == company_id, Position.name == name)
    ).scalar_one_or_none()
    if row:
        return row
    row = Position(company_id=company_id, name=name, description=description)
    db.add(row)
    db.flush()
    return row


def get_or_create_role(db: Session, company_id: str, name: str, description: str = "") -> Role:
    row = db.execute(
        select(Role).where(Role.company_id == company_id, Role.name == name)
    ).scalar_one_or_none()
    if row:
        return row
    row = Role(company_id=company_id, name=name, description=description)
    db.add(row)
    db.flush()
    return row


def ensure_company_roles(db: Session, company_id: str) -> dict[str, Role]:
    role_descriptions = {
        "system_admin": "Administrador global del sistema VYNTRA",
        "owner": "Propietario de la cuenta de empresa",
        "admin": "Administrador de empresa",
        "rrhh": "Recursos humanos",
        "supervisor": "Supervisor",
        "viewer": "Solo lectura",
    }
    return {
        name: get_or_create_role(db, company_id, name, description)
        for name, description in role_descriptions.items()
    }


def seed_organization_catalogs(db: Session, company_id: str):
    for name in [
        "General",
        "Administracion",
        "Contabilidad",
        "Ventas",
        "Marketing",
        "Atencion al cliente",
        "Operaciones",
        "RRHH",
        "Tecnologia",
        "Gerencia",
    ]:
        get_or_create_department(db, company_id, name)

    for name, description in [
        ("Operador", "Usuario operativo de estacion de marcaje."),
        ("Analista", "Analisis, documentacion y reportes."),
        ("Supervisor", "Supervision de equipo y aprobaciones."),
        ("Vendedor", "Gestion comercial y contacto con clientes."),
        ("Contador", "Gestion contable y financiera."),
        ("Disenador", "Diseno, contenido y piezas creativas."),
        ("Soporte", "Atencion y resolucion de solicitudes."),
        ("Desarrollador", "Desarrollo, soporte tecnico y automatizacion."),
        ("Gerente", "Gestion gerencial y seguimiento de indicadores."),
    ]:
        get_or_create_position(db, company_id, name, description)


def agent_event_already_received(db: Session, event_id: str) -> bool:
    if not event_id:
        return False
    existing = db.execute(
        select(AuditLog).where(
            AuditLog.action == "agent_event_received",
            AuditLog.entity_type == "agent_event",
            AuditLog.entity_id == event_id,
        )
    ).scalar_one_or_none()
    return existing is not None


def get_or_create_shift(db: Session, device: Device, payload: dict) -> Shift | None:
    if not device.employee_id:
        return None

    shift_date = (
        payload.get("fecha")
        or (payload.get("inicio_jornada") or payload.get("timestamp") or "")[:10]
        or datetime.now(timezone.utc).date().isoformat()
    )
    shift = db.execute(
        select(Shift)
        .where(
            Shift.company_id == device.company_id,
            Shift.employee_id == device.employee_id,
            Shift.device_id == device.id,
            Shift.shift_date == shift_date,
        )
        .order_by(Shift.created_at.desc())
    ).scalar_one_or_none()
    if shift:
        return shift

    shift = Shift(
        company_id=device.company_id,
        employee_id=device.employee_id,
        device_id=device.id,
        shift_date=shift_date,
        status="open",
        started_at=parse_optional_client_datetime(payload.get("inicio_jornada")),
    )
    db.add(shift)
    db.flush()
    return shift


def apply_shift_snapshot(shift: Shift, event_type: str, payload: dict):
    if payload.get("inicio_jornada"):
        shift.started_at = parse_optional_client_datetime(payload.get("inicio_jornada"))
    if payload.get("fin_jornada"):
        shift.ended_at = parse_optional_client_datetime(payload.get("fin_jornada"))

    if event_type == "shift_started":
        shift.status = "open"
    elif event_type == "shift_finished":
        shift.status = "closed"
    elif event_type in {"break_started", "lunch_started"}:
        shift.status = "paused"
    elif event_type in {"break_finished", "lunch_finished", "shift_restored_by_admin"}:
        shift.status = "open"

    shift.work_seconds = int(payload.get("seg_trabajado") or shift.work_seconds or 0)
    shift.break_seconds = int(payload.get("seg_break") or shift.break_seconds or 0)
    shift.lunch_seconds = int(payload.get("seg_lunch") or shift.lunch_seconds or 0)
    telemetry = payload.get("telemetria") or {}
    shift.idle_seconds = int(telemetry.get("seg_idle") or shift.idle_seconds or 0)
    shift.updated_at = now_utc()


def get_or_create_app(db: Session, company_id: str, executable_name: str) -> AppCatalog:
    name = (executable_name or "(desconocido)").strip()[:160] or "(desconocido)"
    app_row = db.execute(
        select(AppCatalog).where(
            AppCatalog.company_id == company_id,
            AppCatalog.executable_name == name,
        )
    ).scalar_one_or_none()
    if app_row:
        return app_row
    app_row = AppCatalog(company_id=company_id, executable_name=name)
    db.add(app_row)
    db.flush()
    return app_row


def get_or_create_window_title(db: Session, company_id: str, title_text_value: str) -> WindowTitleCatalog:
    text = (title_text_value or "(sin titulo)").strip() or "(sin titulo)"
    hashed = title_hash(text)
    title_row = db.execute(
        select(WindowTitleCatalog).where(
            WindowTitleCatalog.company_id == company_id,
            WindowTitleCatalog.title_hash == hashed,
        )
    ).scalar_one_or_none()
    if title_row:
        return title_row
    title_row = WindowTitleCatalog(
        company_id=company_id,
        title_hash=hashed,
        title_text=text,
    )
    db.add(title_row)
    db.flush()
    return title_row


def classify_activity(
    db: Session,
    company_id: str,
    employee: Employee,
    executable_name: str,
    title_text_value: str,
) -> str:
    executable = (executable_name or "").strip().lower()
    title_lower = (title_text_value or "").strip().lower()
    rules = db.execute(
        select(ProductivityRule).where(
            ProductivityRule.company_id == company_id,
            ProductivityRule.is_active.is_(True),
        )
    ).scalars().all()

    matches = []
    for rule in rules:
        if rule.employee_id and rule.employee_id != employee.id:
            continue
        if rule.department_id and rule.department_id != employee.department_id:
            continue
        if rule.position_id and rule.position_id != employee.position_id:
            continue
        if rule.executable_name and rule.executable_name.strip().lower() != executable:
            continue
        if rule.title_contains and rule.title_contains.strip().lower() not in title_lower:
            continue

        scope_score = 0
        if rule.department_id:
            scope_score += 1000
        if rule.position_id:
            scope_score += 2000
        if rule.employee_id:
            scope_score += 3000
        matches.append((scope_score + rule.priority, rule))

    if not matches:
        return "uncategorized"

    _, best = sorted(matches, key=lambda item: item[0], reverse=True)[0]
    if best.classification in {"productive", "non_productive", "neutral"}:
        return best.classification
    return "uncategorized"


def classification_to_bool(classification: str) -> bool | None:
    if classification == "productive":
        return True
    if classification == "non_productive":
        return False
    return None


def reclassify_activities_for_company(db: Session, company_id: str) -> dict:
    activities = db.execute(
        select(Activity)
        .where(Activity.company_id == company_id)
        .order_by(Activity.started_at)
    ).scalars().all()
    changed = 0
    totals = {
        "productive": 0,
        "neutral": 0,
        "non_productive": 0,
        "uncategorized": 0,
    }

    for activity in activities:
        employee = db.get(Employee, activity.employee_id)
        if employee is None:
            continue
        app_row = db.get(AppCatalog, activity.app_id) if activity.app_id else None
        title_row = db.get(WindowTitleCatalog, activity.window_title_id) if activity.window_title_id else None
        new_classification = classify_activity(
            db,
            company_id,
            employee,
            app_row.executable_name if app_row else "",
            title_row.title_text if title_row else "",
        )
        totals[new_classification] = totals.get(new_classification, 0) + 1
        if activity.classification != new_classification:
            activity.classification = new_classification
            activity.is_productive = classification_to_bool(new_classification)
            changed += 1

    return {"changed": changed, "totals": totals}


def find_employee_credential(
    db: Session,
    company_id: str,
    email: str,
) -> EmployeeCredential | None:
    clean_email = (email or "").strip().lower()
    if not clean_email:
        return None
    return db.execute(
        select(EmployeeCredential).where(
            EmployeeCredential.company_id == company_id,
            EmployeeCredential.email == clean_email,
        )
    ).scalar_one_or_none()


def store_station_login_event(
    db: Session,
    device: Device,
    event: dict,
    payload: dict,
    client_ip: str,
):
    email = str(payload.get("email") or payload.get("correo") or "").strip().lower()
    success = bool(payload.get("success"))
    occurred_at = (
        parse_optional_client_datetime(payload.get("occurred_at"))
        or parse_optional_client_datetime(event.get("created_at"))
        or now_utc()
    )
    credential = find_employee_credential(db, device.company_id, email)
    if credential and success:
        credential.last_login_at = occurred_at

    db.add(
        StationLoginEvent(
            company_id=device.company_id,
            employee_id=credential.employee_id if credential else device.employee_id,
            credential_id=credential.id if credential else None,
            device_id=device.id,
            email_attempted=email[:180],
            success=success,
            failure_reason=str(payload.get("failure_reason") or "")[:180],
            occurred_at=occurred_at,
            ip_address=client_ip[:80],
            payload_json=json_text(payload),
        )
    )


def store_consent_record(
    db: Session,
    device: Device,
    event: dict,
    payload: dict,
):
    email = str(payload.get("auth_email") or payload.get("email") or "").strip().lower()
    credential = find_employee_credential(db, device.company_id, email)
    employee_id = credential.employee_id if credential else device.employee_id
    if not employee_id:
        return

    accepted = bool(payload.get("aceptado"))
    accepted_at = (
        parse_optional_client_datetime(payload.get("fechaHora"))
        or parse_optional_client_datetime(event.get("created_at"))
        or now_utc()
    )
    source_event_id = str(event.get("id") or "")[:36] or None
    existing = db.execute(
        select(ConsentRecord).where(ConsentRecord.source_event_id == source_event_id)
    ).scalar_one_or_none() if source_event_id else None
    if existing:
        return

    db.add(
        ConsentRecord(
            company_id=device.company_id,
            employee_id=employee_id,
            credential_id=credential.id if credential else None,
            device_id=device.id,
            consent_version=str(payload.get("version") or "")[:40],
            accepted=accepted,
            accepted_at=accepted_at if accepted else None,
            revoked_at=None if accepted else accepted_at,
            source_event_id=source_event_id,
            payload_json=json_text(payload),
        )
    )


def incident_title(incident_type: str) -> str:
    return {
        "correccion_marcaje": "Correccion de marcaje",
        "permiso_vacaciones": "Permisos o vacaciones",
        "tiempo_perdido": "Tiempo perdido por sistema",
        "system_lost_time": "Tiempo perdido por sistema",
    }.get(incident_type, "Incidencia")


def store_incident_event(
    db: Session,
    device: Device,
    event: dict,
    payload: dict,
) -> Incident | None:
    employee_id = device.employee_id
    if not employee_id:
        return None
    employee = db.get(Employee, employee_id)
    if employee is None:
        return None

    source_event_id = str(event.get("id") or "")[:36] or None
    if source_event_id:
        existing = db.execute(
            select(Incident).where(
                Incident.company_id == device.company_id,
                Incident.payload_json.contains(source_event_id),
            )
        ).scalar_one_or_none()
        if existing:
            return existing

    incident_type = clean_text(payload.get("tipo") or payload.get("incident_type"), 80)
    title = clean_text(payload.get("titulo") or incident_title(incident_type), 180)
    description = clean_text(payload.get("motivo") or payload.get("description"), 2000)
    requested_at = (
        parse_optional_client_datetime(payload.get("requested_at"))
        or parse_optional_client_datetime(payload.get("fechaHora"))
        or parse_optional_client_datetime(event.get("created_at"))
        or now_utc()
    )
    incident_payload = dict(payload)
    if source_event_id:
        incident_payload["source_event_id"] = source_event_id

    incident = Incident(
        company_id=device.company_id,
        employee_id=employee.id,
        device_id=device.id,
        incident_type=incident_type or "general",
        status="pending",
        title=title,
        description=description,
        requested_at=requested_at,
        payload_json=json_text(incident_payload),
    )
    db.add(incident)
    return incident


def store_activity_samples(
    db: Session,
    device: Device,
    shift: Shift | None,
    source_event_id: str,
    samples: list[dict],
) -> int:
    if not device.employee_id:
        return 0
    employee = db.get(Employee, device.employee_id)
    if employee is None:
        return 0

    inserted = 0
    for index, sample in enumerate(samples):
        existing = db.execute(
            select(Activity).where(
                Activity.source_event_id == source_event_id,
                Activity.source_sample_index == index,
            )
        ).scalar_one_or_none()
        if existing:
            continue

        started_at = parse_optional_client_datetime(sample.get("timestamp"))
        if started_at is None:
            continue
        duration = max(1, int(sample.get("duracion_muestra_segundos") or 0))
        is_idle = bool(sample.get("is_idle"))
        executable_name = sample.get("proceso", "")
        title_text_value = sample.get("titulo", "")
        app_row = get_or_create_app(db, device.company_id, executable_name)
        title_row = get_or_create_window_title(db, device.company_id, title_text_value)
        classification = classify_activity(
            db,
            device.company_id,
            employee,
            executable_name,
            title_text_value,
        )
        duplicate_sample = db.execute(
            select(Activity).where(
                Activity.device_id == device.id,
                Activity.started_at == started_at,
                Activity.app_id == app_row.id,
                Activity.window_title_id == title_row.id,
            )
        ).scalar_one_or_none()
        if duplicate_sample:
            continue
        db.add(
            Activity(
                company_id=device.company_id,
                employee_id=device.employee_id,
                device_id=device.id,
                shift_id=shift.id if shift else None,
                app_id=app_row.id,
                window_title_id=title_row.id,
                started_at=started_at,
                ended_at=started_at + timedelta(seconds=duration),
                duration_seconds=duration,
                idle_seconds=duration if is_idle else 0,
                is_idle=is_idle,
                is_productive=classification_to_bool(classification),
                classification=classification,
                source_event_id=source_event_id,
                source_sample_index=index,
            )
        )
        inserted += 1
    return inserted


def samples_from_agent_event(event_type: str, payload: dict) -> list[dict]:
    if event_type == "activity_sample_created":
        return [
            {
                "timestamp": payload.get("fechaHora") or payload.get("timestamp"),
                "proceso": payload.get("proceso"),
                "titulo": payload.get("ventana") or payload.get("titulo"),
                "idle_segundos": payload.get("idle_segundos", 0),
                "is_idle": bool(payload.get("is_idle", False)),
                "duracion_muestra_segundos": payload.get("duracion_muestra_segundos", 3),
            }
        ]
    telemetry = payload.get("telemetria") or {}
    samples = telemetry.get("muestras_recientes")
    return samples if isinstance(samples, list) else []


def process_agent_event(db: Session, device: Device, event: dict, client_ip: str) -> dict:
    event_id = str(event.get("id") or "")[:36]
    event_type = str(event.get("tipo") or "unknown")[:60]
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    created_at = parse_optional_client_datetime(event.get("created_at")) or now_utc()

    shift = None
    if event_type == "station_login":
        store_station_login_event(db, device, event, payload, client_ip)
    elif event_type == "consent_saved":
        store_consent_record(db, device, event, payload)
    elif event_type in {"incident_submitted", "incidence_created"}:
        store_incident_event(db, device, event, payload)

    shift_event_types = {
        "shift_started",
        "shift_finished",
        "shift_restored_by_admin",
        "shift_clock_reset",
        "break_started",
        "break_finished",
        "break_restored_by_admin",
        "lunch_started",
        "lunch_finished",
        "lunch_restored_by_admin",
        "overtime_requested",
        "overtime_started",
        "overtime_finished",
    }
    if event_type in shift_event_types or payload.get("estado"):
        shift = get_or_create_shift(db, device, payload)
        if shift:
            apply_shift_snapshot(shift, event_type, payload)
            db.add(
                ShiftEvent(
                    shift_id=shift.id,
                    event_type=event_type,
                    occurred_at=created_at,
                    payload_json=json_text(payload),
                )
            )

    samples_inserted = store_activity_samples(
        db,
        device,
        shift,
        event_id,
        samples_from_agent_event(event_type, payload),
    )

    db.add(
        AuditLog(
            company_id=device.company_id,
            device_id=device.id,
            action="agent_event_received",
            entity_type="agent_event",
            entity_id=event_id,
            ip_address=client_ip[:80],
            payload_json=json_text(
                {
                    "event_type": event_type,
                    "activity_samples_inserted": samples_inserted,
                }
            ),
        )
    )
    return {"id": event_id, "event_type": event_type, "activity_samples_inserted": samples_inserted}


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

        roles = ensure_company_roles(db, company.id)
        admin_role = roles["admin"]
        system_admin_role = roles["system_admin"]

        seed_organization_catalogs(db, company.id)
        seed_company_settings(db, company.id)
        if settings.bootstrap_employee_limit > 0:
            set_company_setting(
                db,
                company.id,
                "employee_limit",
                str(settings.bootstrap_employee_limit),
                "Limite comercial de usuarios monitoreados; 0 significa sin limite.",
            )

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
                    password_hash=settings.bootstrap_admin_password_hash,
                    status="active",
                )
            )
        else:
            admin_user.role_id = admin_role.id
            admin_user.full_name = settings.bootstrap_admin_name
            if settings.bootstrap_admin_password_hash:
                admin_user.password_hash = settings.bootstrap_admin_password_hash
            admin_user.status = "active"

        system_admin_email = settings.bootstrap_system_admin_email.strip().lower()
        if system_admin_email and settings.bootstrap_system_admin_password_hash:
            system_admin_user = db.execute(
                select(User).where(
                    User.company_id == company.id,
                    User.email == system_admin_email,
                )
            ).scalar_one_or_none()
            if system_admin_user is None:
                db.add(
                    User(
                        company_id=company.id,
                        role_id=system_admin_role.id,
                        email=system_admin_email,
                        full_name=settings.bootstrap_system_admin_name,
                        password_hash=settings.bootstrap_system_admin_password_hash,
                        status="active",
                    )
                )
            else:
                system_admin_user.role_id = system_admin_role.id
                system_admin_user.full_name = settings.bootstrap_system_admin_name
                system_admin_user.password_hash = settings.bootstrap_system_admin_password_hash
                system_admin_user.status = "active"

        department = get_or_create_department(db, company.id, "General")
        position = get_or_create_position(
            db,
            company.id,
            settings.bootstrap_position_name,
            "Puesto demo para pruebas locales",
        )

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
                position_id=position.id,
                employee_code=settings.bootstrap_employee_code,
                full_name=settings.bootstrap_employee_name,
                email=settings.bootstrap_employee_email,
                status="active",
            )
            db.add(employee)
            db.flush()
        else:
            employee.department_id = department.id
            employee.position_id = position.id

        login_email = settings.bootstrap_employee_login_email.strip().lower()
        if login_email:
            credential = db.execute(
                select(EmployeeCredential).where(
                    EmployeeCredential.company_id == company.id,
                    EmployeeCredential.email == login_email,
                )
            ).scalar_one_or_none()
            if credential is None:
                credential = db.execute(
                    select(EmployeeCredential).where(
                        EmployeeCredential.company_id == company.id,
                        EmployeeCredential.employee_id == employee.id,
                    )
                ).scalar_one_or_none()
            if credential is None:
                db.add(
                    EmployeeCredential(
                        company_id=company.id,
                        employee_id=employee.id,
                        email=login_email,
                        password_hash=settings.bootstrap_employee_password_hash,
                        status="active",
                    )
                )
            else:
                credential.employee_id = employee.id
                credential.password_hash = settings.bootstrap_employee_password_hash
                credential.status = "active"

        token_hash = hash_token(settings.bootstrap_device_token)
        device = db.execute(
            select(Device).where(Device.token_sha256 == token_hash)
        ).scalar_one_or_none()
        if device is None:
            device_name = settings.bootstrap_device_name or "bootstrap-device"
            device = db.execute(
                select(Device).where(
                    Device.company_id == company.id,
                    Device.name == device_name,
                )
            ).scalar_one_or_none()
            if device is None:
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
            else:
                device.employee_id = employee.id
                device.hostname = device_name
                device.token_sha256 = token_hash
                device.is_active = True

        seed_productivity_rules(db, company.id)
        db.commit()


def ensure_employee_credential_schema():
    columns = {
        "password_change_required": "BOOLEAN NOT NULL DEFAULT FALSE",
        "password_changed_at": "TIMESTAMP WITH TIME ZONE",
        "reset_code_hash": "VARCHAR(128) NOT NULL DEFAULT ''",
        "reset_code_expires_at": "TIMESTAMP WITH TIME ZONE",
        "reset_requested_at": "TIMESTAMP WITH TIME ZONE",
        "reset_verified_at": "TIMESTAMP WITH TIME ZONE",
        "reset_attempts": "INTEGER NOT NULL DEFAULT 0",
    }
    with engine.begin() as conn:
        existing = {
            row[0]
            for row in conn.execute(
                text(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'employee_credentials'
                    """
                )
            )
        }
        for column, ddl in columns.items():
            if column not in existing:
                conn.execute(text(f"ALTER TABLE employee_credentials ADD COLUMN {column} {ddl}"))


@app.on_event("startup")
def on_startup():
    os.makedirs(settings.storage_dir, exist_ok=True)
    Base.metadata.create_all(bind=engine)
    ensure_employee_credential_schema()
    bootstrap_data()


@app.get("/health")
def health():
    return {"ok": True, "environment": settings.environment}


def serialize_admin_user(db: Session, user: User, role_name: str | None = None) -> dict:
    role = db.get(Role, user.role_id) if user.role_id and role_name is None else None
    resolved_role = role_name or (role.name if role else "")
    company = db.get(Company, user.company_id)
    return {
        "id": user.id,
        "company_id": user.company_id,
        "company": company.name if company else None,
        "email": user.email,
        "full_name": user.full_name,
        "role": resolved_role,
        "permissions": permissions_for_role(resolved_role),
        "status": user.status,
        "last_login_at": user.last_login_at.isoformat() if user.last_login_at else None,
    }


def serialize_system_company(db: Session, company: Company) -> dict:
    employees_count = db.execute(
        select(func.count()).select_from(Employee).where(Employee.company_id == company.id)
    ).scalar_one()
    users_count = db.execute(
        select(func.count()).select_from(User).where(User.company_id == company.id)
    ).scalar_one()
    devices_count = db.execute(
        select(func.count()).select_from(Device).where(Device.company_id == company.id)
    ).scalar_one()
    return {
        "id": company.id,
        "name": company.name,
        "legal_name": company.legal_name,
        "status": company.status,
        "timezone": company.timezone,
        "created_at": company.created_at.isoformat() if company.created_at else None,
        "employees_count": int(employees_count or 0),
        "users_count": int(users_count or 0),
        "devices_count": int(devices_count or 0),
        "controls": company_controls(db, company.id),
    }


def serialize_panel_user(db: Session, user: User) -> dict:
    role = db.get(Role, user.role_id) if user.role_id else None
    company = db.get(Company, user.company_id)
    return {
        "id": user.id,
        "company_id": user.company_id,
        "company": company.name if company else "",
        "email": user.email,
        "full_name": user.full_name,
        "role": role.name if role else "",
        "permissions": permissions_for_role(role.name if role else ""),
        "status": user.status,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "last_login_at": user.last_login_at.isoformat() if user.last_login_at else None,
    }


def company_admin_messages(db: Session, company_id: str) -> list[dict]:
    controls = company_controls(db, company_id)
    messages = []
    notice = clean_text(controls.get("admin_notice"), 255)
    if notice:
        messages.append({"type": "notice", "message": notice})

    status_value = clean_text(controls.get("subscription_status"), 40)
    if status_value in {"past_due", "suspended", "cancelled"}:
        messages.append(
            {
                "type": "subscription",
                "message": "La suscripcion requiere atencion. Comunicate con el proveedor del sistema.",
            }
        )

    ends_at = clean_text(controls.get("subscription_ends_at"), 10)
    if ends_at:
        try:
            today = datetime.now(timezone.utc).date()
            end_date = datetime.strptime(ends_at, "%Y-%m-%d").date()
            days_left = (end_date - today).days
            if days_left < 0:
                messages.append(
                    {
                        "type": "subscription",
                        "message": "La suscripcion esta vencida. Comunicate con el proveedor del sistema.",
                    }
                )
            elif days_left <= 14:
                messages.append(
                    {
                        "type": "subscription",
                        "message": f"La suscripcion vence en {days_left} dias. Comunicate con el proveedor del sistema.",
                    }
                )
        except ValueError:
            pass
    return messages


@app.post("/api/admin/login")
def admin_login(
    request: Request,
    payload: AdminLoginPayload,
    db: Session = Depends(get_db),
):
    email = clean_text(payload.email, 180).lower()
    password = payload.password
    client_ip_address = client_ip(request)
    if not email or not password:
        raise HTTPException(status_code=400, detail="Missing credentials")

    user = db.execute(
        select(User).where(
            User.email == email,
            User.status == "active",
        )
    ).scalar_one_or_none()
    role = db.get(Role, user.role_id) if user and user.role_id else None
    role_name = role.name if role else ""
    if (
        user is None
        or role_name not in ROLE_PERMISSIONS
        or not verify_password_hash(password, user.password_hash)
    ):
        db.add(
            AuditLog(
                company_id=user.company_id if user else None,
                user_id=user.id if user else None,
                action="admin_login_failed",
                entity_type="user",
                entity_id=user.id if user else "",
                ip_address=client_ip_address[:80],
                payload_json=json_text({"email": email}),
            )
        )
        db.commit()
        raise HTTPException(status_code=401, detail="Invalid credentials")

    user.last_login_at = now_utc()
    db.add(
        AuditLog(
            company_id=user.company_id,
            user_id=user.id,
            action="admin_login_succeeded",
            entity_type="user",
            entity_id=user.id,
            ip_address=client_ip_address[:80],
            payload_json=json_text({"email": email}),
        )
    )
    token = create_admin_access_token(user, role_name)
    db.commit()
    db.refresh(user)
    return {
        "ok": True,
        "access_token": token,
        "token_type": "bearer",
        "expires_in_seconds": settings.admin_token_expire_minutes * 60,
        "user": serialize_admin_user(db, user, role_name),
    }


@app.get("/api/admin/me")
def admin_me(
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if admin.auth_method == "legacy_token":
        company = get_default_company(db)
        return {
            "auth_method": "legacy_token",
            "user": {
                "id": None,
                "company_id": company.id,
                "company": company.name,
                "email": admin.email,
                "full_name": "Legacy Admin Token",
                "role": admin.role,
                "permissions": permissions_for_role(admin.role),
                "status": "active",
                "last_login_at": None,
            },
        }

    user = db.get(User, admin.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid admin session")
    return {
        "auth_method": admin.auth_method,
        "user": serialize_admin_user(db, user, admin.role),
    }


@app.get("/api/admin/company-notice")
def admin_company_notice(
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if admin.auth_method == "legacy_token" or admin.role == "system_admin":
        return {"messages": []}
    return {"messages": company_admin_messages(db, admin.company_id)}


@app.get("/api/audit/logs")
def list_audit_logs(
    company_id: str | None = None,
    actor: str | None = None,
    action: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 200,
    export: Literal["json", "csv"] = "json",
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "audit:read")
    scoped_company_id = clean_text(company_id, 36) or None
    if admin.role != "system_admin":
        scoped_company_id = admin.company_id
    elif scoped_company_id:
        resolve_company(db, scoped_company_id)

    query = select(AuditLog)
    if scoped_company_id:
        query = query.where(AuditLog.company_id == scoped_company_id)

    clean_action = clean_text(action, 120)
    if clean_action:
        query = query.where(AuditLog.action.ilike(f"%{clean_action}%"))

    clean_entity_type = clean_text(entity_type, 80)
    if clean_entity_type:
        query = query.where(AuditLog.entity_type.ilike(f"%{clean_entity_type}%"))

    clean_entity_id = clean_text(entity_id, 80)
    if clean_entity_id:
        query = query.where(AuditLog.entity_id == clean_entity_id)

    if date_from:
        start_date = validate_date(date_from, "date_from")
        query = query.where(AuditLog.created_at >= datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc))
    if date_to:
        end_date = validate_date(date_to, "date_to")
        query = query.where(AuditLog.created_at < datetime.fromisoformat(end_date).replace(tzinfo=timezone.utc) + timedelta(days=1))

    clean_actor = clean_text(actor, 180)
    if clean_actor:
        user_query = select(User.id).where(
            User.full_name.ilike(f"%{clean_actor}%") | User.email.ilike(f"%{clean_actor}%")
        )
        if scoped_company_id:
            user_query = user_query.where(User.company_id == scoped_company_id)
        actor_ids = [row[0] for row in db.execute(user_query).all()]
        if not actor_ids:
            rows: list[AuditLog] = []
        else:
            rows = db.execute(
                query.where(AuditLog.user_id.in_(actor_ids))
                .order_by(AuditLog.created_at.desc())
                .limit(max(1, min(limit, 1000)))
            ).scalars().all()
    else:
        rows = db.execute(
            query.order_by(AuditLog.created_at.desc()).limit(max(1, min(limit, 1000)))
        ).scalars().all()

    company_ids = {row.company_id for row in rows if row.company_id}
    user_ids = {row.user_id for row in rows if row.user_id}
    companies = {
        company.id: company
        for company in db.execute(select(Company).where(Company.id.in_(company_ids))).scalars().all()
    } if company_ids else {}
    actors = {
        user.id: user
        for user in db.execute(select(User).where(User.id.in_(user_ids))).scalars().all()
    } if user_ids else {}
    items = [serialize_audit_log(row, companies.get(row.company_id), actors.get(row.user_id)) for row in rows]

    if export == "csv":
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["created_at", "company", "actor_email", "actor", "action", "entity_type", "entity_id", "ip_address", "payload"])
        for item in items:
            writer.writerow(
                [
                    item["created_at"] or "",
                    item["company"],
                    item["actor_email"],
                    item["actor"],
                    item["action"],
                    item["entity_type"],
                    item["entity_id"],
                    item["ip_address"],
                    json.dumps(item["payload"], ensure_ascii=False),
                ]
            )
        return Response(
            output.getvalue(),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="vyntra-audit.csv"'},
        )

    return {
        "company_id": scoped_company_id,
        "count": len(items),
        "items": items,
        "filters": {
            "company_id": scoped_company_id,
            "actor": clean_actor,
            "action": clean_action,
            "entity_type": clean_entity_type,
            "entity_id": clean_entity_id,
            "date_from": date_from,
            "date_to": date_to,
            "limit": max(1, min(limit, 1000)),
        },
    }


@app.get("/api/system/overview")
def system_overview(
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_system_admin(admin)
    companies = db.execute(select(Company).order_by(Company.created_at.desc())).scalars().all()
    users = db.execute(select(User).order_by(User.created_at.desc()).limit(300)).scalars().all()
    return {
        "companies": [serialize_system_company(db, company) for company in companies],
        "users": [serialize_panel_user(db, user) for user in users],
        "roles": ["system_admin", "owner", "admin", "rrhh", "supervisor", "viewer"],
    }


@app.post("/api/system/companies")
def create_system_company(
    payload: SystemCompanyPayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_system_admin(admin)
    name = clean_text(payload.name, 160)
    legal_name = clean_text(payload.legal_name, 220)
    timezone_name = clean_text(payload.timezone, 80) or "America/Managua"
    existing = db.execute(
        select(Company).where(func.lower(Company.name) == name.lower())
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail="Company already exists")

    company = Company(name=name, legal_name=legal_name, timezone=timezone_name, status="active")
    db.add(company)
    db.flush()
    ensure_company_roles(db, company.id)
    seed_organization_catalogs(db, company.id)
    seed_company_settings(db, company.id)
    seed_productivity_rules(db, company.id)
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="system_company_created",
            entity_type="company",
            entity_id=company.id,
            payload_json=json_text({"name": company.name, "timezone": company.timezone}),
        )
    )
    db.commit()
    db.refresh(company)
    return {"ok": True, "company": serialize_system_company(db, company)}


@app.patch("/api/system/companies/{company_id}/controls")
def update_system_company_controls(
    company_id: str,
    payload: SystemCompanyControlsPayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_system_admin(admin)
    company = db.get(Company, company_id)
    if company is None:
        raise HTTPException(status_code=404, detail="Company not found")

    ends_at = clean_text(payload.subscription_ends_at, 10)
    if ends_at:
        validate_date(ends_at, "subscription_ends_at")

    set_company_setting(
        db,
        company.id,
        "employee_limit",
        str(payload.employee_limit),
        "Limite comercial de usuarios monitoreados; 0 significa sin limite.",
    )
    set_company_setting(db, company.id, "subscription_status", payload.subscription_status, "Estado comercial de la suscripcion.")
    set_company_setting(db, company.id, "subscription_ends_at", ends_at, "Fecha de vencimiento comercial en formato YYYY-MM-DD.")
    set_company_setting(db, company.id, "admin_notice", clean_text(payload.admin_notice, 255), "Mensaje visible para administradores de la empresa.")
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="system_company_controls_updated",
            entity_type="company",
            entity_id=company.id,
            payload_json=json_text(company_controls(db, company.id)),
        )
    )
    db.commit()
    db.refresh(company)
    return {"ok": True, "company": serialize_system_company(db, company)}


@app.post("/api/system/users")
def create_system_panel_user(
    payload: SystemUserPayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_system_admin(admin)
    role_name = clean_text(payload.role, 40)
    full_name = clean_text(payload.full_name, 180)
    email = clean_email(payload.email)
    company_id = clean_text(payload.company_id, 36) or admin.company_id
    company = resolve_company(db, company_id)

    if role_name != "system_admin" and not payload.company_id:
        raise HTTPException(status_code=400, detail="company_id is required for company users")

    duplicate = db.execute(select(User).where(User.email == email)).scalars().first()
    if duplicate is not None:
        raise HTTPException(status_code=409, detail="Email already has panel access")

    roles = ensure_company_roles(db, company.id)
    role = roles.get(role_name)
    if role is None:
        raise HTTPException(status_code=400, detail="Invalid panel role")

    password = generate_password()
    user = User(
        company_id=company.id,
        role_id=role.id,
        email=email,
        full_name=full_name,
        password_hash=hash_password(password),
        status="active",
    )
    db.add(user)
    db.flush()
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="system_panel_user_created",
            entity_type="user",
            entity_id=user.id,
            payload_json=json_text({"email": email, "role": role_name, "delivery_status": "pending"}),
        )
    )
    db.commit()
    db.refresh(user)

    delivery_status = send_plain_email(
        email,
        "Acceso al panel VYNTRA",
        panel_user_email_body(company, full_name, email, password, role_name),
    )
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="system_panel_user_delivery_attempted",
            entity_type="user",
            entity_id=user.id,
            payload_json=json_text({"email": email, "role": role_name, "delivery_status": delivery_status}),
        )
    )
    db.commit()

    credentials = {
        "email": email,
        "delivery_status": delivery_status,
    }
    if allow_local_testing_secrets():
        credentials["password"] = password
    return {"ok": True, "user": serialize_panel_user(db, user), "credentials": credentials}


@app.patch("/api/system/users/{user_id}")
def update_system_panel_user(
    user_id: str,
    payload: SystemUserPatchPayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_system_admin(admin)
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Panel user not found")

    data = payload.model_dump(exclude_unset=True)
    next_role_name = clean_text(data.get("role"), 40) if "role" in data else None
    if next_role_name:
        roles = ensure_company_roles(db, user.company_id)
        role = roles.get(next_role_name)
        if role is None:
            raise HTTPException(status_code=400, detail="Invalid panel role")
        user.role_id = role.id

    if "full_name" in data:
        full_name = clean_text(data.get("full_name"), 180)
        if len(full_name) < 2:
            raise HTTPException(status_code=400, detail="User name is required")
        user.full_name = full_name

    if "status" in data:
        next_status = clean_text(data.get("status"), 40)
        if user.id == admin.user_id and next_status != "active":
            raise HTTPException(status_code=400, detail="Cannot deactivate your own system session")
        user.status = next_status

    db.add(
        AuditLog(
            company_id=user.company_id,
            user_id=admin.user_id,
            action="system_panel_user_updated",
            entity_type="user",
            entity_id=user.id,
            payload_json=json_text(
                {
                    "full_name": user.full_name,
                    "role": next_role_name,
                    "status": user.status,
                }
            ),
        )
    )
    db.commit()
    db.refresh(user)
    return {"ok": True, "user": serialize_panel_user(db, user)}


@app.post("/api/system/users/{user_id}/reset-password")
def reset_system_panel_user_password(
    user_id: str,
    payload: SystemUserPasswordResetPayload = Body(default_factory=SystemUserPasswordResetPayload),
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_system_admin(admin)
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Panel user not found")

    company = resolve_company(db, user.company_id)
    role = db.get(Role, user.role_id) if user.role_id else None
    role_name = role.name if role else ""
    password = generate_password()
    user.password_hash = hash_password(password)
    user.status = "active"
    db.add(
        AuditLog(
            company_id=user.company_id,
            user_id=admin.user_id,
            action="system_panel_user_password_reset",
            entity_type="user",
            entity_id=user.id,
            payload_json=json_text({"email": user.email, "reason": clean_text(payload.reason, 180)}),
        )
    )
    db.commit()
    db.refresh(user)

    delivery_status = send_plain_email(
        user.email,
        "Nuevo acceso temporal al panel VYNTRA",
        panel_user_email_body(company, user.full_name, user.email, password, role_name),
    )
    db.add(
        AuditLog(
            company_id=user.company_id,
            user_id=admin.user_id,
            action="system_panel_user_password_delivery_attempted",
            entity_type="user",
            entity_id=user.id,
            payload_json=json_text({"email": user.email, "delivery_status": delivery_status}),
        )
    )
    db.commit()

    credentials = {
        "email": user.email,
        "delivery_status": delivery_status,
    }
    if allow_local_testing_secrets():
        credentials["password"] = password
    return {"ok": True, "user": serialize_panel_user(db, user), "credentials": credentials}


@app.get("/api/devices")
def list_devices(
    company_id: str | None = None,
    employee_id: str | None = None,
    status_filter: str | None = None,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "devices:read")
    company = resolve_admin_company(db, admin, company_id)
    query = select(Device).where(Device.company_id == company.id)
    if employee_id:
        query = query.where(Device.employee_id == clean_text(employee_id, 36))
    devices = db.execute(query.order_by(Device.last_seen_at.desc().nullslast(), Device.name)).scalars().all()
    employee_ids = {device.employee_id for device in devices if device.employee_id}
    employees = {
        employee.id: employee
        for employee in db.execute(select(Employee).where(Employee.id.in_(employee_ids))).scalars().all()
    } if employee_ids else {}
    items = [serialize_device(device, company, employees.get(device.employee_id)) for device in devices]
    clean_status = clean_text(status_filter, 40)
    if clean_status:
        items = [item for item in items if item["status"] == clean_status]
    return {
        "company": {"id": company.id, "name": company.name},
        "count": len(items),
        "devices": items,
    }


@app.post("/api/devices")
def create_device(
    payload: DeviceCreatePayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "devices:manage")
    data = payload.model_dump(exclude_unset=True)
    company = resolve_admin_company(db, admin, data.get("company_id"))
    name = clean_text(data.get("name"), 160)
    hostname = clean_text(data.get("hostname") or name, 160)
    location = clean_text(data.get("location"), 160)
    agent_version = clean_text(data.get("agent_version") or "pending", 40)
    employee_id = clean_text(data.get("employee_id"), 36) or None
    employee = require_company_owned(db, Employee, employee_id, company.id, "Employee") if employee_id else None

    duplicate = db.execute(
        select(Device).where(Device.company_id == company.id, func.lower(Device.name) == name.lower())
    ).scalar_one_or_none()
    if duplicate is not None:
        raise HTTPException(status_code=409, detail="Device name already exists")

    token = generate_device_token()
    while db.execute(select(Device).where(Device.token_sha256 == hash_token(token))).scalar_one_or_none():
        token = generate_device_token()

    device = Device(
        company_id=company.id,
        employee_id=employee.id if employee else None,
        name=name,
        hostname=hostname,
        location=location,
        token_sha256=hash_token(token),
        is_active=True,
        agent_version=agent_version,
    )
    db.add(device)
    db.flush()
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="device_created",
            entity_type="device",
            entity_id=device.id,
            payload_json=json_text({"name": device.name, "employee_id": device.employee_id, "agent_version": device.agent_version}),
        )
    )
    db.commit()
    db.refresh(device)
    return {
        "ok": True,
        "device": serialize_device(device, company, employee),
        "credentials": {"device_token": token, "delivery_status": "manual"},
    }


@app.patch("/api/devices/{device_id}")
def update_device(
    device_id: str,
    payload: DevicePatchPayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "devices:manage")
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    company = resolve_admin_company(db, admin, device.company_id)
    if device.company_id != company.id:
        raise HTTPException(status_code=403, detail="Cannot edit device from another company")
    data = payload.model_dump(exclude_unset=True)

    if "name" in data:
        name = clean_text(data.get("name"), 160)
        duplicate = db.execute(
            select(Device).where(
                Device.company_id == company.id,
                Device.id != device.id,
                func.lower(Device.name) == name.lower(),
            )
        ).scalar_one_or_none()
        if duplicate is not None:
            raise HTTPException(status_code=409, detail="Device name already exists")
        device.name = name
    if "hostname" in data:
        device.hostname = clean_text(data.get("hostname"), 160)
    if "location" in data:
        device.location = clean_text(data.get("location"), 160)
    if "agent_version" in data:
        device.agent_version = clean_text(data.get("agent_version"), 40) or "unknown"
    if "employee_id" in data:
        employee_id = clean_text(data.get("employee_id"), 36) or None
        require_company_owned(db, Employee, employee_id, company.id, "Employee") if employee_id else None
        device.employee_id = employee_id
    if "is_active" in data and data.get("is_active") is not None:
        device.is_active = bool(data.get("is_active"))

    employee = db.get(Employee, device.employee_id) if device.employee_id else None
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="device_updated",
            entity_type="device",
            entity_id=device.id,
            payload_json=json_text(
                {
                    "name": device.name,
                    "employee_id": device.employee_id,
                    "is_active": device.is_active,
                    "agent_version": device.agent_version,
                }
            ),
        )
    )
    db.commit()
    db.refresh(device)
    return {"ok": True, "device": serialize_device(device, company, employee)}


@app.post("/api/devices/{device_id}/rotate-token")
def rotate_device_token(
    device_id: str,
    payload: DeviceRotateTokenPayload = Body(default_factory=DeviceRotateTokenPayload),
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "devices:manage")
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    company = resolve_admin_company(db, admin, device.company_id)
    if device.company_id != company.id:
        raise HTTPException(status_code=403, detail="Cannot rotate token for another company")

    token = generate_device_token()
    while db.execute(select(Device).where(Device.token_sha256 == hash_token(token))).scalar_one_or_none():
        token = generate_device_token()
    device.token_sha256 = hash_token(token)
    device.is_active = True
    employee = db.get(Employee, device.employee_id) if device.employee_id else None
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="device_token_rotated",
            entity_type="device",
            entity_id=device.id,
            payload_json=json_text({"name": device.name, "reason": clean_text(payload.reason, 180)}),
        )
    )
    db.commit()
    db.refresh(device)
    return {
        "ok": True,
        "device": serialize_device(device, company, employee),
        "credentials": {"device_token": token, "delivery_status": "manual"},
    }


@app.post("/api/station/login")
def station_login(
    request: Request,
    payload: StationLoginPayload,
    device: Device = Depends(require_device),
    db: Session = Depends(get_db),
):
    email = clean_text(payload.email or payload.correo, 180).lower()
    password = payload.password
    occurred_at = (
        parse_optional_client_datetime(payload.occurred_at)
        or now_utc()
    )
    client_ip_address = client_ip(request)

    if not email or not password:
        db.add(
            LoginAttempt(
                email_attempted=email,
                ip_address=client_ip_address[:45],
                success=False,
            )
        )
        db.add(
            StationLoginEvent(
                company_id=device.company_id,
                employee_id=device.employee_id,
                credential_id=None,
                device_id=device.id,
                email_attempted=email,
                success=False,
                failure_reason="missing_credentials",
                occurred_at=occurred_at,
                ip_address=client_ip_address[:80],
                payload_json=json_text({"email": email, "reason": "missing_credentials"}),
            )
        )
        db.commit()
        raise HTTPException(status_code=400, detail="Missing credentials")

    credential = find_employee_credential(db, device.company_id, email)
    employee = db.get(Employee, credential.employee_id) if credential else None
    success = (
        credential is not None
        and employee is not None
        and credential.status == "active"
        and employee.status == "active"
        and verify_password_hash(password, credential.password_hash)
    )

    db.add(
        LoginAttempt(
            email_attempted=email,
            ip_address=client_ip_address[:45],
            success=success,
        )
    )
    db.add(
        StationLoginEvent(
            company_id=device.company_id,
            employee_id=credential.employee_id if credential else device.employee_id,
            credential_id=credential.id if credential else None,
            device_id=device.id,
            email_attempted=email,
            success=success,
            failure_reason="" if success else "invalid_credentials",
            occurred_at=occurred_at,
            ip_address=client_ip_address[:80],
            payload_json=json_text(
                {
                    "email": email,
                    "auth_source": "backend",
                    "agent_version": clean_text(payload.agent_version, 40),
                }
            ),
        )
    )

    if not success:
        db.commit()
        raise HTTPException(status_code=401, detail="Invalid credentials")

    credential.last_login_at = occurred_at
    device.employee_id = credential.employee_id
    device.last_seen_at = occurred_at
    db.commit()

    return {
        "ok": True,
        "company": {
            "id": device.company_id,
        },
        "employee": {
            "id": employee.id,
            "employee_code": employee.employee_code,
            "full_name": employee.full_name,
            "email": employee.email,
            "department_id": employee.department_id,
            "position_id": employee.position_id,
        },
        "credential": {
            "id": credential.id,
            "email": credential.email,
            "password_change_required": bool(credential.password_change_required),
        },
        "device": {
            "id": device.id,
            "name": device.name,
        },
    }


@app.post("/api/station/password/change")
def station_change_password(
    payload: StationPasswordChangePayload,
    device: Device = Depends(require_device),
    db: Session = Depends(get_db),
):
    email = clean_email(payload.email)
    credential = find_employee_credential(db, device.company_id, email)
    employee = db.get(Employee, credential.employee_id) if credential else None
    if (
        credential is None
        or employee is None
        or credential.status != "active"
        or employee.status != "active"
        or not verify_password_hash(payload.current_password, credential.password_hash)
    ):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    validate_password_policy(payload.new_password)
    if verify_password_hash(payload.new_password, credential.password_hash):
        raise HTTPException(status_code=400, detail="New password must be different")

    changed_at = now_utc()
    credential.password_hash = hash_password(payload.new_password)
    credential.password_change_required = False
    credential.password_changed_at = changed_at
    credential.reset_code_hash = ""
    credential.reset_code_expires_at = None
    credential.reset_requested_at = None
    credential.reset_verified_at = None
    credential.reset_attempts = 0
    device.employee_id = credential.employee_id
    device.last_seen_at = changed_at
    db.add(
        AuditLog(
            company_id=device.company_id,
            device_id=device.id,
            action="station_password_changed",
            entity_type="employee_credential",
            entity_id=credential.id,
            payload_json=json_text({"email": email, "employee_id": employee.id}),
        )
    )
    db.commit()
    return {"ok": True, "password_change_required": False}


@app.post("/api/station/password-reset/request")
def station_password_reset_request(
    payload: StationPasswordResetRequestPayload,
    device: Device = Depends(require_device),
    db: Session = Depends(get_db),
):
    email = clean_email(payload.email)
    credential = find_employee_credential(db, device.company_id, email)
    reset_code = ""
    delivery_status = "not_configured"
    if credential and credential.status == "active":
        reset_code = generate_reset_code()
        credential.reset_code_hash = hash_token(reset_code)
        credential.reset_code_expires_at = now_utc() + timedelta(minutes=10)
        credential.reset_requested_at = now_utc()
        credential.reset_verified_at = None
        credential.reset_attempts = 0
        db.commit()
        company = db.get(Company, device.company_id)
        if company:
            delivery_status = send_plain_email(
                credential.email,
                "Codigo de recuperacion VYNTRA",
                reset_code_email_body(company, reset_code),
            )
        db.add(
            AuditLog(
                company_id=device.company_id,
                device_id=device.id,
                action="station_password_reset_requested",
                entity_type="employee_credential",
                entity_id=credential.id,
                payload_json=json_text({"email": email, "delivery_status": delivery_status}),
            )
        )
    else:
        db.add(
            AuditLog(
                company_id=device.company_id,
                device_id=device.id,
                action="station_password_reset_requested_unknown",
                entity_type="employee_credential",
                entity_id="",
                payload_json=json_text({"email": email}),
            )
        )
    db.commit()
    response = {
        "ok": True,
        "delivery_status": delivery_status,
        "message": "If the account exists, a verification code was sent.",
    }
    if reset_code and allow_local_testing_secrets():
        response["reset_code"] = reset_code
        response["note"] = "SMTP is not configured; reset code is returned for local testing."
    return response


@app.post("/api/station/password-reset/confirm")
def station_password_reset_confirm(
    payload: StationPasswordResetConfirmPayload,
    device: Device = Depends(require_device),
    db: Session = Depends(get_db),
):
    email = clean_email(payload.email)
    credential = find_employee_credential(db, device.company_id, email)
    employee = db.get(Employee, credential.employee_id) if credential else None
    if credential is None or employee is None or credential.status != "active":
        raise HTTPException(status_code=400, detail="Invalid or expired verification code")

    expires_at = credential.reset_code_expires_at
    if (
        not credential.reset_code_hash
        or expires_at is None
        or now_utc() > _as_aware_utc(expires_at)
        or credential.reset_attempts >= 5
    ):
        raise HTTPException(status_code=400, detail="Invalid or expired verification code")

    if not secrets.compare_digest(credential.reset_code_hash, hash_token(payload.reset_code.strip())):
        credential.reset_attempts += 1
        db.commit()
        raise HTTPException(status_code=400, detail="Invalid or expired verification code")

    validate_password_policy(payload.new_password)
    verified_at = now_utc()
    credential.password_hash = hash_password(payload.new_password)
    credential.password_change_required = False
    credential.password_changed_at = verified_at
    credential.reset_code_hash = ""
    credential.reset_code_expires_at = None
    credential.reset_verified_at = verified_at
    credential.reset_attempts = 0
    device.employee_id = credential.employee_id
    device.last_seen_at = verified_at
    db.add(
        AuditLog(
            company_id=device.company_id,
            device_id=device.id,
            action="station_password_reset_confirmed",
            entity_type="employee_credential",
            entity_id=credential.id,
            payload_json=json_text({"email": email, "employee_id": employee.id}),
        )
    )
    db.commit()
    return {"ok": True, "password_change_required": False}


@app.post("/api/station/access-codes/consume")
def consume_station_access_code(
    payload: ConsumeAccessCodePayload,
    device: Device = Depends(require_device),
    db: Session = Depends(get_db),
):
    if not device.employee_id:
        raise HTTPException(status_code=400, detail="Device has no authenticated employee")

    employee = db.get(Employee, device.employee_id)
    if employee is None:
        raise HTTPException(status_code=400, detail="Employee not found for device")

    code_value = clean_text(payload.code, 80).upper()
    access_type = clean_text(payload.type, 40)
    issued_now = now_utc()

    def reject(reason: str, entity_type: str = "", entity_id: str = ""):
        db.add(
            AuditLog(
                company_id=device.company_id,
                user_id=None,
                device_id=device.id,
                action="station_access_code_rejected",
                entity_type=entity_type,
                entity_id=entity_id,
                payload_json=json_text(
                    {
                        "employee_id": employee.id,
                        "type": access_type,
                        "reason": reason,
                    }
                ),
            )
        )
        db.commit()
        raise HTTPException(status_code=400, detail="Invalid, expired or already used access code")

    if access_type == "overtime":
        access_code = db.execute(
            select(OvertimeAuthorization).where(
                OvertimeAuthorization.company_id == device.company_id,
                OvertimeAuthorization.employee_id == employee.id,
                OvertimeAuthorization.code == code_value,
            )
        ).scalar_one_or_none()
        entity_type = "overtime_authorization"
    else:
        access_code = db.execute(
            select(StationRestoreCode).where(
                StationRestoreCode.company_id == device.company_id,
                StationRestoreCode.employee_id == employee.id,
                StationRestoreCode.code == code_value,
            )
        ).scalar_one_or_none()
        entity_type = "station_restore_code"

    if access_code is None:
        reject("not_found")

    if access_code.status != "issued":
        reject("not_issued", entity_type, access_code.id)

    if issued_now < _as_aware_utc(access_code.valid_from):
        reject("not_yet_valid", entity_type, access_code.id)

    if issued_now > _as_aware_utc(access_code.valid_until):
        access_code.status = "expired"
        reject("expired", entity_type, access_code.id)

    access_code.device_id = device.id
    if access_type == "overtime":
        access_code.status = "active"
        access_code.started_at = issued_now
        audit_action = "overtime_code_consumed"
    else:
        access_code.status = "used"
        access_code.used_at = issued_now
        audit_action = "station_restore_code_consumed"

    db.add(
        AuditLog(
            company_id=device.company_id,
            user_id=None,
            device_id=device.id,
            action=audit_action,
            entity_type=entity_type,
            entity_id=access_code.id,
            payload_json=json_text(
                {
                    "employee_id": employee.id,
                    "type": access_type,
                    "valid_until": access_code.valid_until.isoformat(),
                }
            ),
        )
    )
    db.commit()
    db.refresh(access_code)
    return {
        "ok": True,
        "authorization": serialize_access_code(access_type, access_code, employee),
    }


@app.get("/api/productivity/catalogs")
def productivity_catalogs(
    company_id: str | None = None,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "employees:read")
    company = resolve_admin_company(db, admin, company_id)
    departments = db.execute(
        select(Department)
        .where(Department.company_id == company.id)
        .order_by(Department.name)
    ).scalars().all()
    positions = db.execute(
        select(Position)
        .where(Position.company_id == company.id)
        .order_by(Position.name)
    ).scalars().all()
    employees = db.execute(
        select(Employee)
        .where(Employee.company_id == company.id)
        .order_by(Employee.full_name)
    ).scalars().all()
    return {
        "company": {"id": company.id, "name": company.name},
        "classifications": ["productive", "neutral", "non_productive", "uncategorized"],
        "departments": [
            {"id": row.id, "name": row.name, "status": row.status}
            for row in departments
        ],
        "positions": [
            {"id": row.id, "name": row.name, "status": row.status}
            for row in positions
        ],
        "employees": [
            {
                "id": row.id,
                "employee_code": row.employee_code,
                "full_name": row.full_name,
                "email": row.email,
                "department_id": row.department_id,
                "position_id": row.position_id,
                "status": row.status,
            }
            for row in employees
        ],
    }

@app.post("/api/settings/departments")
def create_department(
    payload: DepartmentPayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "settings:manage")
    payload = payload.model_dump(exclude_unset=True)
    company = resolve_admin_company(db, admin, payload.get("company_id"))
    name = clean_text(payload.get("name"), 120)
    if len(name) < 2:
        raise HTTPException(status_code=400, detail="Department name is required")
    department = db.execute(
        select(Department).where(
            Department.company_id == company.id,
            func.lower(Department.name) == name.lower(),
        )
    ).scalar_one_or_none()
    if department is None:
        department = Department(company_id=company.id, name=name)
        db.add(department)
        db.flush()
        db.add(
            AuditLog(
                company_id=company.id,
                user_id=admin.user_id,
                action="department_created",
                entity_type="department",
                entity_id=department.id,
                payload_json=json_text({"name": name}),
            )
        )
        db.commit()
        db.refresh(department)
    return {"ok": True, "department": serialize_department(department)}


@app.post("/api/settings/employees")
def create_monitored_employee(
    payload: EmployeeCreatePayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "employees:manage")
    payload = payload.model_dump(exclude_unset=True)
    company = resolve_admin_company(db, admin, payload.get("company_id"))
    full_name = clean_text(payload.get("full_name") or payload.get("name"), 180)
    email = clean_email(payload.get("email"))
    if len(full_name) < 2:
        raise HTTPException(status_code=400, detail="Employee name is required")

    department_id = clean_text(payload.get("department_id"), 36) or None
    new_department = clean_text(payload.get("new_department"), 120)
    department = None
    if new_department:
        department = db.execute(
            select(Department).where(
                Department.company_id == company.id,
                func.lower(Department.name) == new_department.lower(),
            )
        ).scalar_one_or_none()
        if department is None:
            department = Department(company_id=company.id, name=new_department)
            db.add(department)
            db.flush()
        department_id = department.id
    elif department_id:
        department = require_company_owned(db, Department, department_id, company.id, "Department")

    duplicate_credential = db.execute(
        select(EmployeeCredential).where(
            EmployeeCredential.company_id == company.id,
            EmployeeCredential.email == email,
        )
    ).scalar_one_or_none()
    if duplicate_credential:
        raise HTTPException(status_code=409, detail="Email already has station credentials")

    controls = company_controls(db, company.id)
    employee_limit = int(controls.get("employee_limit") or 0)
    active_employee_count = db.execute(
        select(func.count())
        .select_from(Employee)
        .where(Employee.company_id == company.id, Employee.status == "active")
    ).scalar_one()
    if employee_limit > 0 and int(active_employee_count or 0) >= employee_limit:
        raise HTTPException(
            status_code=403,
            detail=f"Employee limit reached for this company ({employee_limit})",
        )

    next_count = db.execute(
        select(func.count()).select_from(Employee).where(Employee.company_id == company.id)
    ).scalar_one()
    employee_code = clean_text(payload.get("employee_code"), 80) or f"EMP-{int(next_count or 0) + 1:03d}"
    password = generate_password()
    employee = Employee(
        company_id=company.id,
        department_id=department_id,
        employee_code=employee_code,
        full_name=full_name,
        email=email,
        status="active",
    )
    db.add(employee)
    db.flush()
    credential = EmployeeCredential(
        company_id=company.id,
        employee_id=employee.id,
        email=email,
        password_hash=hash_password(password),
        password_change_required=True,
        status="active",
    )
    db.add(credential)
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="monitored_employee_created",
            entity_type="employee",
            entity_id=employee.id,
            payload_json=json_text(
                {
                    "email": email,
                    "department_id": department_id,
                    "email_delivery": "pending",
                    "password_change_required": True,
                }
            ),
        )
    )
    db.commit()
    db.refresh(employee)
    delivery_status = send_plain_email(
        email,
        "Acceso temporal VYNTRA",
        temporary_password_email_body(company, employee, email, password),
    )
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="employee_credential_delivery_attempted",
            entity_type="employee_credential",
            entity_id=credential.id,
            payload_json=json_text({"email": email, "delivery_status": delivery_status}),
        )
    )
    db.commit()
    credentials = {
        "email": email,
        "password_change_required": True,
        "delivery_status": delivery_status,
    }
    if allow_local_testing_secrets():
        credentials.update(
            {
                "password": password,
                "note": "SMTP is not configured; password is returned once for local testing.",
            }
        )

    return {
        "ok": True,
        "employee": serialize_employee(employee, department),
        "credentials": credentials,
    }


@app.patch("/api/settings/employees/{employee_id}")
def update_monitored_employee(
    employee_id: str,
    payload: EmployeePatchPayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "employees:manage")
    payload = payload.model_dump(exclude_unset=True)
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status_code=404, detail="Employee not found")
    company = resolve_admin_company(db, admin, employee.company_id)
    if employee.company_id != company.id:
        raise HTTPException(status_code=403, detail="Cannot edit employee from another company")

    department = db.get(Department, employee.department_id) if employee.department_id else None
    if "new_department" in payload and clean_text(payload.get("new_department"), 120):
        new_department = clean_text(payload.get("new_department"), 120)
        department = db.execute(
            select(Department).where(
                Department.company_id == company.id,
                func.lower(Department.name) == new_department.lower(),
            )
        ).scalar_one_or_none()
        if department is None:
            department = Department(company_id=company.id, name=new_department)
            db.add(department)
            db.flush()
        employee.department_id = department.id
    elif "department_id" in payload:
        department_id = clean_text(payload.get("department_id"), 36) or None
        department = require_company_owned(db, Department, department_id, company.id, "Department") if department_id else None
        employee.department_id = department_id

    if "full_name" in payload:
        full_name = clean_text(payload.get("full_name"), 180)
        if len(full_name) < 2:
            raise HTTPException(status_code=400, detail="Employee name is required")
        employee.full_name = full_name

    if "email" in payload:
        email = clean_email(payload.get("email"))
        duplicate_credential = db.execute(
            select(EmployeeCredential).where(
                EmployeeCredential.company_id == company.id,
                EmployeeCredential.email == email,
                EmployeeCredential.employee_id != employee.id,
            )
        ).scalar_one_or_none()
        if duplicate_credential:
            raise HTTPException(status_code=409, detail="Email already has station credentials")
        employee.email = email
        credential = db.execute(
            select(EmployeeCredential).where(EmployeeCredential.employee_id == employee.id)
        ).scalar_one_or_none()
        if credential:
            credential.email = email

    if "status" in payload:
        next_status = clean_text(payload.get("status"), 40)
        if next_status not in {"active", "inactive"}:
            raise HTTPException(status_code=400, detail="Invalid employee status")
        employee.status = next_status
        credentials = db.execute(
            select(EmployeeCredential).where(EmployeeCredential.employee_id == employee.id)
        ).scalars().all()
        for credential in credentials:
            credential.status = next_status

    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="monitored_employee_updated",
            entity_type="employee",
            entity_id=employee.id,
            payload_json=json_text(
                {
                    "department_id": employee.department_id,
                    "status": employee.status,
                }
            ),
        )
    )
    db.commit()
    db.refresh(employee)
    return {"ok": True, "employee": serialize_employee(employee, department)}


@app.get("/api/settings/restore-codes")
def list_restore_codes(
    company_id: str | None = None,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "access_codes:read")
    company = resolve_admin_company(db, admin, company_id)
    codes = db.execute(
        select(StationRestoreCode)
        .where(StationRestoreCode.company_id == company.id)
        .order_by(StationRestoreCode.created_at.desc())
    ).scalars().all()
    employee_ids = [code.employee_id for code in codes]
    employees = {}
    if employee_ids:
        employees = {
            employee.id: employee
            for employee in db.execute(
                select(Employee).where(Employee.id.in_(employee_ids))
            ).scalars()
        }
    return {
        "company": {"id": company.id, "name": company.name},
        "codes": [serialize_restore_code(code, employees.get(code.employee_id)) for code in codes],
    }


@app.post("/api/settings/restore-codes")
def create_restore_code(
    payload: RestoreCodePayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "access_codes:manage")
    payload = payload.model_dump(exclude_unset=True)
    employee_id = clean_text(payload.get("employee_id"), 36)
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status_code=404, detail="Employee not found")
    company = resolve_admin_company(db, admin, employee.company_id)
    if employee.company_id != company.id:
        raise HTTPException(status_code=403, detail="Cannot create code for another company")

    valid_minutes = max(5, min(int(payload.get("valid_minutes") or 60), 1440))
    issued_at = now_utc()
    code_value = generate_restore_code()
    while db.execute(select(StationRestoreCode).where(StationRestoreCode.code == code_value)).scalar_one_or_none():
        code_value = generate_restore_code()

    restore_code = StationRestoreCode(
        company_id=company.id,
        employee_id=employee.id,
        code=code_value,
        reason=clean_text(payload.get("reason") or "Restaurar estacion de marcaje", 180),
        valid_from=issued_at,
        valid_until=issued_at + timedelta(minutes=valid_minutes),
        created_by_user_id=admin.user_id,
    )
    db.add(restore_code)
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="station_restore_code_created",
            entity_type="station_restore_code",
            entity_id=restore_code.id,
            payload_json=json_text(
                {
                    "employee_id": employee.id,
                    "email": employee.email,
                    "delivery_status": "pending",
                    "valid_minutes": valid_minutes,
                }
            ),
        )
    )
    db.commit()
    db.refresh(restore_code)
    delivery_status = send_plain_email(
        employee.email,
        "Codigo para restaurar estacion VYNTRA",
        access_code_email_body(company, employee, "station_reopen", code_value, valid_minutes),
    )
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="station_restore_code_delivery_attempted",
            entity_type="station_restore_code",
            entity_id=restore_code.id,
            payload_json=json_text({"employee_id": employee.id, "email": employee.email, "delivery_status": delivery_status}),
        )
    )
    db.commit()
    response = {
        "ok": True,
        "code": serialize_restore_code(restore_code, employee),
        "delivery_status": delivery_status,
    }
    if allow_local_testing_secrets():
        response["note"] = "SMTP is not configured; code is returned for local testing."
    return response


@app.get("/api/settings/access-codes")
def list_access_codes(
    company_id: str | None = None,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "access_codes:read")
    company = resolve_admin_company(db, admin, company_id)
    station_codes = db.execute(
        select(StationRestoreCode).where(StationRestoreCode.company_id == company.id)
    ).scalars().all()
    overtime_codes = db.execute(
        select(OvertimeAuthorization).where(OvertimeAuthorization.company_id == company.id)
    ).scalars().all()
    employee_ids = [code.employee_id for code in station_codes] + [code.employee_id for code in overtime_codes]
    employees = {}
    if employee_ids:
        employees = {
            employee.id: employee
            for employee in db.execute(select(Employee).where(Employee.id.in_(employee_ids))).scalars()
        }
    codes = [
        serialize_access_code("station_reopen", code, employees.get(code.employee_id))
        for code in station_codes
    ] + [
        serialize_access_code("overtime", code, employees.get(code.employee_id))
        for code in overtime_codes
    ]
    codes.sort(key=lambda row: row.get("created_at") or "", reverse=True)
    return {
        "company": {"id": company.id, "name": company.name},
        "codes": codes,
    }


@app.post("/api/settings/access-codes")
def create_access_code(
    payload: AccessCodePayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "access_codes:manage")
    payload = payload.model_dump(exclude_unset=True)
    access_type = clean_text(payload.get("type"), 40)
    if access_type not in {"station_reopen", "overtime"}:
        raise HTTPException(status_code=400, detail="Invalid access code type")

    employee_id = clean_text(payload.get("employee_id"), 36)
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status_code=404, detail="Employee not found")
    company = resolve_admin_company(db, admin, employee.company_id)
    if employee.company_id != company.id:
        raise HTTPException(status_code=403, detail="Cannot create code for another company")
    if employee.status != "active":
        raise HTTPException(status_code=400, detail="Employee must be active")

    valid_minutes = max(5, min(int(payload.get("valid_minutes") or 60), 1440))
    issued_at = now_utc()
    code_value = generate_restore_code()
    while (
        db.execute(select(StationRestoreCode).where(StationRestoreCode.code == code_value)).scalar_one_or_none()
        or db.execute(select(OvertimeAuthorization).where(OvertimeAuthorization.code == code_value)).scalar_one_or_none()
    ):
        code_value = generate_restore_code()

    assigned_minutes = max(5, min(int(payload.get("assigned_minutes") or valid_minutes), 1440))
    reason = clean_text(payload.get("reason"), 180)
    if access_type == "overtime" and len(reason) < 3:
        raise HTTPException(status_code=400, detail="reason is required for overtime codes")
    if access_type == "overtime":
        access_code = OvertimeAuthorization(
            company_id=company.id,
            employee_id=employee.id,
            code=code_value,
            reason=reason,
            assigned_minutes=assigned_minutes,
            valid_from=issued_at,
            valid_until=issued_at + timedelta(minutes=valid_minutes),
            created_by_user_id=admin.user_id,
        )
        audit_action = "overtime_code_created"
        audit_entity = "overtime_authorization"
    else:
        access_code = StationRestoreCode(
            company_id=company.id,
            employee_id=employee.id,
            code=code_value,
            reason=reason or "Reabrir estacion de marcaje",
            valid_from=issued_at,
            valid_until=issued_at + timedelta(minutes=valid_minutes),
            created_by_user_id=admin.user_id,
        )
        audit_action = "station_restore_code_created"
        audit_entity = "station_restore_code"

    db.add(access_code)
    db.flush()
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action=audit_action,
            entity_type=audit_entity,
            entity_id=access_code.id,
            payload_json=json_text(
                {
                    "employee_id": employee.id,
                    "email": employee.email,
                    "type": access_type,
                    "valid_minutes": valid_minutes,
                    "delivery_status": "pending",
                }
            ),
        )
    )
    db.commit()
    db.refresh(access_code)
    delivery_status = send_plain_email(
        employee.email,
        f"Codigo VYNTRA - {access_type}",
        access_code_email_body(
            company,
            employee,
            access_type,
            code_value,
            valid_minutes,
            assigned_minutes if access_type == "overtime" else None,
        ),
    )
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action=f"{audit_entity}_delivery_attempted",
            entity_type=audit_entity,
            entity_id=access_code.id,
            payload_json=json_text(
                {
                    "employee_id": employee.id,
                    "email": employee.email,
                    "type": access_type,
                    "delivery_status": delivery_status,
                }
            ),
        )
    )
    db.commit()
    response = {
        "ok": True,
        "code": serialize_access_code(access_type, access_code, employee),
        "delivery_status": delivery_status,
    }
    if allow_local_testing_secrets():
        response["note"] = "SMTP is not configured; code is returned for local testing."
    return response


@app.get("/api/incidents")
def list_incidents(
    company_id: str | None = None,
    status_filter: str | None = None,
    employee_id: str | None = None,
    incident_type: str | None = None,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "incidents:read")
    company = resolve_admin_company(db, admin, company_id)
    query = select(Incident).where(Incident.company_id == company.id)
    if status_filter:
        query = query.where(Incident.status == clean_text(status_filter, 40))
    if employee_id:
        query = query.where(Incident.employee_id == clean_text(employee_id, 36))
    if incident_type:
        query = query.where(Incident.incident_type == clean_text(incident_type, 80))
    incidents = db.execute(
        query.order_by(Incident.requested_at.desc(), Incident.id.desc()).limit(200)
    ).scalars().all()
    return {
        "company": {"id": company.id, "name": company.name},
        "count": len(incidents),
        "incidents": [serialize_incident(db, incident) for incident in incidents],
    }


@app.patch("/api/incidents/{incident_id}")
def resolve_incident(
    incident_id: str,
    payload: IncidentResolutionPayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "incidents:resolve")
    incident = db.get(Incident, incident_id)
    if incident is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    company = resolve_admin_company(db, admin, incident.company_id)
    incident.status = payload.status
    incident.resolution_notes = clean_text(payload.resolution_notes, 2000)
    if len(incident.resolution_notes) < 3:
        raise HTTPException(status_code=400, detail="resolution_notes is required")
    incident.resolved_at = now_utc()
    adjustment = None
    if incident.status == "approved":
        adjustment = upsert_time_adjustment_for_incident(
            db,
            incident,
            admin,
            incident.resolution_notes,
        )
    else:
        adjustment = void_time_adjustment_for_incident(db, incident)
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="incident_resolved",
            entity_type="incident",
            entity_id=incident.id,
            payload_json=json_text(
                {
                    "status": incident.status,
                    "resolution_notes": incident.resolution_notes,
                    "time_adjustment_id": adjustment.id if adjustment else None,
                    "time_adjustment_status": adjustment.status if adjustment else None,
                }
            ),
        )
    )
    db.commit()
    db.refresh(incident)
    return {"ok": True, "incident": serialize_incident(db, incident)}


@app.get("/api/productivity/rules")
def list_productivity_rules(
    company_id: str | None = None,
    classification: str | None = None,
    department_id: str | None = None,
    position_id: str | None = None,
    employee_id: str | None = None,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "rules:read")
    company = resolve_admin_company(db, admin, company_id)
    query = select(ProductivityRule).where(ProductivityRule.company_id == company.id)
    if classification:
        query = query.where(ProductivityRule.classification == classification)
    if department_id:
        query = query.where(ProductivityRule.department_id == department_id)
    if position_id:
        query = query.where(ProductivityRule.position_id == position_id)
    if employee_id:
        query = query.where(ProductivityRule.employee_id == employee_id)
    rules = db.execute(
        query.order_by(
            ProductivityRule.is_active.desc(),
            ProductivityRule.priority.desc(),
            ProductivityRule.executable_name,
            ProductivityRule.title_contains,
        )
    ).scalars().all()
    return {
        "company": {"id": company.id, "name": company.name},
        "count": len(rules),
        "rules": [serialize_rule(db, row) for row in rules],
    }


@app.post("/api/productivity/rules")
def create_productivity_rule(
    background_tasks: BackgroundTasks,
    payload: ProductivityRulePayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "rules:manage")
    payload = payload.model_dump(exclude_unset=True)
    company = resolve_admin_company(db, admin, payload.get("company_id"))
    classification = clean_text(payload.get("classification"), 40)
    if classification not in {"productive", "neutral", "non_productive", "uncategorized"}:
        raise HTTPException(status_code=400, detail="Invalid classification")

    department_id = clean_text(payload.get("department_id"), 36) or None
    position_id = clean_text(payload.get("position_id"), 36) or None
    employee_id = clean_text(payload.get("employee_id"), 36) or None
    executable_name = clean_text(payload.get("executable_name"), 160)
    title_contains = clean_text(payload.get("title_contains"), 255)

    require_company_owned(db, Department, department_id, company.id, "Department")
    require_company_owned(db, Position, position_id, company.id, "Position")
    require_company_owned(db, Employee, employee_id, company.id, "Employee")
    if not executable_name and not title_contains:
        raise HTTPException(status_code=400, detail="Rule needs executable_name or title_contains")

    duplicate_query = select(ProductivityRule).where(
        ProductivityRule.company_id == company.id,
        ProductivityRule.executable_name == executable_name,
        ProductivityRule.title_contains == title_contains,
    )
    duplicate_query = duplicate_query.where(
        ProductivityRule.department_id == department_id
        if department_id
        else ProductivityRule.department_id.is_(None)
    )
    duplicate_query = duplicate_query.where(
        ProductivityRule.position_id == position_id
        if position_id
        else ProductivityRule.position_id.is_(None)
    )
    duplicate_query = duplicate_query.where(
        ProductivityRule.employee_id == employee_id
        if employee_id
        else ProductivityRule.employee_id.is_(None)
    )
    rule = db.execute(duplicate_query).scalar_one_or_none()
    if rule is None:
        rule = ProductivityRule(
            company_id=company.id,
            department_id=department_id,
            position_id=position_id,
            employee_id=employee_id,
            executable_name=executable_name,
            title_contains=title_contains,
        )
        db.add(rule)

    rule.classification = classification
    rule.priority = int(payload.get("priority") or rule.priority or 100)
    rule.is_active = bool(payload.get("is_active", True))
    rule.notes = clean_text(payload.get("notes"), 2000)
    rule.updated_at = now_utc()
    db.flush()

    reclassify_result = None
    if bool(payload.get("reclassify", True)):
        reclassify_result = reclassify_activities_for_company(db, company.id)

    db.commit()
    rebuild_queued = bool(payload.get("rebuild_blocks", True))
    if rebuild_queued:
        from scripts.run_productivity_etl import run as run_productivity_etl

        background_tasks.add_task(run_productivity_etl, company_id=company.id)
    return {
        "ok": True,
        "rule": serialize_rule(db, rule),
        "reclassify": reclassify_result,
        "rebuild_queued": rebuild_queued,
    }


@app.patch("/api/productivity/rules/{rule_id}")
def update_productivity_rule(
    rule_id: str,
    background_tasks: BackgroundTasks,
    payload: ProductivityRulePatchPayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "rules:manage")
    payload = payload.model_dump(exclude_unset=True)
    rule = db.get(ProductivityRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    resolve_admin_company(db, admin, rule.company_id)

    if "classification" in payload:
        classification = clean_text(payload.get("classification"), 40)
        if classification not in {"productive", "neutral", "non_productive", "uncategorized"}:
            raise HTTPException(status_code=400, detail="Invalid classification")
        rule.classification = classification
    if "department_id" in payload:
        department_id = clean_text(payload.get("department_id"), 36) or None
        require_company_owned(db, Department, department_id, rule.company_id, "Department")
        rule.department_id = department_id
    if "position_id" in payload:
        position_id = clean_text(payload.get("position_id"), 36) or None
        require_company_owned(db, Position, position_id, rule.company_id, "Position")
        rule.position_id = position_id
    if "employee_id" in payload:
        employee_id = clean_text(payload.get("employee_id"), 36) or None
        require_company_owned(db, Employee, employee_id, rule.company_id, "Employee")
        rule.employee_id = employee_id
    if "executable_name" in payload:
        rule.executable_name = clean_text(payload.get("executable_name"), 160)
    if "title_contains" in payload:
        rule.title_contains = clean_text(payload.get("title_contains"), 255)
    if "priority" in payload:
        rule.priority = int(payload.get("priority") or 100)
    if "is_active" in payload:
        rule.is_active = bool(payload.get("is_active"))
    if "notes" in payload:
        rule.notes = clean_text(payload.get("notes"), 2000)
    if not rule.executable_name and not rule.title_contains:
        raise HTTPException(status_code=400, detail="Rule needs executable_name or title_contains")

    rule.updated_at = now_utc()
    reclassify_result = None
    if bool(payload.get("reclassify", True)):
        reclassify_result = reclassify_activities_for_company(db, rule.company_id)

    db.commit()
    rebuild_queued = bool(payload.get("rebuild_blocks", True))
    if rebuild_queued:
        from scripts.run_productivity_etl import run as run_productivity_etl

        background_tasks.add_task(run_productivity_etl, company_id=rule.company_id)
    return {
        "ok": True,
        "rule": serialize_rule(db, rule),
        "reclassify": reclassify_result,
        "rebuild_queued": rebuild_queued,
    }


@app.post("/api/productivity/reclassify")
def reclassify_productivity(
    background_tasks: BackgroundTasks,
    payload: ReclassifyPayload = Body(default_factory=ReclassifyPayload),
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "rules:manage")
    payload = payload.model_dump(exclude_unset=True)
    company = resolve_admin_company(db, admin, payload.get("company_id"))
    result = reclassify_activities_for_company(db, company.id)
    db.commit()
    rebuild_queued = bool(payload.get("rebuild_blocks", True))
    if rebuild_queued:
        from scripts.run_productivity_etl import run as run_productivity_etl

        background_tasks.add_task(run_productivity_etl, company_id=company.id)
    return {"ok": True, "company_id": company.id, "rebuild_queued": rebuild_queued, **result}


@app.get("/api/productivity/uncategorized")
def uncategorized_activity_summary(
    company_id: str | None = None,
    limit: int = 25,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "rules:read")
    company = resolve_admin_company(db, admin, company_id)
    rows = db.execute(
        select(
            AppCatalog.executable_name.label("executable_name"),
            WindowTitleCatalog.title_text.label("title_text"),
            func.count(Activity.id).label("samples"),
            func.coalesce(func.sum(Activity.duration_seconds), 0).label("seconds"),
        )
        .select_from(Activity)
        .join(AppCatalog, AppCatalog.id == Activity.app_id, isouter=True)
        .join(WindowTitleCatalog, WindowTitleCatalog.id == Activity.window_title_id, isouter=True)
        .where(
            Activity.company_id == company.id,
            Activity.classification == "uncategorized",
        )
        .group_by(AppCatalog.executable_name, WindowTitleCatalog.title_text)
        .order_by(func.coalesce(func.sum(Activity.duration_seconds), 0).desc())
        .limit(max(1, min(limit, 100)))
    ).all()
    return {
        "company": {"id": company.id, "name": company.name},
        "items": [
            {
                "executable_name": row.executable_name or "",
                "title_text": row.title_text or "",
                "samples": int(row.samples or 0),
                "seconds": int(row.seconds or 0),
            }
            for row in rows
        ],
    }


@app.get("/api/productivity/dashboard")
def productivity_dashboard(
    company_id: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    employee_id: str | None = None,
    department_id: str | None = None,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "dashboard:read")
    company = resolve_admin_company(db, admin, company_id)
    query = select(ProductivityBlock).where(ProductivityBlock.company_id == company.id)
    if date_from:
        query = query.where(ProductivityBlock.block_date >= date_from)
    if date_to:
        query = query.where(ProductivityBlock.block_date <= date_to)
    if employee_id:
        query = query.where(ProductivityBlock.employee_id == employee_id)
    if department_id:
        query = query.where(ProductivityBlock.department_id_snapshot == department_id)

    blocks = db.execute(query.order_by(ProductivityBlock.block_date, ProductivityBlock.block_start)).scalars().all()
    employee_query = select(Employee).where(Employee.company_id == company.id)
    if employee_id:
        employee_query = employee_query.where(Employee.id == employee_id)
    if department_id:
        employee_query = employee_query.where(Employee.department_id == department_id)
    employees = {row.id: row for row in db.execute(employee_query).scalars()}
    adjustments = query_active_time_adjustments(db, company.id, date_from, date_to, employee_id, department_id)
    block_rows = [serialize_productivity_block(row) for row in blocks] + adjustment_virtual_blocks(db, adjustments, employees)
    block_rows.sort(key=lambda row: (row["block_date"], row["block_start"], row["employee_id"], row["id"]))
    totals = productivity_totals(block_rows)

    by_day: dict[str, dict] = {}
    for block in block_rows:
        day = by_day.setdefault(
            block["block_date"],
            {
                "block_date": block["block_date"],
                "total_seconds": 0,
                "active_seconds": 0,
                "productive_seconds": 0,
                "neutral_seconds": 0,
                "non_productive_seconds": 0,
                "uncategorized_seconds": 0,
                "idle_seconds": 0,
                "break_seconds": 0,
                "lunch_seconds": 0,
                "break_lunch_seconds": 0,
                "justified_seconds": 0,
            },
        )
        for key in [
            "total_seconds",
            "active_seconds",
            "productive_seconds",
            "neutral_seconds",
            "non_productive_seconds",
            "uncategorized_seconds",
            "idle_seconds",
            "break_seconds",
            "lunch_seconds",
            "break_lunch_seconds",
            "justified_seconds",
        ]:
            day[key] += int(block.get(key, 0) or 0)

    days = []
    for day in by_day.values():
        day_active = day["active_seconds"]
        day_total = day["total_seconds"]
        day["productivity_pct"] = percent(day["productive_seconds"], day_active)
        day["acceptable_pct"] = percent(day["productive_seconds"] + day["neutral_seconds"], day_active)
        day["idle_pct"] = percent(day["idle_seconds"], day_total)
        day["break_pct"] = percent(day["break_seconds"], day_total)
        day["lunch_pct"] = percent(day["lunch_seconds"], day_total)
        days.append(day)

    return {
        "company": {"id": company.id, "name": company.name},
        "filters": {
            "date_from": date_from,
            "date_to": date_to,
            "employee_id": employee_id,
            "department_id": department_id,
        },
        "totals": totals,
        "days": days,
        "adjustments": [serialize_time_adjustment(row) for row in adjustments],
        "blocks": block_rows,
    }


@app.get("/api/employees/{employee_id}/detail")
def employee_detail(
    employee_id: str,
    date_from: str | None = None,
    date_to: str | None = None,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "employees:read")
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status_code=404, detail="Employee not found")
    company = resolve_admin_company(db, admin, employee.company_id)
    if employee.company_id != company.id:
        raise HTTPException(status_code=403, detail="Cannot access another company")

    department = db.get(Department, employee.department_id) if employee.department_id else None
    position = db.get(Position, employee.position_id) if employee.position_id else None
    block_query = select(ProductivityBlock).where(
        ProductivityBlock.company_id == company.id,
        ProductivityBlock.employee_id == employee.id,
    )
    if date_from:
        block_query = block_query.where(ProductivityBlock.block_date >= date_from)
    if date_to:
        block_query = block_query.where(ProductivityBlock.block_date <= date_to)
    blocks = db.execute(
        block_query.order_by(ProductivityBlock.block_date, ProductivityBlock.block_start)
    ).scalars().all()
    adjustments = query_active_time_adjustments(db, company.id, date_from, date_to, employee.id)
    block_rows = [serialize_productivity_block(row) for row in blocks] + adjustment_virtual_blocks(
        db,
        adjustments,
        {employee.id: employee},
    )
    block_rows.sort(key=lambda row: (row["block_date"], row["block_start"], row["id"]))
    totals = productivity_totals(block_rows)

    days_by_date: dict[str, dict] = {}
    for block in block_rows:
        day = days_by_date.setdefault(
            block["block_date"],
            {
                "date": block["block_date"],
                "active_seconds": 0,
                "productive_seconds": 0,
                "neutral_seconds": 0,
                "non_productive_seconds": 0,
                "idle_seconds": 0,
                "break_seconds": 0,
                "lunch_seconds": 0,
                "justified_seconds": 0,
            },
        )
        day["active_seconds"] += int(block.get("active_seconds", 0) or 0)
        day["productive_seconds"] += int(block.get("productive_seconds", 0) or 0)
        day["neutral_seconds"] += int(block.get("neutral_seconds", 0) or 0)
        day["non_productive_seconds"] += int(block.get("non_productive_seconds", 0) or 0)
        day["idle_seconds"] += int(block.get("idle_seconds", 0) or 0)
        day["break_seconds"] += int(block.get("break_seconds", 0) or 0)
        day["lunch_seconds"] += int(block.get("lunch_seconds", 0) or 0)
        day["justified_seconds"] += int(block.get("justified_seconds", 0) or 0)

    activity_query = (
        select(
            AppCatalog.executable_name.label("app"),
            Activity.classification.label("classification"),
            func.coalesce(func.sum(Activity.duration_seconds), 0).label("seconds"),
            func.count(Activity.id).label("samples"),
        )
        .select_from(Activity)
        .join(AppCatalog, AppCatalog.id == Activity.app_id, isouter=True)
        .where(
            Activity.company_id == company.id,
            Activity.employee_id == employee.id,
        )
        .group_by(AppCatalog.executable_name, Activity.classification)
        .order_by(func.coalesce(func.sum(Activity.duration_seconds), 0).desc())
        .limit(20)
    )
    if date_from:
        activity_query = activity_query.where(Activity.started_at >= parse_client_datetime(f"{date_from}T00:00:00+00:00"))
    if date_to:
        activity_query = activity_query.where(Activity.started_at <= parse_client_datetime(f"{date_to}T23:59:59+00:00"))
    app_rows = db.execute(activity_query).all()

    evidence_query = select(EvidenceFile).where(
        EvidenceFile.company_id == company.id,
        EvidenceFile.employee_id == employee.id,
    )
    if date_from:
        evidence_query = evidence_query.where(EvidenceFile.captured_at >= parse_client_datetime(f"{date_from}T00:00:00+00:00"))
    if date_to:
        evidence_query = evidence_query.where(EvidenceFile.captured_at <= parse_client_datetime(f"{date_to}T23:59:59+00:00"))
    evidence = db.execute(
        evidence_query.order_by(EvidenceFile.captured_at.desc()).limit(8)
    ).scalars().all()

    return {
        "company": {"id": company.id, "name": company.name},
        "filters": {"date_from": date_from, "date_to": date_to},
        "employee": serialize_employee(employee, department, position),
        "totals": totals,
        "days": list(days_by_date.values()),
        "apps": [
            {
                "app": row.app or "(desconocido)",
                "classification": row.classification or "uncategorized",
                "seconds": int(row.seconds or 0),
                "samples": int(row.samples or 0),
            }
            for row in app_rows
        ],
        "adjustments": [serialize_time_adjustment(row) for row in adjustments],
        "blocks": block_rows,
        "evidence": [
            {
                "id": row.id,
                "captured_at": row.captured_at.isoformat(),
                "original_filename": row.original_filename,
                "equipment": row.equipment,
                "content_type": row.content_type,
                "status": row.status,
            }
            for row in evidence
        ],
    }


@app.get("/api/attendance/overview")
def attendance_overview(
    company_id: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    employee_id: str | None = None,
    department_id: str | None = None,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "attendance:read")
    company = resolve_admin_company(db, admin, company_id)
    employee_query = select(Employee).where(Employee.company_id == company.id)
    if employee_id:
        employee_query = employee_query.where(Employee.id == employee_id)
    if department_id:
        employee_query = employee_query.where(Employee.department_id == department_id)
    employees = db.execute(employee_query.order_by(Employee.full_name)).scalars().all()
    employee_ids = [employee.id for employee in employees]

    shift_query = select(Shift).where(Shift.company_id == company.id)
    if employee_ids:
        shift_query = shift_query.where(Shift.employee_id.in_(employee_ids))
    if employee_id and not employee_ids:
        shift_query = shift_query.where(Shift.employee_id == employee_id)
    if date_from:
        shift_query = shift_query.where(Shift.shift_date >= date_from)
    if date_to:
        shift_query = shift_query.where(Shift.shift_date <= date_to)
    shifts = db.execute(
        shift_query.order_by(Shift.shift_date.desc(), Shift.started_at.desc())
    ).scalars().all()
    shift_ids = [shift.id for shift in shifts]

    events_by_shift: dict[str, list[ShiftEvent]] = {}
    if shift_ids:
        events = db.execute(
            select(ShiftEvent)
            .where(ShiftEvent.shift_id.in_(shift_ids))
            .order_by(ShiftEvent.occurred_at)
        ).scalars().all()
        for event in events:
            events_by_shift.setdefault(event.shift_id, []).append(event)

    departments = {
        department.id: department
        for department in db.execute(
            select(Department).where(Department.company_id == company.id)
        ).scalars()
    }
    positions = {
        position.id: position
        for position in db.execute(
            select(Position).where(Position.company_id == company.id)
        ).scalars()
    }
    schedules = {
        employee.id: latest_employee_schedule(db, employee.id, date_to or date_from)
        for employee in employees
    }
    adjustments = query_active_time_adjustments(db, company.id, date_from, date_to, employee_id, department_id)
    shift_by_employee_date = {
        (shift.employee_id, shift.shift_date): shift.id
        for shift in shifts
    }
    justified_by_shift: dict[str, int] = {}
    for adjustment in adjustments:
        shift_key = (adjustment.employee_id, adjustment.started_at.date().isoformat())
        shift_id = shift_by_employee_date.get(shift_key)
        if shift_id:
            justified_by_shift[shift_id] = justified_by_shift.get(shift_id, 0) + adjustment.seconds

    return {
        "company": {"id": company.id, "name": company.name},
        "filters": {
            "date_from": date_from,
            "date_to": date_to,
            "employee_id": employee_id,
            "department_id": department_id,
        },
        "employees": [
            serialize_employee_for_attendance(
                employee,
                departments,
                positions,
                schedules.get(employee.id),
            )
            for employee in employees
        ],
        "time_adjustments": [serialize_time_adjustment(row) for row in adjustments],
        "shifts": [serialize_shift_for_attendance(shift, events_by_shift, justified_by_shift) for shift in shifts],
    }


@app.patch("/api/attendance/employees/{employee_id}/schedule")
def update_employee_schedule(
    employee_id: str,
    payload: SchedulePayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "attendance:manage")
    payload = payload.model_dump(exclude_unset=True)
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status_code=404, detail="Employee not found")
    company = resolve_admin_company(db, admin, employee.company_id)
    if employee.company_id != company.id:
        raise HTTPException(status_code=403, detail="Cannot edit employee from another company")

    start_time = validate_time(payload.get("start_time"), "start_time")
    end_time = validate_time(payload.get("end_time"), "end_time")
    effective_from = validate_date(payload.get("effective_from") or "1970-01-01", "effective_from")
    timezone_name = clean_text(payload.get("timezone") or company.timezone or "America/Managua", 80)

    schedule = db.execute(
        select(EmployeeSchedule).where(
            EmployeeSchedule.employee_id == employee.id,
            EmployeeSchedule.effective_from == effective_from,
        )
    ).scalar_one_or_none()
    if schedule is None:
        schedule = EmployeeSchedule(
            company_id=company.id,
            employee_id=employee.id,
            effective_from=effective_from,
        )
        db.add(schedule)
    schedule.start_time = start_time
    schedule.end_time = end_time
    schedule.timezone = timezone_name
    schedule.is_active = True
    schedule.updated_at = now_utc()
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="attendance_schedule_updated",
            entity_type="employee_schedule",
            entity_id=schedule.id,
            payload_json=json_text(
                {
                    "employee_id": employee.id,
                    "start_time": start_time,
                    "end_time": end_time,
                    "effective_from": effective_from,
                }
            ),
        )
    )
    db.commit()
    db.refresh(schedule)
    return {
        "ok": True,
        "schedule": {
            "id": schedule.id,
            "employee_id": schedule.employee_id,
            "start_time": schedule.start_time,
            "end_time": schedule.end_time,
            "effective_from": schedule.effective_from,
            "timezone": schedule.timezone,
        },
    }


@app.patch("/api/attendance/shifts/{shift_id}")
def update_attendance_shift(
    shift_id: str,
    payload: ShiftCorrectionPayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "attendance:manage")
    payload = payload.model_dump(exclude_unset=True)
    shift = db.get(Shift, shift_id)
    if shift is None:
        raise HTTPException(status_code=404, detail="Shift not found")
    company = resolve_admin_company(db, admin, shift.company_id)
    if shift.company_id != company.id:
        raise HTTPException(status_code=403, detail="Cannot edit shift from another company")

    correction_reason = clean_text(payload.get("correction_reason"), 180)
    if len(correction_reason) < 3:
        raise HTTPException(status_code=400, detail="correction_reason is required")

    started_at = parse_optional_client_datetime(payload.get("started_at"))
    ended_at = parse_optional_client_datetime(payload.get("ended_at"))
    break_started_at = parse_optional_client_datetime(payload.get("break_started_at"))
    break_ended_at = parse_optional_client_datetime(payload.get("break_ended_at"))
    lunch_started_at = parse_optional_client_datetime(payload.get("lunch_started_at"))
    lunch_ended_at = parse_optional_client_datetime(payload.get("lunch_ended_at"))

    if started_at and ended_at and ended_at <= started_at:
        raise HTTPException(status_code=400, detail="ended_at must be after started_at")
    if break_started_at and break_ended_at and break_ended_at <= break_started_at:
        raise HTTPException(status_code=400, detail="break end must be after break start")
    if lunch_started_at and lunch_ended_at and lunch_ended_at <= lunch_started_at:
        raise HTTPException(status_code=400, detail="lunch end must be after lunch start")

    events = db.execute(
        select(ShiftEvent)
        .where(ShiftEvent.shift_id == shift.id)
        .order_by(ShiftEvent.occurred_at)
    ).scalars().all()
    event_map = {event.event_type: event for event in events}

    shift.started_at = started_at
    shift.ended_at = ended_at
    shift.status = "closed" if ended_at else "open"
    if (break_started_at and not break_ended_at) or (lunch_started_at and not lunch_ended_at):
        shift.status = "paused"
    shift.work_seconds = seconds_between(started_at, ended_at)
    shift.break_seconds = seconds_between(break_started_at, break_ended_at)
    shift.lunch_seconds = seconds_between(lunch_started_at, lunch_ended_at)
    shift.updated_at = now_utc()

    update_shift_event(db, shift, event_map, "shift_started", started_at)
    update_shift_event(db, shift, event_map, "shift_finished", ended_at)
    update_shift_event(db, shift, event_map, "break_started", break_started_at)
    update_shift_event(db, shift, event_map, "break_finished", break_ended_at)
    update_shift_event(db, shift, event_map, "lunch_started", lunch_started_at)
    update_shift_event(db, shift, event_map, "lunch_finished", lunch_ended_at)

    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="attendance_shift_corrected",
            entity_type="shift",
            entity_id=shift.id,
            payload_json=json_text(
                {
                    "correction_reason": correction_reason,
                    "started_at": payload.get("started_at"),
                    "ended_at": payload.get("ended_at"),
                    "break_started_at": payload.get("break_started_at"),
                    "break_ended_at": payload.get("break_ended_at"),
                    "lunch_started_at": payload.get("lunch_started_at"),
                    "lunch_ended_at": payload.get("lunch_ended_at"),
                }
            ),
        )
    )
    db.commit()
    db.refresh(shift)
    fresh_events = db.execute(
        select(ShiftEvent)
        .where(ShiftEvent.shift_id == shift.id)
        .order_by(ShiftEvent.occurred_at)
    ).scalars().all()
    return {
        "ok": True,
        "shift": serialize_shift_for_attendance(shift, {shift.id: fresh_events}),
    }


@app.post("/api/attendance/shifts")
def create_attendance_shift(
    payload: ShiftCreatePayload,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_permission(admin, "attendance:manage")
    payload = payload.model_dump(exclude_unset=True)
    employee_id = clean_text(payload.get("employee_id"), 36)
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status_code=404, detail="Employee not found")
    company = resolve_admin_company(db, admin, employee.company_id)
    if employee.company_id != company.id:
        raise HTTPException(status_code=403, detail="Cannot create shift for another company")

    shift_date = validate_date(payload.get("shift_date"), "shift_date")
    correction_reason = clean_text(payload.get("correction_reason"), 180)
    if len(correction_reason) < 3:
        raise HTTPException(status_code=400, detail="correction_reason is required")

    duplicate = db.execute(
        select(Shift).where(
            Shift.company_id == company.id,
            Shift.employee_id == employee.id,
            Shift.shift_date == shift_date,
        )
    ).scalars().first()
    if duplicate:
        raise HTTPException(status_code=409, detail="Shift already exists for employee and date")

    started_at = parse_optional_client_datetime(payload.get("started_at"))
    ended_at = parse_optional_client_datetime(payload.get("ended_at"))
    break_started_at = parse_optional_client_datetime(payload.get("break_started_at"))
    break_ended_at = parse_optional_client_datetime(payload.get("break_ended_at"))
    lunch_started_at = parse_optional_client_datetime(payload.get("lunch_started_at"))
    lunch_ended_at = parse_optional_client_datetime(payload.get("lunch_ended_at"))

    if not started_at:
        raise HTTPException(status_code=400, detail="started_at is required")
    if ended_at and ended_at <= started_at:
        raise HTTPException(status_code=400, detail="ended_at must be after started_at")
    if break_started_at and break_ended_at and break_ended_at <= break_started_at:
        raise HTTPException(status_code=400, detail="break end must be after break start")
    if lunch_started_at and lunch_ended_at and lunch_ended_at <= lunch_started_at:
        raise HTTPException(status_code=400, detail="lunch end must be after lunch start")

    shift = Shift(
        company_id=company.id,
        employee_id=employee.id,
        device_id=None,
        shift_date=shift_date,
        status="closed" if ended_at else "open",
        started_at=started_at,
        ended_at=ended_at,
        work_seconds=seconds_between(started_at, ended_at),
        break_seconds=seconds_between(break_started_at, break_ended_at),
        lunch_seconds=seconds_between(lunch_started_at, lunch_ended_at),
    )
    if (break_started_at and not break_ended_at) or (lunch_started_at and not lunch_ended_at):
        shift.status = "paused"
    db.add(shift)
    db.flush()

    event_map: dict[str, ShiftEvent] = {}
    update_shift_event(db, shift, event_map, "shift_started", started_at)
    update_shift_event(db, shift, event_map, "shift_finished", ended_at)
    update_shift_event(db, shift, event_map, "break_started", break_started_at)
    update_shift_event(db, shift, event_map, "break_finished", break_ended_at)
    update_shift_event(db, shift, event_map, "lunch_started", lunch_started_at)
    update_shift_event(db, shift, event_map, "lunch_finished", lunch_ended_at)
    db.add(
        AuditLog(
            company_id=company.id,
            user_id=admin.user_id,
            action="attendance_shift_created_manually",
            entity_type="shift",
            entity_id=shift.id,
            payload_json=json_text(
                {
                    "employee_id": employee.id,
                    "shift_date": shift_date,
                    "correction_reason": correction_reason,
                }
            ),
        )
    )
    db.commit()
    db.refresh(shift)
    fresh_events = db.execute(
        select(ShiftEvent)
        .where(ShiftEvent.shift_id == shift.id)
        .order_by(ShiftEvent.occurred_at)
    ).scalars().all()
    return {
        "ok": True,
        "shift": serialize_shift_for_attendance(shift, {shift.id: fresh_events}),
    }


@app.get("/api/agent/rules")
def get_agent_rules(
    device: Device = Depends(require_device),
    db: Session = Depends(get_db),
):
    """
    Device endpoint to download productivity rules applicable to this device's employee.
    Returns global rules and rules specific to the employee's department/position.
    """
    if not device.employee_id:
        return {
            "ok": True,
            "device_id": device.id,
            "employee_id": None,
            "rules": [],
        }
    
    employee = db.get(Employee, device.employee_id)
    if not employee:
        return {
            "ok": True,
            "device_id": device.id,
            "employee_id": device.employee_id,
            "rules": [],
        }
    
    # Query rules applicable to this employee
    query = select(ProductivityRule).where(
        ProductivityRule.company_id == device.company_id,
        ProductivityRule.is_active.is_(True),
    )
    
    # Start with rules that apply to all (no department/position/employee filter)
    global_rules = db.execute(
        query.where(
            ProductivityRule.department_id.is_(None),
            ProductivityRule.position_id.is_(None),
            ProductivityRule.employee_id.is_(None),
        ).order_by(ProductivityRule.priority.desc())
    ).scalars().all()
    
    # Then add department-specific rules
    department_rules = []
    if employee.department_id:
        department_rules = db.execute(
            query.where(
                ProductivityRule.department_id == employee.department_id,
                ProductivityRule.position_id.is_(None),
                ProductivityRule.employee_id.is_(None),
            ).order_by(ProductivityRule.priority.desc())
        ).scalars().all()
    
    # Then add position-specific rules
    position_rules = []
    if employee.position_id:
        position_rules = db.execute(
            query.where(
                ProductivityRule.position_id == employee.position_id,
                ProductivityRule.employee_id.is_(None),
            ).order_by(ProductivityRule.priority.desc())
        ).scalars().all()
    
    # Finally add employee-specific rules (highest priority)
    employee_rules = db.execute(
        query.where(
            ProductivityRule.employee_id == device.employee_id,
        ).order_by(ProductivityRule.priority.desc())
    ).scalars().all()
    
    # Combine all rules (employee-specific take precedence due to ordering)
    all_rules = global_rules + department_rules + position_rules + employee_rules
    
    return {
        "ok": True,
        "device_id": device.id,
        "company_id": device.company_id,
        "employee_id": device.employee_id,
        "employee_name": employee.full_name if employee else None,
        "department_id": employee.department_id if employee else None,
        "position_id": employee.position_id if employee else None,
        "count": len(all_rules),
        "rules": [
            {
                "id": rule.id,
                "executable_name": rule.executable_name,
                "title_contains": rule.title_contains,
                "classification": rule.classification,
                "priority": rule.priority,
                "updated_at": rule.updated_at.isoformat() if rule.updated_at else None,
            }
            for rule in all_rules
        ],
    }


@app.post("/api/agent/events")
def sync_agent_events(
    request: Request,
    payload: AgentEventsPayload,
    device: Device = Depends(require_device),
    db: Session = Depends(get_db),
):
    payload = payload.model_dump()
    events = payload.get("events")
    if not isinstance(events, list):
        raise HTTPException(status_code=400, detail="events must be a list")
    if len(events) > 200:
        raise HTTPException(status_code=413, detail="too many events in one batch")

    client_ip = request.client.host if request.client else ""
    accepted = []
    rejected = []
    for event in events:
        if not isinstance(event, dict):
            rejected.append({"id": "", "error": "invalid event payload"})
            continue
        event_id = str(event.get("id") or "")[:36]
        if not event_id:
            rejected.append({"id": "", "error": "missing event id"})
            continue
        if agent_event_already_received(db, event_id):
            accepted.append({"id": event_id, "duplicate": True})
            continue

        try:
            result = process_agent_event(db, device, event, client_ip)
            db.commit()
            accepted.append(result)
        except Exception as exc:
            db.rollback()
            rejected.append({"id": event_id, "error": str(exc)[:300]})

    return {
        "ok": not rejected,
        "accepted": accepted,
        "rejected": rejected,
    }


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

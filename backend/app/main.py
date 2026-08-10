"""
main.py - VYNTRA Evidence API.
"""

from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import tempfile

from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import hash_token, require_device
from app.config import settings
from app.database import Base, engine, get_db, SessionLocal
from app.models import (
    Activity,
    AppCatalog,
    AuditLog,
    Company,
    ConsentRecord,
    Department,
    Device,
    Employee,
    EmployeeCredential,
    EvidenceFile,
    EvidenceUploadAttempt,
    Position,
    ProductivityRule,
    Role,
    Shift,
    ShiftEvent,
    StationLoginEvent,
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
        ("", "", "msedge.exe", "YouTube", "neutral", 80, "Global: YouTube depende del rol/departamento."),
        ("", "", "chrome.exe", "YouTube", "neutral", 80, "Global: YouTube depende del rol/departamento."),
        ("", "", "Spotify.exe", "", "neutral", 70, "Global: audio en segundo plano, no mide productividad central."),
        ("", "", "WhatsApp.Root.exe", "", "neutral", 70, "Global: mensajeria depende del area."),
        ("", "", "OUTLOOK.EXE", "", "productive", 60, "Global: correo corporativo."),
        ("", "", "EXCEL.EXE", "", "productive", 60, "Global: hojas de calculo."),
        ("", "", "WINWORD.EXE", "", "productive", 60, "Global: documentos."),
        ("", "", "POWERPNT.EXE", "", "productive", 60, "Global: presentaciones."),
        ("", "", "Teams.exe", "", "productive", 60, "Global: comunicacion corporativa."),
        ("", "", "Zoom.exe", "", "productive", 60, "Global: reuniones."),
        ("", "", "ChatGPT.exe", "", "productive", 60, "Global demo: asistente de trabajo."),
        ("", "", "python.exe", "VYNTRA", "productive", 60, "Global demo: estacion VYNTRA."),
        # Marketing.
        ("Marketing", "", "chrome.exe", "Facebook Business", "productive", 250, "Marketing: herramientas de redes."),
        ("Marketing", "", "msedge.exe", "Facebook Business", "productive", 250, "Marketing: herramientas de redes."),
        ("Marketing", "", "chrome.exe", "Instagram", "productive", 250, "Marketing: redes pueden ser trabajo."),
        ("Marketing", "", "msedge.exe", "Instagram", "productive", 250, "Marketing: redes pueden ser trabajo."),
        ("Marketing", "", "chrome.exe", "Canva", "productive", 250, "Marketing: diseno."),
        ("Marketing", "", "msedge.exe", "Canva", "productive", 250, "Marketing: diseno."),
        ("Marketing", "", "chrome.exe", "YouTube", "productive", 200, "Marketing: investigacion/contenido."),
        ("Marketing", "", "msedge.exe", "YouTube", "productive", 200, "Marketing: investigacion/contenido."),
        # Ventas y atencion.
        ("Ventas", "", "WhatsApp.Root.exe", "", "productive", 250, "Ventas: contacto con clientes."),
        ("Atencion al cliente", "", "WhatsApp.Root.exe", "", "productive", 250, "Atencion: soporte por mensajeria."),
        ("Atencion al cliente", "", "chrome.exe", "Gmail", "productive", 230, "Atencion: correo y soporte."),
        ("Atencion al cliente", "", "msedge.exe", "Gmail", "productive", 230, "Atencion: correo y soporte."),
        # Contabilidad y administracion.
        ("Contabilidad", "", "EXCEL.EXE", "", "productive", 250, "Contabilidad: herramienta principal."),
        ("Contabilidad", "", "chrome.exe", "QuickBooks", "productive", 250, "Contabilidad: sistema contable."),
        ("Contabilidad", "", "msedge.exe", "QuickBooks", "productive", 250, "Contabilidad: sistema contable."),
        ("Administracion", "", "EXCEL.EXE", "", "productive", 230, "Administracion: control operativo."),
        # Tecnologia.
        ("Tecnologia", "", "Code.exe", "", "productive", 250, "Tecnologia: desarrollo."),
        ("Tecnologia", "", "WindowsTerminal.exe", "", "productive", 250, "Tecnologia: terminal."),
        ("Tecnologia", "", "chrome.exe", "GitHub", "productive", 250, "Tecnologia: repositorios."),
        ("Tecnologia", "", "msedge.exe", "GitHub", "productive", 250, "Tecnologia: repositorios."),
        ("Tecnologia", "", "chrome.exe", "Stack Overflow", "productive", 220, "Tecnologia: investigacion tecnica."),
        ("Tecnologia", "", "msedge.exe", "Stack Overflow", "productive", 220, "Tecnologia: investigacion tecnica."),
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
) -> bool | None:
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
        return None

    _, best = sorted(matches, key=lambda item: item[0], reverse=True)[0]
    if best.classification == "productive":
        return True
    if best.classification == "non_productive":
        return False
    return None


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
                is_productive=classification,
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

        seed_organization_catalogs(db, company.id)

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


@app.on_event("startup")
def on_startup():
    os.makedirs(settings.storage_dir, exist_ok=True)
    Base.metadata.create_all(bind=engine)
    bootstrap_data()


@app.get("/health")
def health():
    return {"ok": True, "environment": settings.environment}


@app.post("/api/agent/events")
def sync_agent_events(
    request: Request,
    payload: dict = Body(...),
    device: Device = Depends(require_device),
    db: Session = Depends(get_db),
):
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

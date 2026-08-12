"""
main.py - VYNTRA Evidence API.
"""

from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import re
import tempfile

from fastapi import BackgroundTasks, Body, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import (
    AdminPrincipal,
    create_admin_access_token,
    hash_token,
    require_admin,
    require_device,
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
    LoginAttempt,
    Position,
    ProductivityBlock,
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


def clean_text(value: object, max_len: int = 255) -> str:
    return str(value or "").strip()[:max_len]


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
    if company_id and company_id != admin.company_id:
        raise HTTPException(status_code=403, detail="Cannot access another company")
    return resolve_company(db, admin.company_id)


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


def serialize_shift_for_attendance(shift: Shift, events_by_shift: dict[str, list[ShiftEvent]]) -> dict:
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
        "events": [
            {
                "id": event.id,
                "event_type": event.event_type,
                "occurred_at": event.occurred_at.isoformat(),
            }
            for event in events_by_shift.get(shift.id, [])
        ],
    }


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
        seed_company_settings(db, company.id)

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


def serialize_admin_user(db: Session, user: User, role_name: str | None = None) -> dict:
    role = db.get(Role, user.role_id) if user.role_id and role_name is None else None
    company = db.get(Company, user.company_id)
    return {
        "id": user.id,
        "company_id": user.company_id,
        "company": company.name if company else None,
        "email": user.email,
        "full_name": user.full_name,
        "role": role_name or (role.name if role else ""),
        "status": user.status,
        "last_login_at": user.last_login_at.isoformat() if user.last_login_at else None,
    }


@app.post("/api/admin/login")
def admin_login(
    request: Request,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
):
    email = clean_text(payload.get("email"), 180).lower()
    password = str(payload.get("password") or "")
    client_ip = request.client.host if request.client else ""
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
    allowed_roles = {"admin", "owner", "rrhh", "supervisor", "viewer"}
    if (
        user is None
        or role_name not in allowed_roles
        or not verify_password_hash(password, user.password_hash)
    ):
        db.add(
            AuditLog(
                company_id=user.company_id if user else None,
                user_id=user.id if user else None,
                action="admin_login_failed",
                entity_type="user",
                entity_id=user.id if user else "",
                ip_address=client_ip[:80],
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
            ip_address=client_ip[:80],
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


@app.post("/api/station/login")
def station_login(
    request: Request,
    payload: dict = Body(...),
    device: Device = Depends(require_device),
    db: Session = Depends(get_db),
):
    email = clean_text(payload.get("email") or payload.get("correo"), 180).lower()
    password = str(payload.get("password") or "")
    occurred_at = (
        parse_optional_client_datetime(payload.get("occurred_at"))
        or now_utc()
    )
    client_ip = request.client.host if request.client else ""

    if not email or not password:
        db.add(
            LoginAttempt(
                email_attempted=email,
                ip_address=client_ip[:45],
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
                ip_address=client_ip[:80],
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
            ip_address=client_ip[:45],
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
            ip_address=client_ip[:80],
            payload_json=json_text(
                {
                    "email": email,
                    "auth_source": "backend",
                    "agent_version": clean_text(payload.get("agent_version"), 40),
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
        },
        "device": {
            "id": device.id,
            "name": device.name,
        },
    }


@app.get("/api/productivity/catalogs")
def productivity_catalogs(
    company_id: str | None = None,
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
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
    payload: dict = Body(...),
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
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
    payload: dict = Body(...),
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
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
    payload: dict = Body(default={}),
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
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
    totals = {
        "total_seconds": sum(row.total_seconds for row in blocks),
        "active_seconds": sum(row.active_seconds for row in blocks),
        "productive_seconds": sum(row.productive_seconds for row in blocks),
        "neutral_seconds": sum(row.neutral_seconds for row in blocks),
        "non_productive_seconds": sum(row.non_productive_seconds for row in blocks),
        "uncategorized_seconds": sum(row.uncategorized_seconds for row in blocks),
        "idle_seconds": sum(row.idle_seconds for row in blocks),
        "break_seconds": sum(row.break_seconds for row in blocks),
        "lunch_seconds": sum(row.lunch_seconds for row in blocks),
        "break_lunch_seconds": sum(row.break_lunch_seconds for row in blocks),
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

    by_day: dict[str, dict] = {}
    for block in blocks:
        day = by_day.setdefault(
            block.block_date,
            {
                "block_date": block.block_date,
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
        ]:
            day[key] += getattr(block, key)

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
        "blocks": [
            {
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
                "productivity_pct": row.productivity_pct,
                "acceptable_pct": row.acceptable_pct,
                "idle_pct": row.idle_pct,
                "break_pct": row.break_pct,
                "lunch_pct": row.lunch_pct,
            }
            for row in blocks
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
        "shifts": [serialize_shift_for_attendance(shift, events_by_shift) for shift in shifts],
    }


@app.patch("/api/attendance/employees/{employee_id}/schedule")
def update_employee_schedule(
    employee_id: str,
    payload: dict = Body(...),
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
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
    payload: dict = Body(...),
    admin: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    shift = db.get(Shift, shift_id)
    if shift is None:
        raise HTTPException(status_code=404, detail="Shift not found")
    company = resolve_admin_company(db, admin, shift.company_id)
    if shift.company_id != company.id:
        raise HTTPException(status_code=403, detail="Cannot edit shift from another company")

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

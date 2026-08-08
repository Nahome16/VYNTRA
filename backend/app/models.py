"""
models.py - Database tables for the VYNTRA platform.
"""

from datetime import datetime, timezone
import uuid

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def new_id() -> str:
    return str(uuid.uuid4())


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class Company(Base):
    __tablename__ = "companies"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(160), nullable=False, unique=True)
    legal_name: Mapped[str] = mapped_column(String(220), nullable=False, default="")
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="active")
    timezone: Mapped[str] = mapped_column(String(80), nullable=False, default="America/Managua")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    devices: Mapped[list["Device"]] = relationship(back_populates="company")
    employees: Mapped[list["Employee"]] = relationship(back_populates="company")
    users: Mapped[list["User"]] = relationship(back_populates="company")
    departments: Mapped[list["Department"]] = relationship(back_populates="company")
    roles: Mapped[list["Role"]] = relationship(back_populates="company")


class Department(Base):
    __tablename__ = "departments"
    __table_args__ = (UniqueConstraint("company_id", "name", name="uq_department_company_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    company: Mapped[Company] = relationship(back_populates="departments")
    employees: Mapped[list["Employee"]] = relationship(back_populates="department")


class Role(Base):
    __tablename__ = "roles"
    __table_args__ = (UniqueConstraint("company_id", "name", name="uq_role_company_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    company: Mapped[Company] = relationship(back_populates="roles")
    users: Mapped[list["User"]] = relationship(back_populates="role")


class User(Base):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("company_id", "email", name="uq_user_company_email"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    role_id: Mapped[str | None] = mapped_column(ForeignKey("roles.id"), nullable=True)
    email: Mapped[str] = mapped_column(String(180), nullable=False)
    full_name: Mapped[str] = mapped_column(String(180), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    company: Mapped[Company] = relationship(back_populates="users")
    role: Mapped[Role | None] = relationship(back_populates="users")


class Employee(Base):
    __tablename__ = "employees"
    __table_args__ = (UniqueConstraint("company_id", "employee_code", name="uq_employee_company_code"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    department_id: Mapped[str | None] = mapped_column(ForeignKey("departments.id"), nullable=True)
    employee_code: Mapped[str] = mapped_column(String(80), nullable=False)
    full_name: Mapped[str] = mapped_column(String(180), nullable=False)
    email: Mapped[str] = mapped_column(String(180), nullable=False, default="")
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    company: Mapped[Company] = relationship(back_populates="employees")
    department: Mapped[Department | None] = relationship(back_populates="employees")
    devices: Mapped[list["Device"]] = relationship(back_populates="employee")
    shifts: Mapped[list["Shift"]] = relationship(back_populates="employee")
    incidents: Mapped[list["Incident"]] = relationship(back_populates="employee")
    overtime_authorizations: Mapped[list["OvertimeAuthorization"]] = relationship(back_populates="employee")


class Device(Base):
    __tablename__ = "devices"
    __table_args__ = (UniqueConstraint("company_id", "name", name="uq_device_company_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    hostname: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    location: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    token_sha256: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    agent_version: Mapped[str] = mapped_column(String(40), nullable=False, default="unknown")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    company: Mapped[Company] = relationship(back_populates="devices")
    employee: Mapped[Employee | None] = relationship(back_populates="devices")
    evidence_files: Mapped[list["EvidenceFile"]] = relationship(back_populates="device")
    shifts: Mapped[list["Shift"]] = relationship(back_populates="device")
    incidents: Mapped[list["Incident"]] = relationship(back_populates="device")
    overtime_authorizations: Mapped[list["OvertimeAuthorization"]] = relationship(back_populates="device")


class Shift(Base):
    __tablename__ = "shifts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"), nullable=True)
    shift_date: Mapped[str] = mapped_column(String(10), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="open")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    work_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    break_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lunch_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    idle_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    employee: Mapped[Employee] = relationship(back_populates="shifts")
    device: Mapped[Device | None] = relationship(back_populates="shifts")
    events: Mapped[list["ShiftEvent"]] = relationship(back_populates="shift")


class ShiftEvent(Base):
    __tablename__ = "shift_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shift_id: Mapped[str] = mapped_column(ForeignKey("shifts.id"), nullable=False)
    event_type: Mapped[str] = mapped_column(String(60), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    shift: Mapped[Shift] = relationship(back_populates="events")


class EvidenceFile(Base):
    __tablename__ = "evidence_files"
    __table_args__ = (
        UniqueConstraint("device_id", "sha256", name="uq_evidence_device_sha256"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), nullable=False)
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    employee: Mapped[str] = mapped_column(String(160), nullable=False)
    equipment: Mapped[str] = mapped_column(String(160), nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(String(120), nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    agent_version: Mapped[str] = mapped_column(String(40), nullable=False, default="unknown")
    monitor_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="received")

    device: Mapped[Device] = relationship(back_populates="evidence_files")
    employee_ref: Mapped[Employee | None] = relationship()


class Incident(Base):
    __tablename__ = "incidents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"), nullable=True)
    incident_type: Mapped[str] = mapped_column(String(80), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="pending")
    title: Mapped[str] = mapped_column(String(180), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolution_notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")

    employee: Mapped[Employee] = relationship(back_populates="incidents")
    device: Mapped[Device | None] = relationship(back_populates="incidents")


class OvertimeAuthorization(Base):
    __tablename__ = "overtime_authorizations"
    __table_args__ = (UniqueConstraint("code", name="uq_overtime_code"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"), nullable=True)
    code: Mapped[str] = mapped_column(String(80), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="issued")
    reason: Mapped[str] = mapped_column(String(180), nullable=False, default="")
    assigned_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    valid_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    valid_until: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    employee: Mapped[Employee] = relationship(back_populates="overtime_authorizations")
    device: Mapped[Device | None] = relationship(back_populates="overtime_authorizations")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str | None] = mapped_column(ForeignKey("companies.id"), nullable=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(120), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    entity_id: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    ip_address: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class EvidenceUploadAttempt(Base):
    __tablename__ = "evidence_upload_attempts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    status: Mapped[str] = mapped_column(String(40), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False, default="")
    sha256: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    ip_address: Mapped[str] = mapped_column(String(80), nullable=False, default="")

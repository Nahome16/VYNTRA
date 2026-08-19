"""
models.py - Database tables for the VYNTRA platform.
"""

from datetime import datetime, timezone
import uuid

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
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
    positions: Mapped[list["Position"]] = relationship(back_populates="company")
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


class Position(Base):
    __tablename__ = "positions"
    __table_args__ = (UniqueConstraint("company_id", "name", name="uq_position_company_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    company: Mapped[Company] = relationship(back_populates="positions")
    employees: Mapped[list["Employee"]] = relationship(back_populates="position")


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
    position_id: Mapped[str | None] = mapped_column(ForeignKey("positions.id"), nullable=True)
    employee_code: Mapped[str] = mapped_column(String(80), nullable=False)
    full_name: Mapped[str] = mapped_column(String(180), nullable=False)
    email: Mapped[str] = mapped_column(String(180), nullable=False, default="")
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    company: Mapped[Company] = relationship(back_populates="employees")
    department: Mapped[Department | None] = relationship(back_populates="employees")
    position: Mapped[Position | None] = relationship(back_populates="employees")
    devices: Mapped[list["Device"]] = relationship(back_populates="employee")
    credentials: Mapped[list["EmployeeCredential"]] = relationship(back_populates="employee")
    shifts: Mapped[list["Shift"]] = relationship(back_populates="employee")
    schedules: Mapped[list["EmployeeSchedule"]] = relationship(back_populates="employee")
    incidents: Mapped[list["Incident"]] = relationship(back_populates="employee")
    time_adjustments: Mapped[list["TimeAdjustment"]] = relationship(back_populates="employee")
    overtime_authorizations: Mapped[list["OvertimeAuthorization"]] = relationship(back_populates="employee")
    restore_codes: Mapped[list["StationRestoreCode"]] = relationship(back_populates="employee")


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
    time_adjustments: Mapped[list["TimeAdjustment"]] = relationship(back_populates="device")
    overtime_authorizations: Mapped[list["OvertimeAuthorization"]] = relationship(back_populates="device")
    restore_codes: Mapped[list["StationRestoreCode"]] = relationship(back_populates="device")


class EmployeeCredential(Base):
    __tablename__ = "employee_credentials"
    __table_args__ = (
        UniqueConstraint("company_id", "email", name="uq_employee_credential_company_email"),
        UniqueConstraint("employee_id", name="uq_employee_credential_employee"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    email: Mapped[str] = mapped_column(String(180), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    password_change_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reset_code_hash: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    reset_code_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reset_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reset_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reset_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    employee: Mapped[Employee] = relationship(back_populates="credentials")


class ConsentRecord(Base):
    __tablename__ = "consent_records"
    __table_args__ = (
        UniqueConstraint("source_event_id", name="uq_consent_source_event"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    credential_id: Mapped[str | None] = mapped_column(ForeignKey("employee_credentials.id"), nullable=True)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"), nullable=True)
    consent_version: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    accepted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    source_event_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class StationLoginEvent(Base):
    __tablename__ = "station_login_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str | None] = mapped_column(ForeignKey("companies.id"), nullable=True)
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    credential_id: Mapped[str | None] = mapped_column(ForeignKey("employee_credentials.id"), nullable=True)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"), nullable=True)
    email_attempted: Mapped[str] = mapped_column(String(180), nullable=False)
    success: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    failure_reason: Mapped[str] = mapped_column(String(180), nullable=False, default="")
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ip_address: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class CompanySetting(Base):
    __tablename__ = "company_settings"
    __table_args__ = (UniqueConstraint("company_id", "key", name="uq_company_setting_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    key: Mapped[str] = mapped_column(String(100), nullable=False)
    value: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class EmployeeSchedule(Base):
    __tablename__ = "employee_schedules"
    __table_args__ = (
        UniqueConstraint("employee_id", "effective_from", name="uq_employee_schedule_effective"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    start_time: Mapped[str] = mapped_column(String(5), nullable=False, default="08:00")
    end_time: Mapped[str] = mapped_column(String(5), nullable=False, default="17:00")
    effective_from: Mapped[str] = mapped_column(String(10), nullable=False, default="1970-01-01")
    timezone: Mapped[str] = mapped_column(String(80), nullable=False, default="America/Managua")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    employee: Mapped[Employee] = relationship(back_populates="schedules")


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


class AppCatalog(Base):
    __tablename__ = "app_catalog"
    __table_args__ = (
        UniqueConstraint("company_id", "executable_name", name="uq_app_catalog_company_executable"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    executable_name: Mapped[str] = mapped_column(String(160), nullable=False)
    category: Mapped[str] = mapped_column(String(60), nullable=False, default="uncategorized")
    is_productive: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class WindowTitleCatalog(Base):
    __tablename__ = "window_title_catalog"
    __table_args__ = (
        UniqueConstraint("company_id", "title_hash", name="uq_window_title_company_hash"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    title_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    title_text: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ProductivityRule(Base):
    __tablename__ = "productivity_rules"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    department_id: Mapped[str | None] = mapped_column(ForeignKey("departments.id"), nullable=True)
    position_id: Mapped[str | None] = mapped_column(ForeignKey("positions.id"), nullable=True)
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    app_id: Mapped[str | None] = mapped_column(ForeignKey("app_catalog.id"), nullable=True)
    executable_name: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    title_contains: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    classification: Mapped[str] = mapped_column(String(40), nullable=False)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class Activity(Base):
    __tablename__ = "activities"
    __table_args__ = (
        UniqueConstraint("source_event_id", "source_sample_index", name="uq_activity_source_sample"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), nullable=False)
    shift_id: Mapped[str | None] = mapped_column(ForeignKey("shifts.id"), nullable=True)
    app_id: Mapped[str | None] = mapped_column(ForeignKey("app_catalog.id"), nullable=True)
    window_title_id: Mapped[str | None] = mapped_column(ForeignKey("window_title_catalog.id"), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    idle_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_idle: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_productive: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    classification: Mapped[str] = mapped_column(String(40), nullable=False, default="uncategorized")
    source_event_id: Mapped[str] = mapped_column(String(36), nullable=False)
    source_sample_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ProductivityBlock(Base):
    __tablename__ = "productivity_blocks"
    __table_args__ = (
        UniqueConstraint(
            "employee_id",
            "block_date",
            "block_start",
            name="uq_productivity_employee_block",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    shift_id: Mapped[str | None] = mapped_column(ForeignKey("shifts.id"), nullable=True)
    department_id_snapshot: Mapped[str | None] = mapped_column(ForeignKey("departments.id"), nullable=True)
    block_date: Mapped[str] = mapped_column(String(10), nullable=False)
    block_start: Mapped[str] = mapped_column(String(5), nullable=False)
    total_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    productive_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    neutral_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    non_productive_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    uncategorized_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    idle_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    break_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lunch_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    break_lunch_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    productivity_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    acceptable_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    non_productive_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    neutral_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    uncategorized_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    idle_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    break_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    lunch_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ETLRunLog(Base):
    __tablename__ = "etl_run_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str | None] = mapped_column(ForeignKey("companies.id"), nullable=True)
    executed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    window_start: Mapped[str] = mapped_column(String(10), nullable=False)
    window_end: Mapped[str] = mapped_column(String(10), nullable=False)
    rows_deleted: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rows_inserted: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")


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


class TimeAdjustment(Base):
    __tablename__ = "time_adjustments"
    __table_args__ = (UniqueConstraint("incident_id", name="uq_time_adjustment_incident"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"), nullable=True)
    incident_id: Mapped[str | None] = mapped_column(ForeignKey("incidents.id"), nullable=True)
    adjustment_type: Mapped[str] = mapped_column(String(80), nullable=False, default="justified_time")
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="active")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    productivity_classification: Mapped[str] = mapped_column(String(40), nullable=False, default="neutral")
    reason: Mapped[str] = mapped_column(String(180), nullable=False, default="")
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_by_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    employee: Mapped[Employee] = relationship(back_populates="time_adjustments")
    device: Mapped[Device | None] = relationship(back_populates="time_adjustments")
    incident: Mapped[Incident | None] = relationship()


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


class StationRestoreCode(Base):
    __tablename__ = "station_restore_codes"
    __table_args__ = (UniqueConstraint("code", name="uq_station_restore_code"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), nullable=False)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"), nullable=True)
    code: Mapped[str] = mapped_column(String(80), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="issued")
    reason: Mapped[str] = mapped_column(String(180), nullable=False, default="")
    valid_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    valid_until: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    employee: Mapped[Employee] = relationship(back_populates="restore_codes")
    device: Mapped[Device | None] = relationship(back_populates="restore_codes")


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


class LoginAttempt(Base):
    __tablename__ = "login_attempts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email_attempted: Mapped[str] = mapped_column(String(180), nullable=False)
    ip_address: Mapped[str] = mapped_column(String(45), nullable=False)
    success: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class LoginLockout(Base):
    __tablename__ = "login_lockouts"
    __table_args__ = (
        UniqueConstraint("ip_address", "email_attempted", name="uq_login_lockout_ip_email"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    ip_address: Mapped[str] = mapped_column(String(45), nullable=False)
    email_attempted: Mapped[str] = mapped_column(String(180), nullable=False)
    failed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

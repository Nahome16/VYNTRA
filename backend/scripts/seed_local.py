"""
Seed local/demo VYNTRA database.

Run from backend/ with PYTHONPATH pointing to the current directory:

    python scripts/seed_local.py
"""

import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from app.auth import hash_token
from app.database import Base, SessionLocal, engine
from app.models import Company, Department, Device, Employee, Role, User
from sqlalchemy import select


def get_or_create(db, model, defaults=None, **filters):
    row = db.execute(select(model).filter_by(**filters)).scalar_one_or_none()
    if row:
        return row
    values = dict(filters)
    values.update(defaults or {})
    row = model(**values)
    db.add(row)
    db.flush()
    return row


def main():
    Base.metadata.create_all(bind=engine)
    token = os.environ.get("SEED_DEVICE_TOKEN", "dev_YOGA_PC_LOCAL_TOKEN")

    with SessionLocal() as db:
        company = get_or_create(
            db,
            Company,
            name="VYNTRA Demo",
            defaults={"legal_name": "VYNTRA Demo S.A.", "timezone": "America/Managua"},
        )
        admin_role = get_or_create(
            db,
            Role,
            company_id=company.id,
            name="admin",
            defaults={"description": "Administrador de plataforma"},
        )
        get_or_create(
            db,
            Role,
            company_id=company.id,
            name="rrhh",
            defaults={"description": "Recursos humanos"},
        )
        get_or_create(
            db,
            Role,
            company_id=company.id,
            name="supervisor",
            defaults={"description": "Supervisor"},
        )

        department = get_or_create(db, Department, company_id=company.id, name="Operaciones")
        employee = get_or_create(
            db,
            Employee,
            company_id=company.id,
            employee_code="EMP-001",
            defaults={
                "department_id": department.id,
                "full_name": "Empleado Demo",
                "email": "empleado.demo@vyntra.local",
            },
        )
        get_or_create(
            db,
            User,
            company_id=company.id,
            email="admin@vyntra.local",
            defaults={
                "role_id": admin_role.id,
                "full_name": "Admin VYNTRA",
                "password_hash": "",
            },
        )
        device = get_or_create(
            db,
            Device,
            company_id=company.id,
            name="YOGA-PC",
            defaults={
                "employee_id": employee.id,
                "hostname": "YOGA-PC",
                "token_sha256": hash_token(token),
                "agent_version": "1.0.0",
            },
        )
        db.commit()

    print("Seed completed")
    print(f"Company: {company.name}")
    print(f"Device: {device.name}")
    print(f"Device token: {token}")


if __name__ == "__main__":
    main()

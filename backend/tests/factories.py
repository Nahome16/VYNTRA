"""Helpers para crear datos minimos de prueba."""

from app.auth import hash_token
from app.models import Company, Department, Device, Employee, Position, ProductivityRule

DEVICE_TOKEN = "test-device-token-0123456789"


def create_company_setup(db, timezone_name: str = "America/Managua"):
    company = Company(name="Empresa Prueba", timezone=timezone_name)
    db.add(company)
    db.flush()
    department = Department(company_id=company.id, name="Ventas")
    position = Position(company_id=company.id, name="Vendedor")
    db.add_all([department, position])
    db.flush()
    employee = Employee(
        company_id=company.id,
        department_id=department.id,
        position_id=position.id,
        employee_code="EMP-001",
        full_name="Empleada Prueba",
        email="empleada@example.test",
    )
    db.add(employee)
    db.flush()
    device = Device(
        company_id=company.id,
        employee_id=employee.id,
        name="PC-PRUEBA",
        hostname="PC-PRUEBA",
        token_sha256=hash_token(DEVICE_TOKEN),
        is_active=True,
    )
    db.add(device)
    db.add_all(
        [
            ProductivityRule(
                company_id=company.id,
                executable_name="excel.exe",
                title_contains="Presupuesto",
                classification="productive",
                priority=100,
            ),
            ProductivityRule(
                company_id=company.id,
                executable_name="slack.exe",
                title_contains="",
                classification="neutral",
                priority=100,
            ),
            ProductivityRule(
                company_id=company.id,
                department_id=department.id,
                executable_name="",
                title_contains="facebook",
                classification="non_productive",
                priority=50,
            ),
        ]
    )
    db.commit()
    return company, department, position, employee, device

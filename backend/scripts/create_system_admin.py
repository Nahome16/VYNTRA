"""
Create a system administrator for the VYNTRA panel from the server console.

Use it when there is no system admin yet or SMTP is not available to deliver
the temporary password. The password is typed interactively (never passed as
an argument, so it does not end up in the shell history) and the user must
change it on first login.

    docker compose -f docker-compose.prod.yml --env-file .env.production \
        exec api python scripts/create_system_admin.py
"""

from getpass import getpass
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import select

from app.database import SessionLocal
from app.main import clean_email, ensure_company_roles, hash_password, json_text
from app.models import AuditLog, Company, Role, User

MIN_PASSWORD_LENGTH = 12


def ask_password() -> str:
    while True:
        password = getpass(f"Contrasena temporal (minimo {MIN_PASSWORD_LENGTH} caracteres): ")
        if len(password) < MIN_PASSWORD_LENGTH:
            print("Demasiado corta.")
            continue
        if getpass("Repite la contrasena: ") != password:
            print("No coinciden.")
            continue
        return password


def run():
    email = clean_email(input("Correo del nuevo administrador del sistema: "))
    if "@" not in email:
        raise SystemExit("Correo invalido.")
    full_name = input("Nombre completo: ").strip()
    if len(full_name) < 2:
        raise SystemExit("Nombre invalido.")

    with SessionLocal() as db:
        duplicate = db.execute(
            select(User).where(User.email == email, User.status != "archived")
        ).scalars().first()
        if duplicate is not None:
            raise SystemExit("Ese correo ya tiene acceso al panel.")

        # Los administradores del sistema pertenecen a la empresa de la
        # plataforma: la del primer system_admin existente o, si no hay, la
        # primera empresa creada.
        existing_admin = db.execute(
            select(User)
            .join(Role, Role.id == User.role_id)
            .where(Role.name == "system_admin", User.status != "archived")
            .order_by(User.created_at)
        ).scalars().first()
        if existing_admin is not None:
            company = db.get(Company, existing_admin.company_id)
        else:
            company = db.execute(select(Company).order_by(Company.created_at)).scalars().first()
        if company is None:
            raise SystemExit("No hay ninguna empresa registrada.")

        password = ask_password()
        role = ensure_company_roles(db, company.id)["system_admin"]
        user = User(
            company_id=company.id,
            role_id=role.id,
            email=email,
            full_name=full_name,
            password_hash=hash_password(password),
            password_change_required=True,
            password_changed_at=None,
            status="active",
        )
        db.add(user)
        db.flush()
        db.add(
            AuditLog(
                company_id=company.id,
                action="system_panel_user_created",
                entity_type="user",
                entity_id=user.id,
                payload_json=json_text({"email": email, "role": "system_admin", "source": "server_console"}),
            )
        )
        db.commit()
        print(f"Administrador del sistema creado: {email} (empresa: {company.name}).")
        print("Debera cambiar la contrasena en su primer inicio de sesion.")


if __name__ == "__main__":
    run()

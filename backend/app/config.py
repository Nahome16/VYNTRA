"""
config.py - Environment-based configuration for the VYNTRA evidence backend.
"""

from dataclasses import dataclass
import os


def _bool_env(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    app_name: str = os.environ.get("APP_NAME", "VYNTRA Evidence API")
    environment: str = os.environ.get("ENVIRONMENT", "development")
    database_url: str = os.environ.get(
        "DATABASE_URL",
        "postgresql+psycopg://vyntra:vyntra_dev_password@db:5432/vyntra",
    )
    storage_dir: str = os.environ.get("STORAGE_DIR", "/data/evidence")
    max_upload_bytes: int = int(os.environ.get("MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
    bootstrap_company_name: str = os.environ.get("BOOTSTRAP_COMPANY_NAME", "VYNTRA Demo")
    bootstrap_admin_email: str = os.environ.get("BOOTSTRAP_ADMIN_EMAIL", "admin@vyntra.local")
    bootstrap_admin_name: str = os.environ.get("BOOTSTRAP_ADMIN_NAME", "VYNTRA Admin")
    bootstrap_employee_code: str = os.environ.get("BOOTSTRAP_EMPLOYEE_CODE", "EMP-001")
    bootstrap_employee_name: str = os.environ.get("BOOTSTRAP_EMPLOYEE_NAME", "Empleado Demo")
    bootstrap_employee_email: str = os.environ.get("BOOTSTRAP_EMPLOYEE_EMAIL", "")
    bootstrap_device_name: str = os.environ.get("BOOTSTRAP_DEVICE_NAME", "")
    bootstrap_device_token: str = os.environ.get("BOOTSTRAP_DEVICE_TOKEN", "")
    allow_bootstrap: bool = _bool_env("ALLOW_BOOTSTRAP", True)


settings = Settings()

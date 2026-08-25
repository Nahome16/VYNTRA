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


def _csv_env(name: str) -> tuple[str, ...]:
    value = os.environ.get(name, "")
    return tuple(part.strip() for part in value.split(",") if part.strip())


def _jwt_secret_default() -> str:
    if os.environ.get("ENVIRONMENT", "development").strip().lower() == "production":
        return ""
    return "local_dev_vyntra_jwt_secret_change_before_production"


def _bootstrap_default() -> bool:
    return os.environ.get("ENVIRONMENT", "development").strip().lower() != "production"


@dataclass(frozen=True)
class Settings:
    app_name: str = os.environ.get("APP_NAME", "VYNTRA Evidence API")
    environment: str = os.environ.get("ENVIRONMENT", "development")
    database_url: str = os.environ.get(
        "DATABASE_URL",
        "postgresql+psycopg://vyntra:vyntra_dev_password@db:5432/vyntra",
    )
    storage_dir: str = os.environ.get("STORAGE_DIR", "/data/evidence")
    downloads_dir: str = os.environ.get("DOWNLOADS_DIR", "/data/downloads")
    max_upload_bytes: int = int(os.environ.get("MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
    admin_api_token: str = os.environ.get("ADMIN_API_TOKEN", "")
    jwt_secret: str = os.environ.get("JWT_SECRET", _jwt_secret_default())
    admin_token_expire_minutes: int = int(os.environ.get("ADMIN_TOKEN_EXPIRE_MINUTES", "720"))
    cors_allowed_origins: tuple[str, ...] = _csv_env("CORS_ALLOWED_ORIGINS")
    admin_allowed_ips: tuple[str, ...] = _csv_env("ADMIN_ALLOWED_IPS")
    agent_allowed_ips: tuple[str, ...] = _csv_env("AGENT_ALLOWED_IPS")
    smtp_host: str = os.environ.get("SMTP_HOST", "")
    smtp_port: int = int(os.environ.get("SMTP_PORT", "587"))
    smtp_username: str = os.environ.get("SMTP_USERNAME", "")
    smtp_password: str = os.environ.get("SMTP_PASSWORD", "")
    smtp_from_email: str = os.environ.get("SMTP_FROM_EMAIL", "")
    smtp_from_name: str = os.environ.get("SMTP_FROM_NAME", "VYNTRA")
    smtp_use_tls: bool = _bool_env("SMTP_USE_TLS", True)
    smtp_use_ssl: bool = _bool_env("SMTP_USE_SSL", False)
    smtp_timeout_seconds: int = int(os.environ.get("SMTP_TIMEOUT_SECONDS", "10"))
    app_public_url: str = os.environ.get("APP_PUBLIC_URL", "")
    bootstrap_company_name: str = os.environ.get("BOOTSTRAP_COMPANY_NAME", "VYNTRA Demo")
    bootstrap_employee_limit: int = int(os.environ.get("BOOTSTRAP_EMPLOYEE_LIMIT", "0"))
    bootstrap_admin_email: str = os.environ.get("BOOTSTRAP_ADMIN_EMAIL", "admin@vyntra.local")
    bootstrap_admin_name: str = os.environ.get("BOOTSTRAP_ADMIN_NAME", "VYNTRA Admin")
    bootstrap_admin_password_hash: str = os.environ.get(
        "BOOTSTRAP_ADMIN_PASSWORD_HASH",
        "pbkdf2_sha256:200000:/lZV/m0SF5D+pksiiPC19Q==:M187IVtrUnKIdrQbmXr0Os7WGbz8/JGT27S95xFvhnI=",
    )
    bootstrap_system_admin_email: str = os.environ.get("BOOTSTRAP_SYSTEM_ADMIN_EMAIL", "")
    bootstrap_system_admin_name: str = os.environ.get("BOOTSTRAP_SYSTEM_ADMIN_NAME", "Administrador del sistema")
    bootstrap_system_admin_password_hash: str = os.environ.get("BOOTSTRAP_SYSTEM_ADMIN_PASSWORD_HASH", "")
    bootstrap_employee_code: str = os.environ.get("BOOTSTRAP_EMPLOYEE_CODE", "EMP-001")
    bootstrap_employee_name: str = os.environ.get("BOOTSTRAP_EMPLOYEE_NAME", "Empleado Demo")
    bootstrap_employee_email: str = os.environ.get("BOOTSTRAP_EMPLOYEE_EMAIL", "")
    bootstrap_position_name: str = os.environ.get("BOOTSTRAP_POSITION_NAME", "Operador")
    bootstrap_employee_login_email: str = os.environ.get(
        "BOOTSTRAP_EMPLOYEE_LOGIN_EMAIL", "empleado@vyntra.local"
    )
    bootstrap_employee_password_hash: str = os.environ.get(
        "BOOTSTRAP_EMPLOYEE_PASSWORD_HASH",
        "pbkdf2_sha256:200000:/lZV/m0SF5D+pksiiPC19Q==:M187IVtrUnKIdrQbmXr0Os7WGbz8/JGT27S95xFvhnI=",
    )
    bootstrap_device_name: str = os.environ.get("BOOTSTRAP_DEVICE_NAME", "")
    bootstrap_device_token: str = os.environ.get("BOOTSTRAP_DEVICE_TOKEN", "")
    allow_bootstrap: bool = _bool_env("ALLOW_BOOTSTRAP", _bootstrap_default())
    allow_legacy_admin_token: bool = _bool_env("ALLOW_LEGACY_ADMIN_TOKEN", False)


settings = Settings()

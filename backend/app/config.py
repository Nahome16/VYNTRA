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


DEVELOPMENT_ENVIRONMENTS = frozenset({"development", "dev", "local", "test"})
MIN_JWT_SECRET_LENGTH = 32
# Hash PBKDF2 conocido (solo desarrollo local). Nunca se usa fuera de desarrollo.
LOCAL_DEV_PASSWORD_HASH = (
    "pbkdf2_sha256:200000:/lZV/m0SF5D+pksiiPC19Q==:M187IVtrUnKIdrQbmXr0Os7WGbz8/JGT27S95xFvhnI="
)
LOCAL_DEV_JWT_SECRET = "local_dev_vyntra_jwt_secret_change_before_production"
PLACEHOLDER_MARKERS = ("replace_with", "changeme", "change_me", "example", "local_dev_vyntra")


def is_development_environment(value: str | None = None) -> bool:
    """True solo si ENVIRONMENT es explicitamente de desarrollo (fail-closed)."""
    raw = os.environ.get("ENVIRONMENT", "") if value is None else value
    return (raw or "").strip().lower() in DEVELOPMENT_ENVIRONMENTS


def _jwt_secret_default() -> str:
    return LOCAL_DEV_JWT_SECRET if is_development_environment() else ""


def _dev_only_default(value: str) -> str:
    return value if is_development_environment() else ""


def _bootstrap_default() -> bool:
    return is_development_environment()


@dataclass(frozen=True)
class Settings:
    app_name: str = os.environ.get("APP_NAME", "VYNTRA Evidence API")
    # Sin valor por defecto de desarrollo: si ENVIRONMENT falta se trata como produccion.
    environment: str = os.environ.get("ENVIRONMENT", "")
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
    station_domain: str = os.environ.get("STATION_DOMAIN", "")
    station_public_url: str = os.environ.get("STATION_PUBLIC_URL", "")
    bootstrap_company_name: str = os.environ.get("BOOTSTRAP_COMPANY_NAME", "VYNTRA Demo")
    bootstrap_employee_limit: int = int(os.environ.get("BOOTSTRAP_EMPLOYEE_LIMIT", "0"))
    bootstrap_admin_email: str = os.environ.get("BOOTSTRAP_ADMIN_EMAIL", "admin@vyntra.local")
    bootstrap_admin_name: str = os.environ.get("BOOTSTRAP_ADMIN_NAME", "VYNTRA Admin")
    bootstrap_admin_password_hash: str = os.environ.get(
        "BOOTSTRAP_ADMIN_PASSWORD_HASH",
        _dev_only_default(LOCAL_DEV_PASSWORD_HASH),
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
        _dev_only_default(LOCAL_DEV_PASSWORD_HASH),
    )
    bootstrap_device_name: str = os.environ.get("BOOTSTRAP_DEVICE_NAME", "")
    bootstrap_device_token: str = os.environ.get("BOOTSTRAP_DEVICE_TOKEN", "")
    allow_bootstrap: bool = _bool_env("ALLOW_BOOTSTRAP", _bootstrap_default())
    allow_legacy_admin_token: bool = _bool_env("ALLOW_LEGACY_ADMIN_TOKEN", False)
    # Retencion (RNF-13): evidencia visual 90 dias, telemetria 12 meses.
    retention_evidence_days: int = int(os.environ.get("RETENTION_EVIDENCE_DAYS", "90"))
    retention_telemetry_days: int = int(os.environ.get("RETENTION_TELEMETRY_DAYS", "365"))

    @property
    def is_development(self) -> bool:
        return is_development_environment(self.environment)


def _looks_like_placeholder(value: str) -> bool:
    lowered = (value or "").strip().lower()
    return any(marker in lowered for marker in PLACEHOLDER_MARKERS)


def runtime_settings_errors(current: "Settings") -> list[str]:
    """Errores de configuracion que impiden arrancar fuera de desarrollo."""
    if current.is_development:
        return []
    errors = []
    secret = current.jwt_secret or ""
    if len(secret) < MIN_JWT_SECRET_LENGTH:
        errors.append(f"JWT_SECRET must have at least {MIN_JWT_SECRET_LENGTH} characters")
    elif _looks_like_placeholder(secret):
        errors.append("JWT_SECRET looks like a placeholder value")
    for name, value in (
        ("BOOTSTRAP_ADMIN_PASSWORD_HASH", current.bootstrap_admin_password_hash),
        ("BOOTSTRAP_EMPLOYEE_PASSWORD_HASH", current.bootstrap_employee_password_hash),
        ("BOOTSTRAP_SYSTEM_ADMIN_PASSWORD_HASH", current.bootstrap_system_admin_password_hash),
    ):
        if value and value.strip() == LOCAL_DEV_PASSWORD_HASH:
            errors.append(f"{name} uses the local development hash")
    if current.allow_legacy_admin_token and (
        len(current.admin_api_token or "") < MIN_JWT_SECRET_LENGTH
        or _looks_like_placeholder(current.admin_api_token)
    ):
        errors.append("ADMIN_API_TOKEN is too short or a placeholder while ALLOW_LEGACY_ADMIN_TOKEN=true")
    return errors


def validate_runtime_settings(current: "Settings | None" = None) -> None:
    errors = runtime_settings_errors(current or settings)
    if errors:
        raise RuntimeError("Refusing to start with insecure configuration: " + "; ".join(errors))


settings = Settings()

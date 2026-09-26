"""
auth.py - API authentication helpers.
"""

import base64
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import secrets

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.config import settings
from app.models import AdminSession, Device, Role, User, now_utc


@dataclass(frozen=True)
class AdminPrincipal:
    user_id: str | None
    company_id: str | None
    email: str
    role: str
    auth_method: str
    session_id: str | None = None


ROLE_PERMISSIONS: dict[str, set[str]] = {
    "system_admin": {
        "system:manage",
        "dashboard:read",
        "devices:read",
        "devices:manage",
        "employees:read",
        "employees:manage",
        "attendance:read",
        "attendance:manage",
        "incidents:read",
        "incidents:resolve",
        "settings:manage",
        "rules:read",
        "rules:manage",
        "access_codes:read",
        "access_codes:manage",
        "audit:read",
    },
    "owner": {
        "dashboard:read",
        "devices:read",
        "devices:manage",
        "employees:read",
        "employees:manage",
        "attendance:read",
        "attendance:manage",
        "incidents:read",
        "incidents:resolve",
        "settings:manage",
        "rules:read",
        "rules:manage",
        "access_codes:read",
        "access_codes:manage",
    },
    "admin": {
        "dashboard:read",
        "devices:read",
        "devices:manage",
        "employees:read",
        "employees:manage",
        "attendance:read",
        "attendance:manage",
        "incidents:read",
        "incidents:resolve",
        "settings:manage",
        "rules:read",
        "rules:manage",
        "access_codes:read",
        "access_codes:manage",
    },
    "rrhh": {
        "dashboard:read",
        "employees:read",
        "employees:manage",
        "attendance:read",
        "attendance:manage",
        "incidents:read",
        "incidents:resolve",
        "access_codes:read",
        "access_codes:manage",
    },
    "supervisor": {
        "dashboard:read",
        "employees:read",
        "attendance:read",
        "incidents:read",
    },
    "viewer": {
        "dashboard:read",
        "employees:read",
        "attendance:read",
        "incidents:read",
    },
}


def permissions_for_role(role_name: str) -> list[str]:
    return sorted(ROLE_PERMISSIONS.get(role_name, set()))


def require_permission(admin: AdminPrincipal, permission: str) -> None:
    if permission not in ROLE_PERMISSIONS.get(admin.role, set()):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Permission required: {permission}",
        )


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def create_admin_access_token(user: User, role_name: str, session_id: str) -> str:
    if not settings.jwt_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="JWT secret is not configured",
        )

    now = datetime.now(timezone.utc)
    payload = {
        "typ": "admin_access",
        "sub": user.id,
        "company_id": user.company_id,
        "email": user.email,
        "role": role_name,
        "jti": session_id,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.admin_token_expire_minutes)).timestamp()),
    }
    header = {"alg": "HS256", "typ": "JWT"}
    signing_input = ".".join(
        [
            _b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8")),
            _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")),
        ]
    )
    signature = hmac.new(
        settings.jwt_secret.encode("utf-8"),
        signing_input.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{signing_input}.{_b64url_encode(signature)}"


def decode_admin_access_token(token: str) -> dict:
    try:
        header_text, payload_text, signature_text = token.split(".", 2)
        signing_input = f"{header_text}.{payload_text}"
        expected = hmac.new(
            settings.jwt_secret.encode("utf-8"),
            signing_input.encode("ascii"),
            hashlib.sha256,
        ).digest()
        provided = _b64url_decode(signature_text)
        if not secrets.compare_digest(expected, provided):
            raise ValueError("bad signature")
        header = json.loads(_b64url_decode(header_text))
        payload = json.loads(_b64url_decode(payload_text))
        if header.get("alg") != "HS256" or payload.get("typ") != "admin_access":
            raise ValueError("bad token type")
        exp = int(payload.get("exp") or 0)
        if exp < int(datetime.now(timezone.utc).timestamp()):
            raise ValueError("expired")
        return payload
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid admin session",
        ) from exc


PBKDF2_ALGORITHM = "pbkdf2_sha256"
# OWASP 2023 para PBKDF2-HMAC-SHA256. Los hashes antiguos (200000/390000) se
# siguen verificando y se re-hashean al iniciar sesion correctamente.
PBKDF2_ITERATIONS = 600_000
# Tope defensivo: un hash almacenado con iteraciones absurdas no debe bloquear la API.
PBKDF2_MAX_ITERATIONS = 5_000_000


def hash_password(password: str, iterations: int = PBKDF2_ITERATIONS) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", (password or "").encode("utf-8"), salt, iterations)
    return "{}:{}:{}:{}".format(
        PBKDF2_ALGORITHM,
        iterations,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def password_hash_iterations(stored_hash: str) -> int:
    try:
        algorithm, iterations_text, _salt, _digest = (stored_hash or "").split(":", 3)
        if algorithm != PBKDF2_ALGORITHM:
            return 0
        return int(iterations_text)
    except (ValueError, AttributeError):
        return 0


def password_needs_rehash(stored_hash: str) -> bool:
    """True si el hash es PBKDF2 valido pero con menos iteraciones que las actuales."""
    iterations = password_hash_iterations(stored_hash)
    return 0 < iterations < PBKDF2_ITERATIONS


def verify_password_hash(password: str, stored_hash: str) -> bool:
    """Validate the PBKDF2 hash format used by employee credentials."""
    try:
        algorithm, iterations_text, salt_text, hash_text = (stored_hash or "").split(":", 3)
        if algorithm != PBKDF2_ALGORITHM:
            return False
        iterations = int(iterations_text)
        if iterations <= 0 or iterations > PBKDF2_MAX_ITERATIONS:
            return False
        salt = base64.b64decode(salt_text)
        expected = base64.b64decode(hash_text)
        calculated = hashlib.pbkdf2_hmac(
            "sha256",
            (password or "").encode("utf-8"),
            salt,
            iterations,
        )
        return secrets.compare_digest(calculated, expected)
    except Exception:
        return False


_DUMMY_PASSWORD_HASH: str | None = None


def dummy_password_hash() -> str:
    """Hash descartable para igualar el tiempo de respuesta cuando el usuario no existe."""
    global _DUMMY_PASSWORD_HASH
    if _DUMMY_PASSWORD_HASH is None:
        _DUMMY_PASSWORD_HASH = hash_password(secrets.token_urlsafe(24))
    return _DUMMY_PASSWORD_HASH


def verify_password_constant_time(password: str, stored_hash: str | None) -> bool:
    """Verifica contra el hash real o, si no existe, contra un hash ficticio."""
    if not stored_hash:
        verify_password_hash(password, dummy_password_hash())
        return False
    return verify_password_hash(password, stored_hash)


def _as_aware(value: datetime) -> datetime:
    """PostgreSQL devuelve fechas con zona; SQLite (pruebas) sin zona: se asume UTC."""
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


DEVICE_LAST_SEEN_UPDATE_SECONDS = 60

# Endpoints permitidos mientras el usuario del panel debe cambiar su contrasena.
PASSWORD_CHANGE_EXEMPT_PATHS = frozenset(
    {
        "/api/admin/me",
        "/api/admin/password/change",
        "/api/admin/logout",
        "/api/admin/company-notice",
    }
)
# 428 (Precondition Required) y no 403: el panel web cierra la sesion ante
# cualquier 401/403, lo que romperia el flujo de cambio obligatorio.
PASSWORD_CHANGE_REQUIRED_STATUS = 428
PASSWORD_CHANGE_REQUIRED_DETAIL = "Debes cambiar tu contrasena temporal antes de continuar."


def require_device(
    x_device_token: str = Header(default="", alias="X-Device-Token"),
    db: Session = Depends(get_db),
) -> Device:
    token = x_device_token.strip()
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-Device-Token header",
        )

    token_hash = hash_token(token)
    device = db.execute(
        select(Device).where(
            Device.is_active.is_(True),
            Device.token_sha256 == token_hash,
        )
    ).scalar_one_or_none()
    if device and secrets.compare_digest(device.token_sha256, token_hash):
        current_time = now_utc()
        last_seen = _as_aware(device.last_seen_at) if device.last_seen_at is not None else None
        # Evita una escritura por cada peticion del agente: como maximo una por minuto.
        elapsed = (current_time - last_seen).total_seconds() if last_seen is not None else None
        if elapsed is None or elapsed < 0 or elapsed >= DEVICE_LAST_SEEN_UPDATE_SECONDS:
            device.last_seen_at = current_time
            db.commit()
            db.refresh(device)
        return device

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid device token",
    )


def require_admin(
    request: Request,
    authorization: str = Header(default="", alias="Authorization"),
    x_admin_token: str = Header(default="", alias="X-Admin-Token"),
    db: Session = Depends(get_db),
) -> AdminPrincipal:
    bearer_prefix = "Bearer "
    if authorization.startswith(bearer_prefix):
        payload = decode_admin_access_token(authorization[len(bearer_prefix):].strip())
        user = db.get(User, str(payload.get("sub") or ""))
        if user is None or user.status != "active":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid admin session",
            )
        role = db.get(Role, user.role_id) if user.role_id else None
        role_name = role.name if role else ""
        session_id = str(payload.get("jti") or "")
        if user.company_id != payload.get("company_id") or role_name != payload.get("role"):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid admin session",
            )
        session = db.get(AdminSession, session_id)
        current_time = now_utc()
        if (
            session is None
            or session.user_id != user.id
            or session.company_id != user.company_id
            or session.revoked_at is not None
            or _as_aware(session.expires_at) <= current_time
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid admin session",
            )
        if role_name not in ROLE_PERMISSIONS:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions",
            )
        session.last_seen_at = current_time
        db.commit()
        if user.password_change_required and request.url.path not in PASSWORD_CHANGE_EXEMPT_PATHS:
            raise HTTPException(
                status_code=PASSWORD_CHANGE_REQUIRED_STATUS,
                detail=PASSWORD_CHANGE_REQUIRED_DETAIL,
                headers={"X-Password-Change-Required": "true"},
            )
        return AdminPrincipal(
            user_id=user.id,
            company_id=user.company_id,
            email=user.email,
            role=role_name,
            auth_method="jwt",
            session_id=session.id,
        )

    if not settings.allow_legacy_admin_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer admin session required",
        )

    expected = settings.admin_api_token.strip()
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Admin API token is not configured",
        )

    token = x_admin_token.strip()
    if not token or not secrets.compare_digest(token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid admin token",
        )
    return AdminPrincipal(
        user_id=None,
        company_id=None,
        email="legacy-admin-token",
        role="admin",
        auth_method="legacy_token",
    )

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

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.config import settings
from app.models import Device, Role, User, now_utc


@dataclass(frozen=True)
class AdminPrincipal:
    user_id: str | None
    company_id: str | None
    email: str
    role: str
    auth_method: str


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
        "audit:read",
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
        "audit:read",
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


def create_admin_access_token(user: User, role_name: str) -> str:
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


def verify_password_hash(password: str, stored_hash: str) -> bool:
    """Validate the PBKDF2 hash format used by employee credentials."""
    try:
        algorithm, iterations_text, salt_text, hash_text = (stored_hash or "").split(":", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        iterations = int(iterations_text)
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
        device.last_seen_at = now_utc()
        db.commit()
        db.refresh(device)
        return device

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid device token",
    )


def require_admin(
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
        if user.company_id != payload.get("company_id") or role_name != payload.get("role"):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid admin session",
            )
        if role_name not in ROLE_PERMISSIONS:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions",
            )
        return AdminPrincipal(
            user_id=user.id,
            company_id=user.company_id,
            email=user.email,
            role=role_name,
            auth_method="jwt",
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

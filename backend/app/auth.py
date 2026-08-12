"""
auth.py - API authentication helpers.
"""

import hashlib
import secrets

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.config import settings
from app.models import Device, now_utc


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


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
    x_admin_token: str = Header(default="", alias="X-Admin-Token"),
) -> bool:
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
    return True

"""
storage.py - Local evidence storage.

The interface is intentionally small so it can later be swapped for S3/Spaces.
"""

from datetime import datetime
import os
import re
import shutil

from app.config import settings


IMAGE_EXTENSIONS = {".webp", ".png", ".jpg", ".jpeg"}
IMAGE_CONTENT_TYPES = {"image/webp", "image/png", "image/jpeg", "application/octet-stream"}


def safe_part(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value).strip())
    return cleaned.strip("._") or "unknown"


def validate_image_name(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    if ext not in IMAGE_EXTENSIONS:
        raise ValueError(f"Unsupported evidence extension: {ext}")
    return ext


def validate_image_signature(filepath: str, extension: str):
    with open(filepath, "rb") as f:
        header = f.read(16)

    if extension == ".webp":
        if len(header) < 12 or not (header[:4] == b"RIFF" and header[8:12] == b"WEBP"):
            raise ValueError("Invalid WEBP signature")
        return

    if extension == ".png":
        if not header.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Invalid PNG signature")
        return

    if extension in {".jpg", ".jpeg"}:
        if not header.startswith(b"\xff\xd8\xff"):
            raise ValueError("Invalid JPEG signature")
        return

    raise ValueError("Unsupported image signature")


def build_storage_path(
    company_id: str,
    device_name: str,
    captured_at: datetime,
    evidence_id: str,
    extension: str,
) -> str:
    return os.path.join(
        safe_part(company_id),
        safe_part(device_name),
        f"{captured_at.year:04d}",
        f"{captured_at.month:02d}",
        f"{captured_at.day:02d}",
        f"{evidence_id}{extension}",
    )


def save_from_temp(temp_path: str, relative_path: str) -> str:
    full_path = os.path.abspath(os.path.join(settings.storage_dir, relative_path))
    storage_root = os.path.abspath(settings.storage_dir)
    if os.path.commonpath([full_path, storage_root]) != storage_root:
        raise ValueError("Invalid storage path")

    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    shutil.move(temp_path, full_path)
    return full_path

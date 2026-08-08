"""
gdrive.py - Google Drive upload support for VYNTRA screenshots.
"""

import json
import mimetypes
import os
from typing import Any

from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

try:
    from google.oauth2.service_account import Credentials as ServiceAccountCredentials
    from google.oauth2.credentials import Credentials as UserCredentials
    from google_auth_oauthlib.flow import InstalledAppFlow
except ImportError:  # pragma: no cover
    ServiceAccountCredentials = None
    UserCredentials = None
    InstalledAppFlow = None


class DriveUploader:
    IMAGE_EXTENSIONS = {".webp", ".png", ".jpg", ".jpeg"}

    def __init__(self, cfg: Any, on_event=None):
        self.cfg = cfg
        self.on_event = on_event
        self.folder_id = getattr(cfg, "drive_folder_id", "")
        self.credentials_json = getattr(cfg, "drive_credentials_json", "")
        self._folder_cache = {}
        if not self.folder_id:
            raise ValueError("FolderId no configurado para Google Drive")
        if not self.credentials_json:
            raise ValueError("CredentialsJson no configurado para Google Drive")
        if not os.path.exists(self.credentials_json):
            raise FileNotFoundError(f"Archivo de credenciales no encontrado: {self.credentials_json}")

        self.creds = self._load_credentials()
        self.service = build("drive", "v3", credentials=self.creds)

    def _load_credentials(self):
        with open(self.credentials_json, "r", encoding="utf-8") as f:
            data = json.load(f)

        scopes = ["https://www.googleapis.com/auth/drive.file"]

        if data.get("type") == "service_account":
            if ServiceAccountCredentials is None:
                raise ImportError("google-auth is requerido para credenciales de servicio.")
            creds = ServiceAccountCredentials.from_service_account_info(data, scopes=scopes)
            if not creds.valid:
                creds.refresh(Request())
            return creds

        if "installed" in data or "web" in data:
            if UserCredentials is None or InstalledAppFlow is None:
                raise ImportError("google-auth-oauthlib es requerido para OAuth de usuario.")

            token_path = os.path.join(os.path.dirname(self.credentials_json), "token.json")
            creds = None
            if os.path.exists(token_path):
                creds = UserCredentials.from_authorized_user_file(token_path, scopes=scopes)

            if not creds or not creds.valid:
                if creds and creds.expired and creds.refresh_token:
                    creds.refresh(Request())
                else:
                    client_config = data
                    flow = InstalledAppFlow.from_client_config(client_config, scopes=scopes)
                    try:
                        creds = flow.run_local_server(port=0)
                    except Exception:
                        self._notify(
                            "No se pudo abrir el navegador. Usa el enlace en la terminal."
                        )
                        creds = flow.run_console()
                with open(token_path, "w", encoding="utf-8") as token_file:
                    token_file.write(creds.to_json())
            return creds

        raise ValueError(
            "El archivo de credenciales debe ser de tipo 'service_account' o un cliente OAuth ('installed'/'web')."
        )

    def upload_file(
        self,
        filepath: str,
        remote_name: str | None = None,
        mime_type: str | None = None,
        parent_id: str | None = None,
    ):
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"Archivo no encontrado: {filepath}")
        self._ensure_image_file(filepath)

        filename = remote_name or os.path.basename(filepath)
        mime_type = mime_type or mimetypes.guess_type(filepath)[0] or "application/octet-stream"
        media = MediaFileUpload(filepath, mimetype=mime_type)
        body = {
            "name": filename,
            "parents": [parent_id or self.folder_id],
        }

        file = self.service.files().create(body=body, media_body=media, fields="id,name").execute()
        self._notify(f"Drive subido: {file.get('name')} ({file.get('id')})")
        return file

    def upload_or_update_file(
        self,
        filepath: str,
        remote_name: str | None = None,
        mime_type: str | None = None,
        parent_id: str | None = None,
    ):
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"Archivo no encontrado: {filepath}")
        self._ensure_image_file(filepath)

        filename = remote_name or os.path.basename(filepath)
        mime_type = mime_type or mimetypes.guess_type(filepath)[0] or "application/octet-stream"
        parent_id = parent_id or self.folder_id
        existing = self._find_file(filename, parent_id=parent_id)
        media = MediaFileUpload(filepath, mimetype=mime_type, resumable=True)

        if existing:
            file = (
                self.service.files()
                .update(fileId=existing["id"], media_body=media, fields="id,name,modifiedTime")
                .execute()
            )
            self._notify(f"Drive actualizado: {file.get('name')}")
            return file

        return self.upload_file(
            filepath,
            remote_name=filename,
            mime_type=mime_type,
            parent_id=parent_id,
        )

    def upload_image_backup(self, filepath: str, folder_parts: list[str]):
        self._ensure_image_file(filepath)

        parent_id = self.ensure_folder_path(folder_parts)
        return self.upload_or_update_file(
            filepath,
            remote_name=os.path.basename(filepath),
            mime_type=mimetypes.guess_type(filepath)[0] or "image/webp",
            parent_id=parent_id,
        )

    def ensure_folder_path(self, parts: list[str]) -> str:
        parent_id = self.folder_id
        for raw_part in parts:
            part = str(raw_part).strip()
            if not part:
                continue
            parent_id = self.get_or_create_folder(part, parent_id)
        return parent_id

    def get_or_create_folder(self, name: str, parent_id: str) -> str:
        cache_key = (parent_id, name)
        if cache_key in self._folder_cache:
            return self._folder_cache[cache_key]

        existing = self._find_file(
            name,
            parent_id=parent_id,
            mime_type="application/vnd.google-apps.folder",
        )
        if existing:
            self._folder_cache[cache_key] = existing["id"]
            return existing["id"]

        body = {
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id],
        }
        folder = self.service.files().create(body=body, fields="id,name").execute()
        self._folder_cache[cache_key] = folder["id"]
        self._notify(f"Drive carpeta lista: {name}")
        return folder["id"]

    def _find_file(self, filename: str, parent_id: str | None = None, mime_type: str | None = None):
        escaped_name = filename.replace("\\", "\\\\").replace("'", "\\'")
        escaped_folder = (parent_id or self.folder_id).replace("\\", "\\\\").replace("'", "\\'")
        clauses = [
            f"name = '{escaped_name}'",
            f"'{escaped_folder}' in parents",
            "trashed = false",
        ]
        if mime_type:
            escaped_mime = mime_type.replace("\\", "\\\\").replace("'", "\\'")
            clauses.append(f"mimeType = '{escaped_mime}'")
        query = " and ".join(clauses)
        result = (
            self.service.files()
            .list(q=query, spaces="drive", fields="files(id,name)", pageSize=1)
            .execute()
        )
        files = result.get("files", [])
        return files[0] if files else None

    def _ensure_image_file(self, filepath: str):
        extension = os.path.splitext(filepath)[1].lower()
        if extension not in self.IMAGE_EXTENSIONS:
            raise ValueError(f"Solo se respaldan imagenes, no: {extension}")

    def _notify(self, msg: str):
        if self.on_event:
            try:
                self.on_event(msg)
            except Exception:
                pass

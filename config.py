"""
config.py - Configuracion del agente VYNTRA.

El instalador escribe config.ini junto al ejecutable. El agente solo lee estos
valores y no guarda reglas de clasificacion locales.
"""

import configparser
import os
import sys


def _base_dir() -> str:
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


class Config:
    def __init__(self):
        base = _base_dir()
        self.base_dir = base
        self.config_path = os.path.join(base, "config.ini")

        parser = configparser.ConfigParser()
        parser.read(self.config_path, encoding="utf-8")

        self.server_url = parser.get(
            "Server", "Url", fallback="https://localhost:7168"
        )
        self.agent_version = parser.get("Agent", "Version", fallback="1.0.0")

        self.intervalo_segundos = parser.getint(
            "Capture", "IntervalSeconds", fallback=300
        )
        self.captura_intervalo_segundos = self.intervalo_segundos

        carpeta = parser.get("Capture", "Directory", fallback="capturas")
        if not os.path.isabs(carpeta):
            carpeta = os.path.join(base, carpeta)
        self.carpeta_capturas = carpeta

        self.drive_upload_enabled = parser.getboolean(
            "GoogleDrive", "Enabled", fallback=False
        )
        self.drive_folder_id = parser.get("GoogleDrive", "FolderId", fallback="").strip()
        credentials_json = parser.get("GoogleDrive", "CredentialsJson", fallback="").strip()
        if credentials_json and not os.path.isabs(credentials_json):
            credentials_json = os.path.join(base, credentials_json)
        self.drive_credentials_json = credentials_json

        self.evidence_backend_enabled = parser.getboolean(
            "EvidenceBackend", "Enabled", fallback=False
        )
        self.evidence_backend_url = parser.get(
            "EvidenceBackend", "Url", fallback=self.server_url
        ).strip()
        self.evidence_device_token = parser.get(
            "EvidenceBackend", "DeviceToken", fallback=""
        ).strip()
        self.evidence_retry_limit = parser.getint(
            "EvidenceBackend", "RetryLimit", fallback=50
        )
        self.evidence_request_timeout = parser.getint(
            "EvidenceBackend", "RequestTimeoutSeconds", fallback=30
        )
        self.evidence_queue_db = parser.get(
            "EvidenceBackend", "QueueDatabase", fallback=""
        ).strip()
        if self.evidence_queue_db and not os.path.isabs(self.evidence_queue_db):
            self.evidence_queue_db = os.path.join(base, self.evidence_queue_db)

        self.station_auth_allow_local_fallback = parser.getboolean(
            "StationAuth", "AllowLocalFallback", fallback=False
        )

        self.empresa = parser.get("General", "Empresa", fallback="Tu Empresa S.A.")
        self.correo_contacto = parser.get(
            "General", "CorreoContacto", fallback="rrhh@tuempresa.com"
        )
        self.idle_umbral_segundos = parser.getint(
            "Telemetria", "IdleUmbralSegundos", fallback=60
        )
        self.admin_pin = parser.get("Admin", "PIN", fallback="1234")

    def save_device_token(self, token: str):
        clean_token = (token or "").strip()
        if not clean_token:
            return
        parser = configparser.ConfigParser()
        parser.read(self.config_path, encoding="utf-8")
        if not parser.has_section("EvidenceBackend"):
            parser.add_section("EvidenceBackend")
        parser.set("EvidenceBackend", "Enabled", "true")
        parser.set("EvidenceBackend", "DeviceToken", clean_token)
        with open(self.config_path, "w", encoding="utf-8") as f:
            parser.write(f)
        self.evidence_backend_enabled = True
        self.evidence_device_token = clean_token

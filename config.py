"""
config.py - Configuracion del agente VYNTRA.

El instalador escribe config.ini junto al ejecutable. El agente solo lee estos
valores y no guarda reglas de clasificacion locales.

DeviceToken protegido con DPAPI
-------------------------------
En Windows el token del dispositivo se guarda cifrado con DPAPI (ambito del
usuario actual) como `DeviceTokenProtected` (base64) en [EvidenceBackend]. Si
al cargar existe un `DeviceToken` en texto plano (instalaciones anteriores o
paquetes con token), se migra automaticamente a la forma protegida y se elimina
el texto plano. En sistemas sin DPAPI (desarrollo en macOS/Linux o sin pywin32)
se mantiene en texto plano y se registra una advertencia.

Si el token protegido no se puede descifrar (config.ini copiado a otro usuario
u otro equipo), se ignora: el agente volvera a enrolar el equipo en el
siguiente inicio de sesion.

Lectura/escritura
-----------------
Los archivos se leen con "utf-8-sig" (tolera el BOM que agrega PowerShell 5.1)
y se escriben en UTF-8 sin BOM de forma atomica (archivo .tmp + os.replace).
"""

import base64
import configparser
import os
import sys

from agent_runtime import get_logger

log = get_logger("config")

_DPAPI_ENTROPY = b"VYNTRA-DeviceToken-v1"
_DPAPI_DESCRIPTION = "VYNTRA DeviceToken"
_CRYPTPROTECT_UI_FORBIDDEN = 0x1


def _base_dir() -> str:
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------
# DPAPI
# ---------------------------------------------------------------------------
def _win32crypt():
    if not sys.platform.startswith("win"):
        return None
    try:
        import win32crypt  # type: ignore

        return win32crypt
    except ImportError:
        return None


def dpapi_available() -> bool:
    return _win32crypt() is not None


def protect_secret(plain: str) -> str | None:
    """Cifra con DPAPI (usuario actual). Devuelve base64 o None si no hay DPAPI."""
    crypt = _win32crypt()
    if crypt is None:
        return None
    blob = crypt.CryptProtectData(
        plain.encode("utf-8"),
        _DPAPI_DESCRIPTION,
        _DPAPI_ENTROPY,
        None,
        None,
        _CRYPTPROTECT_UI_FORBIDDEN,
    )
    return base64.b64encode(blob).decode("ascii")


def unprotect_secret(protected_b64: str) -> str | None:
    crypt = _win32crypt()
    if crypt is None:
        return None
    blob = base64.b64decode(protected_b64.encode("ascii"))
    _description, data = crypt.CryptUnprotectData(
        blob, _DPAPI_ENTROPY, None, None, _CRYPTPROTECT_UI_FORBIDDEN
    )
    return data.decode("utf-8")


# ---------------------------------------------------------------------------
# Lectura / escritura de config.ini
# ---------------------------------------------------------------------------
def read_config(path: str) -> configparser.ConfigParser:
    parser = configparser.ConfigParser(interpolation=None)
    if os.path.exists(path):
        parser.read(path, encoding="utf-8-sig")
    return parser


# configparser guarda las claves en minusculas; se reescriben con su forma
# canonica para que los scripts de PowerShell (regex sensibles a mayusculas)
# sigan encontrandolas.
_CANONICAL_KEYS = {
    key.lower(): key
    for key in (
        "Url", "Version", "Enabled", "Language", "IntervalSeconds", "Directory",
        "Empresa", "CorreoContacto", "IdleUmbralSegundos", "DeviceToken",
        "DeviceTokenProtected", "RetryLimit", "RequestTimeoutSeconds",
        "QueueDatabase", "DeleteAfterUpload", "AllowLocalFallback",
        "SignerThumbprint",
    )
}


def write_config_atomic(parser: configparser.ConfigParser, path: str):
    folder = os.path.dirname(os.path.abspath(path))
    tmp = os.path.join(folder, f".{os.path.basename(path)}.{os.getpid()}.tmp")
    output = configparser.ConfigParser(interpolation=None)
    output.optionxform = str
    for section in parser.sections():
        output.add_section(section)
        for key, value in parser.items(section, raw=True):
            output.set(section, _CANONICAL_KEYS.get(key.lower(), key), value)
    try:
        with open(tmp, "w", encoding="utf-8", newline="") as handle:
            output.write(handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


class Config:
    def __init__(self, config_path: str | None = None):
        base = _base_dir()
        self.base_dir = base
        self.config_path = config_path or os.path.join(base, "config.ini")

        parser = read_config(self.config_path)

        self.server_url = parser.get(
            "Server", "Url", fallback="https://localhost:7168"
        )
        self.agent_version = parser.get("Agent", "Version", fallback="1.0.0")
        language = parser.get("Interface", "Language", fallback="es").strip().lower()
        self.language = "en" if language.startswith("en") else "es"
        self.agent_auto_update_enabled = parser.getboolean(
            "AgentUpdate", "Enabled", fallback=True
        )
        # Huella (SHA-1 thumbprint) del certificado que firma VYNTRAAgent.exe.
        # Si se configura, el actualizador exige firma Authenticode valida y del
        # mismo firmante antes de reemplazar archivos.
        self.update_signer_thumbprint = (
            parser.get("Update", "SignerThumbprint", fallback="").strip()
            or parser.get("AgentUpdate", "SignerThumbprint", fallback="").strip()
        ).replace(" ", "").upper()

        self.intervalo_segundos = parser.getint(
            "Capture", "IntervalSeconds", fallback=300
        )
        self.captura_intervalo_segundos = self.intervalo_segundos

        carpeta = parser.get("Capture", "Directory", fallback="capturas")
        if not os.path.isabs(carpeta):
            carpeta = os.path.join(base, carpeta)
        self.carpeta_capturas = carpeta

        self.evidence_backend_enabled = parser.getboolean(
            "EvidenceBackend", "Enabled", fallback=False
        )
        self.evidence_backend_url = parser.get(
            "EvidenceBackend", "Url", fallback=self.server_url
        ).strip()
        self.evidence_device_token = self._load_device_token(parser)
        self.evidence_retry_limit = parser.getint(
            "EvidenceBackend", "RetryLimit", fallback=50
        )
        self.evidence_request_timeout = parser.getint(
            "EvidenceBackend", "RequestTimeoutSeconds", fallback=30
        )
        self.evidence_delete_after_upload = parser.getboolean(
            "EvidenceBackend", "DeleteAfterUpload", fallback=True
        )
        self.evidence_queue_db = parser.get(
            "EvidenceBackend", "QueueDatabase", fallback=""
        ).strip()
        if self.evidence_queue_db and not os.path.isabs(self.evidence_queue_db):
            self.evidence_queue_db = os.path.join(base, self.evidence_queue_db)

        # Solo tiene efecto en modo desarrollo (ver local_auth.py).
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

    # ---- DeviceToken ----------------------------------------------------
    def _load_device_token(self, parser: configparser.ConfigParser) -> str:
        protected = parser.get("EvidenceBackend", "DeviceTokenProtected", fallback="").strip()
        plain = parser.get("EvidenceBackend", "DeviceToken", fallback="").strip()

        if plain:
            # Migracion: token en texto plano -> DPAPI (si esta disponible).
            if self._store_token(plain, parser, write_plain=False):
                log.info("DeviceToken migrado a almacenamiento protegido (DPAPI).")
            return plain

        if protected:
            try:
                token = unprotect_secret(protected)
            except Exception as exc:
                log.error(
                    "No se pudo descifrar DeviceTokenProtected (%s). Se volvera a enrolar el equipo.",
                    exc,
                )
                return ""
            if token is None:
                log.error("DeviceTokenProtected requiere DPAPI (Windows); se ignora en este sistema.")
                return ""
            return token.strip()
        return ""

    def _store_token(
        self,
        token: str,
        parser: configparser.ConfigParser | None = None,
        write_plain: bool = True,
    ) -> bool:
        """Guarda el token (protegido si hay DPAPI). Devuelve True si quedo protegido."""
        parser = parser if parser is not None else read_config(self.config_path)
        if not parser.has_section("EvidenceBackend"):
            parser.add_section("EvidenceBackend")
        try:
            protected = protect_secret(token)
        except Exception as exc:
            log.warning("DPAPI no pudo proteger el DeviceToken: %s", exc)
            protected = None

        if protected:
            parser.set("EvidenceBackend", "DeviceTokenProtected", protected)
            parser.remove_option("EvidenceBackend", "DeviceToken")
        else:
            log.warning(
                "DPAPI no disponible: el DeviceToken queda en texto plano en %s "
                "(solo aceptable en desarrollo).",
                self.config_path,
            )
            if not write_plain:
                return False
            parser.set("EvidenceBackend", "DeviceToken", token)
            parser.remove_option("EvidenceBackend", "DeviceTokenProtected")
        try:
            write_config_atomic(parser, self.config_path)
        except OSError as exc:
            log.error("No se pudo escribir %s: %s", self.config_path, exc)
            return False
        return bool(protected)

    def save_language(self, language: str):
        clean_language = "en" if str(language or "").lower().startswith("en") else "es"
        parser = read_config(self.config_path)
        if not parser.has_section("Interface"):
            parser.add_section("Interface")
        parser.set("Interface", "Language", clean_language)
        try:
            write_config_atomic(parser, self.config_path)
        except OSError as exc:
            log.error("No se pudo guardar el idioma en %s: %s", self.config_path, exc)
        self.language = clean_language

    def save_device_token(self, token: str):
        clean_token = (token or "").strip()
        if not clean_token:
            return
        parser = read_config(self.config_path)
        if not parser.has_section("EvidenceBackend"):
            parser.add_section("EvidenceBackend")
        parser.set("EvidenceBackend", "Enabled", "true")
        self._store_token(clean_token, parser)
        self.evidence_backend_enabled = True
        self.evidence_device_token = clean_token

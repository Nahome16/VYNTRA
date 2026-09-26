"""
local_auth.py - Verificacion de usuario para VYNTRA.

Antes de mostrar el aviso de privacidad o la estacion de marcaje, VYNTRA pide
correo y contrasena para confirmar quien esta operando el equipo.

IMPORTANTE: el agente de escritorio NO crea ni administra usuarios. Este
modulo solo VERIFICA credenciales contra la API de VYNTRA.

Usuarios de prueba locales: solo existen en modo desarrollo
(VYNTRA_DEV_MODE=1 ejecutando desde codigo fuente; ver agent_runtime.is_dev_mode).
Un ejecutable empaquetado nunca los acepta, ni siquiera con
[StationAuth] AllowLocalFallback = true. Las credenciales de prueba se
documentan fuera del codigo de produccion.

Todas las funciones de este modulo hacen peticiones de red: la interfaz debe
llamarlas desde un hilo de trabajo, no desde el hilo principal de Tk.
"""

import base64
import hashlib
import getpass
import socket

import requests

from agent_runtime import get_logger, is_dev_mode, now_iso

log = get_logger("auth")

_ITERATIONS = 200_000

# Usuarios de pruebas SOLO para desarrollo (ver is_dev_mode). Nunca se consultan
# en un ejecutable empaquetado.
_DEV_TEST_USERS = {
    "test@vyntra.com": {
        "salt": "/lZV/m0SF5D+pksiiPC19Q==",
        "hash": "M187IVtrUnKIdrQbmXr0Os7WGbz8/JGT27S95xFvhnI=",
    },
    "empleado@vyntra.local": {
        "salt": "/lZV/m0SF5D+pksiiPC19Q==",
        "hash": "M187IVtrUnKIdrQbmXr0Os7WGbz8/JGT27S95xFvhnI=",
    },
}


def _comparacion_segura(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    resultado = 0
    for x, y in zip(a, b):
        resultado |= ord(x) ^ ord(y)
    return resultado == 0


def verificar_credenciales(correo: str, password: str) -> bool:
    """Verifica contra los usuarios de prueba locales (solo en modo desarrollo)."""
    if not is_dev_mode():
        return False
    correo = (correo or "").strip().lower()
    user = _DEV_TEST_USERS.get(correo)
    if user is None:
        return False
    try:
        salt = base64.b64decode(user["salt"])
        derivado = hashlib.pbkdf2_hmac(
            "sha256", (password or "").encode("utf-8"), salt, _ITERATIONS
        )
        calculado = base64.b64encode(derivado).decode("ascii")
        return _comparacion_segura(calculado, user["hash"])
    except Exception:
        log.exception("Error verificando usuario de prueba")
        return False


def _local_fallback_allowed(cfg) -> bool:
    return is_dev_mode() and bool(getattr(cfg, "station_auth_allow_local_fallback", False))


def autenticar_credenciales(correo: str, password: str, cfg, agent_version: str = "unknown") -> dict:
    """Autentica contra el backend; usa fallback local solo en desarrollo."""
    correo = (correo or "").strip().lower()
    backend_enabled = bool(getattr(cfg, "evidence_backend_enabled", False))
    base_url = str(getattr(cfg, "evidence_backend_url", "") or "").rstrip("/")
    device_token = str(getattr(cfg, "evidence_device_token", "") or "").strip()
    timeout = int(getattr(cfg, "evidence_request_timeout", 30) or 30)
    allow_local_fallback = _local_fallback_allowed(cfg)

    if backend_enabled and base_url and not device_token:
        try:
            response = requests.post(
                f"{base_url}/api/station/enroll",
                json={
                    "email": correo,
                    "password": password or "",
                    "occurred_at": now_iso(),
                    "agent_version": agent_version,
                    "hostname": socket.gethostname(),
                    "windows_user": getpass.getuser(),
                    "device_name": f"{socket.gethostname()}-{getpass.getuser()}",
                },
                timeout=timeout,
            )
        except requests.RequestException as exc:
            if allow_local_fallback and verificar_credenciales(correo, password):
                return {"ok": True, "source": "local_fallback", "email": correo}
            return {
                "ok": False,
                "source": "backend",
                "reason": "backend_unavailable",
                "message": str(exc)[:220],
            }

        if response.status_code < 400:
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            token = ((payload.get("device") or {}).get("token") or "").strip()
            if token and hasattr(cfg, "save_device_token"):
                cfg.save_device_token(token)
            return {
                "ok": True,
                "source": "backend",
                "email": correo,
                "payload": payload,
                "enrolled": bool(token),
            }
        if allow_local_fallback and response.status_code >= 500 and verificar_credenciales(correo, password):
            return {"ok": True, "source": "local_fallback", "email": correo}
        return {
            "ok": False,
            "source": "backend",
            "reason": "invalid_credentials",
            "status_code": response.status_code,
        }

    if backend_enabled and base_url and device_token:
        try:
            response = requests.post(
                f"{base_url}/api/station/login",
                headers={"X-Device-Token": device_token},
                json={
                    "email": correo,
                    "password": password or "",
                    "occurred_at": now_iso(),
                    "agent_version": agent_version,
                },
                timeout=timeout,
            )
        except requests.RequestException as exc:
            if allow_local_fallback and verificar_credenciales(correo, password):
                return {"ok": True, "source": "local_fallback", "email": correo}
            return {
                "ok": False,
                "source": "backend",
                "reason": "backend_unavailable",
                "message": str(exc)[:220],
            }

        if response.status_code < 400:
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            return {
                "ok": True,
                "source": "backend",
                "email": correo,
                "payload": payload,
            }
        if allow_local_fallback and response.status_code >= 500 and verificar_credenciales(correo, password):
            return {"ok": True, "source": "local_fallback", "email": correo}
        return {
            "ok": False,
            "source": "backend",
            "reason": "invalid_credentials",
            "status_code": response.status_code,
        }

    if is_dev_mode():
        local_ok = verificar_credenciales(correo, password)
        return {
            "ok": local_ok,
            "source": "local",
            "email": correo,
            "reason": "" if local_ok else "invalid_credentials",
        }
    log.error("Inicio de sesion sin backend configurado: no se aceptan credenciales locales.")
    return {
        "ok": False,
        "source": "local",
        "email": correo,
        "reason": "backend_not_configured",
    }


def _backend_request(cfg, path: str, payload: dict) -> dict:
    backend_enabled = bool(getattr(cfg, "evidence_backend_enabled", False))
    base_url = str(getattr(cfg, "evidence_backend_url", "") or "").rstrip("/")
    device_token = str(getattr(cfg, "evidence_device_token", "") or "").strip()
    timeout = int(getattr(cfg, "evidence_request_timeout", 30) or 30)
    if not backend_enabled or not base_url or not device_token:
        return {
            "ok": False,
            "reason": "backend_not_configured",
            "message": "Backend de VYNTRA no configurado.",
        }
    try:
        response = requests.post(
            f"{base_url}{path}",
            headers={"X-Device-Token": device_token},
            json=payload,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        return {"ok": False, "reason": "backend_unavailable", "message": str(exc)[:220]}

    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.status_code >= 400:
        return {
            "ok": False,
            "reason": "request_failed",
            "status_code": response.status_code,
            "message": body.get("detail") or "Solicitud rechazada por VYNTRA.",
        }
    return body if isinstance(body, dict) else {"ok": True}


def cambiar_password(correo: str, actual: str, nueva: str, cfg) -> dict:
    return _backend_request(
        cfg,
        "/api/station/password/change",
        {
            "email": (correo or "").strip().lower(),
            "current_password": actual or "",
            "new_password": nueva or "",
        },
    )


def solicitar_recuperacion_password(correo: str, cfg) -> dict:
    return _backend_request(
        cfg,
        "/api/station/password-reset/request",
        {"email": (correo or "").strip().lower()},
    )


def confirmar_recuperacion_password(correo: str, codigo: str, nueva: str, cfg) -> dict:
    return _backend_request(
        cfg,
        "/api/station/password-reset/confirm",
        {
            "email": (correo or "").strip().lower(),
            "reset_code": (codigo or "").strip(),
            "new_password": nueva or "",
        },
    )

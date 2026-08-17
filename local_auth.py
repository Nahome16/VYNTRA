"""
local_auth.py - Verificacion de usuario para VYNTRA.

Antes de mostrar el aviso de privacidad o la estacion de marcaje, VYNTRA pide
correo y contrasena para confirmar quien esta operando el equipo.

IMPORTANTE: el agente de escritorio NO crea ni administra usuarios. Este
modulo solo VERIFICA credenciales; la creacion de cuentas se hara mas
adelante desde la plataforma web.

Cuando el backend de evidencias esta configurado, la verificacion ocurre en
la API. El usuario local fijo queda solo como fallback de desarrollo cuando
no hay backend configurado o cuando se permite explicitamente en config.ini.

Usuarios de pruebas:
    correo:     test@vyntra.com
    contrasena: Vyntra2026

    correo:     empleado@vyntra.local
    contrasena: Vyntra2026
"""

import base64
import hashlib
import datetime

import requests


_ITERATIONS = 200_000

# Usuarios de pruebas temporales (sin base de datos). Sustituir por la
# verificacion contra la plataforma web cuando ese backend este listo.
_TEST_USERS = {
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
    """Verifica correo y contrasena contra el usuario de pruebas fijo.

    Sin base de datos ni almacenamiento local: es solo un chequeo de
    verificacion mientras no exista la integracion con la plataforma web.
    """
    correo = (correo or "").strip().lower()
    user = _TEST_USERS.get(correo)
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
        return False


def autenticar_credenciales(correo: str, password: str, cfg, agent_version: str = "unknown") -> dict:
    """Autentica contra el backend; usa fallback local solo en desarrollo."""
    correo = (correo or "").strip().lower()
    backend_enabled = bool(getattr(cfg, "evidence_backend_enabled", False))
    base_url = str(getattr(cfg, "evidence_backend_url", "") or "").rstrip("/")
    device_token = str(getattr(cfg, "evidence_device_token", "") or "").strip()
    timeout = int(getattr(cfg, "evidence_request_timeout", 30) or 30)
    allow_local_fallback = bool(getattr(cfg, "station_auth_allow_local_fallback", False))

    if backend_enabled and base_url and device_token:
        try:
            response = requests.post(
                f"{base_url}/api/station/login",
                headers={"X-Device-Token": device_token},
                json={
                    "email": correo,
                    "password": password or "",
                    "occurred_at": datetime.datetime.now().isoformat(),
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
        try:
            detail = str(response.json().get("detail") or "")
        except ValueError:
            detail = ""
        return {
            "ok": False,
            "source": "backend",
            "reason": (
                "activation_required" if response.status_code == 403 and "activada" in detail
                else "invalid_credentials"
            ),
            "status_code": response.status_code,
            "message": detail,
        }

    local_ok = verificar_credenciales(correo, password)
    return {
        "ok": local_ok,
        "source": "local",
        "email": correo,
        "reason": "" if local_ok else "invalid_credentials",
    }


# ==========================================================================
# Autoservicio de credenciales (activacion, cambio y recuperacion)
#
# Estas operaciones SIEMPRE requieren el backend: no existe fallback local
# porque implican escribir la credencial del empleado.
# ==========================================================================

def _backend_config(cfg):
    enabled = bool(getattr(cfg, "evidence_backend_enabled", False))
    base_url = str(getattr(cfg, "evidence_backend_url", "") or "").rstrip("/")
    device_token = str(getattr(cfg, "evidence_device_token", "") or "").strip()
    timeout = int(getattr(cfg, "evidence_request_timeout", 30) or 30)
    ready = enabled and bool(base_url) and bool(device_token)
    return ready, base_url, device_token, timeout


def _post_backend(cfg, path: str, payload: dict) -> dict:
    """POST autenticado con el token del equipo. Devuelve {ok, message, status}."""
    ready, base_url, device_token, timeout = _backend_config(cfg)
    if not ready:
        return {
            "ok": False,
            "reason": "backend_disabled",
            "message": (
                "Esta opcion requiere conexion con el servidor de VYNTRA. "
                "Contacta a tu supervisor."
            ),
        }
    try:
        response = requests.post(
            f"{base_url}{path}",
            headers={"X-Device-Token": device_token},
            json=payload,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        return {
            "ok": False,
            "reason": "backend_unavailable",
            "message": "No se pudo conectar con el servidor. Intenta de nuevo.",
            "detail": str(exc)[:220],
        }
    try:
        data = response.json()
    except ValueError:
        data = {}
    if response.status_code < 400:
        return {"ok": True, "status": response.status_code, **data}
    return {
        "ok": False,
        "status": response.status_code,
        "reason": "rejected",
        # El backend responde en espanol con el motivo exacto (codigo caducado,
        # politica de contrasena, bloqueos). Se muestra tal cual al usuario.
        "message": str(data.get("detail") or "No se pudo completar la operacion."),
    }


def activar_cuenta(correo: str, codigo: str, nueva_contrasena: str, cfg) -> dict:
    """Canjea el codigo recibido por correo y define la contrasena personal."""
    return _post_backend(cfg, "/api/station/activate", {
        "email": (correo or "").strip().lower(),
        "code": (codigo or "").strip(),
        "new_password": nueva_contrasena or "",
    })


def cambiar_contrasena(correo: str, actual: str, nueva: str, cfg) -> dict:
    """Cambia la contrasena verificando la actual."""
    return _post_backend(cfg, "/api/station/password", {
        "email": (correo or "").strip().lower(),
        "current_password": actual or "",
        "new_password": nueva or "",
    })


def solicitar_codigo(correo: str, cfg) -> dict:
    """Pide un codigo de recuperacion; el backend lo envia por correo."""
    return _post_backend(cfg, "/api/station/password/forgot", {
        "email": (correo or "").strip().lower(),
    })

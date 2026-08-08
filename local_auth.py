"""
local_auth.py - Verificacion de usuario para VYNTRA (temporal, sin base de datos).

Antes de mostrar el aviso de privacidad o la estacion de marcaje, VYNTRA pide
correo y contrasena para confirmar quien esta operando el equipo.

IMPORTANTE: el agente de escritorio NO crea ni administra usuarios. Este
modulo solo VERIFICA credenciales; la creacion de cuentas se hara mas
adelante desde la plataforma web (paso siguiente, todavia no implementado).

Mientras esa integracion no exista, para poder probar el flujo de inicio de
sesion sin depender de un backend ni de una base de datos local, se valida
contra un unico usuario de pruebas fijo definido aqui abajo. La contrasena
de prueba tampoco se guarda en texto plano: se compara contra un hash
PBKDF2-HMAC-SHA256 precalculado.

Usuario de pruebas:
    correo:     test@vyntra.com
    contrasena: Vyntra2026
"""

import base64
import hashlib


_ITERATIONS = 200_000

# Usuario de pruebas temporal (sin base de datos). Sustituir por la
# verificacion contra la plataforma web cuando ese backend este listo.
_TEST_USER_EMAIL = "test@vyntra.com"
_TEST_USER_SALT_B64 = "/lZV/m0SF5D+pksiiPC19Q=="
_TEST_USER_HASH_B64 = "M187IVtrUnKIdrQbmXr0Os7WGbz8/JGT27S95xFvhnI="


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
    if correo != _TEST_USER_EMAIL:
        return False
    try:
        salt = base64.b64decode(_TEST_USER_SALT_B64)
        derivado = hashlib.pbkdf2_hmac(
            "sha256", (password or "").encode("utf-8"), salt, _ITERATIONS
        )
        calculado = base64.b64encode(derivado).decode("ascii")
        return _comparacion_segura(calculado, _TEST_USER_HASH_B64)
    except Exception:
        return False

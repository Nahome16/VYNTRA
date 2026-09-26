"""
Generate a PBKDF2-SHA256 password hash for VYNTRA production bootstrap users.

La contrasena se lee siempre de forma interactiva (getpass) para que no quede en
el historial de la shell ni en la lista de procesos.
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import os
import sys

# Debe coincidir con app.auth.PBKDF2_ITERATIONS.
ITERATIONS = 600_000


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)
    return "pbkdf2_sha256:{}:{}:{}".format(
        ITERATIONS,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def main() -> int:
    if len(sys.argv) > 1:
        print(
            "No pases la contrasena como argumento; se pedira de forma interactiva.",
            file=sys.stderr,
        )
        return 2
    password = getpass.getpass("Password: ")
    if not password:
        print("Password is required.", file=sys.stderr)
        return 1
    confirmation = getpass.getpass("Repeat password: ")
    if confirmation != password:
        print("Passwords do not match.", file=sys.stderr)
        return 1
    print(hash_password(password))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

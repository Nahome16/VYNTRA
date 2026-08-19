"""
Generate a PBKDF2-SHA256 password hash for VYNTRA production bootstrap users.
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import os
import sys


def hash_password(password: str) -> str:
    iterations = 200_000
    salt = os.urandom(18)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "pbkdf2_sha256:{}:{}:{}".format(
        iterations,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def main() -> int:
    password = sys.argv[1] if len(sys.argv) > 1 else getpass.getpass("Password: ")
    if not password:
        print("Password is required.", file=sys.stderr)
        return 1
    print(hash_password(password))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

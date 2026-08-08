"""
Generate a strong device token for VYNTRA agents.
"""

import secrets


if __name__ == "__main__":
    print(secrets.token_urlsafe(48))

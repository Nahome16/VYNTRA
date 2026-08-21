"""
windows_setup_bootstrap.py - Small Windows installer launcher for VYNTRA.

PyInstaller embeds ``payload.zip`` next to this script. At runtime the launcher
extracts it into a temporary folder and runs the visual PowerShell installer.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import zipfile
from tkinter import Tk, messagebox


def resource_path(name: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, name)


def show_error(message: str):
    root = Tk()
    root.withdraw()
    messagebox.showerror("VYNTRA Agent - Instalador", message)
    root.destroy()


def main() -> int:
    payload = resource_path("payload.zip")
    if not os.path.exists(payload):
        show_error("No se encontro el paquete interno de instalacion.")
        return 1

    target = tempfile.mkdtemp(prefix="VYNTRAAgentInstall-")
    try:
        with zipfile.ZipFile(payload, "r") as archive:
            archive.extractall(target)

        installer = os.path.join(target, "Instalar VYNTRA.ps1")
        if not os.path.exists(installer):
            show_error("El paquete interno no contiene el instalador de VYNTRA.")
            return 1

        completed = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                installer,
            ],
            cwd=target,
            check=False,
        )
        return int(completed.returncode or 0)
    except Exception as exc:
        show_error(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

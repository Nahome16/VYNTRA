# -*- mode: python ; coding: utf-8 -*-
#
# El ejecutable NO incluye config.ini: el config.ini del desarrollador podria
# contener un DeviceToken o una URL de pruebas. La configuracion de produccion
# se genera por empresa con installer\prepare_agent_package.ps1 (a partir de
# installer\config.production.template.ini) y se copia junto a VYNTRAAgent.exe.

from PyInstaller.utils.hooks import collect_data_files

datas = collect_data_files("customtkinter")

block_cipher = None

a = Analysis(
    ["agent.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[
        "win32gui",
        "win32ui",
        "win32process",
        "win32crypt",
        "psutil",
        "pynput",
        "pynput.mouse",
        "requests",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="VYNTRAAgent",
    debug=False,
    strip=False,
    upx=False,
    console=False,
    icon="assets/vyntra.ico",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="VYNTRAAgent",
)

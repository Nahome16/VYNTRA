# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_data_files

datas = collect_data_files("customtkinter") + [
    ("config.ini", "."),
]

block_cipher = None

a = Analysis(
    ["agent.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[
        "win32gui",
        "win32process",
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

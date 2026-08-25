# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_data_files

datas = collect_data_files("customtkinter") + [
    ("config.ini", "."),
]

a = Analysis(
    ["agent.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[
        "pynput",
        "pynput.mouse",
        "requests",
        "mss",
        "PIL",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

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
    target_arch=None,
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

app = BUNDLE(
    coll,
    name="VYNTRAAgent.app",
    icon=None,
    bundle_identifier="com.vyntralab.agent",
    info_plist={
        "CFBundleName": "VYNTRA Agent",
        "CFBundleDisplayName": "VYNTRA Agent",
        "NSHumanReadableCopyright": "Copyright VYNTRA",
        "NSCameraUsageDescription": "VYNTRA does not use the camera.",
        "NSMicrophoneUsageDescription": "VYNTRA does not use the microphone.",
        "NSAppleEventsUsageDescription": "VYNTRA may request permission to read the active application name for work activity records.",
    },
)

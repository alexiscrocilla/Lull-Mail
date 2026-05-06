# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for LullMail.exe.

  pyinstaller lull_mail.spec --noconfirm --clean

Produces dist/LullMail/ (onedir layout — faster startup, easier
debugging than onefile, and lets users see/edit data/ next to the exe).

The frontend assets are bundled inside the exe directory; api.py looks
them up via _MEIPASS at runtime.
"""

from PyInstaller.utils.hooks import collect_submodules, collect_data_files

block_cipher = None

datas = []
datas += [("frontend", "frontend")]
datas += collect_data_files("webview")           # bundled JS/HTML used by pywebview
datas += collect_data_files("apscheduler")

hiddenimports = []
hiddenimports += collect_submodules("apscheduler")
hiddenimports += collect_submodules("webview")
hiddenimports += [
    "pystray._win32",
    "PIL._tkinter_finder",
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
]

a = Analysis(
    ["app_gui.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy", "pandas", "pytest"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# Optional .ico — drop one at assets/lull_mail.ico to brand the exe.
# PyInstaller raises FileNotFoundError if `icon=` points to a missing file,
# so we omit the kwarg entirely when the file isn't there.
import os as _os
_icon_candidate = _os.path.join("assets", "lull_mail.ico")
exe_extra = {"icon": _icon_candidate} if _os.path.isfile(_icon_candidate) else {}

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="LullMail",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,            # no terminal window — this is a real GUI app
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    **exe_extra,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="LullMail",
)

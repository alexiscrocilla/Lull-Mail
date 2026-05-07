# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for Lull Mail.

  pyinstaller lull_mail.spec --noconfirm --clean

Produces dist/LullMail/ (onedir layout — faster startup, easier
debugging than onefile, and lets users see/edit data/ next to the exe).

The frontend assets are bundled inside the exe directory; api.py looks
them up via _MEIPASS at runtime.

Supports Windows, macOS, and Linux. On macOS a .app bundle (dist/LullMail.app)
is produced in addition to the onedir tree, ready to be wrapped in a .dmg.
"""

import os as _os
import sys as _sys

from PyInstaller.utils.hooks import collect_submodules, collect_data_files

block_cipher = None

datas = []
datas += [("frontend", "frontend")]
datas += collect_data_files("webview")           # bundled JS/HTML used by pywebview
datas += collect_data_files("apscheduler")

hiddenimports = []
hiddenimports += collect_submodules("apscheduler")
hiddenimports += collect_submodules("webview")
# `keyring` discovers its OS backends at runtime (Windows Vault, macOS
# Keychain, Linux Secret Service…). PyInstaller's static analysis
# misses them, so we collect every submodule explicitly. Without this
# the frozen build would fall back to `keyring.backends.fail` on every
# machine — and our credential migration would silently no-op.
hiddenimports += collect_submodules("keyring")
# `pystray` discovers its OS backend at runtime too. Include the right one
# per platform so it isn't missed by static analysis.
_pystray_backends: dict = {
    "win32":  ["pystray._win32"],
    "darwin": ["pystray._darwin"],
}
hiddenimports += _pystray_backends.get(_sys.platform, ["pystray._xorg"])
hiddenimports += [
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

# ── Icon — platform-specific ──────────────────────────────────────────────────
# PyInstaller raises FileNotFoundError if `icon=` points to a missing file,
# so we probe each candidate and skip the kwarg when none is found.
_icon_candidates = {
    "win32":  _os.path.join("assets", "lull_mail.ico"),
    "darwin": _os.path.join("assets", "lull_mail.icns"),
}
_icon_path = _icon_candidates.get(_sys.platform, "")
exe_extra = {"icon": _icon_path} if _icon_path and _os.path.isfile(_icon_path) else {}

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

# ── macOS .app bundle ─────────────────────────────────────────────────────────
# BUNDLE is macOS-only; PyInstaller ignores it on other platforms, but we
# guard explicitly so the intent is clear and to avoid any future surprises.
if _sys.platform == "darwin":
    _icns = _os.path.join("assets", "lull_mail.icns")
    _bundle_extra = {"icon": _icns} if _os.path.isfile(_icns) else {}
    app = BUNDLE(
        coll,
        name="LullMail.app",
        bundle_identifier="fr.lullmail.app",
        **_bundle_extra,
    )

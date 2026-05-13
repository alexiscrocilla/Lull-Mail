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
import re as _re
import sys as _sys

from PyInstaller.utils.hooks import collect_submodules, collect_data_files

block_cipher = None


def _app_bundle_version() -> str:
    """Match scripts/build.sh: env override, else src/_version.py, else fallback."""
    ver = _os.environ.get("LULLMAIL_VERSION", "").strip()
    if not ver:
        vfile = _os.path.join(_os.path.dirname(_os.path.abspath(SPEC)), "src", "_version.py")
        if _os.path.isfile(vfile):
            with open(vfile, encoding="utf-8") as _vf:
                _m = _re.search(r'__version__\s*=\s*["\']([^"\']+)["\']', _vf.read())
            if _m:
                ver = _m.group(1)
    if not ver:
        ver = "0.0.0"
    # CFBundleShortVersionString should be a numeric major.minor.patch (no prerelease tag).
    return ver.split("-")[0].split("+")[0] or "0.0.0"

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
    "src._version",
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

# Local LLM backend. Bundle it when `llama_cpp` is importable in the build
# environment. The `hooks/hook-llama_cpp.py` script handles binaries + data
# files (native libllama + Metal shaders) via `collect_dynamic_libs` and
# `collect_data_files`.
#
# Post-v0.7.0 note: the v0.7.0 installer shipped without llama_cpp because
# the build venv (CI + scripts/build.bat) only installed `requirements.txt`,
# not `requirements-local.txt`. The try/import silently skipped, the app
# installed fine, then crashed at runtime on the first call to Local mode.
# To prevent a repeat, the skip is now LOUD: a warning is always printed,
# and LULLMAIL_REQUIRE_LOCAL=1 (set by CI and the build scripts) turns the
# skip into a hard build failure.
try:
    import llama_cpp  # noqa: F401
    _local_llm_available = True
except ImportError:
    _local_llm_available = False

if not _local_llm_available:
    _msg = (
        "\n"
        "════════════════════════════════════════════════════════════════════\n"
        " WARNING: llama-cpp-python is NOT installed in the build venv.\n"
        " The resulting bundle will SKIP the local LLM backend, and the app\n"
        " will crash with ModuleNotFoundError on Local mode at runtime.\n"
        "\n"
        " Fix:  pip install -r requirements-local.txt \\\n"
        "         --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu\n"
        "════════════════════════════════════════════════════════════════════\n"
    )
    print(_msg, file=_sys.stderr)
    # CI and build scripts set LULLMAIL_REQUIRE_LOCAL=1 so a forgotten pip
    # step fails the build instead of producing a broken installer.
    if _os.environ.get("LULLMAIL_REQUIRE_LOCAL", "").strip() == "1":
        raise SystemExit(
            "LULLMAIL_REQUIRE_LOCAL=1 and llama_cpp not importable, aborting build."
        )

_hookspath: list[str] = []
if _local_llm_available:
    _hookspath.append(_os.path.join(_os.path.dirname(_os.path.abspath(SPEC)), "hooks"))

a = Analysis(
    ["app_gui.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=_hookspath,
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
    _ver = _app_bundle_version()
    app = BUNDLE(
        coll,
        name="LullMail.app",
        bundle_identifier="fr.lullmail.app",
        info_plist={
            "CFBundleShortVersionString": _ver,
            "CFBundleVersion": _ver,
        },
        **_bundle_extra,
    )

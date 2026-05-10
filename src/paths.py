# SPDX-License-Identifier: GPL-3.0-or-later
"""
Centralised path resolution for Lull Mail.

Three modes:

  • Frozen (PyInstaller bundle) — config + DB + logs + attachments live in
    the per-user data directory for the host OS:
      Windows : %APPDATA%\\LullMail\\
      macOS   : ~/Library/Application Support/LullMail/
      Linux   : ~/.local/share/LullMail/  (or $XDG_DATA_HOME/LullMail/)
    The executable and bundled files stay read-only in dist/LullMail/.

  • Dev (python main.py / python app_gui.py) — same layout, but anchored
    at the project root so existing developers keep their working
    config.yaml and data/ directory in place.

  • Override — set the env var LULLMAIL_DATA to force a specific dir.
    Useful for tests and for users who want their config on a USB stick.

Two migrations may run at import time so the rest of the codebase only
ever sees the canonical data layout:

  1. (Windows only) Rename %APPDATA%\\AgenticMail → %APPDATA%\\LullMail
     when the app was previously installed under the old name. Keeps
     existing accounts, mail history, attachments, and rules.

  2. The first time a frozen build runs and finds no config in the data
     dir, look for a legacy config.yaml + data/ next to the exe (or one
     level up, to handle the dist/LullMail/ case). If found, copy them
     so the user keeps their setup.

Migration #2 is skipped when:
  • the candidate dir looks like a dev source tree (contains src/paths.py,
    lull_mail.spec, .git, etc.) — protects test runs of dist/LullMail/
    from inheriting the developer's working config.yaml
  • LULLMAIL_NO_MIGRATE is set — explicit escape hatch for onboarding tests
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
from pathlib import Path

logger = logging.getLogger(__name__)


def _appdata_root() -> Path:
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(appdata)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    # Linux / freedesktop XDG Base Directory spec
    xdg = os.environ.get("XDG_DATA_HOME")
    return Path(xdg) if xdg else Path.home() / ".local" / "share"


def _rename_legacy_appdata_dir() -> None:
    """Rename %APPDATA%\\AgenticMail → %APPDATA%\\LullMail when the new
    name doesn't yet exist. Done as the very first step on frozen builds
    so all subsequent paths land in the new dir without breaking
    existing installs.

    Safe properties:
      • only renames when the destination doesn't exist (never clobbers
        a fresh LullMail install with a stale AgenticMail one)
      • atomic on the same filesystem (Path.rename → os.rename)
      • silent no-op when neither dir exists, when only the new dir
        exists, or when the rename fails (we log and let the resolver
        fall back to creating the new dir empty — onboarding handles it)
    """
    root = _appdata_root()
    legacy = root / "AgenticMail"
    target = root / "LullMail"
    if target.exists() or not legacy.exists():
        return
    try:
        legacy.rename(target)
        logger.info("Migration : %s renommé en %s", legacy, target)
    except OSError as e:
        # On Windows, a residual file handle from a still-running process
        # would block the rename. Worst case we log and return — the
        # resolver will create LullMail/ empty and the next launch (after
        # the lock releases) will retry.
        logger.warning(
            "Migration %s → %s impossible (%s). Réessai au prochain démarrage.",
            legacy, target, e,
        )


def _resolve_app_data_dir() -> Path:
    override = os.environ.get("LULLMAIL_DATA")
    if override:
        return Path(override).expanduser().resolve()

    if getattr(sys, "frozen", False):
        # Migrate the old name first so the path we return is the new one
        # even on the very first launch under Lull Mail branding.
        _rename_legacy_appdata_dir()
        return _appdata_root() / "LullMail"

    # Dev: project root (where main.py/app_gui.py lives).
    return Path.cwd().resolve()


APP_DATA_DIR: Path = _resolve_app_data_dir()
DATA_DIR: Path = APP_DATA_DIR / "data"
CONFIG_PATH: Path = APP_DATA_DIR / "config.yaml"
DB_PATH: Path = DATA_DIR / "mail.db"
LOG_PATH: Path = DATA_DIR / "lull_mail.log"
ATTACHMENTS_DIR: Path = DATA_DIR / "attachments"
# Phase 4 — staging area for files the user attaches to outbound mail
# BEFORE the SMTP send actually fires. Distinct from ATTACHMENTS_DIR
# (which holds inbound IMAP attachments) so the two never share path
# resolution / threat-scan logic. Files here are short-lived: created
# on POST /api/uploads, consumed by send_message, then removed.
OUTBOX_ATTACHMENTS_DIR: Path = DATA_DIR / "outbox-attachments"


def ensure_dirs() -> None:
    """Create the data tree on disk. Idempotent — safe to call from anywhere."""
    APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ATTACHMENTS_DIR.mkdir(parents=True, exist_ok=True)
    OUTBOX_ATTACHMENTS_DIR.mkdir(parents=True, exist_ok=True)


def _candidate_legacy_dirs() -> list[Path]:
    """Where to look for a pre-existing config.yaml when the new install
    has none yet. Order matters — first hit wins."""
    candidates: list[Path] = []
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        candidates += [
            exe_dir,
            exe_dir.parent,             # dist\LullMail\.. — typical layout
            exe_dir.parent.parent,      # one more up, in case user moved things
        ]
    candidates.append(Path.cwd().resolve())
    # De-dup while preserving order.
    seen: set[Path] = set()
    out: list[Path] = []
    for c in candidates:
        try:
            r = c.resolve()
        except OSError:
            continue
        if r not in seen and r != APP_DATA_DIR:
            seen.add(r)
            out.append(r)
    return out


# Markers that prove a directory is the dev source tree (not a packaged
# install). Any one of these means: don't migrate from here, otherwise
# `pyinstaller` builds run from `dist\LullMail\` would silently copy
# the developer's working config.yaml into %APPDATA%, defeating any
# attempt to test the onboarding wizard.
_DEV_TREE_MARKERS = ("src/paths.py", "lull_mail.spec", ".git", "app_gui.py")


def _is_dev_source_tree(path: Path) -> bool:
    return any((path / marker).exists() for marker in _DEV_TREE_MARKERS)


def migrate_legacy_install() -> bool:
    """If %APPDATA% is empty but a legacy config.yaml exists nearby, copy
    it (plus data/) into APP_DATA_DIR. Returns True when a migration ran.

    Done at startup before anything reads the config so the rest of the
    code only ever sees the canonical %APPDATA% layout.
    """
    ensure_dirs()
    if CONFIG_PATH.exists():
        return False

    # Escape hatch for testing the onboarding flow on a build that sits
    # next to a real config.yaml.
    if os.environ.get("LULLMAIL_NO_MIGRATE"):
        return False

    for src_dir in _candidate_legacy_dirs():
        legacy_cfg = src_dir / "config.yaml"
        if not legacy_cfg.is_file():
            continue
        if _is_dev_source_tree(src_dir):
            logger.info(
                "Migration ignorée : %s ressemble à un arbre source de dev "
                "(présence de %s)", src_dir,
                ", ".join(m for m in _DEV_TREE_MARKERS if (src_dir / m).exists()),
            )
            continue
        try:
            shutil.copy2(legacy_cfg, CONFIG_PATH)
        except OSError as e:
            logger.warning("Migration config.yaml depuis %s a échoué: %s", src_dir, e)
            continue

        legacy_data = src_dir / "data"
        if legacy_data.is_dir():
            for item in legacy_data.iterdir():
                dest = DATA_DIR / item.name
                try:
                    if item.is_dir():
                        if not dest.exists():
                            shutil.copytree(item, dest)
                    else:
                        if not dest.exists():
                            shutil.copy2(item, dest)
                except OSError as e:
                    logger.warning("Migration de %s a échoué: %s", item, e)

        logger.info("Configuration existante migrée depuis %s vers %s",
                    src_dir, APP_DATA_DIR)
        return True

    return False

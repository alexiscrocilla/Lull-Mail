"""
Auto-update checker for Lull Mail.

Polls the GitHub Releases API (at most once every 6 hours) to compare the
running version against the latest published release. Results are cached
in memory so repeated calls from the frontend are cheap.

Public surface:
    check_for_update() -> dict   — call from the /api/update/check endpoint
    download_and_install() -> None — call from /api/update/install (background task)
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from typing import Optional

logger = logging.getLogger(__name__)

GITHUB_REPO = "alexiscrocilla/Lull-Mail"
_CACHE_TTL_SECONDS = 6 * 3600  # 6 hours

_lock = threading.Lock()
_cached_result: Optional[dict] = None
_cached_at: float = 0.0


# ── Version helpers ────────────────────────────────────────────────────────────

def get_current_version() -> str:
    """Return the version baked in at build time, or '0.0.0' in dev."""
    try:
        from src._version import __version__
        return __version__
    except ImportError:
        return "0.0.0"


def _parse_semver(v: str) -> tuple[int, ...]:
    """Parse 'X.Y.Z' (or 'vX.Y.Z') into an integer tuple for comparison."""
    clean = v.lstrip("v").split("-")[0]  # strip leading 'v' and pre-release suffix
    parts = clean.split(".")
    result = []
    for p in parts[:3]:
        try:
            result.append(int(p))
        except ValueError:
            result.append(0)
    while len(result) < 3:
        result.append(0)
    return tuple(result)


def _is_newer(latest: str, current: str) -> bool:
    return _parse_semver(latest) > _parse_semver(current)


# ── GitHub API ─────────────────────────────────────────────────────────────────

def _fetch_latest_release() -> Optional[dict]:
    """Hit the GitHub Releases API and return the parsed JSON, or None on error."""
    import json

    url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
    current = get_current_version()
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": f"LullMail/{current}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode())
    except Exception as exc:
        logger.debug("Update check failed (network): %s", exc)
        return None


def _extract_installer_url(release: dict) -> Optional[str]:
    """Return the browser_download_url of the first .exe asset, or None."""
    for asset in release.get("assets", []):
        name: str = asset.get("name", "")
        if name.lower().endswith(".exe"):
            return asset.get("browser_download_url")
    return None


# ── Public API ─────────────────────────────────────────────────────────────────

def check_for_update() -> dict:
    """Return update status, using the in-memory cache when fresh.

    Always returns a dict with keys:
        available       bool
        current_version str
        latest_version  str | None
        download_url    str | None
        error           str | None   (set on network failure)
    """
    global _cached_result, _cached_at

    current = get_current_version()

    with _lock:
        if _cached_result is not None and (time.time() - _cached_at) < _CACHE_TTL_SECONDS:
            return _cached_result

        release = _fetch_latest_release()
        if release is None:
            result = {
                "available": False,
                "current_version": current,
                "latest_version": None,
                "download_url": None,
                "error": "Impossible de contacter GitHub.",
            }
            _cached_result = result
            _cached_at = time.time()
            return result

        latest_tag: str = release.get("tag_name", "")
        latest_version = latest_tag.lstrip("v")
        download_url = _extract_installer_url(release)
        available = bool(download_url) and _is_newer(latest_version, current)

        result = {
            "available": available,
            "current_version": current,
            "latest_version": latest_version or None,
            "download_url": download_url if available else None,
            "error": None,
        }
        _cached_result = result
        _cached_at = time.time()
        return result


def invalidate_cache() -> None:
    """Force the next call to check_for_update() to re-fetch from GitHub."""
    global _cached_result, _cached_at
    with _lock:
        _cached_result = None
        _cached_at = 0.0


# ── Download & install ─────────────────────────────────────────────────────────

def download_and_install() -> None:
    """Download the latest installer to %TEMP% and launch it silently.

    Intended to be called as a FastAPI BackgroundTask so the HTTP response
    is returned to the frontend before the process exits.

    Flow:
        1. Fetch current update info (uses cache if fresh).
        2. Download the .exe to a temp directory.
        3. Launch the installer with /SILENT (Inno Setup silent mode).
        4. Exit the current process — Inno Setup will close and replace it.
    """
    info = check_for_update()
    url = info.get("download_url")
    if not url:
        logger.error("download_and_install: no download URL available")
        return

    version = info.get("latest_version", "update")
    tmp_dir = os.path.join(tempfile.gettempdir(), "LullMail-Update")
    os.makedirs(tmp_dir, exist_ok=True)
    dest = os.path.join(tmp_dir, f"LullMail-Setup-{version}.exe")

    logger.info("Téléchargement mise à jour %s → %s", version, dest)
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": f"LullMail/{get_current_version()}"},
        )
        with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as f:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                f.write(chunk)
    except Exception as exc:
        logger.error("Échec téléchargement mise à jour: %s", exc)
        return

    logger.info("Installation silencieuse: %s /SILENT", dest)
    try:
        # /SILENT = progress window, no questions.
        # Inno Setup's CloseApplications=yes will handle closing the current
        # process; we also exit proactively so file handles are released.
        subprocess.Popen([dest, "/SILENT"], close_fds=True)
    except Exception as exc:
        logger.error("Échec lancement installeur: %s", exc)
        return

    # Give the frontend a moment to receive the HTTP 200 before we exit.
    time.sleep(1)
    logger.info("Fermeture de l'app pour laisser l'installeur prendre la main.")
    os._exit(0)

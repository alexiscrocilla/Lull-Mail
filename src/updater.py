# SPDX-License-Identifier: GPL-3.0-or-later
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

# Named mutex the installer (Inno Setup) checks via AppMutex to detect a
# running instance.  MUST match the ISS value exactly.
_APP_MUTEX_NAME = "Global\\LullMail-{5933D412-CD2C-42ED-BCB4-9809CF1683F2}"

_lock = threading.Lock()
_cached_result: Optional[dict] = None
_cached_at: float = 0.0

# ── Platform helpers ───────────────────────────────────────────────────────────

_SHUTDOWN_REQUESTED = threading.Event()


def _get_platform_extension() -> str:
    if sys.platform == "win32":
        return ".exe"
    elif sys.platform == "darwin":
        return ".dmg"
    return ".AppImage"


def _release_app_mutex() -> None:
    """Close the AppMutex handle so the installer can proceed immediately."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        h = ctypes.windll.kernel32.OpenMutexW(0x0001, False, _APP_MUTEX_NAME)
        if h:
            ctypes.windll.kernel32.ReleaseMutex(h)
            ctypes.windll.kernel32.CloseHandle(h)
    except Exception:
        pass


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
    clean = v.lstrip("v").split("-")[0]
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
    """Return the download URL of the first asset matching this platform."""
    ext = _get_platform_extension()
    for asset in release.get("assets", []):
        name: str = asset.get("name", "")
        if name.lower().endswith(ext):
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
        # Only show as available when there is a matching installer for THIS
        # platform — avoids downloading a .exe on macOS or a .dmg on Windows.
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


# ── Download helpers ───────────────────────────────────────────────────────────

def _download_installer(url: str, version: str) -> Optional[str]:
    """Download the installer asset to a temp directory; return its path."""
    ext = _get_platform_extension()
    tmp_dir = os.path.join(tempfile.gettempdir(), "LullMail-Update")
    os.makedirs(tmp_dir, exist_ok=True)
    dest = os.path.join(tmp_dir, f"LullMail-Setup-{version}{ext}")

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
        return dest
    except Exception as exc:
        logger.error("Échec téléchargement mise à jour: %s", exc)
        return None


# ── Platform installers ────────────────────────────────────────────────────────

def _install_windows(dest: str) -> None:
    """Launch Inno Setup installer silently, release mutex, close window, exit."""
    logger.info("Installation silencieuse: %s /SILENT", dest)
    try:
        subprocess.Popen([dest, "/SILENT"], close_fds=True)
    except Exception as exc:
        logger.error("Échec lancement installeur: %s", exc)
        return

    # Give the installer time to initialise and the frontend time to
    # receive the HTTP 200 response before we tear down the process.
    time.sleep(4)
    _release_app_mutex()
    logger.info("Fermeture de l'app — l'installeur prend la main.")

    # Close the webview window from the background thread so the
    # main loop's `finally:` block runs cleanup (server stop, etc.)
    try:
        import webview
        for w in list(webview.windows):
            try:
                w.destroy()
            except Exception:
                pass
    except Exception:
        pass

    os._exit(0)


def _install_macos(dest: str) -> None:
    """Open the .dmg (user drags the .app manually) then exit."""
    logger.info("Ouverture du .dmg : %s", dest)
    try:
        subprocess.Popen(["open", dest], close_fds=True)
    except Exception as exc:
        logger.error("Échec ouverture .dmg: %s", exc)
        return

    time.sleep(3)
    os._exit(0)


def _install_linux(dest: str) -> None:
    """Make .AppImage executable and launch it."""
    logger.info("Lancement AppImage : %s", dest)
    try:
        os.chmod(dest, 0o755)
        subprocess.Popen([dest], close_fds=True)
    except Exception as exc:
        logger.error("Échec lancement AppImage: %s", exc)
        return

    time.sleep(3)
    os._exit(0)


def download_and_install() -> None:
    """Download the platform installer, launch it, then exit the process.

    Called as a FastAPI BackgroundTask so the HTTP response is returned
    to the frontend before the process shuts down.
    """
    info = check_for_update()
    url = info.get("download_url")
    if not url:
        logger.error("download_and_install: no download URL available")
        return

    version = info.get("latest_version", "update")
    dest = _download_installer(url, version)
    if not dest:
        return

    if sys.platform == "win32":
        _install_windows(dest)
    elif sys.platform == "darwin":
        _install_macos(dest)
    else:
        _install_linux(dest)

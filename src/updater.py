# SPDX-License-Identifier: GPL-3.0-or-later
"""Fail-closed, Ed25519-verified updater for LullMail releases."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import platform
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from src import paths
from src.update_keys import trusted_update_keys

logger = logging.getLogger(__name__)

GITHUB_REPO = "alexiscrocilla/Lull-Mail"
_CACHE_TTL_SECONDS = 6 * 3600
_MAX_MANIFEST_BYTES = 1024 * 1024
_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
_ALLOWED_DOWNLOAD_HOSTS = {
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
}
_STATE_PATH = paths.APP_DATA_DIR / "update-state.json"

_lock = threading.Lock()
_cached_result: Optional[dict] = None
_cached_at = 0.0
_shutdown_requested = threading.Event()
_last_verification: Dict[str, Any] = {
    "status": "never",
    "checked_at": None,
    "version": None,
    "key_id": None,
    "error": None,
}


class UpdateVerificationError(RuntimeError):
    """The update metadata or artifact failed a security check."""


def get_current_version() -> str:
    try:
        from src._version import __version__

        return __version__
    except ImportError:
        return "0.0.0"


def _parse_semver(value: str) -> tuple[int, int, int, tuple[str, ...]]:
    clean = str(value or "").strip().lstrip("v")
    main, _, suffix = clean.partition("-")
    parts = main.split(".")
    numbers: list[int] = []
    for part in parts[:3]:
        match = re.match(r"(\d+)", part)
        numbers.append(int(match.group(1)) if match else 0)
    while len(numbers) < 3:
        numbers.append(0)
    prerelease = tuple(suffix.split(".")) if suffix else ()
    return numbers[0], numbers[1], numbers[2], prerelease


def _version_core(value: str) -> tuple[int, int, int]:
    parsed = _parse_semver(value)
    return parsed[0], parsed[1], parsed[2]


def _is_newer(latest: str, current: str) -> bool:
    latest_parsed = _parse_semver(latest)
    current_parsed = _parse_semver(current)
    if latest_parsed[:3] != current_parsed[:3]:
        return latest_parsed[:3] > current_parsed[:3]
    if not latest_parsed[3] and current_parsed[3]:
        return True
    if latest_parsed[3] and not current_parsed[3]:
        return False
    return latest_parsed[3] > current_parsed[3]


def _normalise_arch(value: str) -> str:
    arch = str(value or "").strip().lower()
    if arch in {"amd64", "x64", "x86_64"}:
        return "x86_64"
    if arch in {"arm64", "aarch64"}:
        return "arm64"
    return arch or "unknown"


def _platform_key() -> str:
    if sys.platform == "win32":
        system = "windows"
    elif sys.platform == "darwin":
        system = "macos"
    else:
        system = "linux"
    return f"{system}-{_normalise_arch(platform.machine())}"


def _set_verification(status: str, *, version: Optional[str] = None,
                      key_id: Optional[str] = None, error: Optional[str] = None) -> None:
    global _last_verification
    _last_verification = {
        "status": status,
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "version": version,
        "key_id": key_id,
        "error": error,
    }


def get_verification_status() -> Dict[str, Any]:
    return dict(_last_verification)


def _is_allowed_download_url(url: str, *, require_release_path: bool = False) -> bool:
    parsed = urlparse(str(url or ""))
    if parsed.scheme != "https" or (parsed.hostname or "").lower() not in _ALLOWED_DOWNLOAD_HOSTS:
        return False
    if require_release_path:
        expected = f"/{GITHUB_REPO}/releases/download/"
        return parsed.hostname == "github.com" and parsed.path.startswith(expected)
    return True


def _read_url(url: str, *, max_bytes: int, timeout: int) -> bytes:
    if not _is_allowed_download_url(url):
        raise UpdateVerificationError("Update URL is not an approved HTTPS release URL")
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json, application/json",
            "User-Agent": f"LullMail/{get_current_version()}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        final_url = response.geturl()
        if not _is_allowed_download_url(final_url):
            raise UpdateVerificationError("Update redirect left the approved GitHub hosts")
        declared = response.headers.get("Content-Length")
        if declared and int(declared) > max_bytes:
            raise UpdateVerificationError("Update metadata exceeds the size limit")
        payload = response.read(max_bytes + 1)
    if len(payload) > max_bytes:
        raise UpdateVerificationError("Update metadata exceeds the size limit")
    return payload


def _fetch_latest_release() -> Optional[dict]:
    url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": f"LullMail/{get_current_version()}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read(_MAX_MANIFEST_BYTES).decode("utf-8"))
    except Exception as exc:
        logger.debug("Update release lookup failed: %s", exc)
        return None


def _fetch_signed_manifest(tag: str) -> tuple[bytes, bytes]:
    safe_tag = str(tag or "").strip()
    if not re.fullmatch(r"v?[0-9A-Za-z][0-9A-Za-z._+-]{0,63}", safe_tag):
        raise UpdateVerificationError("Release tag has an invalid format")
    base = f"https://github.com/{GITHUB_REPO}/releases/download/{safe_tag}"
    manifest = _read_url(f"{base}/updates-v1.json", max_bytes=_MAX_MANIFEST_BYTES, timeout=10)
    signature = _read_url(f"{base}/updates-v1.json.sig", max_bytes=16 * 1024, timeout=10)
    return manifest, signature


def verify_manifest_bytes(manifest_bytes: bytes, signature_bytes: bytes,
                          keys: Optional[Dict[str, bytes]] = None) -> dict:
    try:
        signature_doc = json.loads(signature_bytes.decode("utf-8"))
    except Exception as exc:
        raise UpdateVerificationError("Update signature document is invalid JSON") from exc
    if signature_doc.get("schema") != 1 or signature_doc.get("algorithm") != "ed25519":
        raise UpdateVerificationError("Unsupported update signature schema")
    key_id = str(signature_doc.get("key_id") or "")
    available = keys if keys is not None else trusted_update_keys()
    public_bytes = available.get(key_id)
    if public_bytes is None:
        raise UpdateVerificationError(f"Update signing key is not trusted: {key_id or '<missing>'}")
    try:
        signature = base64.b64decode(signature_doc.get("signature") or "", validate=True)
        Ed25519PublicKey.from_public_bytes(public_bytes).verify(signature, manifest_bytes)
    except (ValueError, InvalidSignature) as exc:
        raise UpdateVerificationError("Update manifest signature is invalid") from exc

    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except Exception as exc:
        raise UpdateVerificationError("Signed update manifest is invalid JSON") from exc
    if manifest.get("schema") != 1:
        raise UpdateVerificationError("Unsupported update manifest schema")
    if not isinstance(manifest.get("version"), str) or not manifest["version"].strip():
        raise UpdateVerificationError("Update manifest has no version")
    if not isinstance(manifest.get("artifacts"), dict) or not manifest["artifacts"]:
        raise UpdateVerificationError("Update manifest has no artifacts")
    manifest["_verified_key_id"] = key_id
    return manifest


def _validate_artifact(raw: Any) -> dict:
    if not isinstance(raw, dict):
        raise UpdateVerificationError("Update artifact metadata is missing")
    name = str(raw.get("name") or "")
    url = str(raw.get("url") or "")
    sha256 = str(raw.get("sha256") or "").lower()
    install = str(raw.get("install") or "")
    try:
        size = int(raw.get("size"))
    except (TypeError, ValueError) as exc:
        raise UpdateVerificationError("Update artifact size is invalid") from exc
    if not name or Path(name).name != name:
        raise UpdateVerificationError("Update artifact filename is invalid")
    if not _is_allowed_download_url(url, require_release_path=True):
        raise UpdateVerificationError("Update artifact URL is not an approved release URL")
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise UpdateVerificationError("Update artifact SHA-256 is invalid")
    if size <= 0 or size > _MAX_ARTIFACT_BYTES:
        raise UpdateVerificationError("Update artifact size is outside the allowed range")
    allowed_installers = {"inno", "dmg", "tar.gz"}
    if install not in allowed_installers:
        raise UpdateVerificationError("Update artifact install mode is unsupported")
    return {"name": name, "url": url, "sha256": sha256, "size": size, "install": install}


def _load_update_state() -> dict:
    try:
        return json.loads(_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_highest_seen(version: str) -> None:
    paths.ensure_dirs()
    state = _load_update_state()
    previous = str(state.get("highest_seen_version") or "0.0.0")
    if not _is_newer(version, previous) and _version_core(version) != _version_core(previous):
        return
    state["highest_seen_version"] = version
    state["verified_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    tmp = _STATE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
    os.replace(tmp, _STATE_PATH)


def _error_result(current: str, message: str) -> dict:
    return {
        "available": False,
        "current_version": current,
        "latest_version": None,
        "download_url": None,
        "artifact": None,
        "verified": False,
        "error": message,
    }


def check_for_update() -> dict:
    global _cached_result, _cached_at
    current = get_current_version()
    with _lock:
        if _cached_result is not None and (time.time() - _cached_at) < _CACHE_TTL_SECONDS:
            return dict(_cached_result)

        if not trusted_update_keys():
            result = _error_result(current, "Cette version ne contient aucune clé de mise à jour approuvée.")
            _set_verification("untrusted_build", error=result["error"])
            _cached_result, _cached_at = result, time.time()
            return dict(result)

        release = _fetch_latest_release()
        if release is None:
            result = _error_result(current, "Impossible de contacter GitHub.")
            _set_verification("network_error", error=result["error"])
            _cached_result, _cached_at = result, time.time()
            return dict(result)

        tag = str(release.get("tag_name") or "")
        try:
            manifest_bytes, signature_bytes = _fetch_signed_manifest(tag)
            manifest = verify_manifest_bytes(manifest_bytes, signature_bytes)
            version = str(manifest["version"]).lstrip("v")
            tag_version = tag.lstrip("v")
            if _version_core(version) != _version_core(tag_version):
                raise UpdateVerificationError("Signed manifest version does not match the release tag")
            highest = str(_load_update_state().get("highest_seen_version") or "0.0.0")
            if _is_newer(highest, version):
                raise UpdateVerificationError("Signed update would roll back a previously verified version")
            minimum = str(manifest.get("minimum_version") or "0.0.0")
            if _is_newer(minimum, current):
                raise UpdateVerificationError("This update requires a newer migration bridge release")
            platform_key = _platform_key()
            artifact = _validate_artifact(manifest["artifacts"].get(platform_key))
            available = _is_newer(version, current)
            _save_highest_seen(version)
            result = {
                "available": available,
                "current_version": current,
                "latest_version": version,
                "download_url": artifact["url"] if available else None,
                "artifact": artifact if available else None,
                "verified": True,
                "key_id": manifest["_verified_key_id"],
                "error": None,
            }
            _set_verification("verified", version=version, key_id=manifest["_verified_key_id"])
        except Exception as exc:
            logger.warning("Signed update verification failed: %s", exc)
            result = _error_result(current, str(exc))
            _set_verification("rejected", error=str(exc))

        _cached_result, _cached_at = result, time.time()
        return dict(result)


def invalidate_cache() -> None:
    global _cached_result, _cached_at
    with _lock:
        _cached_result = None
        _cached_at = 0.0


def _download_artifact(artifact: dict, version: str) -> Optional[str]:
    name = artifact["name"]
    url = artifact["url"]
    expected_size = int(artifact["size"])
    expected_sha = artifact["sha256"]
    update_dir = Path(tempfile.gettempdir()) / "LullMail-Update"
    update_dir.mkdir(parents=True, exist_ok=True)
    destination = update_dir / name
    partial = destination.with_suffix(destination.suffix + ".part")
    partial.unlink(missing_ok=True)
    digest = hashlib.sha256()
    downloaded = 0
    logger.info("Downloading verified update %s to %s", version, destination)
    try:
        request = urllib.request.Request(url, headers={"User-Agent": f"LullMail/{get_current_version()}"})
        with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as stream:
            if not _is_allowed_download_url(response.geturl()):
                raise UpdateVerificationError("Artifact redirect left the approved GitHub hosts")
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                downloaded += len(chunk)
                if downloaded > expected_size or downloaded > _MAX_ARTIFACT_BYTES:
                    raise UpdateVerificationError("Downloaded update is larger than the signed manifest")
                digest.update(chunk)
                stream.write(chunk)
        if downloaded != expected_size:
            raise UpdateVerificationError(
                f"Downloaded update size mismatch: expected {expected_size}, got {downloaded}"
            )
        actual_sha = digest.hexdigest()
        if actual_sha != expected_sha:
            raise UpdateVerificationError("Downloaded update SHA-256 does not match the signed manifest")
        os.replace(partial, destination)
        _set_verification("artifact_verified", version=version, key_id=_last_verification.get("key_id"))
        return str(destination)
    except Exception as exc:
        partial.unlink(missing_ok=True)
        logger.error("Verified update download failed: %s", exc)
        _set_verification("artifact_rejected", version=version, error=str(exc))
        return None


def _install_windows(destination: str) -> None:
    logger.info("Preparing graceful shutdown before the verified Windows installer")
    try:
        from app_gui import release_app_mutex

        release_app_mutex()
    except Exception as exc:
        logger.warning("release_app_mutex failed: %s", exc)
    try:
        import webview

        for window in list(webview.windows):
            try:
                window.destroy()
            except Exception:
                pass
    except Exception:
        pass
    time.sleep(2)
    try:
        subprocess.Popen([destination, "/SILENT"], close_fds=True)
    except Exception as exc:
        logger.error("Unable to launch verified Windows installer: %s", exc)
        return
    os._exit(0)


def _install_macos(destination: str) -> None:
    logger.info("Opening verified DMG: %s", destination)
    try:
        subprocess.Popen(["open", destination], close_fds=True)
    except Exception as exc:
        logger.error("Unable to open verified DMG: %s", exc)


def _install_linux(destination: str) -> None:
    folder = str(Path(destination).resolve().parent)
    logger.info("Opening folder containing verified Linux archive: %s", folder)
    try:
        subprocess.Popen(["xdg-open", folder], close_fds=True)
    except Exception as exc:
        logger.error("Unable to open verified Linux update folder: %s", exc)


def download_and_install() -> None:
    info = check_for_update()
    artifact = info.get("artifact")
    if not info.get("available") or not info.get("verified") or not isinstance(artifact, dict):
        logger.error("download_and_install refused: no verified update is available")
        return
    version = str(info.get("latest_version") or "update")
    destination = _download_artifact(artifact, version)
    if not destination:
        return
    mode = artifact.get("install")
    if mode == "inno" and sys.platform == "win32":
        _install_windows(destination)
    elif mode == "dmg" and sys.platform == "darwin":
        _install_macos(destination)
    elif mode == "tar.gz" and sys.platform not in {"win32", "darwin"}:
        _install_linux(destination)
    else:
        _set_verification("artifact_rejected", version=version, error="Installer mode does not match platform")
        logger.error("Verified artifact install mode %s does not match %s", mode, sys.platform)

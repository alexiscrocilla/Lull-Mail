# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import base64
import hashlib
import io
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def _signed_manifest(version: str = "1.2.3"):
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    manifest = {
        "schema": 1,
        "version": version,
        "published_at": "2026-08-25T10:00:00+00:00",
        "minimum_version": "0.0.0",
        "artifacts": {
            "windows-x86_64": {
                "name": f"LullMail-Setup-{version}.exe",
                "url": f"https://github.com/alexiscrocilla/Lull-Mail/releases/download/v{version}/LullMail-Setup-{version}.exe",
                "size": 7,
                "sha256": hashlib.sha256(b"payload").hexdigest(),
                "install": "inno",
            }
        },
    }
    manifest_bytes = (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()
    signature_doc = {
        "schema": 1,
        "algorithm": "ed25519",
        "key_id": "test-key",
        "signature": base64.b64encode(private.sign(manifest_bytes)).decode(),
    }
    signature_bytes = (json.dumps(signature_doc, separators=(",", ":")) + "\n").encode()
    return manifest_bytes, signature_bytes, public


def test_signed_manifest_accepts_exact_bytes(fresh_app):
    from src import updater

    manifest_bytes, signature_bytes, public = _signed_manifest()
    verified = updater.verify_manifest_bytes(
        manifest_bytes,
        signature_bytes,
        keys={"test-key": public},
    )
    assert verified["version"] == "1.2.3"
    assert verified["_verified_key_id"] == "test-key"


def test_signed_manifest_rejects_tampering(fresh_app):
    from src import updater

    manifest_bytes, signature_bytes, public = _signed_manifest()
    tampered = manifest_bytes.replace(b"1.2.3", b"9.9.9")
    with pytest.raises(updater.UpdateVerificationError, match="signature"):
        updater.verify_manifest_bytes(tampered, signature_bytes, keys={"test-key": public})


def test_signed_manifest_rejects_unknown_key(fresh_app):
    from src import updater

    manifest_bytes, signature_bytes, _ = _signed_manifest()
    with pytest.raises(updater.UpdateVerificationError, match="not trusted"):
        updater.verify_manifest_bytes(manifest_bytes, signature_bytes, keys={})


def test_artifact_validation_rejects_wrong_host(fresh_app):
    from src import updater

    with pytest.raises(updater.UpdateVerificationError, match="approved release URL"):
        updater._validate_artifact({
            "name": "LullMail.exe",
            "url": "https://attacker.example/LullMail.exe",
            "size": 10,
            "sha256": "a" * 64,
            "install": "inno",
        })


class _FakeResponse:
    def __init__(self, payload: bytes, url: str):
        self._stream = io.BytesIO(payload)
        self._url = url

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, size: int = -1):
        return self._stream.read(size)

    def geturl(self):
        return self._url


def test_download_verifies_size_and_hash_before_rename(fresh_app, tmp_path, monkeypatch):
    from src import updater

    payload = b"payload"
    url = "https://github.com/alexiscrocilla/Lull-Mail/releases/download/v1.2.3/LullMail.exe"
    monkeypatch.setattr(updater.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(
        updater.urllib.request,
        "urlopen",
        lambda request, timeout=0: _FakeResponse(payload, url),
    )
    artifact = {
        "name": "LullMail.exe",
        "url": url,
        "size": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "install": "inno",
    }
    destination = updater._download_artifact(artifact, "1.2.3")
    assert destination is not None
    assert Path(destination).read_bytes() == payload
    assert not Path(destination + ".part").exists()


def test_download_deletes_partial_file_on_hash_mismatch(fresh_app, tmp_path, monkeypatch):
    from src import updater

    payload = b"payload"
    url = "https://github.com/alexiscrocilla/Lull-Mail/releases/download/v1.2.3/LullMail.exe"
    monkeypatch.setattr(updater.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(
        updater.urllib.request,
        "urlopen",
        lambda request, timeout=0: _FakeResponse(payload, url),
    )
    artifact = {
        "name": "LullMail.exe",
        "url": url,
        "size": len(payload),
        "sha256": "0" * 64,
        "install": "inno",
    }
    assert updater._download_artifact(artifact, "1.2.3") is None
    update_dir = tmp_path / "LullMail-Update"
    assert not (update_dir / "LullMail.exe.part").exists()
    assert not (update_dir / "LullMail.exe").exists()


def test_semver_prevents_downgrade(fresh_app):
    from src import updater

    assert updater._is_newer("1.3.0", "1.2.9") is True
    assert updater._is_newer("1.2.9", "1.3.0") is False
    assert updater._is_newer("1.3.0", "1.3.0-rc.1") is True

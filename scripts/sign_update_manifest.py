# SPDX-License-Identifier: GPL-3.0-or-later
"""Create and sign the deterministic LullMail update manifest."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def _normalise_arch(value: str) -> str:
    arch = value.strip().lower()
    if arch in {"amd64", "x64", "x86_64"}:
        return "x86_64"
    if arch in {"arm64", "aarch64"}:
        return "arm64"
    raise ValueError(f"Unsupported architecture: {value}")


def _load_private_key(value: str) -> Ed25519PrivateKey:
    text = value.strip()
    if text.startswith("-----BEGIN"):
        key = serialization.load_pem_private_key(text.encode("utf-8"), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise ValueError("PEM key is not Ed25519")
        return key
    if text.startswith("base64:"):
        text = text.split(":", 1)[1]
    raw = base64.b64decode(text, validate=True)
    if len(raw) != 32:
        raise ValueError("Ed25519 private key must decode to 32 raw bytes")
    return Ed25519PrivateKey.from_private_bytes(raw)


def _artifact_metadata(directory: Path, repo: str, tag: str) -> dict[str, dict[str, Any]]:
    artifacts: dict[str, dict[str, Any]] = {}
    for sidecar in sorted(directory.glob("*.artifact.json")):
        meta = json.loads(sidecar.read_text(encoding="utf-8"))
        platform_name = str(meta["platform"]).strip().lower()
        arch = _normalise_arch(str(meta["arch"]))
        filename = Path(str(meta["file"])).name
        artifact_path = directory / filename
        if not artifact_path.is_file():
            raise FileNotFoundError(f"Artifact declared by {sidecar.name} is missing: {filename}")
        payload = artifact_path.read_bytes()
        key = f"{platform_name}-{arch}"
        if key in artifacts:
            raise ValueError(f"Duplicate artifact platform key: {key}")
        artifacts[key] = {
            "name": filename,
            "url": f"https://github.com/{repo}/releases/download/{tag}/{filename}",
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "install": str(meta["install"]),
        }
    if not artifacts:
        raise ValueError("No *.artifact.json sidecars found")
    return artifacts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--minimum-version", default="0.0.0")
    parser.add_argument("--key-id", required=True)
    parser.add_argument("--private-key", default=os.environ.get("UPDATE_SIGNING_PRIVATE_KEY", ""))
    args = parser.parse_args()

    if not args.private_key:
        raise SystemExit("UPDATE_SIGNING_PRIVATE_KEY is required")
    private_key = _load_private_key(args.private_key)
    artifacts = _artifact_metadata(args.artifact_dir, args.repo, args.tag)
    manifest = {
        "schema": 1,
        "version": args.version,
        "published_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "minimum_version": args.minimum_version,
        "artifacts": artifacts,
    }
    manifest_bytes = (
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")
    signature = private_key.sign(manifest_bytes)
    signature_doc = {
        "schema": 1,
        "algorithm": "ed25519",
        "key_id": args.key_id,
        "signature": base64.b64encode(signature).decode("ascii"),
    }

    args.artifact_dir.mkdir(parents=True, exist_ok=True)
    (args.artifact_dir / "updates-v1.json").write_bytes(manifest_bytes)
    (args.artifact_dir / "updates-v1.json.sig").write_text(
        json.dumps(signature_doc, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"Signed update manifest for {len(artifacts)} artifact(s) with key {args.key_id}")


if __name__ == "__main__":
    main()

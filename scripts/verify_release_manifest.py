# SPDX-License-Identifier: GPL-3.0-or-later
"""Check a signed manifest the way an installed copy of Lull Mail will.

The release job runs this immediately after signing, against the same
``LULLMAIL_UPDATE_PUBLIC_KEYS`` that was baked into the three builds. It is
the difference between "we signed something" and "the binaries we just built
can verify it".

Everything it can catch is otherwise invisible until a user's app silently
stops offering updates: the private key not matching the published public
key, a key id that is not in the trust store, a manifest naming an artifact
that was never uploaded, or a platform key that no install will ever ask for.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from src.updater import (  # noqa: E402
    UpdateVerificationError, _validate_artifact, verify_manifest_bytes,
)

# src/updater.py::_platform_key builds exactly these. A manifest that names
# anything else is a manifest nobody will ever match.
KNOWN_PLATFORMS = {
    "windows-x86_64", "windows-arm64",
    "macos-x86_64", "macos-arm64",
    "linux-x86_64", "linux-arm64",
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    args = parser.parse_args()

    raw_keys = os.environ.get("LULLMAIL_UPDATE_PUBLIC_KEYS", "").strip()
    if not raw_keys:
        raise SystemExit("LULLMAIL_UPDATE_PUBLIC_KEYS is not set — nothing to verify against")
    keys = {k: base64.b64decode(v, validate=True) for k, v in json.loads(raw_keys).items()}

    manifest_path = args.artifact_dir / "updates-v1.json"
    signature_path = args.artifact_dir / "updates-v1.json.sig"
    for path in (manifest_path, signature_path):
        if not path.is_file():
            raise SystemExit(f"Missing {path.name} — the signing step did not run")

    try:
        manifest = verify_manifest_bytes(manifest_path.read_bytes(),
                                         signature_path.read_bytes(), keys=keys)
    except UpdateVerificationError as exc:
        raise SystemExit(f"The published keys cannot verify this manifest: {exc}") from exc

    problems: list[str] = []
    for platform_key, artifact in manifest["artifacts"].items():
        if platform_key not in KNOWN_PLATFORMS:
            problems.append(f"{platform_key}: no install will ever ask for this key")
        # The app's own validation, including the rule that every download
        # URL must sit under the repository the binaries trust. A release
        # cut from the wrong repo fails here instead of shipping a
        # manifest nobody can use.
        try:
            _validate_artifact(artifact)
        except UpdateVerificationError as exc:
            problems.append(f"{platform_key}: {exc}")
            continue
        local = args.artifact_dir / str(artifact["name"])
        if not local.is_file():
            problems.append(f"{platform_key}: {artifact['name']} is named but not present")
            continue
        payload = local.read_bytes()
        if len(payload) != artifact["size"]:
            problems.append(f"{platform_key}: size {len(payload)} != manifest {artifact['size']}")
        digest = hashlib.sha256(payload).hexdigest()
        if digest != artifact["sha256"]:
            problems.append(f"{platform_key}: sha256 mismatch")

    if problems:
        raise SystemExit("Manifest is signed but unusable:\n  - " + "\n  - ".join(problems))

    print(f"Manifest verified with key {manifest['_verified_key_id']!r}: "
          f"{len(manifest['artifacts'])} artifact(s) — "
          + ", ".join(sorted(manifest["artifacts"])))


if __name__ == "__main__":
    main()

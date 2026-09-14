# SPDX-License-Identifier: GPL-3.0-or-later
"""Describe one built installer for the update manifest signer.

``sign_update_manifest.py`` reads ``*.artifact.json`` sidecars to learn which
platform each file is for and how to install it. Nothing produced them, which
is why the signer was unreachable and every release shipped without a
manifest.

One script rather than three blobs of shell, because the three build jobs run
on three different shells and the field names have to match
``src/updater.py``'s ``_platform_key()`` exactly — ``windows-x86_64``,
``macos-arm64``, ``linux-x86_64``. A typo there produces a manifest the app
parses happily and then finds no artifact in.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

# src/updater.py:248 — anything else is rejected after signature checking.
INSTALL_KINDS = {"inno", "dmg", "tar.gz"}
PLATFORMS = {"windows", "macos", "linux"}

# The signer normalises these; listed here so a bad RUNNER_ARCH fails in the
# build job that knows which platform it is, not in the signing job.
ARCHES = {"amd64", "x64", "x86_64", "arm64", "aarch64"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True,
                        help="the built installer, relative or absolute")
    parser.add_argument("--platform", required=True, choices=sorted(PLATFORMS))
    parser.add_argument("--arch", required=True,
                        help="RUNNER_ARCH or uname -m (X64, arm64, x86_64…)")
    parser.add_argument("--install", required=True, choices=sorted(INSTALL_KINDS))
    args = parser.parse_args()

    artifact = Path(args.file)
    if not artifact.is_file():
        raise SystemExit(f"No such artifact: {artifact}")
    arch = args.arch.strip().lower()
    if arch not in ARCHES:
        raise SystemExit(f"Unsupported arch {args.arch!r}; expected one of {sorted(ARCHES)}")

    sidecar = artifact.with_name(artifact.name + ".artifact.json")
    sidecar.write_text(
        json.dumps({
            "platform": args.platform,
            "arch": arch,
            "file": artifact.name,
            "install": args.install,
        }, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {sidecar.name} ({args.platform}/{arch}, install={args.install})")


if __name__ == "__main__":
    main()

# SPDX-License-Identifier: GPL-3.0-or-later
"""Generate the Ed25519 key pair that signs update manifests.

Run this ONCE, on a machine you trust, and keep the private half out of the
repository for ever. It prints the two values the release pipeline needs:

  * the PUBLIC half, as the JSON that goes in the repository variable
    ``LULLMAIL_UPDATE_PUBLIC_KEYS``. It is baked into every build and is not
    a secret.
  * the PRIVATE half, which goes in the repository SECRET
    ``UPDATE_SIGNING_PRIVATE_KEY`` and nowhere else.

    python scripts/new_update_key.py --key-id 2026-09

Rotation: keep the old public key in the JSON alongside the new one until
every install has moved past the last release signed with it. A build trusts
every key in that object, so an app updated by an old key can still verify a
manifest signed by the new one. Removing a key strands anyone who has not
updated since it was retired — the trust store is sealed at build time.

The private key is written to a file rather than printed, so it does not end
up in a shell history, a terminal scrollback or a CI log.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import stat
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--key-id", required=True,
                        help="a short, stable name recorded in every signature, e.g. 2026-09")
    parser.add_argument("--out", type=Path, default=Path("update-signing-key.private"),
                        help="where to write the private key (default: ./update-signing-key.private)")
    args = parser.parse_args()

    if args.out.exists():
        raise SystemExit(f"{args.out} already exists — refusing to overwrite a signing key")

    private = Ed25519PrivateKey.generate()
    raw_public = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    raw_private = private.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )

    args.out.write_text(base64.b64encode(raw_private).decode("ascii") + "\n", encoding="utf-8")
    try:
        os.chmod(args.out, stat.S_IRUSR | stat.S_IWUSR)   # 0600; a no-op on Windows
    except OSError:
        pass

    public_json = json.dumps({args.key_id: base64.b64encode(raw_public).decode("ascii")},
                             sort_keys=True, separators=(",", ":"))

    print("Key pair generated.\n")
    print("1. Repository VARIABLE  LULLMAIL_UPDATE_PUBLIC_KEYS  (not a secret):")
    print(f"   {public_json}\n")
    print("2. Repository SECRET    UPDATE_SIGNING_PRIVATE_KEY:")
    print(f"   the contents of {args.out}")
    print("   gh secret set UPDATE_SIGNING_PRIVATE_KEY < "
          f"{args.out}\n", file=sys.stderr)
    print(f"3. Then delete {args.out}, or store it in a password manager.")
    print("   Losing it means you can never sign another update for the\n"
          "   installs that trust this key; leaking it means someone else can.")


if __name__ == "__main__":
    main()

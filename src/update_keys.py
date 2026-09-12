# SPDX-License-Identifier: GPL-3.0-or-later
"""Trusted Ed25519 public keys baked into release builds."""

from __future__ import annotations

import base64
from typing import Dict

try:
    from src._update_keys import TRUSTED_UPDATE_KEYS as _GENERATED_KEYS
except ImportError:
    _GENERATED_KEYS: Dict[str, str] = {}


def trusted_update_keys() -> Dict[str, bytes]:
    keys: Dict[str, bytes] = {}
    for key_id, encoded in dict(_GENERATED_KEYS).items():
        try:
            raw = base64.b64decode(encoded, validate=True)
        except Exception:
            continue
        if len(raw) == 32:
            keys[str(key_id)] = raw
    return keys

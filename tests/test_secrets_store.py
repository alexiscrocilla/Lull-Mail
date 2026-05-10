# SPDX-License-Identifier: GPL-3.0-or-later
"""
Keyring round-trip tests. Uses the in-memory `tmp_keyring` fixture so
no real Credential Manager / Keychain entry is created.
"""

from __future__ import annotations


def test_sentinel_detection():
    from src.secrets_store import is_sentinel
    assert is_sentinel("keyring:user@example.com")
    assert is_sentinel("keyring:default")
    assert not is_sentinel("plain-password")
    assert not is_sentinel("")
    assert not is_sentinel(None)


def test_imap_round_trip(tmp_keyring):
    from src.secrets_store import store_imap, resolve, SERVICE_IMAP
    sentinel = store_imap("user@example.com", "s3cret")
    assert sentinel == "keyring:user@example.com"
    assert resolve(sentinel, SERVICE_IMAP) == "s3cret"


def test_openai_round_trip(tmp_keyring):
    from src.secrets_store import store_openai, resolve, SERVICE_OPENAI
    sentinel = store_openai("sk-real-key")
    assert sentinel == "keyring:default"
    assert resolve(sentinel, SERVICE_OPENAI) == "sk-real-key"


def test_resolve_passthrough_for_plain_value(tmp_keyring):
    """Non-sentinel values are returned unchanged — important during
    the migration window where some accounts may still have clear
    text passwords mid-flight."""
    from src.secrets_store import resolve, SERVICE_IMAP
    assert resolve("plain-password", SERVICE_IMAP) == "plain-password"
    assert resolve("", SERVICE_IMAP) == ""


def test_delete_imap_idempotent(tmp_keyring):
    from src.secrets_store import store_imap, delete_imap
    store_imap("user@example.com", "x")
    delete_imap("user@example.com")
    # Second delete is a no-op, must not raise.
    delete_imap("user@example.com")

# SPDX-License-Identifier: GPL-3.0-or-later
"""
No-AI mode — the user opted out of OpenAI by leaving the key empty.

Covers the boundaries that gate every OpenAI call:
  • config schema accepts an empty key
  • cfg.ai_enabled() reflects the in-memory config
  • setup_api save_openai accepts "" (explicit disable) and purges keyring
  • /api/emails/{id}/draft and /reanalyze return 409 when AI is off
"""

from __future__ import annotations


def _config_no_ai() -> dict:
    return {
        "openai": {"api_key": "", "model": "gpt-4o-mini"},
        "accounts": [{
            "email": "u@example.com",
            "imap_host": "imap.example.com",
            "imap_port": 993,
            "username": "u@example.com",
            "password": "secret",
            "enabled": True,
        }],
    }


def test_validate_accepts_empty_key():
    from src.config import _validate
    _validate(_config_no_ai())  # no raise


def test_ai_enabled_false_when_empty(monkeypatch):
    from src import config as cfg
    monkeypatch.setattr(cfg, "_config", _config_no_ai())
    assert cfg.ai_enabled() is False


def test_ai_enabled_true_with_key(monkeypatch):
    from src import config as cfg
    conf = _config_no_ai()
    conf["openai"]["api_key"] = "sk-real"
    monkeypatch.setattr(cfg, "_config", conf)
    assert cfg.ai_enabled() is True


def test_ai_enabled_false_when_no_config(monkeypatch):
    from src import config as cfg
    monkeypatch.setattr(cfg, "_config", {})
    assert cfg.ai_enabled() is False


def test_setup_save_openai_empty_purges_keyring(client, tmp_keyring):
    """POST with api_key="" must succeed and remove the keyring entry."""
    from src import secrets_store
    # Pre-seed a key so we can verify the purge.
    sentinel = secrets_store.store_openai("sk-old")
    assert sentinel  # sanity: keyring write worked

    # Persist a config with the sentinel so the endpoint sees an existing key.
    from src import config as cfg
    import yaml
    cfg.CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(cfg.CONFIG_PATH, "w") as f:
        yaml.safe_dump({
            "openai": {"api_key": sentinel, "model": "gpt-4o-mini"},
            "accounts": [],
        }, f)

    r = client.post("/api/setup/openai", json={"api_key": "", "model": "gpt-4o-mini"})
    assert r.status_code == 200, r.text

    # Keyring entry must be gone (delete_openai called by the endpoint).
    try:
        # secrets_store.resolve raises when the entry is missing.
        secrets_store.resolve(sentinel, secrets_store.SERVICE_OPENAI)
        purged = False
    except secrets_store.SecretsBackendError:
        purged = True
    assert purged, "delete_openai should have removed the keyring entry"

    # Config on disk should now carry the empty key.
    with open(cfg.CONFIG_PATH) as f:
        data = yaml.safe_load(f)
    assert data["openai"]["api_key"] == ""


def test_setup_save_openai_rejects_bad_format(client):
    """A non-empty, non-MASK key that doesn't start with sk- is still rejected."""
    r = client.post("/api/setup/openai", json={"api_key": "garbage", "model": "gpt-4o-mini"})
    assert r.status_code == 400


def test_draft_endpoint_returns_409_when_ai_off(client, monkeypatch):
    """The on-demand draft generator must short-circuit before touching OpenAI."""
    from src import config as cfg
    from src import database as db
    monkeypatch.setattr(cfg, "_config", _config_no_ai())

    # Insert one email so the endpoint passes the 404 guard.
    db.insert_email({
        "message_id": "<m1@x>",
        "account": "u@example.com",
        "account_email": "u@example.com",
        "uid": "1",
        "sender": "x@y.com",
        "recipient": "u@example.com",
        "subject": "hi",
        "body_text": "hello",
        "body_html": "",
        "date_received": "2026-01-01T00:00:00",
    })
    # Lookup int_id from the message_id (insert_email returns nothing).
    em = db.get_email_by_message_id("<m1@x>") if hasattr(db, "get_email_by_message_id") else None
    if em is None:
        # Fallback: scan via SQL — keeps the test resilient to API drift.
        import sqlite3
        from src import paths
        with sqlite3.connect(paths.DB_PATH) as con:
            row = con.execute("SELECT int_id FROM emails WHERE message_id = ?", ("<m1@x>",)).fetchone()
        int_id = row[0]
    else:
        int_id = em["int_id"]

    r = client.post(f"/api/emails/{int_id}/draft")
    assert r.status_code == 409
    assert "IA désactivée" in r.json().get("detail", "")


def test_reanalyze_endpoint_returns_409_when_ai_off(client, monkeypatch):
    from src import config as cfg
    from src import database as db
    monkeypatch.setattr(cfg, "_config", _config_no_ai())

    db.insert_email({
        "message_id": "<m2@x>",
        "account": "u@example.com",
        "account_email": "u@example.com",
        "uid": "2",
        "sender": "x@y.com",
        "recipient": "u@example.com",
        "subject": "hi",
        "body_text": "hello",
        "body_html": "",
        "date_received": "2026-01-01T00:00:00",
    })
    import sqlite3
    from src import paths
    with sqlite3.connect(paths.DB_PATH) as con:
        row = con.execute("SELECT int_id FROM emails WHERE message_id = ?", ("<m2@x>",)).fetchone()
    int_id = row[0]

    r = client.post(f"/api/emails/{int_id}/reanalyze")
    assert r.status_code == 409

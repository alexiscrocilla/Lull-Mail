"""Persistence of the new settings (P0.1 injection mode, P1.2/P1.3 per-account
AI profile) through the setup API."""

from __future__ import annotations

import yaml


def _seed_config(cfg):
    cfg.CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(cfg.CONFIG_PATH, "w", encoding="utf-8") as f:
        yaml.safe_dump({
            "openai": {"api_key": "", "model": "gpt-4o-mini"},
            "security": {"injection_scan": {"mode": "hybrid"}},
            "accounts": [{
                "name": "Perso", "email": "u@x.fr", "imap_host": "imap.x",
                "imap_port": 993, "username": "u@x.fr", "password": "keyring:u@x.fr",
                "enabled": True,
            }],
        }, f)


def test_general_persists_injection_mode(client):
    from src import config as cfg
    _seed_config(cfg)
    r = client.post("/api/setup/general", json={
        "polling_interval_minutes": 10,
        "injection_scan_mode": "local",
    })
    assert r.status_code == 200, r.text
    with open(cfg.CONFIG_PATH) as f:
        data = yaml.safe_load(f)
    assert data["security"]["injection_scan"]["mode"] == "local"


def test_general_rejects_bad_injection_mode(client):
    from src import config as cfg
    _seed_config(cfg)
    r = client.post("/api/setup/general", json={
        "polling_interval_minutes": 10,
        "injection_scan_mode": "nonsense",
    })
    assert r.status_code == 422  # Pydantic validation


def test_account_payload_carries_ai_profile():
    """The AccountPayload model_dump (persisted verbatim) includes the AI
    profile + auto_draft fields."""
    from src.setup_api import AccountPayload
    p = AccountPayload(
        name="Pro", email="pro@x.fr", imap_host="imap.x",
        username="pro@x.fr", password="secret",
        ai_account_enabled=False, ai_importance_threshold=9, auto_draft=True,
    )
    d = p.model_dump()
    assert d["ai_account_enabled"] is False
    assert d["ai_importance_threshold"] == 9
    assert d["auto_draft"] is True


def test_full_config_accepts_ai_profile_fields():
    """AccountConfig validation must accept the new per-account fields."""
    from src.config import _validate
    _validate({
        "openai": {"api_key": "", "model": "gpt-4o-mini"},
        "accounts": [{
            "email": "u@x.fr", "imap_host": "imap.x", "imap_port": 993,
            "username": "u@x.fr", "password": "p", "enabled": True,
            "ai_account_enabled": False, "ai_importance_threshold": 8,
            "auto_draft": True,
        }],
    })  # no raise

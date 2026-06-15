"""Setup/API routes for the Ollama + Anthropic providers."""

from __future__ import annotations

import yaml


def _read_cfg(cfg):
    with open(cfg.CONFIG_PATH) as f:
        return yaml.safe_load(f)


def test_save_ollama_persists(client):
    from src import config as cfg
    r = client.post("/api/setup/llm/ollama",
                    json={"base_url": "http://localhost:11434/", "model": "llama3.1"})
    assert r.status_code == 200, r.text
    data = _read_cfg(cfg)
    assert data["llm"]["ollama"]["model"] == "llama3.1"
    assert data["llm"]["ollama"]["base_url"] == "http://localhost:11434"  # trailing / stripped


def test_save_anthropic_stores_key_in_keyring(client):
    from src import config as cfg, secrets_store as ss
    r = client.post("/api/setup/llm/anthropic",
                    json={"api_key": "sk-ant-secret", "model": "claude-3-5-haiku-latest"})
    assert r.status_code == 200, r.text
    data = _read_cfg(cfg)
    # Config holds only the sentinel; the real key sits in the keyring.
    assert data["llm"]["anthropic"]["api_key"].startswith("keyring:")
    assert ss.resolve(data["llm"]["anthropic"]["api_key"], ss.SERVICE_ANTHROPIC) == "sk-ant-secret"


def test_save_anthropic_rejects_bad_format(client):
    r = client.post("/api/setup/llm/anthropic", json={"api_key": "not-a-key"})
    assert r.status_code == 400


def test_save_anthropic_empty_clears(client):
    from src import config as cfg
    client.post("/api/setup/llm/anthropic", json={"api_key": "sk-ant-x"})
    r = client.post("/api/setup/llm/anthropic", json={"api_key": ""})
    assert r.status_code == 200
    data = _read_cfg(cfg)
    assert data["llm"]["anthropic"]["api_key"] == ""


def test_config_masks_anthropic_key(client):
    client.post("/api/setup/llm/anthropic", json={"api_key": "sk-ant-x"})
    r = client.get("/api/setup/config")
    assert r.json()["llm"]["anthropic"]["api_key"] == "***"


def test_ollama_models_endpoint_reports_unreachable(client):
    # No Ollama running on this port → ok=false, friendly error, no crash.
    r = client.get("/api/llm/ollama/models", params={"base_url": "http://127.0.0.1:1"})
    body = r.json()
    assert r.status_code == 200
    assert body["ok"] is False and body["models"] == []

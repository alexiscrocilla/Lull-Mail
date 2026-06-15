"""Ollama + Anthropic (Claude) providers and their config wiring."""

from __future__ import annotations

import types


def _openai_like(content):
    """Fake OpenAI-compatible client: chat.completions.create -> content."""
    def create(**kwargs):
        msg = types.SimpleNamespace(content=content)
        usage = types.SimpleNamespace(prompt_tokens=5, completion_tokens=7)
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=msg)], usage=usage)
    return types.SimpleNamespace(
        chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)))


def _anthropic_like(text):
    """Fake anthropic.Anthropic: messages.create -> content[0].text."""
    def create(**kwargs):
        usage = types.SimpleNamespace(input_tokens=5, output_tokens=7)
        return types.SimpleNamespace(content=[types.SimpleNamespace(text=text)], usage=usage)
    return types.SimpleNamespace(messages=types.SimpleNamespace(create=create))


_CLS_JSON = '{"category":"important","importance_score":8,"summary":"s","needs_reply":true}'


# ── Ollama ──────────────────────────────────────────────────────────

def test_ollama_process_email(monkeypatch):
    from src.llm.ollama_provider import OllamaProvider
    p = OllamaProvider()
    p.model = "llama3.1"
    p._client = _openai_like(_CLS_JSON)
    res = p.process_email({"sender": "a@b.c", "subject": "x", "body_text": "y"})
    assert res["category"] == "important"
    assert res["importance_score"] == 8
    assert res["analyzed_by"] == "ollama-llama3.1"
    assert p.chat_endpoint() == (p._client, "llama3.1")


def test_ollama_extracts_json_from_fenced_reply(monkeypatch):
    from src.llm.ollama_provider import OllamaProvider
    p = OllamaProvider()
    p.model = "qwen2.5"
    p._client = _openai_like("```json\n" + _CLS_JSON + "\n```")
    res = p.process_email({"sender": "a@b.c", "subject": "x", "body_text": "y"})
    assert res["category"] == "important"


# ── Anthropic / Claude ──────────────────────────────────────────────

def test_anthropic_process_email(monkeypatch):
    from src.llm.anthropic_provider import AnthropicProvider
    p = AnthropicProvider()
    p.model = "claude-3-5-haiku-latest"
    p._client = _anthropic_like('{"category":"newsletter","importance_score":2,"summary":"s","needs_reply":false}')
    p._compat = _openai_like("ok")
    res = p.process_email({"sender": "a@b.c", "subject": "x", "body_text": "y"})
    assert res["category"] == "newsletter"
    assert res["analyzed_by"] == "anthropic-claude-3-5-haiku-latest"
    client, model = p.chat_endpoint()
    assert client is p._compat and model == "claude-3-5-haiku-latest"


# ── chat_client routing ─────────────────────────────────────────────

def test_chat_client_routes_to_ollama(monkeypatch):
    import src.llm as llm
    from src.llm.ollama_provider import OllamaProvider
    p = OllamaProvider(); p.model = "llama3.1"; p._client = _openai_like("ok")
    monkeypatch.setattr(llm, "get_provider", lambda: p)
    client, model = llm.chat_client()
    assert client is p._client and model == "llama3.1"


def test_chat_client_routes_to_anthropic_compat(monkeypatch):
    import src.llm as llm
    from src.llm.anthropic_provider import AnthropicProvider
    p = AnthropicProvider(); p.model = "claude-3-5-haiku-latest"
    p._client = _anthropic_like("x"); p._compat = _openai_like("ok")
    monkeypatch.setattr(llm, "get_provider", lambda: p)
    client, model = llm.chat_client()
    assert client is p._compat


# ── config / ai_enabled ─────────────────────────────────────────────

def test_ai_enabled_ollama_needs_model(monkeypatch):
    from src import config as cfg
    monkeypatch.setattr(cfg, "_config", {"llm": {"provider": "ollama", "ollama": {"model": ""}}})
    assert cfg.ai_enabled() is False
    monkeypatch.setattr(cfg, "_config", {"llm": {"provider": "ollama", "ollama": {"model": "llama3.1"}}})
    assert cfg.ai_enabled() is True


def test_ai_enabled_anthropic_needs_key(monkeypatch):
    from src import config as cfg
    monkeypatch.setattr(cfg, "_config", {"llm": {"provider": "anthropic", "anthropic": {"api_key": ""}}})
    assert cfg.ai_enabled() is False
    monkeypatch.setattr(cfg, "_config", {"llm": {"provider": "anthropic", "anthropic": {"api_key": "sk-ant-x"}}})
    assert cfg.ai_enabled() is True


def test_config_validates_new_providers():
    from src.config import _validate
    for prov in ("ollama", "anthropic"):
        _validate({
            "openai": {"api_key": "", "model": "gpt-4o-mini"},
            "llm": {"provider": prov,
                    "ollama": {"base_url": "http://localhost:11434", "model": "llama3.1"},
                    "anthropic": {"api_key": "", "model": "claude-3-5-haiku-latest"}},
            "accounts": [{"email": "u@x.fr", "imap_host": "h", "username": "u@x.fr",
                          "password": "p", "enabled": True}],
        })  # no raise


def test_anthropic_key_resolved_from_keyring(monkeypatch, tmp_keyring):
    from src import secrets_store as ss
    sentinel = ss.store_anthropic("sk-ant-secret")
    from src import config as cfg
    data = {"openai": {"api_key": ""}, "llm": {"anthropic": {"api_key": sentinel}},
            "accounts": []}
    cfg._resolve_secrets(data)
    assert data["llm"]["anthropic"]["api_key"] == "sk-ant-secret"

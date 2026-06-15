"""src.llm.chat_client() — routes AI extras to the active backend so the
prompt-injection check / draft verify / agent run with NO OpenAI account when
the user is fully local (the local llama_cpp.server is OpenAI-compatible)."""

from __future__ import annotations

import types


def test_routes_to_openai_client(monkeypatch):
    import src.llm as llm
    from src import config as cfg
    fake_client = object()
    prov = types.SimpleNamespace(_client=fake_client)
    monkeypatch.setattr(llm, "get_provider", lambda: prov)
    monkeypatch.setattr(cfg, "_config", {"openai": {"model": "gpt-4o-mini"}})
    client, model = llm.chat_client()
    assert client is fake_client and model == "gpt-4o-mini"


def test_routes_to_local_analyzer_when_no_openai(monkeypatch):
    """Local provider: reuse its analyzer server's OpenAI-compatible client."""
    import src.llm as llm
    fake_local = object()
    prov = types.SimpleNamespace(
        _client=None, _analyzer_client=fake_local, analyzer_model_id="phi-3.5-mini-q4")
    monkeypatch.setattr(llm, "get_provider", lambda: prov)
    client, model = llm.chat_client()
    assert client is fake_local and model == "phi-3.5-mini-q4"


def test_none_when_no_backend(monkeypatch):
    import src.llm as llm
    prov = types.SimpleNamespace(_client=None)  # no analyzer client either
    monkeypatch.setattr(llm, "get_provider", lambda: prov)
    assert llm.chat_client() == (None, None)

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


def test_agent_routes_to_drafter_when_local(monkeypatch):
    """Local provider: agent_chat_client must hit the drafter (Qwen 7B class)
    via agent_chat_endpoint, NOT the analyzer — the small analyzer can't
    follow tool-call specs and hallucinates narrative replies instead."""
    import src.llm as llm
    fake_drafter = object()
    prov = types.SimpleNamespace(
        agent_chat_endpoint=lambda: (fake_drafter, "qwen-2.5-7b-q4"),
        chat_endpoint=lambda: (object(), "phi-3.5-mini-q4"),
    )
    monkeypatch.setattr(llm, "get_provider", lambda: prov)
    client, model = llm.agent_chat_client()
    assert client is fake_drafter and model == "qwen-2.5-7b-q4"


def test_tools_for_prompt_is_compact_textual_not_json_schema():
    """The local model gets one line per tool, not the full JSON Schema —
    the schema dump was eating ~2500 tokens out of the 4096 ctx and the
    second turn overflowed silently. Verify the format is compact text."""
    from src import agent_tools
    text = agent_tools.tools_for_prompt()
    # Compact text format: one line per tool, signature-like.
    assert "- list_emails(" in text
    assert "- search_emails(" in text
    # The verbose JSON Schema shape MUST be gone.
    assert '"parameters"' not in text
    assert '"properties"' not in text
    # And the whole thing stays short enough to fit comfortably. Budgeted
    # PER TOOL rather than as a flat ceiling: the toolset grew from 7 to 15,
    # and a fixed cap would either fail on honest growth or stop catching a
    # schema-dump regression once the list is long. ~115 chars/tool today;
    # a JSON-Schema relapse lands near 500/tool, so 200 still trips it.
    per_tool = len(text) / max(1, len(agent_tools.TOOL_SPECS))
    assert per_tool < 200, f"{per_tool:.0f} chars/tool — tool prompt is bloating"
    assert len(text) < 2500       # absolute backstop for the 4k local context


def test_agent_falls_back_to_chat_endpoint_for_cloud_providers(monkeypatch):
    """OpenAI / Claude / Ollama don't override agent_chat_endpoint — the base
    class delegates to chat_endpoint, so the agent runs on the same client
    as the extras (one model handles both there)."""
    from src.llm.base import LLMProvider
    import src.llm as llm

    fake_cloud = object()

    class StubCloud(LLMProvider):
        name = "stub"
        def init(self, **kw):  # noqa: D401
            pass
        def process_email(self, data, model):  # noqa: D401
            return None
        def enrich_draft(self, data, existing_result, model):  # noqa: D401
            return existing_result
        def chat_endpoint(self):
            return fake_cloud, "gpt-4o-mini"

    prov = StubCloud()
    monkeypatch.setattr(llm, "get_provider", lambda: prov)
    client, model = llm.agent_chat_client()
    assert client is fake_cloud and model == "gpt-4o-mini"

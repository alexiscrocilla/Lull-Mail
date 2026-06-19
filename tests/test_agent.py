"""Bounded agent loop + shared tool layer (P3.1)."""

from __future__ import annotations

import json
import types


def _seed(db):
    db.insert_email({
        "message_id": "<a@t>", "account": "u@x.fr", "uid": "1",
        "subject": "Devis", "sender": "client@corp.com", "recipient": "u@x.fr",
        "body_text": "Pouvez-vous m'envoyer un devis ?",
        "date_str": "Mon, 05 May 2025 10:00:00 +0000",
    })


def _int_id(db, mid="<a@t>"):
    return next(r["int_id"] for r in db.get_emails(limit=10) if r["message_id"] == mid)


# ── shared tool layer ───────────────────────────────────────────────

def test_no_send_tool_exposed():
    from src import agent_tools
    names = set(agent_tools.TOOL_FUNCS)
    assert not any("send" in n for n in names)
    spec_names = {s["function"]["name"] for s in agent_tools.TOOL_SPECS}
    assert spec_names == names  # specs and funcs are 1:1


def test_tool_list_and_get(fresh_app):
    from src import database as db, agent_tools
    _seed(db)
    out = agent_tools.list_emails(folder="inbox")
    assert len(out["emails"]) == 1
    iid = out["emails"][0]["int_id"]
    full = agent_tools.get_email(iid)
    assert "devis" in full["body_text"].lower()
    assert "injection_suspected" in full


def test_tool_draft_reply_saves_not_sends(fresh_app):
    from src import database as db, agent_tools
    _seed(db)
    iid = _int_id(db)
    res = agent_tools.draft_reply(iid, "Bonjour, voici le devis.")
    assert res["status"] == "draft_saved"
    row = next(r for r in db.get_emails(limit=10) if r["int_id"] == iid)
    assert row["draft_response"] == "Bonjour, voici le devis."


def test_tool_move_and_mark(fresh_app):
    from src import database as db, agent_tools
    _seed(db)
    iid = _int_id(db)
    agent_tools.mark_email_read(iid, True)
    agent_tools.move_email(iid, "deleted")
    row = db.get_email_by_id(iid)
    assert row["is_read"] == 1 and row["folder"] == "deleted"


def test_dispatch_unknown_tool():
    from src import agent_tools
    assert "error" in agent_tools.dispatch("nope", {})


# ── agent loop ──────────────────────────────────────────────────────

def _fake_tool_call(name, args):
    fn = types.SimpleNamespace(name=name, arguments=json.dumps(args))
    return types.SimpleNamespace(id="call_1", function=fn)


def _fake_client(script):
    """script: list of message objects to return on successive create() calls."""
    state = {"i": 0}

    def create(**kwargs):
        msg = script[state["i"]]
        state["i"] += 1
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=msg)])

    return types.SimpleNamespace(
        chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)))


def test_run_agent_executes_tool_then_answers(fresh_app, monkeypatch):
    from src import database as db, agent
    _seed(db)

    step1 = types.SimpleNamespace(
        content="", tool_calls=[_fake_tool_call("list_emails", {"folder": "inbox"})])
    step2 = types.SimpleNamespace(content="Tu as 1 email en attente.", tool_calls=None)
    monkeypatch.setattr(agent, "_chat", lambda: (_fake_client([step1, step2]), "gpt-4o-mini"))

    out = agent.run_agent("Qu'est-ce qui attend ?")
    assert out["text"] == "Tu as 1 email en attente."
    assert out["trace"] == [{"tool": "list_emails", "args": {"folder": "inbox"}}]


def test_run_agent_step_cap(fresh_app, monkeypatch):
    from src import agent
    # Always returns a tool call → loop must stop at max_steps.
    always = types.SimpleNamespace(
        content="", tool_calls=[_fake_tool_call("list_emails", {})])
    monkeypatch.setattr(agent, "_chat", lambda: (_fake_client([always] * 10), "gpt-4o-mini"))
    out = agent.run_agent("boucle", max_steps=3)
    assert len(out["trace"]) == 3


def test_run_agent_raises_without_client(monkeypatch):
    from src import agent
    monkeypatch.setattr(agent, "_chat", lambda: (None, None))
    import pytest
    with pytest.raises(RuntimeError):
        agent.run_agent("hello")


# ── local-backend loop ─────────────────────────────────────────────


def _fake_text_client(script):
    """Local-loop fake: each create() call pops the next text content.

    Mirrors what llama_cpp.server returns when the model emits its native
    tool-call format (Qwen <tool_call>, Mistral [TOOL_CALLS], …) in the
    response body rather than in tool_calls[]."""
    state = {"i": 0}

    def create(**kwargs):
        text = script[state["i"]]
        state["i"] += 1
        msg = types.SimpleNamespace(content=text, tool_calls=None)
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=msg)])

    return types.SimpleNamespace(
        chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)))


def test_local_loop_parses_qwen_tool_call_then_answers(fresh_app, monkeypatch):
    from src import database as db, agent
    _seed(db)

    step1 = (
        'Je vais chercher.\n'
        '<tool_call>{"name":"list_emails","arguments":{"folder":"inbox"}}</tool_call>'
    )
    step2 = "Tu as un email de client@corp.com sur un devis."
    monkeypatch.setattr(agent, "_chat", lambda: (_fake_text_client([step1, step2]), "local"))
    monkeypatch.setattr(agent, "_is_local_backend", lambda: True)

    out = agent.run_agent("Qu'attend une réponse ?")
    assert out["text"] == "Tu as un email de client@corp.com sur un devis."
    assert out["trace"] == [{"tool": "list_emails", "args": {"folder": "inbox"}}]


def test_local_loop_strips_leaked_tool_call_from_final_text(fresh_app, monkeypatch):
    """If the model emits a malformed (unparseable) tool_call as its final
    answer, the user must never see the XML — even though the loop terminates
    early because parse_tool_calls() found nothing dispatchable."""
    from src import agent

    leaked = 'Voici la réponse.\n<tool_call>{garbage</tool_call>'
    monkeypatch.setattr(agent, "_chat", lambda: (_fake_text_client([leaked]), "local"))
    monkeypatch.setattr(agent, "_is_local_backend", lambda: True)

    out = agent.run_agent("test")
    assert "<tool_call>" not in out["text"]
    assert "Voici la réponse." in out["text"]


def test_local_loop_step_cap(fresh_app, monkeypatch):
    from src import agent
    looping = '<tool_call>{"name":"list_emails","arguments":{}}</tool_call>'
    monkeypatch.setattr(agent, "_chat", lambda: (_fake_text_client([looping] * 10), "local"))
    monkeypatch.setattr(agent, "_is_local_backend", lambda: True)
    out = agent.run_agent("boucle", max_steps=2)
    assert len(out["trace"]) == 2


def test_local_loop_handles_mistral_format(fresh_app, monkeypatch):
    from src import database as db, agent
    _seed(db)

    step1 = '[TOOL_CALLS][{"name":"list_emails","arguments":{"folder":"inbox"}}]'
    step2 = "OK fait."
    monkeypatch.setattr(agent, "_chat", lambda: (_fake_text_client([step1, step2]), "local"))
    monkeypatch.setattr(agent, "_is_local_backend", lambda: True)

    out = agent.run_agent("liste")
    assert out["trace"] and out["trace"][0]["tool"] == "list_emails"
    assert out["text"] == "OK fait."


def test_cloud_loop_strips_leaked_tool_call_in_final_message(fresh_app, monkeypatch):
    """A cloud model that ignores tools= and instead emits <tool_call> in
    content (rare but observed on Claude-via-OpenAI shims) must still produce
    clean text — the cloud path also runs strip_tool_artifacts now."""
    from src import agent

    leaked = types.SimpleNamespace(
        content='Texte.\n<tool_call>{"name":"x"}</tool_call>', tool_calls=None)
    monkeypatch.setattr(agent, "_chat",
                        lambda: (_fake_client([leaked]), "gpt-4o-mini"))
    monkeypatch.setattr(agent, "_is_local_backend", lambda: False)

    out = agent.run_agent("test")
    assert "<tool_call>" not in out["text"]


def test_assistant_endpoint_409_when_ai_off(client, monkeypatch):
    from src import config as cfg
    monkeypatch.setattr(cfg, "_config", {
        "openai": {"api_key": "", "model": "gpt-4o-mini"},
        "accounts": [], "security": {"injection_scan": {"mode": "off"}},
    })
    r = client.post("/api/assistant/ask", json={"message": "salut"})
    assert r.status_code == 409
    # Assert the gate fired (non-empty localized detail) without coupling to a
    # specific locale's wording.
    assert r.json().get("detail")

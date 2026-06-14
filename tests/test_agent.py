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
    monkeypatch.setattr(agent, "_openai_client", lambda: _fake_client([step1, step2]))

    out = agent.run_agent("Qu'est-ce qui attend ?")
    assert out["text"] == "Tu as 1 email en attente."
    assert out["trace"] == [{"tool": "list_emails", "args": {"folder": "inbox"}}]


def test_run_agent_step_cap(fresh_app, monkeypatch):
    from src import agent
    # Always returns a tool call → loop must stop at max_steps.
    always = types.SimpleNamespace(
        content="", tool_calls=[_fake_tool_call("list_emails", {})])
    monkeypatch.setattr(agent, "_openai_client", lambda: _fake_client([always] * 10))
    out = agent.run_agent("boucle", max_steps=3)
    assert len(out["trace"]) == 3


def test_run_agent_raises_without_client(monkeypatch):
    from src import agent
    monkeypatch.setattr(agent, "_openai_client", lambda: None)
    import pytest
    with pytest.raises(RuntimeError):
        agent.run_agent("hello")


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

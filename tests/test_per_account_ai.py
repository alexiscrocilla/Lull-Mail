# SPDX-License-Identifier: GPL-3.0-or-later
"""The per-account AI switch, honoured everywhere and not only in the pass.

`ai_account_enabled` was read by the analysis pass and by nothing else. The
read pane could still hand a work email to the model on a button press, the
frontend had no way to know the switch existed, and mail that got the
"AI off for this account" verdict stayed that way forever once the switch
was turned back on.
"""

from __future__ import annotations

import yaml


def _seed_config(cfg, ai_by_account):
    cfg.CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(cfg.CONFIG_PATH, "w", encoding="utf-8") as f:
        yaml.safe_dump({
            "openai": {"api_key": "sk-test", "model": "gpt-4o-mini"},
            "llm": {"provider": "openai"},
            "accounts": [{
                "name": email.split("@")[0], "email": email,
                "imap_host": "imap.x", "imap_port": 993, "username": email,
                "password": "seeded-password", "ssl": True, "enabled": True,
                "ai_account_enabled": on,
            } for email, on in ai_by_account.items()],
        }, f)
    cfg.reload()


def _insert(db, message_id, account):
    db.insert_email({
        "message_id": message_id, "account": account, "uid": "1",
        "subject": "Sujet", "sender": "Someone <s@x.fr>", "recipient": account,
        "date_str": "Mon, 14 Sep 2026 09:00:00 +0000",
        "body_text": "corps", "body_html": "<p>corps</p>",
    })
    with db._conn() as con:
        row = con.execute("SELECT int_id FROM emails WHERE message_id = ?",
                          (message_id,)).fetchone()
    return int(row["int_id"])


def test_accounts_endpoint_ships_the_switch(client):
    from src import config as cfg
    _seed_config(cfg, {"on@x.fr": True, "off@x.fr": False})

    r = client.get("/api/accounts")
    assert r.status_code == 200, r.text
    by_email = {a["email"]: a for a in r.json()}
    assert by_email["on@x.fr"]["ai_account_enabled"] is True
    # Without this the frontend cannot tell the two mailboxes apart, and it
    # renders the same AI controls over both.
    assert by_email["off@x.fr"]["ai_account_enabled"] is False


def _forbid_llm(monkeypatch):
    """Any call that reaches this is the bug: the mail left the machine."""
    from src import ai_processor

    def boom(*_a, **_k):
        raise AssertionError("the model was called for an opted-out account")

    monkeypatch.setattr(ai_processor, "process_email", boom)
    monkeypatch.setattr(ai_processor, "enrich_draft", boom)
    monkeypatch.setattr(ai_processor, "init_client", boom)


def test_reanalyze_refuses_an_email_from_an_opted_out_account(client, monkeypatch):
    from src import config as cfg, database as db
    _seed_config(cfg, {"on@x.fr": True, "off@x.fr": False})
    _forbid_llm(monkeypatch)
    off_id = _insert(db, "<off@x>", "off@x.fr")

    r = client.post(f"/api/emails/{off_id}/reanalyze")
    assert r.status_code == 409, r.text
    assert "off@x.fr" in r.json()["detail"]


def test_draft_refuses_an_email_from_an_opted_out_account(client, monkeypatch):
    from src import config as cfg, database as db
    _seed_config(cfg, {"on@x.fr": True, "off@x.fr": False})
    _forbid_llm(monkeypatch)
    off_id = _insert(db, "<off2@x>", "off@x.fr")

    r = client.post(f"/api/emails/{off_id}/draft")
    assert r.status_code == 409, r.text
    assert "off@x.fr" in r.json()["detail"]


def test_turning_the_switch_back_on_requeues_only_that_account(fresh_app):
    """The neutral verdict marks the mail done. Nothing looked at it again."""
    from src import database as db
    from src.scheduler import ACCOUNT_AI_OFF_REASON

    for i, acct in enumerate(["back@x.fr", "still@x.fr"]):
        for n in range(3):
            mid = f"<{acct}-{n}>"
            _insert(db, mid, acct)
            db.update_email_ai(mid, {
                "category": "other", "importance_score": 5,
                "importance_reason": ACCOUNT_AI_OFF_REASON,
                "summary": "", "needs_reply": False,
                "analyzed_by": "local-rules",
            })

    moved = db.requeue_emails_by_reason(ACCOUNT_AI_OFF_REASON,
                                        accounts=["back@x.fr"])
    assert moved == 3

    back = [e for e in db.get_emails(limit=50) if e["account_email"] == "back@x.fr"]
    still = [e for e in db.get_emails(limit=50) if e["account_email"] == "still@x.fr"]
    assert {e["category"] for e in back} == {"pending"}
    # The other mailbox is still opted out; its mail must not be handed to
    # the model because a neighbour changed its mind.
    assert {e["category"] for e in still} == {"other"}


def test_requeue_with_no_eligible_account_touches_nothing(fresh_app):
    from src import database as db
    from src.scheduler import ACCOUNT_AI_OFF_REASON

    _insert(db, "<solo@x>", "solo@x.fr")
    db.update_email_ai("<solo@x>", {
        "category": "other", "importance_score": 5,
        "importance_reason": ACCOUNT_AI_OFF_REASON,
        "summary": "", "needs_reply": False, "analyzed_by": "local-rules",
    })

    # An empty list means "no mailbox turned it back on", not "every mailbox".
    assert db.requeue_emails_by_reason(ACCOUNT_AI_OFF_REASON, accounts=[]) == 0
    assert db.get_emails(limit=5)[0]["category"] == "other"


def test_the_streaming_draft_route_is_gated_too(client, monkeypatch):
    """The streaming twin was the only route that still reached the model.

    /draft answered 409 while /draft/stream handed the body to the provider
    and persisted the result — so the switch the user flipped was honoured
    by every path except the one the read pane actually uses on a local
    model.
    """
    from src import config as cfg, database as db
    _seed_config(cfg, {"on@x.fr": True, "off@x.fr": False})
    _forbid_llm(monkeypatch)
    off_id = _insert(db, "<off3@x>", "off@x.fr")

    r = client.post(f"/api/emails/{off_id}/draft/stream")
    assert r.status_code == 409, r.text
    assert "off@x.fr" in r.json()["detail"]


def test_the_streaming_draft_route_still_serves_an_allowed_account(client, monkeypatch):
    """The gate must refuse the opted-out mailbox and nothing else."""
    from src import config as cfg, database as db
    _seed_config(cfg, {"on@x.fr": True, "off@x.fr": False})
    on_id = _insert(db, "<on1@x>", "on@x.fr")

    r = client.post(f"/api/emails/{on_id}/draft/stream")
    # 409 is still allowed here (the provider is not local in this config),
    # but it must NOT be the per-account refusal.
    if r.status_code == 409:
        assert "on@x.fr" not in r.json().get("detail", "")

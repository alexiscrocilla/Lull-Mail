"""Parallel IMAP fetch (scheduler.run_sync).

fetch_emails() is called concurrently per account; the DB write phase
stays sequential. These tests monkeypatch fetch_emails so no real IMAP
connection is made, and verify: all accounts processed, a per-account
error doesn't sink the others, and cursors are persisted.
"""

from __future__ import annotations

import threading
import time


def _conf(accounts):
    return {
        "openai": {"api_key": "", "model": "gpt-4o-mini"},
        "polling": {"fetch_workers": 4, "initial_fetch_count": 100,
                    "ai_batch_size": 50, "max_age_days": 0},
        "ntfy": {"topic": ""},
        "security": {"injection_scan": {"mode": "off"}},
        "accounts": accounts,
        "attachments": {"enabled": False},
    }


def _acc(email):
    return {"email": email, "imap_host": "imap.x", "username": email,
            "password": "p", "enabled": True}


def test_all_accounts_fetched_in_parallel(fresh_app, monkeypatch):
    from src import scheduler, config as cfg, database as db

    accounts = [_acc(f"u{i}@x.fr") for i in range(4)]
    monkeypatch.setattr(cfg, "get", lambda: _conf(accounts))

    calls = []
    lock = threading.Lock()
    state = {"current": 0, "max": 0}

    def fake_fetch(acc, last_uid=None, limit=50):
        # Deterministic concurrency proof: count how many fetches overlap,
        # instead of a flaky wall-clock threshold.
        with lock:
            calls.append(acc["email"])
            state["current"] += 1
            state["max"] = max(state["max"], state["current"])
        time.sleep(0.2)
        with lock:
            state["current"] -= 1
        em = {
            "message_id": f"<m-{acc['email']}>", "account": acc["email"],
            "uid": "10", "subject": "hi", "sender": "a@b.c",
            "recipient": acc["email"], "body_text": "x",
            "date_str": "Mon, 05 May 2025 10:00:00 +0000",
        }
        return [em], None

    monkeypatch.setattr(scheduler, "fetch_emails", fake_fetch)
    scheduler.run_sync()

    # At least two fetches ran at the same time → genuinely parallel.
    assert state["max"] >= 2, f"fetches did not overlap (max={state['max']})"
    assert set(calls) == {a["email"] for a in accounts}
    rows = db.get_emails(limit=100)
    assert len(rows) == 4


def test_one_account_error_does_not_block_others(fresh_app, monkeypatch):
    from src import scheduler, config as cfg, database as db

    accounts = [_acc("ok@x.fr"), _acc("bad@x.fr")]
    monkeypatch.setattr(cfg, "get", lambda: _conf(accounts))

    def fake_fetch(acc, last_uid=None, limit=50):
        if acc["email"] == "bad@x.fr":
            raise RuntimeError("boom")
        em = {
            "message_id": "<ok@t>", "account": "ok@x.fr", "uid": "5",
            "subject": "ok", "sender": "a@b.c", "recipient": "ok@x.fr",
            "body_text": "x", "date_str": "Mon, 05 May 2025 10:00:00 +0000",
        }
        return [em], None

    monkeypatch.setattr(scheduler, "fetch_emails", fake_fetch)
    scheduler.run_sync()

    rows = db.get_emails(limit=100)
    assert {r["message_id"] for r in rows} == {"<ok@t>"}
    # The failing account recorded a sync error rather than crashing the run.
    state = db.get_sync_state("bad@x.fr")
    assert state is not None and state.get("last_error")

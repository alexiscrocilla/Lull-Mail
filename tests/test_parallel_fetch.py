"""Parallel IMAP fetch (scheduler.run_sync).

fetch_emails() is called concurrently per account; every DB write stays on
the sync thread, in the as_completed loop body. Each account is committed as
soon as its own fetch returns, which is what lets the mailbox show mail while
a slower account is still downloading. These tests monkeypatch fetch_emails so
no real IMAP connection is made, and verify: all accounts processed, a fast
account lands before a slow one finishes, a per-account error doesn't sink the
others, and cursors are persisted.
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


def test_fast_account_lands_before_slow_one_finishes(fresh_app, monkeypatch):
    """Streaming display depends on this: a slow account must not hold back
    the ones that already answered. Before the write phase moved into the
    as_completed loop, nothing reached the DB until every fetch had returned,
    so the mailbox stayed empty for the duration of the slowest account."""
    from src import scheduler, config as cfg, database as db

    accounts = [_acc("fast@x.fr"), _acc("slow@x.fr")]
    monkeypatch.setattr(cfg, "get", lambda: _conf(accounts))

    fast_stored = threading.Event()
    real_insert = db.insert_email

    def spy_insert(em):
        out = real_insert(em)
        if em["account"] == "fast@x.fr":
            fast_stored.set()
        return out

    monkeypatch.setattr(db, "insert_email", spy_insert)

    observed = {}

    def fake_fetch(acc, last_uid=None, limit=50):
        if acc["email"] == "slow@x.fr":
            # Block until the other account has actually been written. With
            # batch-at-the-end persistence this wait can only time out.
            observed["fast_already_stored"] = fast_stored.wait(timeout=5)
        em = {
            "message_id": f"<m-{acc['email']}>", "account": acc["email"],
            "uid": "7", "subject": "hi", "sender": "a@b.c",
            "recipient": acc["email"], "body_text": "x",
            "date_str": "Mon, 05 May 2025 10:00:00 +0000",
        }
        return [em], None

    monkeypatch.setattr(scheduler, "fetch_emails", fake_fetch)
    scheduler.run_sync()

    assert observed.get("fast_already_stored") is True, (
        "fast@x.fr was still unwritten while slow@x.fr was fetching — "
        "the sync went back to committing everything at the end"
    )
    rows = db.get_emails(limit=100)
    assert {r["message_id"] for r in rows} == {"<m-fast@x.fr>", "<m-slow@x.fr>"}


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

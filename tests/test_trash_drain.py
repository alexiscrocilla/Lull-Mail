# SPDX-License-Identifier: GPL-3.0-or-later
"""Queued deletions replay in one IMAP connection per account.

A cleanup action moves hundreds of messages at once. Replaying those the way a
single flag change is replayed — one login, one command, one logout per
message — is twenty minutes of queue for a thousand rows, during which every
ordinary "mark this read" waits behind them (the queue is drained in id
order), and long enough for a large provider to start throttling.
"""

from __future__ import annotations

import pytest


def _seed(db, n: int, account: str = "u@x.fr", start: int = 0) -> list:
    ids = []
    with db._conn() as con:
        for i in range(start, start + n):
            cur = con.execute(
                "INSERT INTO emails (message_id, account_email, uid, sender, folder)"
                " VALUES (?, ?, ?, 'a@b.c', 'inbox')",
                (f"<{account}-{i}@x>", account, str(1000 + i)),
            )
            ids.append(cur.lastrowid)
    return ids


def _acc(email):
    return {"email": email, "imap_host": "imap.x", "username": email,
            "password": "p", "enabled": True}


def test_a_large_backlog_opens_one_connection_per_account(fresh_app, monkeypatch):
    from src import scheduler, database as db, email_fetcher as ef

    db.bulk_set_folder_tx(_seed(db, 200, "a@x.fr"), "deleted", trash_delay_seconds=0)
    db.bulk_set_folder_tx(_seed(db, 100, "b@x.fr", start=1000), "deleted", trash_delay_seconds=0)

    batches = []
    per_uid_calls = []
    monkeypatch.setattr(ef, "move_to_trash_on_server",
                        lambda acc, uid: per_uid_calls.append(uid) or True)

    def fake_batch(account, uids, on_each=None):
        batches.append((account["email"], len(uids)))
        for uid in uids:
            on_each(uid, True)
        return [True] * len(uids)

    monkeypatch.setattr(ef, "batch_move_to_trash", fake_batch)
    scheduler._drain_pending_ops([_acc("a@x.fr"), _acc("b@x.fr")])

    assert per_uid_calls == [], "trash must not go through the one-login-per-message path"
    assert sorted(batches) == [("a@x.fr", 200), ("b@x.fr", 50)], (
        f"expected one batch per account inside the 250 cap, got {batches}")
    with db._conn() as con:
        left = con.execute("SELECT COUNT(*) FROM pending_ops").fetchone()[0]
    assert left == 50, "the rest stays queued for the next pass"


def test_a_failed_uid_is_retried_and_the_others_complete(fresh_app, monkeypatch):
    from src import scheduler, database as db, email_fetcher as ef

    ids = _seed(db, 3)
    db.bulk_set_folder_tx(ids, "deleted", trash_delay_seconds=0)

    def fake_batch(account, uids, on_each=None):
        for i, uid in enumerate(uids):
            on_each(uid, i != 1)  # the middle one is refused
        return []

    monkeypatch.setattr(ef, "batch_move_to_trash", fake_batch)
    scheduler._drain_pending_ops([_acc("u@x.fr")])

    with db._conn() as con:
        rows = [dict(r) for r in con.execute(
            "SELECT status, last_error, next_attempt_at FROM pending_ops")]
    assert len(rows) == 1, "only the refused message stays queued"
    assert rows[0]["status"] == "pending" and rows[0]["next_attempt_at"]
    assert "IMAP" in (rows[0]["last_error"] or "")


def test_a_dead_connection_requeues_the_whole_batch(fresh_app, monkeypatch):
    from src import scheduler, database as db, email_fetcher as ef

    ids = _seed(db, 5)
    db.bulk_set_folder_tx(ids, "deleted", trash_delay_seconds=0)

    def boom(account, uids, on_each=None):
        raise OSError("connection reset")

    monkeypatch.setattr(ef, "batch_move_to_trash", boom)
    scheduler._drain_pending_ops([_acc("u@x.fr")])

    with db._conn() as con:
        rows = [dict(r) for r in con.execute("SELECT status FROM pending_ops")]
    assert len(rows) == 5 and {r["status"] for r in rows} == {"pending"}, (
        "a dead connection must leave every op retryable, not stuck in flight")


def test_flag_changes_still_use_the_per_message_path(fresh_app, monkeypatch):
    from src import scheduler, database as db, email_fetcher as ef

    ids = _seed(db, 2)
    db.bulk_set_read_tx(ids, True)

    seen = []
    monkeypatch.setattr(ef, "mark_seen_on_server",
                        lambda acc, uid: seen.append(uid) or True)
    monkeypatch.setattr(ef, "batch_move_to_trash",
                        lambda *a, **k: pytest.fail("no trash op was queued"))
    scheduler._drain_pending_ops([_acc("u@x.fr")])

    assert len(seen) == 2
    with db._conn() as con:
        assert con.execute("SELECT COUNT(*) FROM pending_ops").fetchone()[0] == 0


def test_claim_can_select_or_exclude_an_operation(fresh_app):
    from src import database as db

    ids = _seed(db, 4)
    db.bulk_set_folder_tx(ids[:2], "deleted", trash_delay_seconds=0)
    db.bulk_set_read_tx(ids[2:], True)

    trash = db.claim_pending_ops(limit=100, operation="trash")
    assert {op["operation"] for op in trash} == {"trash"} and len(trash) == 2
    others = db.claim_pending_ops(limit=100, exclude_operations=["trash"])
    assert {op["operation"] for op in others} == {"seen"} and len(others) == 2

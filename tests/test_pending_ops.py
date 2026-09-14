# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests for offline-first pending operations queue and transactional mutations."""

from __future__ import annotations

import pytest


def test_pending_ops_coalesce_and_revision(fresh_app):
    from src import database as db

    db.insert_email({
        "message_id": "<op1@test>",
        "account": "user@test.fr",
        "uid": "10",
        "subject": "Op test",
        "date_str": "Mon, 05 May 2026 10:00:00 +0000",
    })

    # Read toggle tx: unread -> read
    updated = db.set_email_read_state_tx(1, is_read=True)
    assert updated["is_read"] == 1

    ops = db.get_due_pending_ops(account="user@test.fr")
    assert len(ops) == 1
    assert ops[0]["operation"] == "seen"
    assert ops[0]["desired_value"] == "1"
    assert ops[0]["revision"] == 1

    # Read toggle tx again: read -> unread (should coalesce and bump revision)
    db.set_email_read_state_tx(1, is_read=False)
    ops2 = db.get_due_pending_ops(account="user@test.fr")
    assert len(ops2) == 1
    assert ops2[0]["desired_value"] == "0"
    assert ops2[0]["revision"] == 2


def test_claim_and_complete_pending_ops(fresh_app):
    from src import database as db

    db.insert_email({
        "message_id": "<op2@test>",
        "account": "user@test.fr",
        "uid": "20",
        "subject": "Fav test",
        "date_str": "Mon, 05 May 2026 10:00:00 +0000",
    })

    db.set_email_favourite_tx(1, is_favourite=True)
    claimed = db.claim_pending_ops(account="user@test.fr")
    assert len(claimed) == 1
    op = claimed[0]
    assert op["operation"] == "flagged"

    # Complete op with matching revision
    ok = db.complete_pending_op(op["id"], expected_revision=op["revision"])
    assert ok is True
    assert db.count_pending_ops() == 0


def test_complete_pending_op_rejected_on_stale_revision(fresh_app):
    from src import database as db

    db.insert_email({
        "message_id": "<op3@test>",
        "account": "user@test.fr",
        "uid": "30",
        "subject": "Revision test",
        "date_str": "Mon, 05 May 2026 10:00:00 +0000",
    })

    db.set_email_read_state_tx(1, is_read=True)
    claimed = db.claim_pending_ops(account="user@test.fr")
    op = claimed[0]
    old_rev = op["revision"]

    # User concurrently flips back to unread before background worker completes
    db.set_email_read_state_tx(1, is_read=False)

    # Worker finishes old op -> complete should be rejected due to revision mismatch
    completed = db.complete_pending_op(op["id"], expected_revision=old_rev)
    assert completed is False
    # Op remains in queue with new revision and desired value '0'
    due = db.get_due_pending_ops(account="user@test.fr")
    assert len(due) == 1
    assert due[0]["desired_value"] == "0"
    assert due[0]["revision"] > old_rev


def test_trash_and_undo_cancellation(fresh_app):
    from src import database as db

    db.insert_email({
        "message_id": "<trash@test>",
        "account": "user@test.fr",
        "uid": "40",
        "subject": "Trash test",
        "date_str": "Mon, 05 May 2026 10:00:00 +0000",
    })

    # Move to deleted (trash with delay)
    db.set_email_folder_tx(1, folder="deleted", trash_delay_seconds=10)
    assert db.get_email_by_id(1)["folder"] == "deleted"
    assert db.count_pending_ops() == 1

    # User clicks Undo -> moves back to inbox, cancelling pending trash op
    db.set_email_folder_tx(1, folder="inbox")
    assert db.get_email_by_id(1)["folder"] == "inbox"
    assert db.count_pending_ops() == 0


def test_the_drain_leaves_a_backed_off_account_alone(fresh_app, monkeypatch):
    """`claim_pending_ops` says the caller must pass mailboxes it can reach.

    The drain passed every enabled account, so an account the fetch pass had
    just declared unreachable still got fifty one-connection attempts — each
    one waiting for a timeout, with the analysis lock held and the inbox
    saying it was downloading messages the whole time.
    """
    from src import scheduler, database as db
    import src.email_fetcher as ef

    db.insert_email({
        "message_id": "<op-1@x>", "account": "dead@x.fr", "uid": "11",
        "subject": "s", "date_str": "Mon, 05 May 2026 10:00:00 +0000",
    })
    db.queue_pending_op(1, "dead@x.fr", "seen", "1")
    db.set_sync_error("dead@x.fr", "connexion refusée", backoff_seconds=3600)

    calls = []
    monkeypatch.setattr(ef, "mark_seen_on_server", lambda a, u: calls.append(u) or True)
    monkeypatch.setattr(scheduler, "_drain_trash_ops", lambda acc: 0)

    scheduler._drain_pending_ops([{"email": "dead@x.fr", "imap_host": "h"}])

    assert calls == [], f"the drain opened {len(calls)} connection(s) to a backed-off account"
    with db._conn() as con:
        stuck = con.execute(
            "SELECT COUNT(*) FROM pending_ops WHERE status = 'in_flight'").fetchone()[0]
        waiting = con.execute(
            "SELECT COUNT(*) FROM pending_ops WHERE status = 'pending'").fetchone()[0]
    assert stuck == 0, "an op was claimed and then never worked on"
    assert waiting == 1, "the mutation must still be queued for when the account comes back"


def test_the_drain_stops_at_the_pass_deadline_without_losing_work(fresh_app, monkeypatch):
    """It used to run before the pass consulted its budget at all."""
    from src import scheduler, database as db
    import src.email_fetcher as ef

    for i in range(5):
        db.insert_email({
            "message_id": f"<op-{i}@x>", "account": "live@x.fr", "uid": str(100 + i),
            "subject": "s", "date_str": "Mon, 05 May 2026 10:00:00 +0000",
        })
        db.queue_pending_op(i + 1, "live@x.fr", "seen", "1")

    calls = []

    def slow(acc, uid):
        calls.append(uid)
        return True

    monkeypatch.setattr(ef, "mark_seen_on_server", slow)
    monkeypatch.setattr(scheduler, "_drain_trash_ops", lambda acc: 0)

    # A budget that is already spent: nothing may be attempted.
    scheduler._drain_pending_ops([{"email": "live@x.fr", "imap_host": "h"}],
                                 scheduler.time.monotonic() - 1)

    assert calls == [], f"{len(calls)} operation(s) ran past the deadline"
    with db._conn() as con:
        stuck = con.execute(
            "SELECT COUNT(*) FROM pending_ops WHERE status = 'in_flight'").fetchone()[0]
        waiting = con.execute(
            "SELECT COUNT(*) FROM pending_ops WHERE status = 'pending'").fetchone()[0]
    assert stuck == 0, f"{stuck} operations were claimed and abandoned in flight"
    assert waiting == 5, "every mutation must still be queued for the next pass"

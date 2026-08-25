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

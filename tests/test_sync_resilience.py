# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests for sync resilience, backoff scheduling, and UIDVALIDITY tracking."""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
import pytest


def test_uidvalidity_change_remaps_uids(fresh_app):
    from src import database as db

    db.insert_email({
        "message_id": "<m1@test>",
        "account": "acc@test.com",
        "uid": "100",
        "subject": "Email 1",
        "date_str": "Mon, 05 May 2026 10:00:00 +0000",
    })
    db.update_sync_state("acc@test.com", last_uid="100", uidvalidity="1111")

    state = db.get_sync_state("acc@test.com")
    assert state["uidvalidity"] == "1111"
    assert state["last_uid"] == "100"

    # Server resets UIDVALIDITY
    db.remap_account_uids_on_uidvalidity_change("acc@test.com", "2222")

    state2 = db.get_sync_state("acc@test.com")
    assert state2["uidvalidity"] == "2222"
    assert state2["last_uid"] is None

    # Emails for this account should have had their stale UIDs cleared
    row = db.get_email_by_id(1)
    assert row["uid"] is None


def test_account_backoff_on_fetch_error(fresh_app):
    from src import scheduler, database as db
    from src.attachment_security import AttachmentPolicy

    acc = {"email": "err@test.com"}
    att_policy = AttachmentPolicy(enabled=False)

    scheduler._persist_account(
        acc,
        last_uid="5",
        emails=[],
        fetch_error="Connection timeout",
        att_policy=att_policy,
    )

    state = db.get_sync_state("err@test.com")
    assert state["last_error"] == "Connection timeout"
    assert state["consecutive_failures"] == 1
    assert state["backoff_until"] is not None


def test_body_hydration_claim_and_retry(fresh_app):
    from src import database as db

    db.insert_email({
        "message_id": "<env1@test>",
        "account": "acc@test.com",
        "uid": "10",
        "subject": "Env 1",
        "body_state": "envelope",
        "date_str": "Mon, 05 May 2026 10:00:00 +0000",
    })

    # Claim for hydration
    claimed = db.claim_emails_for_body_hydration(limit=10, account="acc@test.com")
    assert len(claimed) == 1
    assert claimed[0]["message_id"] == "<env1@test>"

    # Row is now marked 'hydrating'
    row = db.get_email_by_id(1)
    assert row["body_state"] == "hydrating"

    # Reset hydrating state (e.g., app restart)
    db.reset_hydrating_body_states()
    row2 = db.get_email_by_id(1)
    assert row2["body_state"] == "envelope"

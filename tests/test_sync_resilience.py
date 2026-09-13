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


# ── a body that can never be fetched ─────────────────────────────────────────

def _envelope(email="u@x.fr", uid=1):
    return {
        "message_id": f"<m-{uid}@x>", "account": email, "uid": str(uid),
        "subject": "hi", "sender": "a@b.c", "recipient": email,
        "date_str": "Mon, 05 May 2025 10:00:00 +0000",
        "body_state": "envelope", "body_text": "", "body_html": "",
    }


def test_body_retry_delay_grows_with_each_attempt(fresh_app):
    """A flat 60-second retry burns all five attempts in five minutes.

    The fetch path and the offline-op drain both back off exponentially.
    This one did not, so a transient outage lasting longer than five
    minutes exhausted the message permanently.
    """
    from src import database as db

    from datetime import datetime, timezone

    db.insert_email(_envelope())
    delays = []
    for _ in range(4):
        before = datetime.now(timezone.utc)
        db.mark_email_body_failed("<m-1@x>", "boom")
        nxt = datetime.fromisoformat(db.get_email_by_id(1)["body_next_retry_at"])
        delays.append(round((nxt - before).total_seconds()))

    # A flat delay gives [60, 60, 60, 60]; every step must at least double.
    assert all(b >= 2 * a for a, b in zip(delays, delays[1:])), (
        f"retry delay does not grow: {delays}"
    )


def test_a_permanently_failed_body_leaves_the_pending_queue(fresh_app):
    """Five failures used to park a row where nothing could ever reach it.

    `failed` matches neither the hydration claim nor the analysable set,
    while the pending counter still counts it — so the rail badge sat at N
    forever and clicking it started a sync that could not help. The row is
    now classified on its envelope, which is what subject and sender are
    for.
    """
    from src import database as db

    db.insert_email(_envelope())
    for _ in range(5):
        db.mark_email_body_failed("<m-1@x>", "IMAP fetch empty response")

    assert db.get_email_by_id(1)["body_state"] == "failed"
    assert db.claim_emails_for_body_hydration(limit=10, account="u@x.fr") == []
    pending = db.get_pending_emails(limit=10)
    assert [p["int_id"] for p in pending] == [1], (
        "a failed body must still be classifiable from its envelope"
    )

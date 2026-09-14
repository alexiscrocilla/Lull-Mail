# SPDX-License-Identifier: GPL-3.0-or-later
"""The one-shot unsubscribe-header backfill, and when it is allowed to stop.

The give-up flag is global. It used to be set whenever a pass moved nothing,
which with several mailboxes happens for reasons that have nothing to do with
whether the work is possible: one account in backoff, or a deadline reached
before the third account's turn. Every other mailbox then lost unsubscribe
discovery permanently.
"""

from __future__ import annotations

import time

import pytest

FLAG = "unsubscribe_backfill_done_at"


def _account(email):
    return {"name": email.split("@")[0], "email": email, "imap_host": "imap.x",
            "imap_port": 993, "username": email, "password": "x",
            "ssl": True, "enabled": True}


def _seed_missing(db, account, n):
    """Rows with a UID and no List-Unsubscribe value: never inspected."""
    for i in range(n):
        mid = f"<{account}-{i}>"
        db.insert_email({
            "message_id": mid, "account": account, "uid": str(100 + i),
            "subject": "S", "sender": "N <n@x.fr>", "recipient": account,
            "date_str": "Mon, 14 Sep 2026 09:00:00 +0000",
            "body_text": "b", "body_html": "<p>b</p>",
        })
    with db._conn() as con:
        con.execute("UPDATE emails SET list_unsubscribe = NULL "
                    "WHERE account_email = ?", (account,))


@pytest.fixture
def sched(fresh_app, monkeypatch):
    from src import scheduler
    # No IMAP anywhere in this test: every fetch fails the way an unreachable
    # server does.
    monkeypatch.setattr("src.email_fetcher.batch_fetch_headers",
                        lambda *a, **k: (_ for _ in ()).throw(OSError("unreachable")))
    return scheduler


def test_one_account_in_backoff_does_not_end_discovery_for_the_others(sched):
    from src import database as db
    from datetime import datetime, timedelta, timezone

    _seed_missing(db, "live@x.fr", 3)
    _seed_missing(db, "paused@x.fr", 3)
    with db._conn() as con:
        con.execute(
            "INSERT INTO sync_state (account_email, backoff_until) VALUES (?, ?)",
            ("paused@x.fr",
             (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()))

    accounts = [_account("live@x.fr"), _account("paused@x.fr")]
    sched._backfill_unsubscribe_headers(accounts, time.monotonic() + 30)

    # live@ was tried and failed; paused@ was never asked. Giving up here
    # writes off a mailbox over a failure that is not its own and that
    # clears by itself.
    assert db.get_kv(FLAG) is None


def test_every_reachable_account_tried_and_empty_does_end_it(sched):
    from src import database as db

    _seed_missing(db, "a@x.fr", 2)
    _seed_missing(db, "b@x.fr", 2)

    accounts = [_account("a@x.fr"), _account("b@x.fr")]
    sched._backfill_unsubscribe_headers(accounts, time.monotonic() + 30)

    # Both were asked, both said nothing. Retrying every pass is pointless;
    # the Nettoyage page keeps a manual re-run.
    assert db.get_kv(FLAG) is not None


def test_a_pass_that_runs_out_of_time_leaves_the_rest_for_next_time(sched):
    from src import database as db

    _seed_missing(db, "a@x.fr", 2)
    _seed_missing(db, "b@x.fr", 2)

    accounts = [_account("a@x.fr"), _account("b@x.fr")]
    # Already past the deadline: nothing is attempted at all.
    sched._backfill_unsubscribe_headers(accounts, time.monotonic() - 1)

    assert db.get_kv(FLAG) is None


def test_rows_belonging_to_no_reachable_account_do_not_spin_forever(sched):
    """An account disabled or deleted while it still had un-inspected rows.

    Those rows are never attempted and never deferred, so the give-up guard
    saw done==0, attempted==0, deferred==0 and set no flag — and the job
    restarted from scratch on every 60-second analysis tick, rebuilding a
    multi-thousand-row list each time, forever.
    """
    from src import database as db

    _seed_missing(db, "gone@x.fr", 5)          # no longer in the config
    accounts = [_account("live@x.fr")]          # and it has nothing pending

    sched._backfill_unsubscribe_headers(accounts, time.monotonic() + 30)

    assert db.get_kv(FLAG) is not None, "the backfill will re-scan on every pass forever"

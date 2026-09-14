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


def test_opening_a_message_does_not_download_one_already_in_flight(fresh_app, monkeypatch):
    """The read pane must not open a second connection for a row a round holds.

    `claim_single_email_for_hydration` was written to return None for a row
    already marked in flight, and had no caller anywhere. The lazy path
    called the fetcher directly, so opening a message while the background
    round held it downloaded the same message twice and wrote a second
    attachment file that is never served.
    """
    from src import api, database as db

    db.insert_email(_envelope())
    claimed = db.claim_emails_for_body_hydration(limit=10, account="u@x.fr")
    assert claimed, "the background round must hold the row"

    calls = []
    monkeypatch.setattr(api, "_account_for", lambda e: {"email": e, "imap_host": "h",
                                                        "username": e, "password": "p"})
    import src.email_fetcher as ef
    monkeypatch.setattr(ef, "hydrate_single_email",
                        lambda *a, **k: calls.append(a) or True)

    api._lazy_hydrate_one(1, "u@x.fr", "1", "<m-1@x>")
    assert calls == [], "the row was already in flight; no second download"
    assert db.get_email_by_id(1)["body_state"] == "hydrating"


def test_a_lazy_hydration_that_cannot_run_releases_its_claim(fresh_app, monkeypatch):
    """Claiming first means every exit path has to give the row back.

    Without that, a row whose account has vanished from the config, or
    whose fetch raised, is parked in 'hydrating': invisible to the
    analysable set and unclaimable until the stale reclaimer runs.
    """
    from src import api, database as db

    db.insert_email(_envelope())
    monkeypatch.setattr(api, "_account_for", lambda e: None)
    api._lazy_hydrate_one(1, "u@x.fr", "1", "<m-1@x>")
    assert db.get_email_by_id(1)["body_state"] == "envelope", "unknown account stranded the row"

    monkeypatch.setattr(api, "_account_for", lambda e: {"email": e, "imap_host": "h",
                                                        "username": e, "password": "p"})
    import src.email_fetcher as ef

    def boom(*a, **k):
        raise OSError("connection refused")

    monkeypatch.setattr(ef, "hydrate_single_email", boom)
    api._lazy_hydrate_one(1, "u@x.fr", "1", "<m-1@x>")
    assert db.get_email_by_id(1)["body_state"] == "envelope", "a raising fetch stranded the row"


def test_analysis_classifies_before_the_whole_backlog_is_downloaded(fresh_app, monkeypatch):
    """A first sync used to show no category at all until every body landed.

    `_hydrate_round` drained an account to exhaustion, and the analysable
    set only ever contained rows whose body was already there, so the two
    halves of the pass could not interleave. One claim per account per
    round makes the alternation the outer loop already writes real.
    """
    from src import database as db, scheduler as sched
    from src.attachment_security import AttachmentPolicy
    import time

    for uid in range(100):
        db.insert_email(_envelope(uid=uid))

    def fake_hydrate(acc, targets, policy, on_each=None, on_body=None):
        for t in targets:
            db.update_email_body_hydrated(t["message_id"], body_text="body", body_html="")
        return len(targets)

    import src.email_fetcher as ef
    monkeypatch.setattr(ef, "hydrate_email_bodies", fake_hydrate)

    accounts = [{"email": "u@x.fr", "imap_host": "h", "username": "u@x.fr",
                 "password": "p", "enabled": True}]
    sched._hydrate_round(accounts, AttachmentPolicy(enabled=False),
                         time.monotonic() + 30)

    remaining = db.count_hydration_candidates("u@x.fr")
    assert remaining > 0, "one round must not drain the whole backlog"
    assert db.get_pending_emails(limit=200), "the first bodies must be analysable already"


def test_a_failing_account_is_skipped_for_the_rest_of_the_pass(fresh_app, monkeypatch):
    """Losing the inner drain loop must not turn into retrying a dead host.

    The drain abandoned an account on its first failed connection. With one
    batch per round, the outer hydrate/analyse alternation would come back
    to it every iteration; the pass-level set restores the old bound.
    """
    from src import database as db, scheduler as sched
    from src.attachment_security import AttachmentPolicy
    import src.email_fetcher as ef
    import time

    for uid in range(50):
        db.insert_email(_envelope(uid=uid))

    calls = []

    def dead(acc, targets, policy, on_each=None, on_body=None):
        calls.append(acc["email"])
        db.release_hydration_claims([t["message_id"] for t in targets])
        return 0

    monkeypatch.setattr(ef, "hydrate_email_bodies", dead)
    accounts = [{"email": "u@x.fr", "imap_host": "h", "username": "u@x.fr",
                 "password": "p", "enabled": True}]
    unreachable: set = set()
    for _ in range(5):
        sched._hydrate_round(accounts, AttachmentPolicy(enabled=False),
                             time.monotonic() + 30, unreachable)

    assert calls == ["u@x.fr"], f"a dead host was retried {len(calls)} times in one pass"


def test_queued_work_for_an_account_the_drain_cannot_serve_is_left_alone(fresh_app, monkeypatch):
    """Pausing one account must not swallow its queue and block the others.

    The drain claimed a batch across every account, flipped all of them to
    in-flight, then skipped the ones whose account it could not resolve --
    without putting them back. Nothing but a restart ever resets an
    in-flight op, so those deletions were lost: the app showed the mail
    deleted and the server still had it. Worse, they filled the batch, so
    the first pass afterwards did no work at all for the healthy account.
    """
    from src import database as db, scheduler as sched
    import src.email_fetcher as ef

    for uid in range(12):
        db.insert_email({**_envelope(uid=uid), "account": "paused@x.fr",
                         "message_id": f"<p-{uid}@x>", "body_state": "full"})
    for uid in range(2):
        db.insert_email({**_envelope(uid=100 + uid), "account": "live@x.fr",
                         "message_id": f"<l-{uid}@x>", "body_state": "full"})

    all_ids = [r["int_id"] for r in db.get_emails(limit=100)]
    db.bulk_set_folder_tx(all_ids, "deleted", trash_delay_seconds=0)

    moved = []

    def fake_move(acc, uids, on_each=None):
        moved.append(acc["email"])
        if on_each:
            for u in uids:
                on_each(u, True)
        return [True] * len(uids)

    monkeypatch.setattr(ef, "batch_move_to_trash", fake_move)
    # Only the live account is configured — the other is paused in Settings.
    live = {"email": "live@x.fr", "imap_host": "h", "username": "live@x.fr", "password": "p"}
    sched._drain_trash_ops({"live@x.fr": live})

    assert moved == ["live@x.fr"], f"the drain did {moved!r} on its first pass"
    with db._conn() as con:
        stuck = con.execute(
            "SELECT COUNT(*) FROM pending_ops WHERE status = 'in_flight'").fetchone()[0]
        waiting = con.execute(
            "SELECT COUNT(*) FROM pending_ops WHERE status = 'pending'").fetchone()[0]
    assert stuck == 0, f"{stuck} operations were claimed and thrown away"
    assert waiting == 12, f"the paused account's 12 deletions should still be queued, found {waiting}"


def test_a_pass_the_watchdog_broke_out_of_does_not_release_its_successors_lock(fresh_app):
    """threading.Lock can be released from a thread that does not hold it.

    So when the watchdog broke a hung pass's lock and handed it to a new
    pass, the hung one's own `finally` released the lock out from under the
    new holder: a third caller could then start a genuinely concurrent pass,
    and the rightful holder's `release()` raised RuntimeError from a
    `finally`, taking the scheduler job down with it.
    """
    import threading
    from src import scheduler

    lock = threading.Lock()

    # A holds the lock and is long past its budget.
    a_token = scheduler._acquire_or_break(lock, None, "T", 1.0)
    assert a_token is not None and lock.locked()

    # The watchdog breaks it and hands it to B.
    hung_since = scheduler.time.monotonic() - 999
    b_token = scheduler._acquire_or_break(lock, hung_since, "T", 1.0)
    assert b_token is not None and b_token != a_token
    assert lock.locked()

    # A finally unwinds. It must not release B's lock, and must not raise.
    assert scheduler._release_if_owner(lock, a_token) is False
    assert lock.locked(), "the hung pass released the lock its successor holds"

    # Nobody else can start a pass while B runs.
    assert scheduler._acquire_or_break(lock, scheduler.time.monotonic(), "T", 1.0) is None

    # B finishes normally.
    assert scheduler._release_if_owner(lock, b_token) is True
    assert not lock.locked()


def test_the_rightful_holder_never_raises_from_its_finally(fresh_app):
    import threading
    from src import scheduler

    lock = threading.Lock()
    token = scheduler._acquire_or_break(lock, None, "T", 1.0)
    scheduler._release_if_owner(lock, token)
    # A double release used to be RuntimeError out of a `finally`.
    assert scheduler._release_if_owner(lock, token) is False


# ── Two locks, one counter ───────────────────────────────────────────────────
# The tests above prove the ownership token works. They all use a single lock,
# which is exactly how the bug got through: the token was minted from one
# process-wide counter shared by both pass locks, so taking either lock
# invalidated the other's live token.


def _release_pass_locks():
    """Leave the module's locks free whatever the assertions did."""
    from src import scheduler

    for lock in (scheduler._fetch_lock, scheduler._analysis_lock):
        try:
            lock.release()
        except RuntimeError:
            pass


def test_taking_one_pass_lock_does_not_invalidate_the_others_token(fresh_app):
    """Fetch and analysis are independent passes on independent locks.

    They overlap constantly in production: an analysis pass is budgeted ten
    minutes, and any mail arriving in that window flushes a targeted fetch
    two seconds later.
    """
    import threading
    from src import scheduler

    fetch = threading.Lock()
    analysis = threading.Lock()

    f_token = scheduler._acquire_or_break(fetch, None, "Relève", 60.0)
    a_token = scheduler._acquire_or_break(analysis, None, "Analyse", 60.0)
    assert f_token is not None and a_token is not None

    # Neither pass was broken out of, so each still owns the lock it took.
    assert scheduler._release_if_owner(fetch, f_token) is True
    assert not fetch.locked(), "the fetch lock leaked when analysis took its own lock"
    assert scheduler._release_if_owner(analysis, a_token) is True
    assert not analysis.locked(), "the analysis lock leaked"


def test_the_sync_indicator_returns_to_idle_after_interleaved_passes(fresh_app):
    """`is_running()` is what the inbox spinner is bound to.

    `get_status()` reports `running = is_fetching() or is_analysing()`, the
    API passes it through, and rail-toast.js keeps a persistent loading toast
    up while it is true. A lock that is never released is a spinner that
    never stops.
    """
    from src import scheduler

    try:
        a_token = scheduler._acquire_or_break(
            scheduler._analysis_lock, None, "Analyse", scheduler.ANALYSIS_WATCHDOG_SECONDS)
        f_token = scheduler._acquire_or_break(
            scheduler._fetch_lock, None, "Relève", scheduler.FETCH_WATCHDOG_SECONDS)
        assert a_token is not None and f_token is not None
        assert scheduler.is_running()

        scheduler._release_if_owner(scheduler._fetch_lock, f_token)
        scheduler._release_if_owner(scheduler._analysis_lock, a_token)

        assert not scheduler.is_running(), (
            "the inbox spinner never goes back to idle: "
            f"fetching={scheduler.is_fetching()} analysing={scheduler.is_analysing()}"
        )
    finally:
        _release_pass_locks()


def test_an_overlapping_fetch_does_not_kill_background_analysis(fresh_app, monkeypatch):
    """The spinner is the symptom; this is the damage.

    `request_analysis()` refuses to start a pass while `is_analysing()`, and
    the sixty-second analysis job goes through it. Nothing else calls
    `analysis_pass()` in the background, so the watchdog inside
    `_acquire_or_break` is never reached: a leaked analysis lock ends body
    hydration and AI classification until the app is restarted.
    """
    import threading
    from src import scheduler

    try:
        a_token = scheduler._acquire_or_break(
            scheduler._analysis_lock, None, "Analyse", scheduler.ANALYSIS_WATCHDOG_SECONDS)
        # Mail arrives mid-pass; the IDLE watcher flushes a targeted fetch.
        f_token = scheduler._acquire_or_break(
            scheduler._fetch_lock, None, "Relève", scheduler.FETCH_WATCHDOG_SECONDS)
        scheduler._release_if_owner(scheduler._fetch_lock, f_token)
        # The analysis pass now unwinds normally.
        scheduler._release_if_owner(scheduler._analysis_lock, a_token)

        ran = threading.Event()
        monkeypatch.setattr(scheduler, "analysis_pass", lambda *a, **k: ran.set())
        assert scheduler.request_analysis() is True, (
            "background analysis is dead: request_analysis() still believes a pass is running")
        assert ran.wait(5), "the analysis thread never started"
    finally:
        _release_pass_locks()


def test_a_stuck_analysis_lock_is_eventually_reached_by_the_watchdog(fresh_app, monkeypatch):
    """`ANALYSIS_WATCHDOG_SECONDS` has to be reachable to mean anything.

    `request_analysis()` is the only thing that starts an analysis pass in
    the background, so short-circuiting on `is_analysing()` alone put the
    watchdog behind the very condition it exists to clear.
    """
    import threading
    from src import scheduler

    try:
        # A pass is holding the lock and is long past its budget.
        assert scheduler._analysis_lock.acquire(blocking=False)
        monkeypatch.setattr(
            scheduler, "_analysis_started_at",
            scheduler.time.monotonic() - scheduler.ANALYSIS_WATCHDOG_SECONDS - 1)

        ran = threading.Event()
        monkeypatch.setattr(scheduler, "analysis_pass", lambda *a, **k: ran.set())
        assert scheduler.request_analysis() is True, (
            "a hung pass blocks every later one: the watchdog is never reached")
        assert ran.wait(5)

        # A pass still inside its budget is still left alone.
        monkeypatch.setattr(scheduler, "_analysis_started_at", scheduler.time.monotonic())
        assert scheduler.request_analysis() is False
    finally:
        _release_pass_locks()

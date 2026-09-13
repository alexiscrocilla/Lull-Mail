# SPDX-License-Identifier: GPL-3.0-or-later
"""Lot 1 — new mail must reach the inbox fast, and the UI must be able to
say what the sync is doing.

Covers: the fetch pass persisting chunks while the IMAP download is still
running, the fetch never waiting for the analysis lock, the per-account
timeout and the stale-lock watchdog, the live status snapshot, the batched
FETCH parser, the 10→2 minute interval migration, hot rescheduling, and the
IMAP IDLE watcher against a scripted fake client. No network anywhere.
"""

from __future__ import annotations

import threading
import time

import pytest


# ── helpers ───────────────────────────────────────────────────────────────────

def _conf(accounts, **polling):
    p = {
        "fetch_workers": 4, "initial_fetch_count": 100,
        "ai_batch_size": 50, "max_age_days": 0, "idle_enabled": False,
    }
    p.update(polling)
    return {
        "openai": {"api_key": "", "model": "gpt-4o-mini"},
        "polling": p,
        "ntfy": {"topic": ""},
        "security": {"injection_scan": {"mode": "off"}},
        "accounts": accounts,
        "attachments": {"enabled": False},
    }


def _acc(email):
    return {"email": email, "imap_host": "imap.x", "username": email,
            "password": "p", "enabled": True}


def _em(email, uid, subject="hi"):
    return {
        "message_id": f"<m-{email}-{uid}>", "account": email, "uid": str(uid),
        "subject": subject, "sender": "a@b.c", "recipient": email,
        "body_text": "x", "date_str": "Mon, 05 May 2025 10:00:00 +0000",
    }


def _wait(pred, timeout=5.0, step=0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(step)
    return pred()


# ── fetch pass ────────────────────────────────────────────────────────────────

def test_chunks_are_persisted_while_the_fetch_is_still_running(fresh_app, monkeypatch):
    """Progressive persistence: the first chunk must be in the DB before the
    fetch returns — that is what fills the inbox during a first sync."""
    from src import scheduler, config as cfg, database as db

    email = "u@x.fr"
    monkeypatch.setattr(cfg, "get", lambda: _conf([_acc(email)]))
    observed = {}

    def fake_fetch(acc, last_uid=None, known_uidvalidity=None, limit=50, on_chunk=None):
        on_chunk({"emails": [_em(email, 1), _em(email, 2)],
                  "server_uidvalidity": "42", "uidvalidity_changed": False})
        # Block until the sync thread has written the chunk (bounded).
        observed["first_chunk_visible"] = _wait(lambda: len(db.get_emails(limit=10)) == 2)
        on_chunk({"emails": [_em(email, 3), _em(email, 4)],
                  "server_uidvalidity": "42", "uidvalidity_changed": False})
        return [], None, "42", False

    monkeypatch.setattr(scheduler, "fetch_emails", fake_fetch)
    new = scheduler.fetch_pass(trigger="test", chain_analysis=False)

    assert new == 4
    assert observed.get("first_chunk_visible") is True, (
        "the first chunk was not persisted until the whole fetch returned"
    )
    state = db.get_sync_state(email)
    assert state["last_uid"] == "4"
    assert state["uidvalidity"] == "42"
    assert state["last_error"] is None


def test_fetch_does_not_wait_for_a_running_analysis(fresh_app, monkeypatch):
    """The whole point of the two locks: a long AI batch must not delay the
    next IMAP delta by a full interval."""
    from src import scheduler, config as cfg, database as db

    email = "u@x.fr"
    monkeypatch.setattr(cfg, "get", lambda: _conf([_acc(email)]))
    monkeypatch.setattr(
        scheduler, "fetch_emails",
        lambda acc, last_uid=None, limit=50: ([_em(email, 9)], None),
    )

    assert scheduler._analysis_lock.acquire(blocking=False)
    scheduler._analysis_started_at = time.monotonic()
    try:
        t0 = time.monotonic()
        new = scheduler.fetch_pass(trigger="test", chain_analysis=False)
        elapsed = time.monotonic() - t0
    finally:
        scheduler._analysis_started_at = None
        scheduler._analysis_lock.release()

    assert new == 1
    assert elapsed < 3.0
    assert len(db.get_emails(limit=10)) == 1


def test_hung_account_times_out_without_blocking_the_others(fresh_app, monkeypatch):
    from src import scheduler, config as cfg, database as db

    monkeypatch.setattr(cfg, "get", lambda: _conf([_acc("fast@x.fr"), _acc("slow@x.fr")]))
    monkeypatch.setattr(scheduler, "ACCOUNT_FETCH_TIMEOUT_SECONDS", 0.6)
    release = threading.Event()

    def fake_fetch(acc, last_uid=None, limit=50):
        if acc["email"] == "slow@x.fr":
            release.wait(timeout=10)   # simulates a socket that never answers
            return [], None
        return [_em("fast@x.fr", 1)], None

    monkeypatch.setattr(scheduler, "fetch_emails", fake_fetch)
    t0 = time.monotonic()
    new = scheduler.fetch_pass(trigger="test", chain_analysis=False)
    elapsed = time.monotonic() - t0
    release.set()

    assert new == 1
    assert elapsed < 5.0, f"fetch_pass waited on the hung account ({elapsed:.1f}s)"
    assert not scheduler.is_fetching(), "the fetch lock was not released"
    slow = db.get_sync_state("slow@x.fr")
    assert slow and "Délai" in (slow["last_error"] or "")
    assert slow["backoff_until"] is not None
    fast = db.get_sync_state("fast@x.fr")
    assert fast and fast["last_error"] is None and fast["last_uid"] == "1"


def test_stale_fetch_lock_is_broken_by_the_watchdog(fresh_app, monkeypatch):
    from src import scheduler, config as cfg

    email = "u@x.fr"
    monkeypatch.setattr(cfg, "get", lambda: _conf([_acc(email)]))
    monkeypatch.setattr(scheduler, "fetch_emails",
                        lambda acc, last_uid=None, limit=50: ([_em(email, 1)], None))

    # A previous pass "hung" long ago and never released its lock.
    assert scheduler._fetch_lock.acquire(blocking=False)
    scheduler._fetch_started_at = time.monotonic() - scheduler.FETCH_WATCHDOG_SECONDS - 5

    new = scheduler.fetch_pass(trigger="test", chain_analysis=False)

    assert new == 1, "the watchdog did not break the stale lock"
    assert not scheduler.is_fetching()


def test_fresh_lock_holder_is_respected(fresh_app, monkeypatch):
    from src import scheduler, config as cfg

    monkeypatch.setattr(cfg, "get", lambda: _conf([_acc("u@x.fr")]))
    assert scheduler._fetch_lock.acquire(blocking=False)
    scheduler._fetch_started_at = time.monotonic()
    try:
        assert scheduler.fetch_pass(trigger="test", chain_analysis=False) is None
    finally:
        scheduler._fetch_started_at = None
        scheduler._fetch_lock.release()


def test_manual_fetch_lifts_backoff_and_targets_one_account(fresh_app, monkeypatch):
    from src import scheduler, config as cfg, database as db

    monkeypatch.setattr(cfg, "get", lambda: _conf([_acc("a@x.fr"), _acc("b@x.fr")]))
    db.set_sync_error("a@x.fr", "boom", backoff_seconds=3600)
    calls = []

    def fake_fetch(acc, last_uid=None, limit=50):
        calls.append(acc["email"])
        return [_em(acc["email"], 1)], None

    monkeypatch.setattr(scheduler, "fetch_emails", fake_fetch)

    # Scheduler tick: the account in backoff is skipped.
    scheduler.fetch_pass(trigger="scheduler", chain_analysis=False)
    assert calls == ["b@x.fr"]

    # Manual, targeted: backoff lifted, only that account fetched.
    calls.clear()
    scheduler.fetch_pass(["a@x.fr"], trigger="manual", ignore_backoff=True, chain_analysis=False)
    assert calls == ["a@x.fr"]
    assert db.get_sync_state("a@x.fr")["backoff_until"] is None


def test_status_reports_the_account_being_fetched(fresh_app, monkeypatch):
    from src import scheduler, config as cfg

    email = "u@x.fr"
    monkeypatch.setattr(cfg, "get", lambda: _conf([_acc(email)]))
    gate = threading.Event()

    def fake_fetch(acc, last_uid=None, limit=50):
        gate.wait(timeout=10)
        return [_em(email, 1)], None

    monkeypatch.setattr(scheduler, "fetch_emails", fake_fetch)
    th = threading.Thread(target=scheduler.fetch_pass,
                          kwargs={"trigger": "test", "chain_analysis": False})
    th.start()
    try:
        assert _wait(lambda: scheduler.get_status()["accounts"].get(email, {}).get("phase") == "fetching")
        mid = scheduler.get_status()
        assert mid["fetching"] is True and mid["phase"] == "fetching"
        assert mid["fetch"]["trigger"] == "test"
    finally:
        gate.set()
        th.join(timeout=5)

    done = scheduler.get_status()
    assert done["fetching"] is False and done["phase"] == "idle"
    assert done["accounts"][email]["phase"] == "idle"
    assert done["accounts"][email]["new"] == 1
    assert done["last_sync_iso"]


def test_run_sync_still_fetches_then_analyses(fresh_app, monkeypatch):
    """Historical entry point used by older callers and tests."""
    from src import scheduler, config as cfg, database as db

    email = "u@x.fr"
    monkeypatch.setattr(cfg, "get", lambda: _conf([_acc(email)]))
    em = _em(email, 1)
    em["body_state"] = "full"
    monkeypatch.setattr(scheduler, "fetch_emails",
                        lambda acc, last_uid=None, limit=50: ([em], None))
    scheduler.run_sync()
    rows = db.get_emails(limit=10)
    assert len(rows) == 1
    # No AI configured → the no-AI fallback classifies it as 'other'.
    assert rows[0]["category"] == "other"


# ── status endpoint ───────────────────────────────────────────────────────────

def test_sync_status_endpoint_shape(client, monkeypatch):
    from src import config as cfg, database as db

    monkeypatch.setattr(cfg, "get", lambda: _conf([_acc("u@x.fr")]))
    db.update_sync_state("u@x.fr", last_uid="7", uidvalidity="1")
    r = client.get("/api/sync/status")
    assert r.status_code == 200
    s = r.json()
    for key in ("running", "fetching", "analysing", "phase", "accounts",
                "queue_pending", "pending_ops", "fetch", "analysis"):
        assert key in s
    assert s["phase"] == "idle"
    assert len(s["accounts"]) == 1
    acc = s["accounts"][0]
    assert acc["email"] == "u@x.fr"
    assert acc["phase"] == "idle"
    assert acc["last_sync"] and acc["last_sync"].endswith("+00:00")
    assert acc["backoff_until"] is None
    assert "push" in acc


def test_sync_status_endpoint_without_config(client):
    r = client.get("/api/sync/status")
    assert r.status_code == 200
    assert r.json()["accounts"] == []


def test_accounts_endpoint_carries_unread_counts(client, monkeypatch):
    from src import config as cfg, database as db

    monkeypatch.setattr(cfg, "get", lambda: _conf([_acc("u@x.fr")]))
    db.insert_email(_em("u@x.fr", 1))
    r = client.get("/api/accounts")
    assert r.status_code == 200
    acc = r.json()[0]
    assert acc["unread"] == 1 and acc["total"] == 1


# ── batched FETCH parsing ─────────────────────────────────────────────────────

def test_parse_fetch_items_handles_multi_message_responses():
    from src import email_fetcher as ef

    msg_data = [
        (b"1 (UID 101 FLAGS (\\Seen) BODY[HEADER] {14}", b"Subject: a\r\n\r\n"),
        b")",
        (b"2 (UID 102 BODY[HEADER] {14}", b"Subject: b\r\n\r\n"),
        b" FLAGS (\\Flagged))",
    ]
    items = ef._parse_fetch_items(msg_data)
    assert [u for u, _, _ in items] == [b"101", b"102"]
    assert ef._parse_flags(items[0][2]) == (True, False)
    # The FLAGS that imaplib split off after the literal belong to UID 102.
    assert ef._parse_flags(items[1][2]) == (False, True)


class _FakeConn:
    """Minimal imaplib stand-in: two messages, grouped FETCH supported."""

    def __init__(self):
        self.fetch_calls = []

    def select(self, *a, **k):
        return "OK", [b"2"]

    def response(self, key):
        return "OK", [b"77"] if key == "UIDVALIDITY" else [None]

    def uid(self, cmd, *args):
        if cmd == "search":
            return "OK", [b"101 102"]
        if cmd == "fetch":
            self.fetch_calls.append(args[0])
            if args[0] == b"101,102":
                return "OK", [
                    (b"1 (UID 101 FLAGS (\\Seen) BODY[HEADER] {40}",
                     b"Subject: one\r\nMessage-ID: <one@x>\r\n\r\n"),
                    b")",
                    (b"2 (UID 102 FLAGS () BODY[HEADER] {40}",
                     b"Subject: two\r\nMessage-ID: <two@x>\r\n\r\n"),
                    b")",
                ]
            raise AssertionError(f"unexpected per-message fetch for {args[0]!r}")
        raise AssertionError(cmd)

    def logout(self):
        return "BYE", []


def test_fetch_emails_uses_one_grouped_fetch_and_streams_chunks(monkeypatch):
    from src import email_fetcher as ef

    conn = _FakeConn()
    monkeypatch.setattr(ef, "_make_connection", lambda acc: conn)
    chunks = []
    results, err, uidval, changed = ef.fetch_emails(
        {"email": "u@x.fr", "imap_host": "h", "imap_port": 993, "username": "u", "password": "p"},
        last_uid=None, limit=50, on_chunk=chunks.append, chunk_size=20, fetch_batch=50,
    )
    assert err is None
    assert uidval == "77" and changed is False
    assert [r["uid"] for r in results] == ["101", "102"]
    assert results[0]["is_read"] is True and results[1]["is_read"] is False
    assert conn.fetch_calls == [b"101,102"], "expected a single grouped FETCH"
    assert len(chunks) == 1 and len(chunks[0]["emails"]) == 2
    assert chunks[0]["server_uidvalidity"] == "77"


# ── hydration bookkeeping ────────────────────────────────────────────────────

def test_hydration_claims_are_released_when_the_connection_fails(fresh_app, monkeypatch):
    from src import database as db, email_fetcher as ef
    from src.attachment_security import AttachmentPolicy

    db.insert_email({**_em("u@x.fr", 5), "body_state": "envelope", "body_text": "", "body_html": ""})
    claimed = db.claim_emails_for_body_hydration(limit=10, account="u@x.fr")
    assert claimed and db.get_email_by_id(1)["body_state"] == "hydrating"

    def boom(acc):
        raise OSError("connection refused")

    monkeypatch.setattr(ef, "_make_connection", boom)
    got = ef.hydrate_email_bodies(_acc("u@x.fr"), claimed, AttachmentPolicy(enabled=False))
    assert got == 0
    assert db.get_email_by_id(1)["body_state"] == "envelope"


def test_stale_hydrating_rows_are_reclaimed(fresh_app):
    from src import database as db

    db.insert_email({**_em("u@x.fr", 5), "body_state": "envelope", "body_text": "", "body_html": ""})
    db.claim_emails_for_body_hydration(limit=10, account="u@x.fr")
    with db._conn() as con:
        con.execute("UPDATE emails SET body_updated_at = datetime('now', '-30 minutes')")
    assert db.reclaim_stale_hydrating(max_age_minutes=10) == 1
    assert db.get_email_by_id(1)["body_state"] == "envelope"
    assert db.count_hydration_candidates("u@x.fr") == 1


# ── config: interval migration + hot reschedule ───────────────────────────────

def _write_config(cfg, interval, migrated=None):
    import yaml
    data = cfg.default_skeleton()
    data["polling"]["interval_minutes"] = interval
    if migrated is None:
        data["polling"].pop("interval_migrated", None)
    else:
        data["polling"]["interval_migrated"] = migrated
    data["accounts"] = [{
        "name": "A", "type": "imap", "email": "a@x.fr", "imap_host": "imap.x",
        "imap_port": 993, "username": "a@x.fr", "password": "plain",
    }]
    cfg.paths.ensure_dirs()
    with open(cfg.CONFIG_PATH, "w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, allow_unicode=True, sort_keys=False)


@pytest.mark.parametrize("interval,migrated,expected", [
    (10, None, 2),     # legacy default → new default
    (7, None, 7),      # a chosen value stays
    (10, True, 10),    # 10 chosen after the migration stays
    (2, None, 2),
])
def test_polling_interval_migration(fresh_app, interval, migrated, expected):
    import yaml
    from src import config as cfg

    _write_config(cfg, interval, migrated)
    conf = cfg.load()
    assert conf["polling"]["interval_minutes"] == expected
    with open(cfg.CONFIG_PATH, encoding="utf-8") as f:
        on_disk = yaml.safe_load(f)
    assert on_disk["polling"]["interval_minutes"] == expected
    assert on_disk["polling"]["interval_migrated"] is True
    # Secrets stay in their on-disk form: the migration wrote before resolution.
    assert on_disk["accounts"][0]["password"] == "plain"
    # Idempotent.
    assert cfg.load()["polling"]["interval_minutes"] == expected


def test_reschedule_fetch_updates_the_running_job():
    from apscheduler.schedulers.background import BackgroundScheduler
    from src import lifecycle

    sched = BackgroundScheduler()
    lifecycle._apply_fetch_interval(sched, 2)
    sched.start(paused=True)
    lifecycle._scheduler = sched
    try:
        assert lifecycle.reschedule_fetch(7) is True
        job = sched.get_job(lifecycle.FETCH_JOB_ID)
        assert job.trigger.interval.total_seconds() == 7 * 60
        assert job.misfire_grace_time == 7 * 60
    finally:
        lifecycle._scheduler = None
        sched.shutdown(wait=False)
    assert lifecycle.reschedule_fetch(3) is False


def test_the_analysis_job_survives_a_missed_tick():
    """A resume must not silently drop the analysis tick it slept through.

    The fetch job got a misfire grace when it moved to a 2-minute interval;
    the analysis job kept APScheduler's 1-second default, so any tick the
    machine slept through was discarded rather than run late. Invisible
    while a 60-second list refresh covered for it -- that refresh is gone.
    """
    from apscheduler.schedulers.background import BackgroundScheduler
    from src import lifecycle

    sched = BackgroundScheduler()
    lifecycle._register_analysis_job(sched)
    job = sched.get_job(lifecycle.ANALYSIS_JOB_ID)
    assert job is not None
    assert job.misfire_grace_time >= lifecycle.ANALYSIS_TICK_SECONDS


def test_save_general_reschedules_without_restart(client, monkeypatch):
    from src import lifecycle

    calls = []
    monkeypatch.setattr(lifecycle, "reschedule_fetch", lambda m: calls.append(m) or True)
    r = client.post("/api/setup/general", json={"polling_interval_minutes": 3})
    assert r.status_code == 200, r.text
    assert calls == [3]
    import yaml
    from src import config as cfg
    with open(cfg.CONFIG_PATH, encoding="utf-8") as f:
        on_disk = yaml.safe_load(f)
    assert on_disk["polling"]["interval_minutes"] == 3
    assert on_disk["polling"]["interval_migrated"] is True


# ── IMAP IDLE watcher ─────────────────────────────────────────────────────────

class _FakeIdleClient:
    def __init__(self, script, caps=(b"IMAP4rev1", b"IDLE")):
        self.script = list(script)
        self.caps = list(caps)
        self.idle_calls = 0
        self.done_calls = 0
        self.logged_out = False

    def capabilities(self):
        return self.caps

    def select_folder(self, name, readonly=False):
        return {b"EXISTS": 3}

    def idle(self):
        self.idle_calls += 1

    def idle_check(self, timeout=None):
        if self.script:
            return self.script.pop(0)
        time.sleep(0.02)
        return []

    def idle_done(self):
        self.done_calls += 1
        return b"OK", []

    def logout(self):
        self.logged_out = True


def _watcher(factory, fired):
    from src.idle_watcher import AccountWatcher
    return AccountWatcher(
        _acc("u@x.fr"), fired.append, factory,
        renew_seconds=0.5, check_seconds=0.05, reconnect_min=0.05, reconnect_max=0.2,
    )


def test_idle_exists_response_fires_the_callback():
    from src.sync_progress import progress

    fired = []
    client = _FakeIdleClient([[(b"4", b"EXISTS")]])
    w = _watcher(lambda acc: client, fired)
    w.start()
    try:
        assert _wait(lambda: len(fired) >= 1, timeout=3)
        assert fired[0] == "u@x.fr"
        push = progress.snapshot()["push"]["u@x.fr"]
        assert push["connected"] is True and push["supported"] is True
    finally:
        w.stop()
        w.join(timeout=3)
    assert not w.is_alive()
    assert client.done_calls >= 1


def test_idle_ignores_flag_and_expunge_responses():
    fired = []
    client = _FakeIdleClient([[(b"1", b"FETCH", (b"FLAGS", (b"\\Seen",)))], [(b"2", b"EXPUNGE")]])
    w = _watcher(lambda acc: client, fired)
    w.start()
    try:
        time.sleep(0.4)
        assert fired == []
    finally:
        w.stop()
        w.join(timeout=3)


def test_idle_unsupported_server_stops_quietly():
    from src.sync_progress import progress

    fired = []
    client = _FakeIdleClient([], caps=(b"IMAP4rev1",))
    w = _watcher(lambda acc: client, fired)
    w.start()
    w.join(timeout=3)
    assert not w.is_alive()
    assert fired == []
    assert progress.snapshot()["push"]["u@x.fr"]["supported"] is False


def test_idle_reconnects_after_a_failure():
    attempts = []

    def factory(acc):
        attempts.append(1)
        if len(attempts) == 1:
            raise OSError("refused")
        return _FakeIdleClient([[(b"9", b"EXISTS")]])

    fired = []
    w = _watcher(factory, fired)
    w.start()
    try:
        assert _wait(lambda: len(fired) >= 1, timeout=3)
        assert len(attempts) >= 2
    finally:
        w.stop()
        w.join(timeout=3)


def test_idle_manager_starts_only_enabled_accounts():
    from src.idle_watcher import IdleManager

    made = []

    def factory(acc):
        made.append(acc["email"])
        return _FakeIdleClient([])

    mgr = IdleManager(client_factory=factory)
    watched = mgr.start([_acc("a@x.fr"), {**_acc("b@x.fr"), "enabled": False}], lambda e: None)
    try:
        assert watched == ["a@x.fr"]
        assert _wait(lambda: made == ["a@x.fr"], timeout=2)
    finally:
        mgr.stop()
    assert mgr.watched() == []


def test_notify_new_mail_coalesces_into_one_targeted_fetch(fresh_app, monkeypatch):
    from src import scheduler

    monkeypatch.setattr(scheduler, "IDLE_DEBOUNCE_SECONDS", 0.1)
    calls = []
    monkeypatch.setattr(
        scheduler, "fetch_pass",
        lambda only=None, **kw: calls.append((tuple(only or ()), kw.get("trigger"))) or 0,
    )
    scheduler.notify_new_mail("a@x.fr")
    scheduler.notify_new_mail("a@x.fr")
    scheduler.notify_new_mail("b@x.fr")
    assert _wait(lambda: len(calls) == 1, timeout=2)
    time.sleep(0.2)
    assert calls == [(("a@x.fr", "b@x.fr"), "idle")]


def test_concurrent_claims_never_hand_out_the_same_row(fresh_app):
    """Two claimers draining the same backlog must partition it, not share it.

    The claim used to be a SELECT followed by a separate UPDATE inside one
    `with _conn()` block. sqlite3's default isolation level opens a
    transaction only before DML, so the SELECT ran in autocommit and two
    threads could read the same rows before either wrote. Duplicated rows
    are downloaded twice, and the second pass's attachment file is written
    and then never served.

    Only lot 4 makes this reachable — opening a message now claims the row
    it hydrates — so the guard lands before the second claimer does.
    """
    import threading
    from src import database as db

    rows = 400
    for uid in range(rows):
        db.insert_email({**_em("u@x.fr", uid), "body_state": "envelope",
                         "body_text": "", "body_html": ""})

    seen: list = []
    lock = threading.Lock()
    start = threading.Event()

    def drain():
        start.wait()
        while True:
            got = db.claim_emails_for_body_hydration(limit=30, account="u@x.fr")
            if not got:
                return
            with lock:
                seen.extend(r["int_id"] for r in got)

    workers = [threading.Thread(target=drain, name=f"claim-{i}") for i in range(2)]
    for w in workers:
        w.start()
    start.set()
    for w in workers:
        w.join(timeout=30)
        assert not w.is_alive(), "a claimer never finished"

    assert len(seen) == rows, f"{len(seen)} claims handed out for {rows} rows"
    assert len(set(seen)) == len(seen), (
        f"{len(seen) - len(set(seen))} rows were handed to both claimers"
    )

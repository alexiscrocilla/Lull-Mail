# SPDX-License-Identifier: GPL-3.0-or-later
"""The in-process event hub.

Every test here guards a property some other part of the app relies on
without being able to check for itself: that a scheduler thread can reach a
browser, that publishing costs nothing when nobody is listening, and that a
client which missed frames is told so rather than left quietly wrong.
"""

from __future__ import annotations

import asyncio
import json
import threading

import pytest


def _parse(frames):
    """Turn raw SSE bytes into (seq, event, data) triples."""
    out = []
    for raw in frames:
        text = raw.decode("utf-8")
        if text.startswith(":"):
            continue
        fields = dict(
            line.split(": ", 1) for line in text.strip().split("\n") if ": " in line
        )
        out.append((int(fields["id"]), fields["event"], json.loads(fields["data"])))
    return out


async def _drain(sub, n, timeout=2.0):
    got = []
    for _ in range(n):
        got.append(await asyncio.wait_for(sub.queue.get(), timeout))
    return got


def test_publish_from_a_thread_reaches_a_subscriber(fresh_app):
    """The real publishers are threads, not the event loop.

    The fetch pass, the analysis pass, APScheduler's executor, a Timer and
    an IDLE watcher all publish. A direct `put_nowait` works in-process and
    fails the moment any of them does it.
    """
    from src.events import EventHub

    async def scenario():
        hub = EventHub()
        loop = asyncio.get_running_loop()
        sub = hub.subscribe(loop)
        assert sub is not None

        # The subscriber must already be parked on the queue when the thread
        # publishes. That is the case a plain `put_nowait` from a foreign
        # thread fails: it hands the item over but never wakes the loop,
        # which is sitting in select() until some unrelated event arrives.
        ready = threading.Event()

        def publisher():
            assert ready.wait(2)
            hub.publish("mail", {"account": "u@x.fr", "count": 3})

        threading.Thread(target=publisher, name="pretend-fetch-pass", daemon=True).start()

        # The mechanism is asserted, not just the outcome. A plain
        # `put_nowait` from a foreign thread appears to work in-process --
        # the item lands, and the loop happens to wake for an unrelated
        # timer -- so no behavioural assertion here can tell the two apart
        # reliably. What it cannot do is wake a loop that is genuinely idle,
        # which is every real publish on a quiet mailbox. Spy on the hop.
        hops = []
        real = loop.call_soon_threadsafe
        sub.loop = type("LoopProxy", (), {
            "call_soon_threadsafe": staticmethod(
                lambda fn, *a: hops.append(fn) or real(fn, *a)
            ),
        })()

        ready.set()
        raw = await asyncio.wait_for(sub.queue.get(), 5)

        assert _parse([raw]) == [(1, "mail", {"account": "u@x.fr", "count": 3})]
        assert hops, "delivery must hop to the loop, not touch the queue directly"
        hub.close_all()

    asyncio.run(scenario())


def test_publishing_to_nobody_is_free_and_silent(fresh_app):
    """`publish` runs inside the fetch pass with the fetch lock held.

    With no window open it must not raise, must not build a snapshot, and
    must not touch SQLite.
    """
    from src.events import EventHub

    hub = EventHub()
    calls = []
    hub.set_snapshot_provider(lambda: calls.append(1) or {})
    assert hub.publish("mail", {"count": 1}) == 0
    assert hub.publish("verdict", {"int_id": 4}) == 0
    assert calls == [], "a snapshot was built with nobody listening"


def test_a_subscriber_that_cannot_keep_up_is_dropped_not_waited_for(fresh_app):
    """A slow browser must never slow the fetch pass down."""
    from src.events import EventHub, QUEUE_DEPTH

    async def scenario():
        hub = EventHub()
        sub = hub.subscribe(asyncio.get_running_loop())
        assert sub is not None

        for i in range(QUEUE_DEPTH + 20):
            hub.publish("mail", {"n": i})
        # Give the loop a turn to run every queued callback.
        await asyncio.sleep(0.05)

        assert sub.lagged is True, "an over-full subscriber must be marked lagged"
        assert sub.queue.qsize() <= QUEUE_DEPTH
        hub.close_all()

    asyncio.run(scenario())


def test_a_reconnecting_client_gets_exactly_what_it_missed(fresh_app):
    from src.events import EventHub

    async def scenario():
        hub = EventHub()
        sub = hub.subscribe(asyncio.get_running_loop())
        assert sub is not None
        for i in range(1, 11):
            hub.publish("mail", {"n": i})

        missed = hub.replay_since("4", hub.run_id)
        assert missed is not None
        assert [seq for seq, _, _ in _parse(missed)] == [5, 6, 7, 8, 9, 10]

        # Up to date: nothing to replay, and not a resync either.
        assert hub.replay_since("10", hub.run_id) == []
        # No cursor at all, and a cursor the ring has rolled past.
        assert hub.replay_since(None, hub.run_id) is None
        assert hub.replay_since("99", hub.run_id) is None
        hub.close_all()

    asyncio.run(scenario())


def test_a_restart_forces_a_resync(fresh_app):
    """Sequence numbers restart with the process; a stale cursor must not match."""
    from src.events import EventHub

    async def scenario():
        hub = EventHub()
        sub = hub.subscribe(asyncio.get_running_loop())
        assert sub is not None
        for i in range(5):
            hub.publish("mail", {"n": i})
        stale_run = "0" * 32
        assert hub.replay_since("3", stale_run) is None
        hub.close_all()

    asyncio.run(scenario())


def test_the_subscriber_cap_refuses_the_extra_stream(fresh_app):
    """The route is a GET: no origin check, no rate limit. This is the brake."""
    from src.events import EventHub, MAX_SUBSCRIBERS

    async def scenario():
        hub = EventHub()
        loop = asyncio.get_running_loop()
        subs = [hub.subscribe(loop) for _ in range(MAX_SUBSCRIBERS)]
        assert all(s is not None for s in subs)
        assert hub.subscribe(loop) is None
        hub.unsubscribe(subs[0])
        assert hub.subscribe(loop) is not None
        hub.close_all()
        assert hub.subscriber_count() == 0

    asyncio.run(scenario())


def test_closing_ends_every_open_stream(fresh_app):
    """Quitting must not wait on a stream that will never end by itself."""
    from src.events import EventHub

    async def scenario():
        hub = EventHub()
        sub = hub.subscribe(asyncio.get_running_loop())
        assert sub is not None
        hub.close_all()
        await asyncio.sleep(0)
        assert await asyncio.wait_for(sub.queue.get(), 1) is None, (
            "close_all must wake the generator with a sentinel"
        )

    asyncio.run(scenario())


def test_status_changes_are_coalesced_into_at_most_four_frames_a_second(fresh_app):
    """The analysis pass bumps the board once per message.

    Building a snapshot there would cost a config read and one SQLite
    connection per account, per message — multiplying the traffic this
    module exists to remove. The ticker is what makes that impossible.
    """
    from src.events import EventHub
    from src.sync_progress import SyncProgress

    async def scenario():
        hub = EventHub()
        builds = []
        hub.set_snapshot_provider(lambda: builds.append(1) or {"ok": True})
        progress = SyncProgress()
        progress.set_on_change(hub.mark_dirty)

        sub = hub.subscribe(asyncio.get_running_loop())
        assert sub is not None
        hub.start_ticker(asyncio.get_running_loop())

        for i in range(200):
            progress.analysis_progress(i, 200)
        await asyncio.sleep(0.6)

        assert len(builds) <= 4, f"{len(builds)} snapshots built for 200 changes"
        assert sub.queue.qsize() <= 4, f"{sub.queue.qsize()} frames for 200 changes"
        assert sub.queue.qsize() >= 1, "the change never reached the client"
        hub.close_all()

    asyncio.run(scenario())


# ── the route ────────────────────────────────────────────────────────────────
#
# The stream itself is exercised end to end by the Playwright suite, against
# the real server. TestClient parks on a response that never ends, so what is
# asserted here is the property a live test cannot see: that the stream and
# the poll describe the same world. The poll is the stream's fallback, and two
# builders would drift.


def test_the_stream_and_the_poll_are_built_from_one_payload(client):
    from src import api

    polled = client.get("/api/sync/status").json()
    pushed = api._sync_snapshot()

    assert pushed == polled, "the pushed snapshot and the polled one differ"
    for key in ("running", "fetching", "analysing", "phase", "accounts",
                "queue_pending", "pending_ops", "fetch", "analysis"):
        assert key in pushed


def test_the_hub_snapshot_provider_is_wired_to_that_payload(client):
    """Registered at import, so a `sync` frame cannot carry something else."""
    from src import api
    from src.events import hub

    assert hub.snapshot() == api._sync_snapshot()


def test_the_stream_refuses_to_open_past_the_cap(client, monkeypatch):
    """A GET route gets no origin check and no rate limit; the cap is the brake."""
    from src import events

    monkeypatch.setattr(events.hub, "subscribe", lambda loop: None)
    r = client.get("/api/events")
    assert r.status_code == 503


def test_a_body_fetched_because_you_opened_it_is_announced(client, monkeypatch):
    """The read pane's whole promise rests on this one publish.

    Lot 4 deleted the client's 1200 ms retry on the stated premise that the
    server now says when a body lands. The background round says it; the
    path that exists *because the user opened a message* did not, so the
    pane showed the download skeleton for ever while the body sat complete
    in the database. Once a row is 'full' no round will ever claim it
    again, so no later frame could rescue it either.
    """
    from src import api, database as db, events
    import src.email_fetcher as ef

    db.insert_email({
        "message_id": "<lazy-1@x>", "account": "u@x.fr", "uid": "1",
        "subject": "hi", "sender": "a@b.c", "recipient": "u@x.fr",
        "date_str": "Mon, 05 May 2025 10:00:00 +0000",
        "body_state": "envelope", "body_text": "", "body_html": "",
    })

    published = []
    monkeypatch.setattr(events.hub, "publish",
                        lambda event, data: published.append((event, data)) or 1)
    monkeypatch.setattr(api, "_account_for", lambda e: {"email": e, "imap_host": "h",
                                                        "username": e, "password": "p"})
    monkeypatch.setattr(api.cfg, "get", lambda: {})

    def land_the_body(acc, row, policy):
        db.update_email_body_hydrated(row["message_id"], body_text="corps", body_html="")
        return True

    monkeypatch.setattr(ef, "hydrate_single_email", land_the_body)
    api._lazy_hydrate_one(1, "u@x.fr", "1", "<lazy-1@x>")

    bodies = [d for e, d in published if e == "body"]
    assert bodies, "the body landed and nothing told the window"
    assert bodies[0]["int_id"] == 1
    assert bodies[0]["body_state"] == "full"


def test_a_body_that_could_not_be_fetched_on_demand_is_announced_too(client, monkeypatch):
    """Otherwise the pane waits on a message that is never coming."""
    from src import api, database as db, events
    import src.email_fetcher as ef

    db.insert_email({
        "message_id": "<lazy-2@x>", "account": "u@x.fr", "uid": "2",
        "subject": "hi", "sender": "a@b.c", "recipient": "u@x.fr",
        "date_str": "Mon, 05 May 2025 10:00:00 +0000",
        "body_state": "envelope", "body_text": "", "body_html": "",
    })

    published = []
    monkeypatch.setattr(events.hub, "publish",
                        lambda event, data: published.append((event, data)) or 1)
    monkeypatch.setattr(api, "_account_for", lambda e: {"email": e, "imap_host": "h",
                                                        "username": e, "password": "p"})
    monkeypatch.setattr(api.cfg, "get", lambda: {})

    def give_up(acc, row, policy):
        for _ in range(5):
            db.mark_email_body_failed(row["message_id"], "IMAP fetch empty response")
        return False

    monkeypatch.setattr(ef, "hydrate_single_email", give_up)
    api._lazy_hydrate_one(1, "u@x.fr", "2", "<lazy-2@x>")

    bodies = [d for e, d in published if e == "body"]
    assert bodies, "a permanent failure told the window nothing"
    assert bodies[0]["body_state"] == "failed"

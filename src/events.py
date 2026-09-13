# SPDX-License-Identifier: GPL-3.0-or-later
"""In-process publish/subscribe for the browser event stream.

The app used to tell its own window what had changed by making the window
ask, twenty-three times a minute, forever. The server knows exactly when
anything changes; this is the channel that lets it say so.

Three properties the rest of the code depends on:

* **Publishing is cheap and never blocks.** `publish()` is called from the
  fetch pass while the fetch lock is held, and from the analysis pass
  between messages. It copies a list under a short lock and hands each
  frame to an event loop. With nobody listening it does nothing at all.
  It never touches SQLite.

* **Any thread may publish.** APScheduler executors, the fetch and
  analysis threads, a `threading.Timer`, an IDLE watcher and a FastAPI
  worker all call into this. The only hop to the loop is
  ``call_soon_threadsafe``.

* **A client that missed frames finds out.** Every frame carries a
  sequence number and the ring keeps the last few hundred, so a browser
  reconnecting with ``Last-Event-ID`` either gets exactly what it missed
  or is told plainly to resynchronise. The ring is deliberately not
  durable: a restart mints a new run id, which forces a resync.

Snapshots are built by the ticker, never at the publish call site. The
status payload costs a config read plus a SQLite connection per account,
and the analysis pass would otherwise build one per message — multiplying
the very traffic this module exists to remove.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import uuid
from collections import deque
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# How many frames a reconnecting client can have missed and still be caught
# up exactly. Beyond it the client is told to resynchronise. A first sync on
# three accounts publishes about 75 `mail` frames, so this covers several of
# them; it is a few tens of kilobytes.
RING_SIZE = 256

# Per-subscriber depth. A browser that cannot keep up with this is not going
# to catch up, so it is dropped and left to reconnect.
QUEUE_DEPTH = 64

# Refuse beyond this many concurrent streams. One window needs one. The
# route is a GET, so the origin check waves it through and the rate limiter
# has no default, which makes this the only thing standing between a stray
# local page and a wedged app.
MAX_SUBSCRIBERS = 8

# Comment frame. Writing it is what discovers a peer that went away without
# closing; without it a dead connection is noticed only at the next real
# event, which on a quiet mailbox is never.
KEEPALIVE = b": ka\n\n"
KEEPALIVE_SECONDS = 15.0

# How often the hub turns "something changed" into a snapshot frame. Four a
# second is far below anything a person perceives and far above anything the
# analysis pass can make expensive.
TICK_SECONDS = 0.25


def _frame(seq: int, event: str, data: Any) -> bytes:
    return (
        f"id: {seq}\n"
        f"event: {event}\n"
        f"data: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"
    ).encode("utf-8")


class _Subscriber:
    __slots__ = ("queue", "loop", "lagged")

    def __init__(self, queue: "asyncio.Queue[Optional[bytes]]", loop: asyncio.AbstractEventLoop):
        self.queue = queue
        self.loop = loop
        self.lagged = False


class EventHub:
    """Fan-out to every open browser stream, plus a short replay ring."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subs: List[_Subscriber] = []
        self._ring: Deque[Tuple[int, bytes]] = deque(maxlen=RING_SIZE)
        self._seq = 0
        self._run_id = uuid.uuid4().hex
        self._dirty = False
        self._ticker: Optional[asyncio.Task] = None
        self._snapshot_provider: Optional[Callable[[], Dict[str, Any]]] = None

    # ── wiring ───────────────────────────────────────────────────────────
    @property
    def run_id(self) -> str:
        return self._run_id

    def set_snapshot_provider(self, fn: Callable[[], Dict[str, Any]]) -> None:
        """Register what a `sync` frame carries.

        Late-bound on purpose: this module must not import the scheduler or
        the API, and the payload must be the same one the polling endpoint
        returns or the fallback would describe a different world.
        """
        self._snapshot_provider = fn

    def snapshot(self) -> Dict[str, Any]:
        fn = self._snapshot_provider
        if fn is None:
            return {}
        try:
            return fn()
        except Exception:  # noqa: BLE001 — a status probe must never break the stream
            logger.exception("Construction du snapshot d'événement impossible")
            return {}

    # ── publishing ───────────────────────────────────────────────────────
    def publish(self, event: str, data: Any) -> int:
        """Send one frame to every subscriber. Returns how many got it.

        Safe from any thread. Never blocks: a subscriber whose queue is
        full is dropped rather than waited for.
        """
        with self._lock:
            if not self._subs:
                # Still sequence nothing and keep no ring entry — a frame
                # nobody can receive is not a gap anyone can detect.
                return 0
            self._seq += 1
            payload = _frame(self._seq, event, data)
            self._ring.append((self._seq, payload))
            targets = list(self._subs)

        delivered = 0
        for sub in targets:
            if self._deliver(sub, payload):
                delivered += 1
        return delivered

    def _deliver(self, sub: _Subscriber, payload: Optional[bytes]) -> bool:
        def put() -> None:
            try:
                sub.queue.put_nowait(payload)
            except asyncio.QueueFull:
                sub.lagged = True
                # Wake the generator so it can end itself.
                try:
                    sub.queue.put_nowait(None)
                except asyncio.QueueFull:
                    pass

        try:
            sub.loop.call_soon_threadsafe(put)
            return True
        except RuntimeError:
            # The loop is closed; the subscriber is already gone.
            return False

    def mark_dirty(self) -> None:
        """Note that the status snapshot changed. Cheap enough for a hot path."""
        self._dirty = True

    # ── subscription ─────────────────────────────────────────────────────
    def subscribe(self, loop: asyncio.AbstractEventLoop) -> Optional[_Subscriber]:
        """Register a stream. Returns None when the cap is reached."""
        sub = _Subscriber(asyncio.Queue(maxsize=QUEUE_DEPTH), loop)
        with self._lock:
            if len(self._subs) >= MAX_SUBSCRIBERS:
                return None
            self._subs.append(sub)
        return sub

    def unsubscribe(self, sub: _Subscriber) -> None:
        with self._lock:
            try:
                self._subs.remove(sub)
            except ValueError:
                pass

    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subs)

    # ── replay ───────────────────────────────────────────────────────────
    def replay_since(self, last_event_id: Optional[str], run_id: Optional[str]) -> Optional[List[bytes]]:
        """Frames a reconnecting client missed, or None when it cannot be caught up.

        None means "resynchronise": no cursor, a cursor from a previous run,
        or a cursor the ring has already rolled past.
        """
        if not last_event_id:
            return None
        if run_id is not None and run_id != self._run_id:
            return None
        try:
            cursor = int(last_event_id)
        except (TypeError, ValueError):
            return None
        with self._lock:
            if cursor == self._seq:
                return []
            if not self._ring:
                # Nothing has been published since this hub started, so a
                # cursor from this run is by definition up to date.
                return [] if cursor <= self._seq else None
            oldest = self._ring[0][0]
            if cursor < oldest - 1 or cursor > self._seq:
                return None
            return [payload for seq, payload in self._ring if seq > cursor]

    # ── lifecycle ────────────────────────────────────────────────────────
    def start_ticker(self, loop: asyncio.AbstractEventLoop) -> None:
        """Begin turning `mark_dirty` into `sync` frames, at most 4/s."""
        if self._ticker is not None and not self._ticker.done():
            return
        self._ticker = loop.create_task(self._tick_forever())

    async def _tick_forever(self) -> None:
        try:
            while True:
                await asyncio.sleep(TICK_SECONDS)
                if not self._dirty:
                    continue
                self._dirty = False
                if self.subscriber_count() == 0:
                    continue
                self.publish("sync", self.snapshot())
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Le ticker d'événements s'est arrêté")

    def close_all(self) -> None:
        """End every open stream. Called immediately before the server stops.

        Not from a shutdown hook: uvicorn drains connections before it runs
        those, and an open stream is exactly what stops the drain finishing.
        """
        with self._lock:
            targets = list(self._subs)
            self._subs.clear()
        for sub in targets:
            self._deliver(sub, None)
        ticker = self._ticker
        if ticker is not None and not ticker.done():
            try:
                ticker.get_loop().call_soon_threadsafe(ticker.cancel)
            except RuntimeError:
                pass
        self._ticker = None

    def reset(self) -> None:
        """Test helper: forget every subscriber, frame and sequence number."""
        self.close_all()
        with self._lock:
            self._ring.clear()
            self._seq = 0
            self._dirty = False
            self._run_id = uuid.uuid4().hex


hub = EventHub()

# SPDX-License-Identifier: GPL-3.0-or-later
"""In-memory, thread-safe view of what the sync machinery is doing right now.

Feeds ``GET /api/sync/status`` so the UI can say which account is being
fetched, how far the analysis pass is, and whether an account has a live
IMAP IDLE connection. Nothing here is persisted: the durable per-account
record (cursor, last error, backoff) stays in the ``sync_state`` table.
"""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterable, Optional

PHASE_IDLE = "idle"
PHASE_FETCHING = "fetching"
PHASE_HYDRATING = "hydrating"
PHASE_ANALYSING = "analysing"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class SyncProgress:
    """Mutable status board. Every writer takes the lock; ``snapshot()``
    returns plain dicts so callers never see a half-updated entry."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._revision = 0
        # Called on every change, from whichever thread made it. It must do
        # almost nothing — `_bump` runs inside the fetch pass with the fetch
        # lock held, and once per message during analysis. The event hub
        # registers a flag-setter here and builds the actual payload on its
        # own timer.
        self._on_change: Optional[Callable[[], None]] = None
        self._fetch: Dict[str, Any] = {
            "active": False, "trigger": None,
            "started_at": None, "finished_at": None,
        }
        self._analysis: Dict[str, Any] = {
            "active": False, "phase": PHASE_IDLE, "account": None,
            "done": 0, "total": 0,
            "started_at": None, "finished_at": None,
        }
        self._accounts: Dict[str, Dict[str, Any]] = {}
        self._push: Dict[str, Dict[str, Any]] = {}

    # ── helpers ──────────────────────────────────────────────────────────
    def _bump(self) -> None:
        self._revision += 1
        cb = self._on_change
        if cb is not None:
            try:
                cb()
            except Exception:  # noqa: BLE001 — a listener must never break a pass
                pass

    def set_on_change(self, fn: Optional[Callable[[], None]]) -> None:
        self._on_change = fn

    def _acc(self, email: str) -> Dict[str, Any]:
        entry = self._accounts.get(email)
        if entry is None:
            entry = {
                "phase": PHASE_IDLE, "started_at": None, "finished_at": None,
                "fetched": 0, "new": 0, "error": None,
                "last_new_count": 0, "last_new_at": None,
            }
            self._accounts[email] = entry
        return entry

    # ── fetch pass ───────────────────────────────────────────────────────
    def fetch_started(self, trigger: str, accounts: Iterable[str]) -> None:
        with self._lock:
            self._fetch.update({
                "active": True, "trigger": trigger,
                "started_at": _now_iso(), "finished_at": None,
            })
            for email in accounts:
                self._acc(email)
            self._bump()

    def fetch_finished(self) -> None:
        with self._lock:
            self._fetch.update({"active": False, "finished_at": _now_iso()})
            # A pass that was abandoned (watchdog) must not leave an account
            # looking busy forever.
            for entry in self._accounts.values():
                if entry["phase"] == PHASE_FETCHING:
                    entry["phase"] = PHASE_IDLE
                    entry["finished_at"] = _now_iso()
            self._bump()

    def account_fetch_started(self, email: str) -> None:
        with self._lock:
            entry = self._acc(email)
            entry.update({
                "phase": PHASE_FETCHING, "started_at": _now_iso(),
                "finished_at": None, "fetched": 0, "new": 0, "error": None,
            })
            self._bump()

    def account_fetch_progress(self, email: str, fetched: int, new: int) -> None:
        with self._lock:
            entry = self._acc(email)
            entry["fetched"] = int(fetched)
            entry["new"] = int(new)
            self._bump()

    def account_fetch_finished(self, email: str, *, error: Optional[str] = None,
                               new: int = 0) -> None:
        with self._lock:
            entry = self._acc(email)
            entry.update({
                "phase": PHASE_IDLE, "finished_at": _now_iso(),
                "error": (str(error)[:300] if error else None), "new": int(new),
            })
            if new > 0:
                entry["last_new_count"] = int(new)
                entry["last_new_at"] = _now_iso()
            self._bump()

    # ── analysis pass ────────────────────────────────────────────────────
    def analysis_started(self, phase: str = PHASE_HYDRATING) -> None:
        with self._lock:
            self._analysis.update({
                "active": True, "phase": phase, "account": None,
                "done": 0, "total": 0,
                "started_at": _now_iso(), "finished_at": None,
            })
            self._bump()

    def analysis_phase(self, phase: str, *, account: Optional[str] = None,
                       done: int = 0, total: int = 0) -> None:
        with self._lock:
            self._analysis.update({
                "phase": phase, "account": account,
                "done": int(done), "total": int(total),
            })
            self._bump()

    def analysis_progress(self, done: int, total: int) -> None:
        with self._lock:
            self._analysis["done"] = int(done)
            self._analysis["total"] = int(total)
            self._bump()

    def analysis_finished(self) -> None:
        with self._lock:
            self._analysis.update({
                "active": False, "phase": PHASE_IDLE, "account": None,
                "finished_at": _now_iso(),
            })
            self._bump()

    # ── IMAP IDLE (push) ─────────────────────────────────────────────────
    def push_state(self, email: str, connected: bool, *,
                   supported: Optional[bool] = None,
                   error: Optional[str] = None) -> None:
        with self._lock:
            entry = self._push.get(email) or {
                "connected": False, "supported": None,
                "error": None, "since": None,
            }
            was_connected = entry["connected"]
            entry["connected"] = bool(connected)
            if supported is not None:
                entry["supported"] = bool(supported)
            entry["error"] = (str(error)[:300] if error else None)
            if connected and not was_connected:
                entry["since"] = _now_iso()
            if not connected:
                entry["since"] = None
            self._push[email] = entry
            self._bump()

    def forget_push(self, emails: Iterable[str]) -> None:
        with self._lock:
            for email in emails:
                self._push.pop(email, None)
            self._bump()

    # ── read side ────────────────────────────────────────────────────────
    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "revision": self._revision,
                "fetch": dict(self._fetch),
                "analysis": dict(self._analysis),
                "accounts": {k: dict(v) for k, v in self._accounts.items()},
                "push": {k: dict(v) for k, v in self._push.items()},
            }

    def reset(self) -> None:
        """Test helper: wipe everything (module singleton survives reloads)."""
        with self._lock:
            self.__init__()  # type: ignore[misc]


progress = SyncProgress()

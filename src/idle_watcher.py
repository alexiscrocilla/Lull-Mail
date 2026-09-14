# SPDX-License-Identifier: GPL-3.0-or-later
"""IMAP IDLE watcher (RFC 2177).

One long-lived connection per enabled account sits in ``IDLE`` and wakes the
fetch pass the moment the server announces new mail — instead of waiting for
the next polling tick. Polling stays as the safety net: for servers without
IDLE, for the seconds between two reconnects, and for anything IDLE missed.

Design constraints:

* The watcher never touches SQLite. It only calls ``on_new_mail(email)``,
  which the scheduler turns into a targeted fetch pass (debounced).
* Every network call has a socket timeout and every ``idle_check()`` is short
  (``IDLE_CHECK_SECONDS``), so ``stop()`` and a forced reconnect after
  wake-from-sleep take effect within seconds, not minutes.
* Failures back off exponentially (15 s → 10 min) and never crash the thread.
"""

from __future__ import annotations

import logging
import ssl
import threading
import time
from typing import Any, Callable, Dict, Iterable, List, Optional

from src.sync_progress import progress as _progress

logger = logging.getLogger(__name__)

# Re-issue IDLE well under the 29-minute RFC cap: consumer NAT boxes drop a
# silent TCP session much sooner than that.
IDLE_RENEW_SECONDS = 4 * 60
# How long a single idle_check() may block — bounds stop / kick latency.
IDLE_CHECK_SECONDS = 30
CONNECT_TIMEOUT_SECONDS = 30
RECONNECT_MIN_SECONDS = 15
RECONNECT_MAX_SECONDS = 600


def make_client(account: Dict[str, Any], timeout: float = CONNECT_TIMEOUT_SECONDS):
    """Open and authenticate an ``imapclient.IMAPClient`` for *account*.

    Mirrors ``email_fetcher._make_connection`` (same TLS policy, same
    STARTTLS handling, same verify_ssl guard) but on imapclient, whose
    ``idle()`` / ``idle_check()`` API stdlib ``imaplib`` lacks.
    """
    from imapclient import IMAPClient
    from src.security.tls import assert_verify_ssl_allowed

    host = account["imap_host"]
    port = int(account["imap_port"])
    use_ssl = account.get("ssl", True)
    starttls = account.get("starttls", False)
    verify = account.get("verify_ssl", True)
    assert_verify_ssl_allowed(host, verify)

    ctx = ssl.create_default_context()
    if not verify:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    client = IMAPClient(
        host, port=port, ssl=use_ssl,
        ssl_context=ctx if use_ssl else None,
        timeout=timeout,
    )
    try:
        if not use_ssl and starttls:
            client.starttls(ctx)
        client.login(account["username"], account["password"])
    except Exception:
        try:
            client.shutdown()
        except Exception:  # noqa: BLE001
            pass
        raise
    return client


def _has_new_mail(responses: Iterable[Any]) -> bool:
    """``idle_check()`` yields tuples such as ``(b'12', b'EXISTS')``. Only
    EXISTS / RECENT mean "something arrived"; FLAGS and EXPUNGE do not."""
    for resp in responses or ():
        try:
            if len(resp) >= 2 and resp[1] in (b"EXISTS", b"RECENT", "EXISTS", "RECENT"):
                return True
        except TypeError:
            continue
    return False


def _supports_idle(capabilities: Iterable[Any]) -> bool:
    for cap in capabilities or ():
        if cap in (b"IDLE", "IDLE"):
            return True
    return False


class AccountWatcher(threading.Thread):
    """Keeps one account in IDLE until ``stop()``; reconnects on error."""

    def __init__(
        self,
        account: Dict[str, Any],
        on_new_mail: Callable[[str], None],
        client_factory: Callable[[Dict[str, Any]], Any] = make_client,
        *,
        renew_seconds: float = IDLE_RENEW_SECONDS,
        check_seconds: float = IDLE_CHECK_SECONDS,
        reconnect_min: float = RECONNECT_MIN_SECONDS,
        reconnect_max: float = RECONNECT_MAX_SECONDS,
    ) -> None:
        super().__init__(daemon=True, name=f"imap-idle:{account.get('email', '?')}")
        self.account = account
        self.email = account.get("email", "?")
        self._on_new_mail = on_new_mail
        self._factory = client_factory
        self._renew = renew_seconds
        self._check = check_seconds
        self._reconnect_min = reconnect_min
        self._reconnect_max = reconnect_max
        # NOT `_stop`: threading.Thread already has a private _stop() method
        # and join() calls it the moment it observes the thread has finished.
        # Shadowing it with an Event made every such join raise
        # "TypeError: 'Event' object is not callable" -- non-deterministically,
        # because join() only reaches that branch when the thread really is
        # done inside the timeout. It passed locally and failed on CI.
        self._stopping = threading.Event()
        self._kick = threading.Event()
        # Set when this watcher has been REPLACED rather than shut down. It
        # can be parked up to `check_seconds` inside a socket call, so its
        # final "push is off" lands seconds after its replacement already
        # reported "push is on" -- and the sidebar then says the mailbox lost
        # instant delivery while it is sitting in IDLE. A retired watcher
        # publishes nothing; only the live one speaks for the account.
        self._retired = threading.Event()
        self.connects = 0      # for tests / diagnostics
        self.fired = 0

    def _publish(self, connected: bool, **kw) -> None:
        if self._retired.is_set():
            return
        _progress.push_state(self.email, connected, **kw)

    # ── control ──────────────────────────────────────────────────────────
    def stop(self) -> None:
        self._stopping.set()

    def retire(self) -> None:
        """Stop, and say nothing more about this mailbox on the way out.

        For replacement only. A real shutdown uses stop(), because there the
        final "push is off" is the truth and nothing races it.
        """
        self._retired.set()
        self._stopping.set()

    def kick(self) -> None:
        """Force a reconnect at the next opportunity (after wake-from-sleep
        the old socket is usually dead but not yet known to be)."""
        self._kick.set()

    # ── main loop ────────────────────────────────────────────────────────
    def run(self) -> None:  # noqa: C901 — one loop, deliberately explicit
        delay = self._reconnect_min
        while not self._stopping.is_set():
            client = None
            try:
                client = self._factory(self.account)
                self.connects += 1
                if not _supports_idle(client.capabilities()):
                    logger.info("[%s] Le serveur IMAP ne supporte pas IDLE — polling seul", self.email)
                    self._publish(False, supported=False)
                    return
                client.select_folder("INBOX", readonly=True)
                self._publish(True, supported=True)
                delay = self._reconnect_min
                logger.info("[%s] IMAP IDLE actif", self.email)

                while not self._stopping.is_set():
                    if self._kick.is_set():
                        self._kick.clear()
                        raise _Reconnect("réveil")
                    fired = self._idle_once(client)
                    if fired:
                        self.fired += 1
                        self._fire()
            except _Reconnect as why:
                logger.info("[%s] Reconnexion IDLE (%s)", self.email, why)
                self._publish(False)
                delay = self._reconnect_min
                self._stopping.wait(1.0)
            except Exception as e:  # noqa: BLE001 — never let the thread die
                if self._stopping.is_set():
                    break
                logger.warning("[%s] IDLE interrompu (%s) — nouvel essai dans %ds",
                               self.email, e, int(delay))
                self._publish(False, error=f"{type(e).__name__}: {e}")
                self._stopping.wait(delay)
                delay = min(self._reconnect_max, delay * 2)
            finally:
                if client is not None:
                    try:
                        client.logout()
                    except Exception:  # noqa: BLE001
                        try:
                            client.shutdown()
                        except Exception:  # noqa: BLE001
                            pass
        self._publish(False)

    def _idle_once(self, client) -> bool:
        """One IDLE session: at most ``renew_seconds`` long, polled in
        ``check_seconds`` slices so stop/kick are honoured quickly.
        Returns True when the server announced new mail."""
        client.idle()
        fired = False
        deadline = time.monotonic() + self._renew
        try:
            while not self._stopping.is_set() and not self._kick.is_set():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                responses = client.idle_check(timeout=min(self._check, remaining))
                if responses and _has_new_mail(responses):
                    fired = True
                    break
        finally:
            try:
                _text, responses = client.idle_done()
                if responses and _has_new_mail(responses):
                    fired = True
            except Exception:  # noqa: BLE001 — a broken DONE is a reconnect, handled by run()
                raise
        return fired

    def _fire(self) -> None:
        try:
            self._on_new_mail(self.email)
        except Exception:  # noqa: BLE001
            logger.exception("[%s] callback nouveau courrier a échoué", self.email)


class _Reconnect(Exception):
    """Internal: leave the IDLE loop and open a fresh connection."""


class IdleManager:
    """Owns one ``AccountWatcher`` per account. Safe to start/stop/restart."""

    def __init__(self, client_factory: Callable[[Dict[str, Any]], Any] = make_client) -> None:
        self._factory = client_factory
        self._watchers: Dict[str, AccountWatcher] = {}
        self._lock = threading.Lock()

    def start(self, accounts: Iterable[Dict[str, Any]],
              on_new_mail: Callable[[str], None]) -> List[str]:
        """(Re)start watchers for *accounts*; returns the emails watched."""
        # `retire=True`: these watchers are being REPLACED, not shut down, so
        # they must not publish a final "push is off" for a mailbox whose new
        # watcher is about to report it connected.
        self.stop(retire=True)
        started: List[str] = []
        with self._lock:
            for acc in accounts:
                if not acc.get("enabled", True):
                    continue
                email = acc.get("email")
                if not email or email in self._watchers:
                    continue
                w = AccountWatcher(acc, on_new_mail, self._factory)
                self._watchers[email] = w
                w.start()
                started.append(email)
        if started:
            logger.info("IMAP IDLE : %d compte(s) surveillé(s)", len(started))
        return started

    def stop(self, join_timeout: float = 2.0, retire: bool = False) -> None:
        with self._lock:
            watchers = list(self._watchers.values())
            self._watchers.clear()
        for w in watchers:
            w.retire() if retire else w.stop()
        for w in watchers:
            w.join(timeout=join_timeout)
        # Only on a real shutdown. During a replacement the new watchers are
        # about to publish for these same mailboxes, and forgetting their
        # state here would blank the sidebar's push indicator every time an
        # account is edited.
        if watchers and not retire:
            _progress.forget_push([w.email for w in watchers])

    def kick(self) -> None:
        with self._lock:
            watchers = list(self._watchers.values())
        for w in watchers:
            w.kick()

    def watched(self) -> List[str]:
        with self._lock:
            return list(self._watchers.keys())

    def is_active(self) -> bool:
        with self._lock:
            return any(w.is_alive() for w in self._watchers.values())


idle_manager = IdleManager()

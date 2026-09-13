# SPDX-License-Identifier: GPL-3.0-or-later
"""Mail sync: two independent passes.

* ``fetch_pass()`` — the IMAP delta: new headers for every enabled account,
  persisted in chunks as they arrive. Seconds long, guarded by its own lock,
  never waits for the AI.
* ``analysis_pass()`` — everything slow: offline mutations, body hydration,
  classification / summary / draft. Guarded by a second lock so a long local
  LLM batch can never block the next fetch.

``run_sync()`` keeps the historical "fetch then analyse, synchronously"
contract for callers and tests that still expect one call to do both.

Progress (which account is being fetched, how far the analysis is) is
reported through ``src.sync_progress.progress`` for ``/api/sync/status``.
"""

from __future__ import annotations

import inspect
import logging
import queue
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

from dateutil import parser as dateparser

from src import config as cfg
from src import database as db
from src import injection_guard
from src import draft_verify
from src.ai_processor import init_client, process_email, enrich_draft
from src.attachment_security import policy_from_config
from src.email_fetcher import fetch_emails, persist_attachments
from src.local_classifier import classify as local_classify, extract_domain
from src.notifier import send
from src.sync_progress import (
    PHASE_ANALYSING,
    PHASE_HYDRATING,
    progress,
)

logger = logging.getLogger(__name__)


# Importance_reason value written by the no-AI fallback below. Used as the
# match key by db.requeue_emails_by_reason so a later AI-on sync can
# re-queue these emails for real analysis. Keep in sync with the literal
# in the fabricated result dict.
NO_AI_FALLBACK_REASON = "Non classé (mode sans IA)"

# A fetch pass that has been holding its lock this long is considered hung
# (typically a socket that never came back): the next caller breaks the lock
# and proceeds. Socket timeouts make this a last resort, not the norm.
FETCH_WATCHDOG_SECONDS = 15 * 60
# Per-account budget inside one fetch pass. Beyond it the account is marked
# in error (with backoff) and the pass moves on without it.
ACCOUNT_FETCH_TIMEOUT_SECONDS = 10 * 60
# Analysis passes are long by nature (local LLM); the watchdog is looser.
ANALYSIS_WATCHDOG_SECONDS = 60 * 60
# An analysis pass yields after this long so the periodic trigger can start a
# fresh one (fresh config, fresh backoff state) instead of one endless loop.
ANALYSIS_TIME_BUDGET_SECONDS = 10 * 60
# Bodies claimed per account per hydration round.
HYDRATION_BATCH = 30
# Unsubscribe headers re-fetched per account per analysis pass. One IMAP
# round-trip each, so keep the slice small enough to stay invisible.
UNSUB_BACKFILL_PER_PASS = 300
# Queued deletions replayed per pass. High because they share one connection
# per account, unlike flag changes which open one each.
TRASH_DRAIN_BATCH = 250
# IDLE notifications are coalesced for this long before a targeted fetch.
IDLE_DEBOUNCE_SECONDS = 2.0


def _neutral_result(category: str, score: int, reason: str, summary: str = "") -> dict:
    """No-token classification result for the non-LLM paths (local cache hit,
    per-account AI off, injection-flagged, no-AI mode). Single source of truth
    for the result contract consumed by db.update_email_ai."""
    return {
        "category": category,
        "importance_score": score,
        "importance_reason": reason,
        "summary": summary,
        "needs_reply": False,
        "draft_response": None,
        "tokens_in": 0,
        "tokens_out": 0,
        "local_classified": True,
    }


def _is_too_old(date_str: str, max_age_days: int) -> bool:
    if not date_str or max_age_days <= 0:
        return False
    try:
        dt = dateparser.parse(date_str)
        if dt is None:
            return False
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        age = datetime.now(timezone.utc) - dt
        return age.days > max_age_days
    except Exception:
        return False


# ═══════════════════════════════════════════════════════════════════════════
# Per-account persistence (always on the fetch-pass thread)
# ═══════════════════════════════════════════════════════════════════════════

class _AccountCtx:
    """Write-side state for one account during a fetch pass.

    Every SQLite write for fetched mail goes through here, on the thread that
    runs ``fetch_pass`` — never on a fetch worker — so writes stay serialised.
    Chunks may arrive several times before ``finish()``; the UID cursor is
    advanced after every chunk, so an interrupted pass resumes where it left.
    """

    def __init__(self, acc: Dict[str, Any], last_uid: Optional[str], att_policy) -> None:
        self.acc = acc
        self.email = acc["email"]
        self.last_uid = last_uid
        self.max_uid = last_uid
        self.att_policy = att_policy
        self.uidvalidity: Optional[str] = None
        self.remapped = False
        self.regression_checked = False
        self.new = 0
        self.fetched = 0
        self.done = False

    def _apply_uidvalidity(self, server_uidvalidity: Optional[str], changed: bool) -> None:
        if server_uidvalidity:
            self.uidvalidity = server_uidvalidity
        if changed and server_uidvalidity and not self.remapped:
            logger.warning(
                f"[{self.email}] Réinitialisation UIDVALIDITY vers {server_uidvalidity}"
            )
            db.remap_account_uids_on_uidvalidity_change(self.email, server_uidvalidity)
            self.last_uid = None
            self.max_uid = None
            self.remapped = True

    def _check_uid_regression(self, emails: List[Dict]) -> None:
        # Detect UID regression: server reset UIDs (mailbox migration). When
        # every fetched UID is below our stored last_uid the old cursor would
        # never move and new mail would be missed forever. Checked on the
        # first chunk only — later chunks carry higher UIDs by construction.
        if self.regression_checked:
            return
        self.regression_checked = True
        if not emails or not self.last_uid or self.remapped:
            return
        try:
            max_fetched = max(int(em["uid"]) for em in emails if em.get("uid"))
            if max_fetched < int(self.last_uid):
                logger.warning(
                    f"[{self.email}] Régression d'UID détectée "
                    f"(server max={max_fetched} < last_uid={self.last_uid}), "
                    "réinitialisation du curseur."
                )
                self.max_uid = None
        except (ValueError, TypeError):
            pass

    def persist_chunk(self, emails: List[Dict], server_uidvalidity: Optional[str] = None,
                      uidvalidity_changed: bool = False) -> int:
        """Insert *emails* (already-known message-ids are skipped), advance the
        cursor, publish progress. Returns the number of rows actually inserted."""
        self._apply_uidvalidity(server_uidvalidity, uidvalidity_changed)
        self._check_uid_regression(emails)
        new = 0
        for em in emails:
            if not db.email_exists(em["message_id"]):
                db.insert_email(em)
                new += 1
                # Attachments are persisted only the FIRST time we see the
                # message — re-syncs of an existing UID never write duplicate
                # files. Failures are logged but never fatal: the email still
                # lands in the inbox even if PJ extraction explodes.
                parts = em.get("_attachment_parts") or []
                if parts and self.att_policy.enabled:
                    try:
                        persist_attachments(
                            message_id=em["message_id"],
                            account_email=em["account"],
                            parts=parts,
                            policy=self.att_policy,
                        )
                    except Exception as e:
                        logger.warning(
                            f"[{em['account']}] persist_attachments "
                            f"crashed for {em['message_id']}: {e}"
                        )
            else:
                if em.get("uid"):
                    db.update_email_uid(em["message_id"], self.email, em["uid"])

            try:
                if em.get("uid"):
                    uid_int = int(em["uid"])
                    max_int = int(self.max_uid) if self.max_uid else 0
                    if uid_int > max_int:
                        self.max_uid = em["uid"]
            except (ValueError, TypeError):
                pass

        self.fetched += len(emails)
        self.new += new
        if emails:
            db.update_sync_state(self.email, last_uid=self.max_uid, uidvalidity=self.uidvalidity)
        progress.account_fetch_progress(self.email, self.fetched, self.new)
        return new

    def finish(self, error: Optional[str] = None, server_uidvalidity: Optional[str] = None,
               uidvalidity_changed: bool = False) -> None:
        if self.done:
            return
        self.done = True
        if error:
            state = db.get_sync_state(self.email) or {}
            fails = state.get("consecutive_failures", 0) + 1
            base_delay = 30  # seconds
            max_delay = 1800  # 30 min
            delay = min(max_delay, base_delay * (2 ** min(fails - 1, 6)))
            jittered = int(delay * random.uniform(0.5, 1.5))
            db.set_sync_error(self.email, error, backoff_seconds=jittered)
            logger.warning(
                f"[{self.email}] Erreur enregistrée ({fails}e échec, backoff {jittered}s) : {error}"
            )
            progress.account_fetch_finished(self.email, error=error, new=self.new)
            return
        self._apply_uidvalidity(server_uidvalidity, uidvalidity_changed)
        db.update_sync_state(self.email, last_uid=self.max_uid, uidvalidity=self.uidvalidity)
        logger.info(f"[{self.email}] {self.new} nouveau(x) ({self.fetched} reçu(s))")
        progress.account_fetch_finished(self.email, new=self.new)


def _persist_account(
    acc,
    last_uid,
    emails,
    fetch_error,
    att_policy,
    server_uidvalidity=None,
    uidvalidity_changed=False,
) -> int:
    """Store one account's fetched emails in one go and advance its cursor.

    Kept for callers that hold a complete list (tests, one-shot tools); the
    fetch pass itself persists chunk by chunk through ``_AccountCtx``.
    Returns the number of emails newly inserted.
    """
    logger.info(f"→ Sync {acc['email']} ...")
    ctx = _AccountCtx(acc, last_uid, att_policy)
    if fetch_error:
        ctx.finish(error=fetch_error)
        return 0
    ctx.persist_chunk(emails, server_uidvalidity, uidvalidity_changed)
    ctx.finish(server_uidvalidity=server_uidvalidity, uidvalidity_changed=uidvalidity_changed)
    return ctx.new


# ═══════════════════════════════════════════════════════════════════════════
# Offline mutations
# ═══════════════════════════════════════════════════════════════════════════

def _drain_trash_ops(acc_by_email: Dict[str, Dict]) -> int:
    """Replay queued deletions, one IMAP connection per account.

    Trash used to go through the same per-UID path as a flag change, which
    opens and tears down a full IMAP connection per message. A cleanup action
    on a thousand messages was a thousand logins at fifty a minute — twenty
    minutes of queue, behind which every ordinary "mark this read" waited,
    and long enough for a large provider to start throttling.
    """
    from src.email_fetcher import batch_move_to_trash

    claimed = db.claim_pending_ops(limit=TRASH_DRAIN_BATCH, operation="trash")
    if not claimed:
        return 0

    by_acc: Dict[str, List[Dict]] = {}
    for op in claimed:
        if not op.get("uid"):
            db.fail_pending_op(op["id"], op["revision"], "UID non disponible",
                               retry_delay_seconds=30)
            continue
        if op["account_email"] not in acc_by_email:
            continue
        by_acc.setdefault(op["account_email"], []).append(op)

    done = 0
    for account_email, ops in by_acc.items():
        acc = acc_by_email[account_email]
        by_uid: Dict[str, List[Dict]] = {}
        for op in ops:
            by_uid.setdefault(op["uid"], []).append(op)

        def _on_each(uid, ok, _by_uid=by_uid):
            for op in _by_uid.get(uid, []):
                if ok:
                    db.complete_pending_op(op["id"], op["revision"])
                else:
                    db.fail_pending_op(op["id"], op["revision"],
                                       "Échec suppression IMAP", retry_delay_seconds=30)

        try:
            batch_move_to_trash(acc, list(by_uid.keys()), on_each=_on_each)
            done += len(ops)
        except Exception as e:  # noqa: BLE001 — one account must not sink the rest
            logger.warning(f"[{account_email}] suppression par lot : {e}")
            for op in ops:
                db.fail_pending_op(op["id"], op["revision"], str(e)[:200] or "Échec",
                                   retry_delay_seconds=30)
    return done


def _drain_pending_ops(accounts: List[Dict]):
    """Replay offline mutations (seen, flagged, trash) queued in pending_ops."""
    from src.email_fetcher import (
        mark_seen_on_server,
        mark_unseen_on_server,
        set_flagged_on_server,
    )
    acc_by_email = {a["email"]: a for a in accounts}
    _drain_trash_ops(acc_by_email)

    # Flag changes still open one connection each, so they stay on a small
    # batch: they arrive one at a time as the user reads mail, never in
    # thousands the way a cleanup action does.
    claimed = db.claim_pending_ops(limit=50, exclude_operations=["trash"])
    for op in claimed:
        acc = acc_by_email.get(op["account_email"])
        if not acc:
            continue
        uid = op.get("uid")
        if not uid:
            db.fail_pending_op(op["id"], op["revision"], "UID non disponible", retry_delay_seconds=30)
            continue

        operation = op["operation"]
        val = op.get("desired_value", "")
        ok = False
        err = ""
        try:
            if operation == "seen":
                if val == "1":
                    ok = mark_seen_on_server(acc, uid)
                else:
                    ok = mark_unseen_on_server(acc, uid)
            elif operation == "flagged":
                ok = set_flagged_on_server(acc, uid, val == "1")
            else:
                # 'trash' never reaches here — _drain_trash_ops claimed it.
                ok = True
        except Exception as e:
            ok = False
            err = str(e)

        if ok:
            db.complete_pending_op(op["id"], op["revision"])
        else:
            db.fail_pending_op(
                op["id"],
                op["revision"],
                error=err or "Échec opération IMAP",
                retry_delay_seconds=30,
            )


# ═══════════════════════════════════════════════════════════════════════════
# Locks, status
# ═══════════════════════════════════════════════════════════════════════════

_fetch_lock = threading.Lock()
_analysis_lock = threading.Lock()
_fetch_started_at: Optional[float] = None       # time.monotonic()
_analysis_started_at: Optional[float] = None
_last_sync: Optional[str] = None                # HH:MM:SS, historical field
_last_sync_iso: Optional[str] = None
_last_fetch_mono: float = 0.0


def get_last_sync() -> Optional[str]:
    return _last_sync


def get_last_sync_iso() -> Optional[str]:
    return _last_sync_iso


def is_fetching() -> bool:
    return _fetch_lock.locked()


def is_analysing() -> bool:
    return _analysis_lock.locked()


def is_running() -> bool:
    """Historical meaning: "some sync work is happening"."""
    return is_fetching() or is_analysing()


def _acquire_or_break(lock: threading.Lock, started_at: Optional[float],
                      label: str, watchdog_seconds: float) -> bool:
    """Non-blocking acquire with a watchdog: a holder older than
    *watchdog_seconds* is presumed hung and its lock is broken."""
    if lock.acquire(blocking=False):
        return True
    if started_at is not None and time.monotonic() - started_at > watchdog_seconds:
        logger.error(
            "%s bloqué depuis %d s — verrou forcé, reprise.",
            label, int(time.monotonic() - started_at),
        )
        try:
            lock.release()
        except RuntimeError:
            pass
        return lock.acquire(blocking=False)
    return False


def get_status() -> Dict[str, Any]:
    """Snapshot for ``/api/sync/status`` (the API adds DB-backed fields)."""
    snap = progress.snapshot()
    fetching = is_fetching()
    analysing = is_analysing()
    if fetching:
        phase = "fetching"
    elif analysing:
        phase = snap["analysis"].get("phase") or PHASE_ANALYSING
    else:
        phase = "idle"
    stuck = bool(
        _fetch_started_at is not None
        and time.monotonic() - _fetch_started_at > FETCH_WATCHDOG_SECONDS
    )
    return {
        "running": fetching or analysing,
        "fetching": fetching,
        "analysing": analysing,
        "phase": phase,
        "stuck": stuck,
        "last_sync": _last_sync,
        "last_sync_iso": _last_sync_iso,
        "fetch": snap["fetch"],
        "analysis": snap["analysis"],
        "accounts": snap["accounts"],
        "push": snap["push"],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Fetch pass
# ═══════════════════════════════════════════════════════════════════════════

_FETCH_OPTIONAL_KWARGS = ("known_uidvalidity", "on_chunk")


def _fetch_kwargs_supported() -> Set[str]:
    """Which optional keyword arguments the current ``fetch_emails`` accepts.
    Tests substitute simplified fakes; the real function takes them all."""
    try:
        sig = inspect.signature(fetch_emails)
    except (TypeError, ValueError):
        return set(_FETCH_OPTIONAL_KWARGS)
    params = sig.parameters
    if any(p.kind == p.VAR_KEYWORD for p in params.values()):
        return set(_FETCH_OPTIONAL_KWARGS)
    return {name for name in _FETCH_OPTIONAL_KWARGS if name in params}


def _invoke_fetch(acc, luid, kuid, limit, on_chunk=None, supports: Optional[Set[str]] = None):
    if supports is None:
        supports = _fetch_kwargs_supported()
    kwargs: Dict[str, Any] = {"last_uid": luid, "limit": limit}
    if "known_uidvalidity" in supports:
        kwargs["known_uidvalidity"] = kuid
    if on_chunk is not None and "on_chunk" in supports:
        kwargs["on_chunk"] = on_chunk
    try:
        return fetch_emails(acc, **kwargs)
    except TypeError as e:
        if "known_uidvalidity" in str(e) or "on_chunk" in str(e):
            kwargs.pop("known_uidvalidity", None)
            kwargs.pop("on_chunk", None)
            return fetch_emails(acc, **kwargs)
        raise


def _normalise_result(res) -> Tuple[List[Dict], Optional[str], Optional[str], bool]:
    if isinstance(res, tuple) and len(res) == 4:
        return res
    if isinstance(res, tuple) and len(res) == 2:
        emails, err = res
        return emails, err, None, False
    return [], f"Unexpected fetch result: {res!r}", None, False


def _drain_chunks(q: "queue.Queue", ctxs: List[_AccountCtx]) -> int:
    new = 0
    while True:
        try:
            idx, payload = q.get_nowait()
        except queue.Empty:
            return new
        ctx = ctxs[idx]
        if ctx.done:
            continue
        try:
            new += ctx.persist_chunk(
                payload.get("emails") or [],
                payload.get("server_uidvalidity"),
                bool(payload.get("uidvalidity_changed")),
            )
        except Exception as e:  # noqa: BLE001 — one bad chunk must not sink the pass
            logger.warning(f"[{ctx.email}] persistance d'un lot a échoué : {e}")


def _run_fetch_jobs(jobs, limit, att_policy, fetch_workers) -> int:
    """Fetch every account in parallel (network only) and persist on THIS
    thread as chunks arrive. Returns the number of new emails."""
    supports = _fetch_kwargs_supported()
    chunked = "on_chunk" in supports
    q: "queue.Queue" = queue.Queue()
    ctxs = [_AccountCtx(acc, luid, att_policy) for (acc, luid, _kuid) in jobs]

    ex = ThreadPoolExecutor(
        max_workers=max(1, min(int(fetch_workers), len(jobs))),
        thread_name_prefix="imap-fetch",
    )
    futs = {}
    for idx, (acc, luid, kuid) in enumerate(jobs):
        progress.account_fetch_started(acc["email"])
        logger.info(f"→ Sync {acc['email']} ...")
        on_chunk = (lambda payload, i=idx: q.put((i, payload))) if chunked else None
        futs[ex.submit(_invoke_fetch, acc, luid, kuid, limit, on_chunk, supports)] = idx

    total_new = 0
    pending = set(futs)
    deadline = time.monotonic() + ACCOUNT_FETCH_TIMEOUT_SECONDS
    try:
        while pending:
            total_new += _drain_chunks(q, ctxs)
            done = {f for f in pending if f.done()}
            if done:
                # Chunks are queued before the future resolves: drain them
                # first so the cursor never moves past unpersisted mail.
                total_new += _drain_chunks(q, ctxs)
                for f in done:
                    ctx = ctxs[futs[f]]
                    try:
                        emails, err, s_uidval, changed = _normalise_result(f.result())
                    except Exception as e:  # noqa: BLE001 — isolate per-account
                        emails, err, s_uidval, changed = [], f"{type(e).__name__}: {e}", None, False
                    if not chunked and emails and not err:
                        total_new += ctx.persist_chunk(emails, s_uidval, changed)
                    ctx.finish(error=err, server_uidvalidity=s_uidval, uidvalidity_changed=changed)
                pending -= done
                continue
            if time.monotonic() > deadline:
                total_new += _drain_chunks(q, ctxs)
                for f in pending:
                    ctx = ctxs[futs[f]]
                    f.cancel()
                    ctx.finish(error=f"Délai dépassé ({ACCOUNT_FETCH_TIMEOUT_SECONDS} s sans réponse)")
                pending.clear()
                break
            try:
                idx, payload = q.get(timeout=0.25)
            except queue.Empty:
                continue
            ctx = ctxs[idx]
            if not ctx.done:
                try:
                    total_new += ctx.persist_chunk(
                        payload.get("emails") or [],
                        payload.get("server_uidvalidity"),
                        bool(payload.get("uidvalidity_changed")),
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"[{ctx.email}] persistance d'un lot a échoué : {e}")
    finally:
        # Never wait here: a worker stuck in a dying socket would hold the
        # whole pass hostage. Socket timeouts reap it on their own.
        ex.shutdown(wait=False, cancel_futures=True)
    return total_new


def fetch_pass(
    only_accounts: Optional[List[str]] = None,
    *,
    trigger: str = "scheduler",
    ignore_backoff: bool = False,
    chain_analysis: bool = True,
) -> Optional[int]:
    """Pull new headers for every enabled account (or *only_accounts*).

    Returns the number of new emails, or ``None`` when a fetch pass was
    already running (the call is then a no-op). With *chain_analysis* a
    background analysis pass is started afterwards when there is work.
    """
    global _fetch_started_at, _last_sync, _last_sync_iso, _last_fetch_mono

    if not _acquire_or_break(_fetch_lock, _fetch_started_at, "Relève", FETCH_WATCHDOG_SECONDS):
        logger.info("Relève déjà en cours, ignorée (%s).", trigger)
        return None

    _fetch_started_at = time.monotonic()
    total_new = 0
    try:
        conf = cfg.get()
        accounts = [a for a in conf.get("accounts", []) if a.get("enabled", True)]
        if only_accounts:
            wanted = set(only_accounts)
            accounts = [a for a in accounts if a.get("email") in wanted]
        polling = conf.get("polling", {}) or {}
        limit = polling.get("initial_fetch_count", 500)
        fetch_workers = int(polling.get("fetch_workers", 4))
        att_policy = policy_from_config(conf)

        now_iso = datetime.now(timezone.utc).isoformat()
        jobs = []  # (acc, last_uid, known_uidvalidity)
        for acc in accounts:
            state = db.get_sync_state(acc["email"])
            in_backoff = bool(
                state and state.get("backoff_until") and state["backoff_until"] > now_iso
            )
            if in_backoff:
                if ignore_backoff:
                    db.reset_sync_backoff(acc["email"])
                    logger.info(f"[{acc['email']}] Backoff levé (relève {trigger})")
                else:
                    logger.info(
                        f"[{acc['email']}] En backoff jusqu'à {state['backoff_until']}, relève différée"
                    )
                    continue
            jobs.append((
                acc,
                state["last_uid"] if state else None,
                state.get("uidvalidity") if state else None,
            ))

        progress.fetch_started(trigger, [j[0]["email"] for j in jobs])
        if jobs:
            total_new = _run_fetch_jobs(jobs, limit, att_policy, fetch_workers)

        now = datetime.now()
        _last_sync = now.strftime("%H:%M:%S")
        _last_sync_iso = now.astimezone(timezone.utc).isoformat(timespec="seconds")
        _last_fetch_mono = time.monotonic()
        logger.info(f"Relève terminée ({trigger}) : {total_new} nouveau(x) email(s).")
    except Exception as e:
        logger.error(f"Erreur relève : {e}", exc_info=True)
    finally:
        _fetch_started_at = None
        progress.fetch_finished()
        _fetch_lock.release()

    if chain_analysis:
        try:
            if total_new > 0 or db.count_pending() > 0 or db.count_hydration_candidates() > 0:
                request_analysis()
        except Exception:  # noqa: BLE001 — status probes must not fail the pass
            logger.exception("Impossible de lancer l'analyse après la relève")
    return total_new


# ═══════════════════════════════════════════════════════════════════════════
# Analysis pass
# ═══════════════════════════════════════════════════════════════════════════

def _hydrate_round(accounts: List[Dict], att_policy, deadline: float,
                   unreachable: Optional[set] = None) -> int:
    """Download one batch of bodies per account. Returns how many landed.

    `unreachable` is the caller's per-pass set of accounts whose connection
    already failed this pass; a failing account is skipped for the rest of
    it. The inner drain loop this replaced got that for free by abandoning
    the account on the first failure — the outer alternation would
    otherwise retry a dead host once per round.
    """
    from src.email_fetcher import hydrate_email_bodies

    now_iso = datetime.now(timezone.utc).isoformat()
    hydrated = 0
    for acc in accounts:
        if unreachable is not None and acc["email"] in unreachable:
            continue
        state = db.get_sync_state(acc["email"])
        if state and state.get("backoff_until") and state["backoff_until"] > now_iso:
            # The account is unreachable right now: claiming rows would only
            # park them in 'hydrating' until the claim is released.
            continue
        if time.monotonic() >= deadline:
            break
        progress.analysis_phase(PHASE_HYDRATING, account=acc["email"])
        # One batch per account per round, not a drain. The caller already
        # alternates hydrate → analyse; draining here made that alternation
        # a lie, because the analysable set only ever holds rows whose body
        # has landed. On a first sync that meant no message was classified
        # until every message had been downloaded. Login count is unchanged:
        # the fetcher opens and closes one connection per call either way.
        targets = db.claim_emails_for_body_hydration(limit=HYDRATION_BATCH, account=acc["email"])
        if not targets:
            continue
        try:
            got = hydrate_email_bodies(acc, targets, att_policy)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[{acc['email']}] Hydration error: {e}")
            db.release_hydration_claims([t.get("message_id") for t in targets])
            got = 0
        hydrated += got
        if got == 0 and unreachable is not None:
            # Connection-level failure; the claims are already back.
            unreachable.add(acc["email"])
    return hydrated


def _backfill_unsubscribe_headers(accounts: List[Dict], deadline: float) -> int:
    """Fill in the List-Unsubscribe header for rows that never had it captured.

    Mail fetched by any current version carries the header (or the empty-string
    sentinel) from the moment it is inserted, so this only ever touches rows
    synced by an older build — a one-shot migration. It used to be a button on
    the Nettoyage page labelled "Analyser les en-têtes", which meant the
    unsubscribe list was simply empty until the user found and pressed it.
    """
    if db.get_kv("unsubscribe_backfill_done_at"):
        return 0
    from src.email_fetcher import batch_fetch_headers

    rows = db.find_uids_missing_headers()
    if not rows:
        db.set_kv("unsubscribe_backfill_done_at", datetime.now(timezone.utc).isoformat())
        return 0

    logger.info("Recherche des liens de désabonnement : %d message(s) à inspecter", len(rows))
    now_iso = datetime.now(timezone.utc).isoformat()
    by_acc: Dict[str, List[Dict]] = {}
    for r in rows:
        by_acc.setdefault(r["account_email"], []).append(r)

    done = 0
    for acc in accounts:
        if time.monotonic() > deadline:
            break
        pending = by_acc.get(acc["email"]) or []
        if not pending:
            continue
        state = db.get_sync_state(acc["email"])
        if state and state.get("backoff_until") and state["backoff_until"] > now_iso:
            continue

        batch = pending[:UNSUB_BACKFILL_PER_PASS]
        index = {r["uid"]: r["message_id"] for r in batch}

        def _on_each(uid, _ok, parsed, _index=index):
            msg_id = _index.get(uid)
            # `parsed` carries the header keys only when the message was really
            # inspected. On a connection-level failure batch_fetch_headers
            # calls back with a bare {"uid": …}; writing that would stamp the
            # "checked, no header" sentinel and hide the sender from the
            # unsubscribe list forever.
            if not msg_id or "list_unsubscribe" not in parsed:
                return
            try:
                db.update_unsubscribe_headers(msg_id, parsed)
            except Exception as e:  # noqa: BLE001
                logger.warning(f"[{acc['email']}] écriture en-tête {uid} : {e}")

        try:
            batch_fetch_headers(acc, [r["uid"] for r in batch], on_each=_on_each)
            done += len(batch)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[{acc['email']}] recherche des liens de désabonnement : {e}")

    remaining = db.count_emails_missing_headers()
    if remaining == 0:
        db.set_kv("unsubscribe_backfill_done_at", datetime.now(timezone.utc).isoformat())
        logger.info("Liens de désabonnement : analyse initiale terminée")
    elif done == 0:
        # Nothing moved this pass and rows are still missing: every reachable
        # account either failed or is in backoff. Stop retrying every minute;
        # the Nettoyage page keeps a manual re-run.
        db.set_kv("unsubscribe_backfill_done_at", datetime.now(timezone.utc).isoformat())
        logger.info(
            "Liens de désabonnement : %d message(s) non inspectés, reprise manuelle depuis Nettoyage",
            remaining,
        )
    return done


def _analyse_round(conf: Dict, accounts: List[Dict], ai_on: bool, deadline: float) -> int:
    """Classify / summarise pending emails (bodies already hydrated).
    Returns the number of emails settled (analysed, skipped or failed)."""
    polling = conf.get("polling", {}) or {}
    max_age_days = polling.get("max_age_days", 30)
    ai_batch = int(polling.get("ai_batch_size", 200))
    model = conf.get("openai", {}).get("model", "gpt-4o-mini")
    ntfy = conf.get("ntfy", {})
    min_score = ntfy.get("min_importance", 7)
    ntfy_ok = bool(ntfy.get("topic") and not str(ntfy.get("topic", "")).startswith("TODO"))
    injection_mode = ((conf.get("security") or {}).get("injection_scan") or {}).get("mode", "hybrid")
    # Per-account AI profiles (P1.2/P1.3), keyed by email address.
    profiles = {a["email"]: a for a in accounts}

    pending = db.get_pending_emails(limit=ai_batch)
    to_process = []
    settled = 0
    skipped = 0
    for em in pending:
        if _is_too_old(em.get("date_received", ""), max_age_days):
            db.skip_old_email(em["message_id"])
            skipped += 1
            settled += 1
        else:
            to_process.append(em)

    if skipped:
        logger.info(f"   {skipped} email(s) trop ancien(s) ignorés (>{max_age_days}j)")
    if not to_process:
        return settled
    logger.info(f"Traitement AI : {len(to_process)} email(s) en attente...")
    progress.analysis_phase(PHASE_ANALYSING, done=0, total=len(to_process))

    local_hits = 0
    cache_hits = 0
    ai_calls = 0
    consecutive_ai_errors = 0

    for i, em in enumerate(to_process):
        if time.monotonic() > deadline:
            logger.info("Budget temps de l'analyse épuisé, reprise au prochain passage.")
            break
        try:
            result = None
            acc_profile = profiles.get(em.get("account_email")) or {}
            # Injection verdict from the classification phase — reused by the
            # auto-draft gate so the same body is never scanned twice.
            injection_verdict = None

            # ── Niveau 1 : règles locales (0 token) ───────────────────────────
            result = local_classify(em)
            if result:
                local_hits += 1

            # ── Niveau 2 : mémoisation domaine expéditeur (0 token) ───────────
            if result is None:
                domain = extract_domain(em.get("sender", "") or "")
                if domain:
                    cached_cat = db.get_sender_category(domain)
                    if cached_cat and cached_cat not in ("important", "other"):
                        # Only trust cached category for low-value types;
                        # "important" / "other" are too broad to skip AI.
                        result = _neutral_result(
                            cached_cat,
                            2 if cached_cat == "newsletter" else 3,
                            f"Domaine {domain} connu ({cached_cat})",
                        )
                        cache_hits += 1

            # ── Niveau 2.6 : IA désactivée pour CE compte (P1.2) ──────────────
            # Garde les règles locales gratuites mais n'appelle jamais le LLM.
            if result is None and acc_profile.get("ai_account_enabled") is False:
                result = _neutral_result("other", 5, "IA désactivée pour ce compte")

            # ── Niveau 2.5 : scan anti-injection avant tout appel LLM ─────────
            # Un corps hostile ne doit jamais atteindre le modèle. Fail-OPEN :
            # un scan non vérifiable (LLM indispo) ne signale PAS — on classe.
            if result is None and ai_on and injection_mode != "off":
                injection_verdict = injection_guard.scan(
                    em.get("body_text", "") or "", injection_mode)
                if injection_verdict["injection"]:
                    db.flag_injection(em["message_id"], injection_verdict["reason"])
                    result = _neutral_result(
                        "other", 4, "Contenu suspect — analyse IA ignorée",
                        "⚠ Email potentiellement malveillant (injection détectée).")

            # ── Niveau 3 : IA classification (body réduit à 800 cars.) ─────────
            # In no-AI mode we fabricate a neutral result so the email still
            # lands in the inbox with a predictable category/score. The user
            # has explicitly opted out — no LLM call must happen here.
            if result is None and not ai_on:
                result = _neutral_result("other", 5, NO_AI_FALLBACK_REASON)

            # Circuit breaker: if too many consecutive AI errors, stop calling LLM in this run
            if result is None and consecutive_ai_errors >= 5:
                continue

            if result is None:
                try:
                    result = process_email(em, model=model)
                except Exception as e:
                    logger.warning(f"process_email exception for {em['message_id']}: {e}")
                    result = None

                if result:
                    ai_calls += 1
                    consecutive_ai_errors = 0
                    # Apprendre le domaine pour les prochains emails
                    domain = extract_domain(em.get("sender", "") or "")
                    if domain and result.get("category") not in ("important", "other", None):
                        db.set_sender_category(domain, result["category"])
                else:
                    consecutive_ai_errors += 1
                    attempts = db.increment_ai_attempts(em["message_id"])
                    if attempts >= 3:
                        db.mark_ai_failed(em["message_id"])
                        skipped += 1
                        settled += 1
                    continue

            if not result:
                continue

            # ── Auto-draft opt-in par compte (P1.3) ───────────────────────────
            # Pré-rédige une réponse pour les mails qui attendent une réponse et
            # dépassent le seuil du compte. JAMAIS envoyé. Enrichit `result`
            # AVANT update_email_ai pour persister brouillon + tokens en une
            # passe. Seuil 0/absent hérite du global.
            acc_threshold = acc_profile.get("ai_importance_threshold") or min_score
            auto_drafted = False
            if (
                acc_profile.get("auto_draft")
                and ai_on
                and result.get("needs_reply")
                and result.get("importance_score", 0) >= acc_threshold
            ):
                v = injection_verdict
                if v is None:
                    v = injection_guard.scan(em.get("body_text", "") or "", injection_mode)
                if not v["injection"] and not v.get("unverified"):
                    try:
                        enrich_draft(em, result, model=model)
                        if result.get("draft_response"):
                            result["draft_response"] = draft_verify.verify_draft(
                                result["draft_response"], model=model)
                            auto_drafted = True
                    except Exception as e:
                        logger.warning(f"enrich_draft error: {e}")

            db.update_email_ai(em["message_id"], result)
            settled += 1
            if auto_drafted:
                db.mark_auto_draft(em["message_id"])

            if (
                ntfy_ok
                and result.get("importance_score", 0) >= acc_threshold
                and not em.get("is_notified")
            ):
                payload = {**em, **result, "account_email": em["account_email"]}
                if send(payload, server=ntfy["server"], topic=ntfy["topic"]):
                    db.mark_notified(em["message_id"])
        except Exception as e:
            logger.warning(f"Error processing email {em.get('message_id')}: {e}")
        finally:
            progress.analysis_progress(i + 1, len(to_process))

    logger.info(
        f"   Classification : {local_hits} règles locales, "
        f"{cache_hits} cache domaine, {ai_calls} appels IA"
    )
    return settled


def analysis_pass(*, time_budget_seconds: float = ANALYSIS_TIME_BUDGET_SECONDS) -> bool:
    """Offline mutations, body hydration and AI classification, in rounds,
    until nothing is left or the time budget is spent. Returns ``False`` when
    another analysis pass already holds the lock."""
    global _analysis_started_at

    if not _acquire_or_break(_analysis_lock, _analysis_started_at, "Analyse", ANALYSIS_WATCHDOG_SECONDS):
        logger.debug("Analyse déjà en cours, ignorée.")
        return False

    _analysis_started_at = time.monotonic()
    deadline = _analysis_started_at + time_budget_seconds
    progress.analysis_started(PHASE_HYDRATING)
    try:
        conf = cfg.get()
        provider = (conf.get("llm") or {}).get("provider", "openai")
        # `cfg.ai_enabled()` comprend tous les providers : OpenAI (clé non
        # vide), local (GGUF analyzer présent sur disque), Ollama, Claude,
        # OpenRouter. Avant ce fix on testait uniquement `bool(api_key)`.
        ai_on = cfg.ai_enabled()
        if ai_on:
            # init_client n'est nécessaire que pour OpenAI ; en mode local
            # l'AnalyzerServer a déjà été démarré par lifecycle au boot
            # (ou par /api/llm/activate après un switch de provider).
            if provider == "openai":
                api_key = (conf.get("openai") or {}).get("api_key", "")
                init_client(api_key)
            # Re-queue any emails that were classified by the no-AI
            # fallback during a prior run. They were marked as 'other'
            # to keep them visible in the inbox, but the user has now
            # enabled AI — give them a real classification.
            requeued = db.requeue_emails_by_reason(NO_AI_FALLBACK_REASON)
            if requeued:
                logger.info(
                    f"{requeued} email(s) classés en mode sans IA "
                    "remis en file pour analyse IA"
                )

        accounts = [a for a in conf.get("accounts", []) if a.get("enabled", True)]
        att_policy = policy_from_config(conf)

        # ── Offline mutations queue (seen, flagged, trash) ─────────────────
        try:
            _drain_pending_ops(accounts)
        except Exception as e:
            logger.warning(f"Échec drain pending_ops : {e}")

        # Rows left in 'hydrating' by a crash or a dead connection.
        try:
            stale = db.reclaim_stale_hydrating(max_age_minutes=10)
            if stale:
                logger.info(f"{stale} corps de message bloqués en hydratation remis en file")
        except Exception as e:  # noqa: BLE001
            logger.warning(f"reclaim_stale_hydrating a échoué : {e}")

        # One-shot migration for mailboxes synced before unsubscribe headers
        # were captured at ingest. No-op on every pass once it has run.
        try:
            _backfill_unsubscribe_headers(accounts, deadline)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"Recherche des liens de désabonnement : {e}")

        # ── Rounds: hydrate → analyse, until idle or out of time ───────────
        unreachable: set = set()
        while time.monotonic() < deadline:
            hydrated = _hydrate_round(accounts, att_policy, deadline, unreachable)
            settled = _analyse_round(conf, accounts, ai_on, deadline)
            if hydrated == 0 and settled == 0:
                break

        logger.info("Analyse terminée.")
    except Exception as e:
        logger.error(f"Erreur analyse : {e}", exc_info=True)
    finally:
        _analysis_started_at = None
        progress.analysis_finished()
        _analysis_lock.release()
    return True


# ═══════════════════════════════════════════════════════════════════════════
# Triggers
# ═══════════════════════════════════════════════════════════════════════════

def run_sync():
    """Historical entry point: fetch, then analyse, on the calling thread."""
    fetch_pass(trigger="manual", chain_analysis=False)
    analysis_pass()


def request_fetch(
    only_accounts: Optional[List[str]] = None,
    *,
    trigger: str = "ui",
    ignore_backoff: bool = False,
    min_gap_seconds: float = 0.0,
) -> bool:
    """Start a fetch pass on a background thread. Returns False when one is
    already running or the last one finished less than *min_gap_seconds* ago."""
    if is_fetching():
        return False
    if min_gap_seconds and _last_fetch_mono and (time.monotonic() - _last_fetch_mono) < min_gap_seconds:
        return False
    threading.Thread(
        target=fetch_pass,
        args=(only_accounts,),
        kwargs={"trigger": trigger, "ignore_backoff": ignore_backoff},
        daemon=True,
        name=f"fetch-{trigger}",
    ).start()
    return True


def request_analysis() -> bool:
    """Start an analysis pass on a background thread unless one is running."""
    if is_analysing():
        return False
    threading.Thread(target=analysis_pass, daemon=True, name="analysis-pass").start()
    return True


# IDLE notifications arrive on the watcher threads, possibly in bursts (one
# EXISTS per message during a mail-merge). Coalesce them into one targeted
# fetch pass, and never drop one: if a pass is already running when the
# timer fires, the accounts are re-queued for a slightly later attempt.
_idle_lock = threading.Lock()
_idle_pending: Set[str] = set()
_idle_timer: Optional[threading.Timer] = None


def notify_new_mail(account_email: str) -> None:
    """Called by the IMAP IDLE watcher when a server announces new mail."""
    _schedule_idle_flush(account_email, IDLE_DEBOUNCE_SECONDS)


def _schedule_idle_flush(account_email: Optional[str], delay: float) -> None:
    global _idle_timer
    with _idle_lock:
        if account_email:
            _idle_pending.add(account_email)
        if _idle_timer is None:
            _idle_timer = threading.Timer(delay, _flush_idle)
            _idle_timer.daemon = True
            _idle_timer.name = "idle-flush"
            _idle_timer.start()


def _flush_idle() -> None:
    global _idle_timer
    with _idle_lock:
        emails = sorted(_idle_pending)
        _idle_pending.clear()
        _idle_timer = None
    if not emails:
        return
    logger.info("Nouveau courrier annoncé par IDLE : %s", ", ".join(emails))
    result = fetch_pass(emails, trigger="idle")
    if result is None:
        # A pass was already running; make sure these accounts get their turn.
        with _idle_lock:
            _idle_pending.update(emails)
        _schedule_idle_flush(None, 5.0)

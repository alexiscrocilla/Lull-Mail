# SPDX-License-Identifier: GPL-3.0-or-later
"""
Lifecycle helpers for the email subsystem.

Wraps the bits that need a valid config: LLM provider init, the two
scheduler jobs (header fetch, analysis), the IMAP IDLE watchers, the
wake-from-sleep watchdog and the kick-off fetch. Exposed as
start_email_services() so both the boot-time entry points (main.py /
app_gui.py) and the setup wizard's "finalize" endpoint drive the same path.

Idempotent — calling it twice is a no-op for everything except an
explicit `restart=True`, which tears down the existing scheduler and
brings up a fresh one (used after the wizard adds an account).
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler

from src import config as cfg
from src import database as db
from src import scheduler as sync
from src.ai_processor import init_client
from src.idle_watcher import idle_manager

logger = logging.getLogger(__name__)

_scheduler: Optional[BackgroundScheduler] = None
_lock = threading.Lock()
_wake_thread: Optional[threading.Thread] = None
_wake_stop = threading.Event()

FETCH_JOB_ID = "email_fetch"
ANALYSIS_JOB_ID = "email_analysis"
# The analysis trigger is cheap when there is nothing to do (a few COUNTs),
# so it can tick often: hydration + AI then run continuously in the
# background instead of 30 bodies per fetch cycle.
ANALYSIS_TICK_SECONDS = 60
# Wake-from-sleep detection: the wall clock jumps forward while a monotonic
# sleep() does not. A jump this large means the machine was suspended.
WAKE_CHECK_SECONDS = 30
WAKE_JUMP_SECONDS = 120


def is_running() -> bool:
    return _scheduler is not None and _scheduler.running


# ── Scheduler jobs ───────────────────────────────────────────────────────────

def _fetch_job() -> None:
    sync.fetch_pass(trigger="scheduler")


def _analysis_job() -> None:
    # Returns immediately: the pass runs on its own thread, so a long local
    # LLM batch never trips APScheduler's max_instances guard.
    sync.request_analysis()


def _apply_fetch_interval(sched: BackgroundScheduler, minutes: int) -> None:
    """Add or reschedule the header-fetch job. A misfire grace equal to the
    interval means a tick missed during sleep still runs on resume instead
    of being discarded (APScheduler's default grace is 1 second)."""
    minutes = max(1, int(minutes))
    grace = max(60, minutes * 60)
    if sched.get_job(FETCH_JOB_ID):
        sched.reschedule_job(FETCH_JOB_ID, trigger="interval", minutes=minutes)
        sched.modify_job(FETCH_JOB_ID, misfire_grace_time=grace)
    else:
        sched.add_job(
            _fetch_job, "interval", minutes=minutes, id=FETCH_JOB_ID,
            coalesce=True, max_instances=1, misfire_grace_time=grace,
        )


def _register_analysis_job(sched: BackgroundScheduler) -> None:
    """Add the analysis job, with a grace as long as its own interval.

    APScheduler discards a tick whose scheduled time has passed by more
    than `misfire_grace_time`, and the default is one second. The fetch job
    was given a real grace when it moved to a two-minute interval; this one
    was left on the default, so every resume from sleep dropped a tick. It
    used not to matter because a 60-second list refresh covered for it.
    """
    sched.add_job(
        _analysis_job, "interval", seconds=ANALYSIS_TICK_SECONDS,
        id=ANALYSIS_JOB_ID, coalesce=True, max_instances=1,
        misfire_grace_time=ANALYSIS_TICK_SECONDS,
    )


def reschedule_fetch(minutes: int) -> bool:
    """Apply a new fetch interval to the running scheduler (Settings save).
    Returns False when the services are not running (nothing to update)."""
    with _lock:
        if _scheduler is None or not _scheduler.running:
            return False
        _apply_fetch_interval(_scheduler, minutes)
        logger.info("Intervalle de relève mis à jour : %d min", int(minutes))
        return True


# ── Wake-from-sleep watchdog ─────────────────────────────────────────────────

def _wake_watchdog() -> None:
    last = time.time()
    while not _wake_stop.wait(WAKE_CHECK_SECONDS):
        now = time.time()
        if now - last > WAKE_CHECK_SECONDS + WAKE_JUMP_SECONDS:
            logger.info(
                "Reprise après veille détectée (%d s) — reconnexion IDLE et relève immédiate",
                int(now - last),
            )
            try:
                idle_manager.kick()
            except Exception:  # noqa: BLE001
                logger.exception("kick IDLE a échoué")
            sync.request_fetch(trigger="wake")
        last = now


def _start_wake_watchdog() -> None:
    global _wake_thread
    if _wake_thread is not None and _wake_thread.is_alive():
        return
    _wake_stop.clear()
    _wake_thread = threading.Thread(target=_wake_watchdog, daemon=True, name="wake-watchdog")
    _wake_thread.start()


# ── IMAP IDLE ────────────────────────────────────────────────────────────────

def _start_idle(conf: dict) -> None:
    polling = conf.get("polling") or {}
    if not polling.get("idle_enabled", True):
        idle_manager.stop()
        logger.info("IMAP IDLE désactivé par la configuration — polling seul")
        return
    accounts = [a for a in conf.get("accounts", []) if a.get("enabled", True)]
    try:
        idle_manager.start(accounts, on_new_mail=sync.notify_new_mail)
    except Exception:  # noqa: BLE001 — IDLE is an accelerator, never a blocker
        logger.exception("Démarrage IMAP IDLE a échoué (polling seul)")


def reconcile_idle() -> None:
    """Bring the IDLE watchers back in line with config.yaml.

    Adding, editing, disabling or deleting an account rewrote the config
    and nothing else: the watchers kept running against the roster they
    were started with. A deleted account held its IMAP connection open
    until the next restart, and a new one had no push at all -- which,
    from the user's side, is a mailbox that simply does not deliver
    instantly while its neighbour does.

    Safe to call when the services are not running: IdleManager.start()
    stops first, so this either restarts the set or leaves it stopped.
    """
    if _scheduler is None:
        # Still in setup mode -- start_email_services() will do it.
        return
    try:
        conf = cfg.reload()
        if not conf:
            # The rewrite left the config unusable (a secret the keyring no
            # longer holds, say). Stop the watchers rather than keep them on
            # a roster nobody can vouch for.
            idle_manager.stop()
            return
        _start_idle(conf)
    except Exception:  # noqa: BLE001 — IDLE is an accelerator, never a blocker
        logger.exception("Reconfiguration IMAP IDLE a échoué (polling seul)")


# ── Public API ───────────────────────────────────────────────────────────────

def start_email_services(*, restart: bool = False) -> bool:
    """Start (or restart) the LLM provider, the scheduler and IMAP IDLE.

    Returns True when the services are up after the call. Returns False
    when no valid config is available (caller stays in setup mode).
    """
    global _scheduler

    with _lock:
        conf = cfg.reload() if restart else cfg.try_load()
        if not conf:
            return False

        if _scheduler is not None and _scheduler.running:
            if not restart:
                return True
            try:
                _scheduler.shutdown(wait=False)
            except Exception:
                logger.exception("Échec arrêt scheduler avant redémarrage")
            _scheduler = None
            idle_manager.stop()

        # Init du provider LLM actif (OpenAI ou local).
        # `cfg.llm.provider` décide : "openai" → besoin d'une api_key ;
        # "local" → besoin que le GGUF analyzer soit téléchargé.
        # Si l'init échoue (clé absente, GGUF absent, serveur crash), on
        # retombe en mode sans IA : le scheduler utilise les rules locales
        # et le fallback no-AI ; les endpoints /draft + /reanalyze
        # short-circuitent avec 409.
        provider_name = (conf.get("llm") or {}).get("provider", "openai")
        if provider_name == "local":
            from src.llm.registry import get_provider, reset as _reset_provider
            from src.llm.server import LLMServerError
            # Reset au cas où l'utilisateur vient de basculer de "openai"
            # à "local" via /api/setup/llm — le registry doit ré-instancier.
            _reset_provider()
            try:
                get_provider().init()
                logger.info("Provider local actif — analyzer démarré")
            except LLMServerError as e:
                logger.warning("Local LLM indisponible (%s) — mode sans IA", e)
            except Exception:
                logger.exception("init du provider local a échoué")
        elif provider_name in ("ollama", "anthropic", "openrouter"):
            # Lightweight remote/HTTP backends: no embedded server to spawn,
            # just (re)build the client. Reset covers a provider switch.
            from src.llm.registry import get_provider, reset as _reset_provider
            _reset_provider()
            try:
                get_provider().init()
                logger.info("Provider %s actif", provider_name)
            except Exception:
                logger.exception("init du provider %s a échoué", provider_name)
        else:
            api_key = (conf.get("openai") or {}).get("api_key", "")
            if api_key:
                try:
                    init_client(api_key)
                except Exception:
                    logger.exception("init_client a échoué")
                    return False
            else:
                logger.info("Mode sans IA actif — pas d'initialisation du client OpenAI")

        # Rows left in 'hydrating' by a crash would never be analysed
        # (the AI only looks at hydrated bodies). Same for in-flight ops.
        try:
            stuck = db.reset_hydrating_body_states()
            if stuck:
                logger.info("%d message(s) bloqués en hydratation remis en file", stuck)
        except Exception:  # noqa: BLE001
            logger.exception("reset_hydrating_body_states a échoué")

        interval = int(conf.get("polling", {}).get("interval_minutes", 2))
        sched = BackgroundScheduler(timezone="Europe/Paris")
        _apply_fetch_interval(sched, interval)
        _register_analysis_job(sched)
        sched.start()
        _scheduler = sched
        logger.info("Polling email actif (relève toutes les %d min, analyse en continu)", interval)

        _start_idle(conf)
        _start_wake_watchdog()

    # Kick off an immediate fetch outside the lock so it doesn't block other
    # callers that might want to know the running state. The fetch chains
    # an analysis pass in the background when there is work.
    threading.Thread(
        target=sync.fetch_pass, kwargs={"trigger": "boot"},
        daemon=True, name="initial-sync",
    ).start()
    return True


def stop_email_services() -> None:
    global _scheduler
    with _lock:
        _wake_stop.set()
        try:
            idle_manager.stop()
        except Exception:
            logger.exception("Échec arrêt IMAP IDLE")
        if _scheduler is not None and _scheduler.running:
            try:
                _scheduler.shutdown(wait=False)
            except Exception:
                logger.exception("Échec arrêt scheduler")
        _scheduler = None

        # Arrêt propre des serveurs LLM locaux si on les avait spawné.
        # No-op en mode OpenAI (le provider OpenAI n'a pas de stop()).
        try:
            from src.llm.registry import get_provider
            provider = get_provider()
            if hasattr(provider, "stop"):
                provider.stop()
        except Exception:
            logger.exception("Échec arrêt provider LLM")

# SPDX-License-Identifier: GPL-3.0-or-later
"""
Lifecycle helpers for the email subsystem.

Wraps the bits that need a valid config: OpenAI client init, the polling
scheduler, and the kick-off sync. Exposed as start_email_services() so
both the boot-time entry points (main.py / app_gui.py) and the setup
wizard's "finalize" endpoint can drive the same code path.

Idempotent — calling it twice is a no-op for everything except an
explicit `restart=True`, which tears down the existing scheduler and
brings up a fresh one (used after the wizard adds an account).
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler

from src import config as cfg
from src.ai_processor import init_client
from src.scheduler import run_sync

logger = logging.getLogger(__name__)

_scheduler: Optional[BackgroundScheduler] = None
_lock = threading.Lock()


def is_running() -> bool:
    return _scheduler is not None and _scheduler.running


def start_email_services(*, restart: bool = False) -> bool:
    """Start (or restart) the OpenAI client + polling scheduler.

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

        interval = int(conf.get("polling", {}).get("interval_minutes", 10))
        sched = BackgroundScheduler(timezone="Europe/Paris")
        sched.add_job(run_sync, "interval", minutes=interval, id="email_sync")
        sched.start()
        _scheduler = sched
        logger.info("Polling email actif (intervalle = %d min)", interval)

    # Kick off an immediate sync outside the lock so it doesn't block other
    # callers that might want to know the running state.
    threading.Thread(target=run_sync, daemon=True, name="initial-sync").start()
    return True


def stop_email_services() -> None:
    global _scheduler
    with _lock:
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

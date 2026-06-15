# SPDX-License-Identifier: GPL-3.0-or-later
"""
LLM provider abstraction.

Le code historique vivait dans `src/ai_processor.py` qui parlait
directement à l'API OpenAI. Phase 1 du refactor déplace cette logique
dans `src/llm/openai_provider.py` derrière une interface `LLMProvider`,
ce qui permettra à Phase 2 d'ajouter un `LocalLLMProvider`
(Phi-3.5-mini + rules + score dérivé) sans toucher aux call sites.

Cette indirection passe par `registry.get_provider()` qui choisit
le bon backend selon `cfg["llm"]["provider"]` (Phase 1 : toujours
"openai"). Les wrappers `init_client / process_email / enrich_draft`
ci-dessous reproduisent l'API publique de l'ancien `ai_processor.py`
verbatim, donc les imports existants continuent à marcher :

    from src.ai_processor import init_client, process_email, enrich_draft

ne casse pas — `src/ai_processor.py` est devenu un shim qui re-exporte
ces noms depuis ici.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from src.llm.registry import get_provider, reset  # re-export


def chat_client() -> Tuple[Optional[Any], Optional[str]]:
    """Return ``(client, model)`` for the active provider, or ``(None, None)``.

    ``client`` is an OpenAI-compatible client — the cloud OpenAI client when
    ``provider == openai``, or the LOCAL ``llama_cpp.server`` client (also
    OpenAI-compatible) when ``provider == local``. ``model`` is the name to
    pass on the request.

    This is what lets the OpenAI-flavoured extras (prompt-injection LLM check,
    draft verification, the Cmd-K assistant/agent) run with NO OpenAI account
    when the user has gone fully local — the same chat-completions API, pointed
    at the embedded local server.
    """
    try:
        p = get_provider()
    except Exception:  # noqa: BLE001
        return None, None
    # Preferred path: every concrete provider implements chat_endpoint().
    ce = getattr(p, "chat_endpoint", None)
    if callable(ce):
        try:
            res = ce()
            if res and res[0] is not None:
                return res
        except Exception:  # noqa: BLE001
            pass
    # Fallback for lightweight doubles without chat_endpoint (e.g. tests).
    client = getattr(p, "_client", None)
    if client is not None:
        try:
            from src import config as cfg
            model = (cfg.get().get("openai") or {}).get("model", "gpt-4o-mini")
        except Exception:  # noqa: BLE001
            model = "gpt-4o-mini"
        return client, model
    client = getattr(p, "_analyzer_client", None)
    if client is not None:
        model = getattr(p, "analyzer_model_id", None) or "local"
        return client, model
    return None, None


def init_client(api_key: str) -> None:
    """Idempotent provider init.

    En Phase 1, équivalent à `OpenAIProvider.init(api_key=api_key)` :
    instancie ou réutilise le client OpenAI. En Phase 2, déclenche le
    démarrage des serveurs `llama_cpp.server` si le provider local est
    actif. Passé `api_key=""`, le provider est dé-initialisé (mode no-AI).
    """
    get_provider().init(api_key=api_key)


def process_email(data: Dict, model: str = "gpt-4o-mini") -> Optional[Dict]:
    """Classification d'un email (Level-3). Retourne `None` en cas
    d'échec — le scheduler incrémente alors le compteur de tentatives
    sur la ligne pour ne pas la re-classifier indéfiniment.
    """
    return get_provider().process_email(data, model=model)


def enrich_draft(data: Dict, existing_result: Dict, model: str = "gpt-4o-mini") -> Dict:
    """Génération de brouillon complet (Level-4). Appelée à la demande
    via `POST /api/emails/{int_id}/draft` quand `needs_reply=True` et que
    `existing_result.draft_response` est vide.
    """
    return get_provider().enrich_draft(data, existing_result, model=model)


__all__ = [
    "init_client",
    "process_email",
    "enrich_draft",
    "get_provider",
    "reset",
    "chat_client",
]

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

from typing import Dict, Optional

from src.llm.registry import get_provider, reset  # re-export


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
]

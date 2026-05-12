# SPDX-License-Identifier: GPL-3.0-or-later
"""
Sélection du provider LLM actif. Pattern singleton.

Phase 1 : retourne toujours `OpenAIProvider` (un seul backend supporté).
Phase 2 : branche sur `cfg["llm"]["provider"]` pour choisir entre
`OpenAIProvider` et `LocalLLMProvider` (Phi-3.5-mini + rules + score
dérivé via logprob — voir `data/phase0_bis_summary.md`).

`reset()` est appelé par `cfg.reload()` (planifié Phase 2) pour forcer
la ré-évaluation du choix après un changement de configuration.
"""

from __future__ import annotations

from typing import Optional

from src.llm.base import LLMProvider
from src.llm.openai_provider import OpenAIProvider


_provider: Optional[LLMProvider] = None


def get_provider() -> LLMProvider:
    """Retourne le provider LLM actif (instancié à la 1ère demande).

    Phase 1 hard-code `OpenAIProvider`. Phase 2 lira
    `cfg["llm"]["provider"]` ici pour brancher entre "openai" et "local".
    Cache le résultat dans `_provider` pour amortir les init répétés
    (par ex. le scheduler appelle `init_client` à chaque tick — on ne
    veut pas reconstruire le client OpenAI à chaque fois).
    """
    global _provider
    if _provider is None:
        _provider = OpenAIProvider()
    return _provider


def reset() -> None:
    """Vide le cache. Appelé après un hot-reload de config — la prochaine
    `get_provider()` ré-instanciera selon les nouveaux paramètres.
    """
    global _provider
    _provider = None

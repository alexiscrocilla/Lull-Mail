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

    Lit `cfg.llm.provider` pour choisir entre :
      - "openai" (défaut) → `OpenAIProvider` (cloud GPT)
      - "local" → `LocalLLMProvider` (Phi-3.5-mini + llama_cpp.server)

    Le résultat est caché dans `_provider` pour amortir les init répétés
    (le scheduler appelle `init_client` à chaque tick — pas la peine de
    reconstruire le client à chaque fois). `reset()` permet de forcer le
    re-pick après un changement de `cfg.llm.provider` via Settings.

    Import lazy de `LocalLLMProvider` : tant qu'on est en mode OpenAI,
    on ne charge pas `llama_cpp` ni les dépendances locales.
    """
    global _provider
    if _provider is not None:
        return _provider

    # Lazy import de `cfg` pour éviter le cycle config → registry → config.
    try:
        from src import config as cfg
        provider_name = (cfg.get().get("llm") or {}).get("provider", "openai")
    except Exception:  # noqa: BLE001
        # Si la config n'est pas chargeable (mode setup), on tombe sur OpenAI
        # par défaut — il sera de toute façon désactivé tant qu'`ai_enabled()`
        # ne renvoie pas True.
        provider_name = "openai"

    if provider_name == "local":
        from src.llm.local_provider import LocalLLMProvider
        _provider = LocalLLMProvider()
    elif provider_name == "ollama":
        from src.llm.ollama_provider import OllamaProvider
        _provider = OllamaProvider()
    elif provider_name == "anthropic":
        from src.llm.anthropic_provider import AnthropicProvider
        _provider = AnthropicProvider()
    else:
        _provider = OpenAIProvider()
    return _provider


def reset() -> None:
    """Vide le cache. Appelé après un hot-reload de config — la prochaine
    `get_provider()` ré-instanciera selon les nouveaux paramètres.
    """
    global _provider
    _provider = None

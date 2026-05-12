# SPDX-License-Identifier: GPL-3.0-or-later
"""
Shim de compatibilité.

L'implémentation historique a été déplacée vers `src/llm/*` au moment
du refactor Phase 1 (cf. `data/hazy-nibbling-sphinx.md`) :

  - `src.llm.base`            : interface `LLMProvider` + prompts + helpers
  - `src.llm.openai_provider` : backend OpenAI (où vivait le code d'origine)
  - `src.llm.registry`        : sélection du provider actif
  - `src.llm`                 : API fonctionnelle re-exportée ci-dessous

Les call sites existants (`scheduler.py`, `api.py`, `lifecycle.py`) qui
font `from src.ai_processor import init_client, process_email, enrich_draft`
continuent à fonctionner sans modification. Les nouveaux call sites
devraient préférer `from src.llm import …` ou
`from src.llm.registry import get_provider` directement.
"""

from src.llm import enrich_draft, init_client, process_email  # noqa: F401


__all__ = ["init_client", "process_email", "enrich_draft"]

# SPDX-License-Identifier: GPL-3.0-or-later
"""
Implémentation `OpenAIProvider` — backend par défaut.

Encapsule la logique qui vivait dans `src/ai_processor.py` avant le
refactor Phase 1. Les paramètres (modèle, temperature, max_tokens,
response_format) et les prompts sont rigoureusement identiques pour
garantir zéro régression visible côté utilisateur.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

from openai import OpenAI

from src.llm.base import (
    LLMProvider,
    SYSTEM_CLASSIFICATION,
    SYSTEM_DRAFT,
    build_classification_prompt,
    build_draft_prompt,
    validate_classification_result,
)

logger = logging.getLogger(__name__)


class OpenAIProvider(LLMProvider):
    """LLM backend qui parle à l'API OpenAI via le SDK officiel.

    Le client est instancié à la première `init(api_key=...)` et caché
    sur l'instance. Re-appeler `init()` avec une autre clé remplace le
    client (utilisé par le setup wizard quand l'user change sa clé).
    """

    name = "openai"

    def __init__(self) -> None:
        self._client: Optional[OpenAI] = None

    def init(self, api_key: str = "", **_kwargs: Any) -> None:
        """Idempotent. `api_key=""` repasse en mode no-AI (le client est
        mis à None ; les calls suivants à `process_email` renvoient None
        et loggent une erreur claire)."""
        if not api_key:
            self._client = None
            return
        self._client = OpenAI(api_key=api_key)

    def chat_endpoint(self) -> tuple:
        if self._client is None:
            return None, None
        try:
            from src import config as cfg
            model = (cfg.get().get("openai") or {}).get("model", "gpt-4o-mini")
        except Exception:  # noqa: BLE001
            model = "gpt-4o-mini"
        return self._client, model

    def process_email(
        self, data: Dict[str, Any], model: str = "gpt-4o-mini"
    ) -> Optional[Dict[str, Any]]:
        """Classification Level-3. Identique à l'ancien
        `ai_processor.process_email`, paramètres compris :
          - temperature=0.1 (déterminisme préférable pour le scoring)
          - max_tokens=600 (suffit pour le JSON complet)
          - response_format={"type":"json_object"} (mode JSON natif)
        """
        if not self._client:
            logger.error("OpenAI client not initialized")
            return None

        prompt = build_classification_prompt(data)
        try:
            response = self._client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": SYSTEM_CLASSIFICATION},
                    {"role": "user", "content": prompt},
                ],
                response_format={"type": "json_object"},
                temperature=0.1,
                max_tokens=600,
            )
            result = json.loads(response.choices[0].message.content)
            result = validate_classification_result(result)

            usage = response.usage
            result["tokens_in"] = usage.prompt_tokens if usage else 0
            result["tokens_out"] = usage.completion_tokens if usage else 0
            # Tracé pour le rapport per-provider dans la DB. Le scheduler
            # propage ce champ jusqu'à `update_email_ai` (cf. Phase 1.5).
            result["analyzed_by"] = self.name
            return result

        except json.JSONDecodeError as e:
            logger.error(f"AI JSON parse error: {e}")
        except Exception as e:
            logger.error(f"AI processing error: {e}")
        return None

    def enrich_draft(
        self,
        data: Dict[str, Any],
        existing_result: Dict[str, Any],
        model: str = "gpt-4o-mini",
    ) -> Dict[str, Any]:
        """Génération de brouillon complet. Mute `existing_result` sur
        place (compat avec ancien code) et le retourne. No-op si le
        client n'est pas initialisé ou si un draft est déjà présent.
        """
        if not self._client:
            return existing_result
        if existing_result.get("draft_response"):
            return existing_result

        prompt = build_draft_prompt(data)
        try:
            response = self._client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": SYSTEM_DRAFT},
                    {"role": "user", "content": prompt},
                ],
                response_format={"type": "json_object"},
                temperature=0.3,
                max_tokens=400,
            )
            parsed = json.loads(response.choices[0].message.content)
            existing_result["draft_response"] = parsed.get("draft_response") or ""

            usage = response.usage
            existing_result["tokens_in"] = existing_result.get("tokens_in", 0) + (
                usage.prompt_tokens if usage else 0
            )
            existing_result["tokens_out"] = existing_result.get("tokens_out", 0) + (
                usage.completion_tokens if usage else 0
            )
        except Exception as e:
            logger.error(f"Draft enrichment error: {e}")
        return existing_result

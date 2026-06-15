# SPDX-License-Identifier: GPL-3.0-or-later
"""Provider for a user-installed **Ollama** server.

Ollama exposes an OpenAI-compatible API at ``<base_url>/v1``, so we drive it
with the OpenAI SDK — same chat-completions calls as the cloud provider, just
pointed at the local Ollama daemon. The user picks one of their ``ollama
pull``-ed models in Settings. Nothing leaves the machine (unless they point
``base_url`` at a remote Ollama).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from openai import OpenAI

from src.llm.base import (
    LLMProvider,
    SYSTEM_CLASSIFICATION,
    SYSTEM_DRAFT,
    build_classification_prompt,
    build_draft_prompt,
    extract_json as _extract_json,
    validate_classification_result,
)

logger = logging.getLogger(__name__)


class OllamaProvider(LLMProvider):
    name = "ollama"

    def __init__(self) -> None:
        self._client: Optional[OpenAI] = None
        self.model: str = ""

    def init(self, **_kwargs: Any) -> None:
        """Read base_url + model from config and build the OpenAI-compatible
        client. Ollama needs no API key, but the SDK requires a non-empty one."""
        from src import config as cfg
        ollama = (cfg.get().get("llm") or {}).get("ollama") or {}
        base_url = (ollama.get("base_url") or "http://localhost:11434").rstrip("/")
        self.model = ollama.get("model") or ""
        self._client = OpenAI(base_url=f"{base_url}/v1", api_key="ollama")

    def _ready(self) -> bool:
        if self._client is None or not self.model:
            # Lazy (re)init in case init() wasn't called for this provider.
            self.init()
        return self._client is not None and bool(self.model)

    def process_email(self, data: Dict[str, Any], model: str = "") -> Optional[Dict[str, Any]]:
        if not self._ready():
            logger.error("[Ollama] no model configured")
            return None
        prompt = build_classification_prompt(data)
        try:
            resp = self._client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": SYSTEM_CLASSIFICATION},
                    {"role": "user", "content": prompt},
                ],
                response_format={"type": "json_object"},
                temperature=0.1,
                max_tokens=600,
            )
            result = _extract_json(resp.choices[0].message.content or "")
            if not result:
                logger.error("[Ollama] empty/invalid JSON from model")
                return None
            result = validate_classification_result(result)
            usage = getattr(resp, "usage", None)
            result["tokens_in"] = getattr(usage, "prompt_tokens", 0) if usage else 0
            result["tokens_out"] = getattr(usage, "completion_tokens", 0) if usage else 0
            result["analyzed_by"] = f"ollama-{self.model}"
            return result
        except Exception as e:  # noqa: BLE001 — network/model error, recoverable
            logger.error(f"[Ollama] processing error: {e}")
            return None

    def enrich_draft(self, data: Dict[str, Any], existing_result: Dict[str, Any],
                     model: str = "") -> Dict[str, Any]:
        if existing_result.get("draft_response"):
            return existing_result
        if not self._ready():
            return existing_result
        prompt = build_draft_prompt(data)
        try:
            resp = self._client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": SYSTEM_DRAFT},
                    {"role": "user", "content": prompt},
                ],
                response_format={"type": "json_object"},
                temperature=0.3,
                max_tokens=400,
            )
            parsed = _extract_json(resp.choices[0].message.content or "")
            existing_result["draft_response"] = parsed.get("draft_response") or ""
            usage = getattr(resp, "usage", None)
            if usage:
                existing_result["tokens_in"] = existing_result.get("tokens_in", 0) + getattr(usage, "prompt_tokens", 0)
                existing_result["tokens_out"] = existing_result.get("tokens_out", 0) + getattr(usage, "completion_tokens", 0)
        except Exception as e:  # noqa: BLE001
            logger.error(f"[Ollama] draft error: {e}")
        return existing_result

    def chat_endpoint(self) -> tuple:
        if not self._ready():
            return None, None
        return self._client, self.model

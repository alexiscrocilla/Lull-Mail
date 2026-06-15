# SPDX-License-Identifier: GPL-3.0-or-later
"""Provider for **Claude** (Anthropic).

Classification and drafting go through the official ``anthropic`` SDK
(Messages API). The OpenAI-flavoured extras (prompt-injection check, draft
verify, the Cmd-K agent) reuse Anthropic's OpenAI-compatible endpoint via the
OpenAI SDK, so they keep working without a second code path.

The API key lives in the OS keyring (resolved into ``cfg.llm.anthropic.api_key``
at load time); it is never written to config.yaml in clear text.
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
    extract_json,
    validate_classification_result,
)

logger = logging.getLogger(__name__)

# Anthropic's OpenAI-compatibility base URL (drives the OpenAI-shape extras).
_COMPAT_BASE_URL = "https://api.anthropic.com/v1/"


class AnthropicProvider(LLMProvider):
    name = "anthropic"

    def __init__(self) -> None:
        self._client = None            # native anthropic.Anthropic
        self._compat: Optional[OpenAI] = None  # OpenAI SDK → Anthropic compat
        self.model: str = "claude-3-5-haiku-latest"

    def init(self, **_kwargs: Any) -> None:
        """Read key + model from config and build both clients. Empty key →
        no-AI (clients None)."""
        from src import config as cfg
        anthropic_cfg = (cfg.get().get("llm") or {}).get("anthropic") or {}
        key = anthropic_cfg.get("api_key") or ""
        self.model = anthropic_cfg.get("model") or "claude-3-5-haiku-latest"
        if not key:
            self._client = None
            self._compat = None
            return
        try:
            import anthropic
        except ImportError:
            logger.error("[Anthropic] le paquet `anthropic` n'est pas installé")
            self._client = None
            self._compat = None
            return
        self._client = anthropic.Anthropic(api_key=key)
        self._compat = OpenAI(api_key=key, base_url=_COMPAT_BASE_URL)

    def _ready(self) -> bool:
        if self._client is None:
            self.init()
        return self._client is not None

    def process_email(self, data: Dict[str, Any], model: str = "") -> Optional[Dict[str, Any]]:
        if not self._ready():
            logger.error("[Anthropic] client non initialisé")
            return None
        prompt = build_classification_prompt(data)
        try:
            resp = self._client.messages.create(
                model=self.model,
                max_tokens=600,
                temperature=0.1,
                system=SYSTEM_CLASSIFICATION,
                messages=[{"role": "user", "content": prompt}],
            )
            text = resp.content[0].text if resp.content else ""
            result = extract_json(text)
            if not result:
                logger.error("[Anthropic] empty/invalid JSON from model")
                return None
            result = validate_classification_result(result)
            usage = getattr(resp, "usage", None)
            result["tokens_in"] = getattr(usage, "input_tokens", 0) if usage else 0
            result["tokens_out"] = getattr(usage, "output_tokens", 0) if usage else 0
            result["analyzed_by"] = f"anthropic-{self.model}"
            return result
        except Exception as e:  # noqa: BLE001 — recoverable
            logger.error(f"[Anthropic] processing error: {e}")
            return None

    def enrich_draft(self, data: Dict[str, Any], existing_result: Dict[str, Any],
                     model: str = "") -> Dict[str, Any]:
        if existing_result.get("draft_response"):
            return existing_result
        if not self._ready():
            return existing_result
        prompt = build_draft_prompt(data)
        try:
            resp = self._client.messages.create(
                model=self.model,
                max_tokens=600,
                temperature=0.3,
                system=SYSTEM_DRAFT,
                messages=[{"role": "user", "content": prompt}],
            )
            text = resp.content[0].text if resp.content else ""
            parsed = extract_json(text)
            existing_result["draft_response"] = parsed.get("draft_response") or ""
            usage = getattr(resp, "usage", None)
            if usage:
                existing_result["tokens_in"] = existing_result.get("tokens_in", 0) + getattr(usage, "input_tokens", 0)
                existing_result["tokens_out"] = existing_result.get("tokens_out", 0) + getattr(usage, "output_tokens", 0)
        except Exception as e:  # noqa: BLE001
            logger.error(f"[Anthropic] draft error: {e}")
        return existing_result

    def chat_endpoint(self) -> tuple:
        """OpenAI-compatible client (Anthropic compat endpoint) for the extras."""
        if not self._ready() or self._compat is None:
            return None, None
        return self._compat, self.model

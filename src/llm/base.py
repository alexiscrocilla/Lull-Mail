# SPDX-License-Identifier: GPL-3.0-or-later
"""
Classe abstraite `LLMProvider` + helpers partagés.

Les prompts (`_SYSTEM_CLASSIFICATION`, `_USER_CLASSIFICATION`, etc.) sont
extraits verbatim de l'ancien `src/ai_processor.py`. Tout changement ici
modifie ce que GPT voit — un snapshot test verrouille leur contenu
(cf. `tests/test_llm_openai_provider.py`) pour détecter tout drift
silencieux pendant les refactors futurs.

Phase 1 : seul `OpenAIProvider` implémente cette interface.
Phase 2 : `LocalLLMProvider` (Phi-3.5-mini + rules + score dérivé)
ajoute une seconde implémentation. Les deux partagent les helpers
`_strip_html`, `_validate_classification_result` mais ont chacun leurs
propres prompts (le local utilise `scripts/prompts_local_v3.py` qui
diffère significativement — pas de CoT, pas de score numérique demandé).
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional


# ─────────────────────────────────────────────────────────────────────────────
# Prompts OpenAI — extraits verbatim de src/ai_processor.py (commit avant
# refactor Phase 1). Toute modification doit être reflétée dans le snapshot
# test, sinon la PR casse intentionnellement la CI pour forcer la review.
# ─────────────────────────────────────────────────────────────────────────────

_SYSTEM_CLASSIFICATION = """Tu es un assistant expert en gestion d'emails. Analyse les emails et retourne UNIQUEMENT du JSON valide, sans markdown ni texte autour.

Catégories :
- important   : messages personnels ou professionnels nécessitant attention ou action
- newsletter  : marketing, abonnements, contenu envoyé en masse
- transactional : confirmations de commande, reçus, livraisons, notifications automatiques
- spam        : non sollicité, suspect, publicitaire indésirable
- other       : tout le reste

Score d'importance (1-10) :
- 9-10 : Urgent, action immédiate requise
- 7-8  : Important, à traiter aujourd'hui
- 5-6  : Importance modérée
- 3-4  : Basse priorité
- 1-2  : Pas important (newsletters, transactionnel routinier)"""


_USER_CLASSIFICATION = """Analyse cet email :

De      : {sender}
À       : {recipient}
Objet   : {subject}
Corps   :
{body}

Réponds UNIQUEMENT avec ce JSON (aucun autre texte) :
{{
  "category": "important|newsletter|transactional|spam|other",
  "importance_score": <entier 1-10>,
  "importance_reason": "<une phrase expliquant le score>",
  "summary": "<une phrase résumant l'email>",
  "needs_reply": <true|false>,
  "draft_response": "<brouillon de réponse dans la même langue que l'email, ou null>"
}}"""


_SYSTEM_DRAFT = "Tu es un assistant de rédaction d'emails. Réponds uniquement avec du JSON valide."


_USER_DRAFT = """Rédige une réponse à cet email.

De      : {sender}
À       : {recipient}
Objet   : {subject}
Corps   :
{body}

Réponds UNIQUEMENT avec ce JSON (aucun autre texte) :
{{
  "draft_response": "<brouillon complet dans la même langue que l'email>"
}}"""


VALID_CATEGORIES = {"important", "newsletter", "transactional", "spam", "other"}


# ─────────────────────────────────────────────────────────────────────────────
# Helpers — utilisés par OpenAIProvider et, à terme, LocalLLMProvider.
# ─────────────────────────────────────────────────────────────────────────────


def strip_html(html: str) -> str:
    """Extrait du texte plat depuis un body HTML. Réutilisé par les deux
    providers pour normaliser l'input avant prompt-build. Logique
    identique à l'ancien `src/ai_processor.py:_strip_html`.
    """
    text = re.sub(r"<style[^>]*>.*?</style>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<script[^>]*>.*?</script>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def build_classification_prompt(data: Dict[str, Any], body_limit: int = 800) -> str:
    """Construit le user-prompt de classification. body_limit=800 reproduit
    l'ancienne troncature de Level-3 (faible coût de tokens)."""
    body = (data.get("body_text") or "").strip()
    if not body and data.get("body_html"):
        body = strip_html(data["body_html"])
    body = body[:body_limit]
    return _USER_CLASSIFICATION.format(
        sender=str(data.get("sender") or "")[:200],
        recipient=str(data.get("recipient") or "")[:200],
        subject=str(data.get("subject") or "")[:200],
        body=body,
    )


def build_draft_prompt(data: Dict[str, Any], body_limit: int = 4000) -> str:
    """Level-4 : body_limit=4000 pour avoir assez de contexte pour rédiger
    une réponse cohérente. Reproduit l'ancien `enrich_draft`."""
    body = (data.get("body_text") or "").strip()
    if not body and data.get("body_html"):
        body = strip_html(data["body_html"])
    body = body[:body_limit]
    return _USER_DRAFT.format(
        sender=str(data.get("sender") or "")[:200],
        recipient=str(data.get("recipient") or "")[:200],
        subject=str(data.get("subject") or "")[:200],
        body=body,
    )


def extract_json(text: str) -> Dict[str, Any]:
    """Best-effort JSON parse from a model reply: strips ``` fences and falls
    back to the first {...} block. Small local models and Claude don't always
    return bare JSON, so we never trust the raw string blindly."""
    import json
    s = (text or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\s*", "", s)
        s = re.sub(r"\s*```$", "", s).strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", s, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
    return {}


def validate_classification_result(result: Dict[str, Any]) -> Dict[str, Any]:
    """Normalise le dict retourné par n'importe quel provider :
      - catégorie inconnue → "other"
      - score clampé à [1, 10] avec coercion int
      - clés manquantes → defaults
    Identique à `src/ai_processor.py:95-100`. Préserve le contrat avec
    `db.update_email_ai` qui s'attend à ces 5 champs.
    """
    if result.get("category") not in VALID_CATEGORIES:
        result["category"] = "other"
    try:
        result["importance_score"] = max(1, min(10, int(result.get("importance_score", 3))))
    except (TypeError, ValueError):
        result["importance_score"] = 3
    result.setdefault("needs_reply", False)
    result.setdefault("summary", "")
    result.setdefault("importance_reason", "")
    return result


# Exports nominatifs pour les imports « depuis » base.py
SYSTEM_CLASSIFICATION = _SYSTEM_CLASSIFICATION
USER_CLASSIFICATION = _USER_CLASSIFICATION
SYSTEM_DRAFT = _SYSTEM_DRAFT
USER_DRAFT = _USER_DRAFT


# ─────────────────────────────────────────────────────────────────────────────
# Interface abstraite. Les implémentations encapsulent l'endroit où
# l'inférence se passe (OpenAI cloud, llama_cpp.server local) mais
# partagent la même API d'entrée/sortie pour que les call sites
# (scheduler.py, api.py) ne sachent pas qui répond.
# ─────────────────────────────────────────────────────────────────────────────


class LLMProvider(ABC):
    """Interface commune à tous les backends LLM."""

    #: Identifiant court écrit dans `emails.analyzed_by` pour tracer
    #: quel provider a classifié quelle ligne. Phase 2 introduira des
    #: variantes comme "local-phi-3.5-mini-q4".
    name: str = "abstract"

    @abstractmethod
    def init(self, **kwargs: Any) -> None:
        """Configuration idempotente (clé API OpenAI, spawn de serveurs
        locaux, …). Re-appelé à chaque hot-reload de config."""
        raise NotImplementedError

    @abstractmethod
    def process_email(self, data: Dict[str, Any], model: str) -> Optional[Dict[str, Any]]:
        """Classification d'un email. Retourne le dict normalisé attendu
        par `db.update_email_ai`, ou `None` en cas d'échec récupérable
        (le scheduler retentera jusqu'à 3 fois)."""
        raise NotImplementedError

    @abstractmethod
    def enrich_draft(
        self, data: Dict[str, Any], existing_result: Dict[str, Any], model: str
    ) -> Dict[str, Any]:
        """Génération de brouillon complet (Level-4). Mute `existing_result`
        sur place pour rester compatible avec l'ancien comportement, et
        renvoie la même référence pour la pratique."""
        raise NotImplementedError

    def chat_endpoint(self) -> tuple:
        """``(client, model)`` — an **OpenAI-compatible** chat client for the
        OpenAI-flavoured extras (prompt-injection LLM check, draft verify, the
        Cmd-K agent), plus the model name to use. Returns ``(None, None)`` when
        the backend can't serve one. Each concrete provider overrides this so
        those features work on whatever backend is active (cloud, local,
        Ollama, or Claude via its OpenAI-compatible endpoint)."""
        return None, None

    def agent_chat_endpoint(self) -> tuple:
        """``(client, model)`` for the tool-calling Cmd-K agent specifically.

        Defaults to :meth:`chat_endpoint` — cloud providers (OpenAI, Claude,
        Ollama) have a single model that handles both the light extras and the
        agent. The local provider overrides this to route the agent at the
        heavier drafter (trained on tool-call traces) instead of the small
        always-on analyzer, which can't follow tool specs reliably."""
        return self.chat_endpoint()

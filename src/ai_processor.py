import json
import logging
import re
from typing import Dict, Optional

from openai import OpenAI

logger = logging.getLogger(__name__)

_client: Optional[OpenAI] = None

_SYSTEM = """Tu es un assistant expert en gestion d'emails. Analyse les emails et retourne UNIQUEMENT du JSON valide, sans markdown ni texte autour.

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

_USER = """Analyse cet email :

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

_VALID_CATEGORIES = {"important", "newsletter", "transactional", "spam", "other"}


def init_client(api_key: str):
    global _client
    _client = OpenAI(api_key=api_key)


def _strip_html(html: str) -> str:
    text = re.sub(r"<style[^>]*>.*?</style>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<script[^>]*>.*?</script>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def process_email(data: Dict, model: str = "gpt-4o-mini") -> Optional[Dict]:
    if not _client:
        logger.error("OpenAI client not initialized")
        return None

    body = (data.get("body_text") or "").strip()
    if not body and data.get("body_html"):
        body = _strip_html(data["body_html"])
    # Level-3: compact excerpt for classification (low token cost).
    # Level-4: full body only when a draft reply is needed (re-queried after).
    body = body[:800]

    prompt = _USER.format(
        sender=str(data.get("sender", ""))[:200],
        recipient=str(data.get("recipient", ""))[:200],
        subject=str(data.get("subject", ""))[:200],
        body=body,
    )

    try:
        response = _client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.1,
            max_tokens=600,
        )
        result = json.loads(response.choices[0].message.content)

        if result.get("category") not in _VALID_CATEGORIES:
            result["category"] = "other"
        result["importance_score"] = max(1, min(10, int(result.get("importance_score", 3))))
        result.setdefault("needs_reply", False)
        result.setdefault("summary", "")
        result.setdefault("importance_reason", "")

        usage = response.usage
        result["tokens_in"]  = usage.prompt_tokens     if usage else 0
        result["tokens_out"] = usage.completion_tokens if usage else 0

        return result

    except json.JSONDecodeError as e:
        logger.error(f"AI JSON parse error: {e}")
    except Exception as e:
        logger.error(f"AI processing error: {e}")

    return None


_DRAFT_USER = """Rédige une réponse à cet email.

De      : {sender}
À       : {recipient}
Objet   : {subject}
Corps   :
{body}

Réponds UNIQUEMENT avec ce JSON (aucun autre texte) :
{{
  "draft_response": "<brouillon complet dans la même langue que l'email>"
}}"""


def enrich_draft(data: Dict, existing_result: Dict, model: str = "gpt-4o-mini") -> Dict:
    """Level-4: generate a full draft response using the complete body.

    Called only when the level-3 result has needs_reply=True but draft_response
    is absent or empty (because the body was truncated during classification).
    Returns the enriched result dict with draft_response filled in.
    """
    if not _client:
        return existing_result
    if existing_result.get("draft_response"):
        return existing_result  # Already have one, nothing to do.

    body = (data.get("body_text") or "").strip()
    if not body and data.get("body_html"):
        body = _strip_html(data["body_html"])
    body = body[:4000]  # Generous limit for drafting

    prompt = _DRAFT_USER.format(
        sender=str(data.get("sender", ""))[:200],
        recipient=str(data.get("recipient", ""))[:200],
        subject=str(data.get("subject", ""))[:200],
        body=body,
    )

    try:
        response = _client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "Tu es un assistant de rédaction d'emails. Réponds uniquement avec du JSON valide."},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.3,
            max_tokens=400,
        )
        parsed = json.loads(response.choices[0].message.content)
        existing_result["draft_response"] = parsed.get("draft_response") or ""
        usage = response.usage
        existing_result["tokens_in"]  = existing_result.get("tokens_in", 0)  + (usage.prompt_tokens     if usage else 0)
        existing_result["tokens_out"] = existing_result.get("tokens_out", 0) + (usage.completion_tokens if usage else 0)
    except Exception as e:
        logger.error(f"Draft enrichment error: {e}")

    return existing_result

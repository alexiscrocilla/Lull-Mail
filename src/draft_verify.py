"""AI draft verifier — strip agent/system artifacts that may leak into a
generated reply, without altering legitimate content.

Port of cloudflare/agentic-inbox ``verifyDraft`` (``workers/lib/ai.ts``),
adapted to OpenAI. Safety bias: when in doubt, KEEP the content. Always
returns the original draft on any failure (never an empty string)."""

import logging
from typing import Optional

logger = logging.getLogger(__name__)

_VERIFIER_PROMPT = """Tu relis un brouillon d'email sortant rédigé par un assistant IA pour le compte d'un humain.

C'est un VRAI email destiné à une VRAIE personne. Il contient du contenu légitime : URLs, liens, questions, détails techniques, tarifs, références — tout cela est intentionnel et DOIT être conservé exactement.

Ta tâche : repérer si l'assistant a accidentellement laissé son propre commentaire interne ou des artefacts système dans le texte de l'email. Ce sont des phrases qui parlent DU processus de rédaction, pas destinées au destinataire.

Exemples d'artefacts à RETIRER (s'ils sont présents) :
- "Brouillon enregistré." / "Draft saved." / "Draft created."
- "J'ai rédigé une réponse à valider."
- "L'opérateur pourra relire et envoyer depuis l'interface."
- "[Auto-déclenché]" / "[Auto-triggered]"
- Lignes contenant des noms d'outils comme draft_reply, get_email, etc.

Exemples de contenu légitime à GARDER (ne jamais retirer) :
- URLs et liens, questions au destinataire, informations de prix, détails techniques
- La signature (le nom de l'expéditeur)
- Tout ce qui ressemble à une personne qui parle à une autre personne

RÈGLES :
1. Si l'email n'a AUCUN artefact, renvoie-le EXACTEMENT tel quel, caractère pour caractère. Ne reformule rien.
2. Si tu trouves des artefacts, retire UNIQUEMENT ces lignes. Garde tout le reste identique.
3. En cas de doute, GARDE le contenu. Un faux positif (retirer du vrai contenu) est bien pire qu'un faux négatif.
4. Renvoie UNIQUEMENT le texte de l'email. Aucune explication, aucun préambule."""


def _openai_client():
    """Raw OpenAI client from the active provider, or None (local mode /
    no key). When None, verify_draft returns the original unchanged."""
    try:
        from src.llm.registry import get_provider
        return getattr(get_provider(), "_client", None)
    except Exception:  # noqa: BLE001
        return None


def verify_draft(text: str, model: str = "gpt-4o-mini") -> str:
    """Return a cleaned draft body, or the original on any uncertainty.

    Guards: skips very short drafts, falls back to the original if the AI
    removes more than 50% of the content (over-aggressive), and never
    returns an empty string."""
    if not text or len(text.strip()) < 20:
        return text

    client = _openai_client()
    if client is None:
        return text

    try:
        r = client.chat.completions.create(
            model=model,
            temperature=0,
            max_tokens=1200,
            messages=[
                {"role": "system", "content": _VERIFIER_PROMPT},
                {"role": "user", "content": text},
            ],
        )
        cleaned: Optional[str] = (r.choices[0].message.content or "").strip()
    except Exception as e:  # noqa: BLE001 — transient/network, never fatal
        logger.error(f"draft verify failed: {e}")
        return text

    if not cleaned:
        return text
    # Over-aggressive removal → keep the original (artifacts are rarer than
    # the risk of gutting a real email).
    if len(cleaned) < len(text.strip()) * 0.5:
        logger.warning(
            "draft verifier removed >50%% of content, keeping original "
            "(orig=%d, cleaned=%d)", len(text.strip()), len(cleaned)
        )
        return text
    return cleaned

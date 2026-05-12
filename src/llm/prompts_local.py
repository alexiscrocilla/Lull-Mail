# SPDX-License-Identifier: GPL-3.0-or-later
"""
Prompts pour le LocalLLMProvider (Phi-3.5-mini + petits modèles ≤ 7B).

Différents des prompts OpenAI (`src.llm.base`) parce que les petits
modèles ont besoin d'aides spécifiques que GPT-4o n'a pas — c'est le
résultat des spikes Phase 0 et Phase 0 bis (cf. `data/phase0_bis_summary.md`).

Trois leviers pour passer les seuils go/no-go avec un 3.8B :

  1. **Pas de Chain-of-Thought.** CoT handicape les modèles ≤10B
     (Wei et al. 2022, NeurIPS) : ils produisent des chaînes "fluides
     mais illogiques". Le prompt classification est plat : un seul
     JSON court, pas de "step 1 → step 2 → step 3".

  2. **Few-shot inline.** 4 exemples FR concrets dans le system prompt,
     un par catégorie non-spam. Le modèle pattern-matche au lieu de
     raisonner abstraitement. C'est ce qui élimine les hallucinations
     "important" sur des newsletters Twitch/Quora.

  3. **JSON Schema strict avec enum.** llama_cpp.server convertit le
     schema en grammaire GBNF interne — impossible pour le modèle de
     sortir "Important" majuscule, "promo" comme catégorie, ou un
     score à virgule. Élimine la dispersion de format.

Le **score 1-10 n'est PAS demandé au modèle.** Le modèle sature à 7-9
quand on lui demande directement (Phase 0 spikes : 1.5B et 3B). Le
score est dérivé côté Python via :

    score = SCORE_BY_CATEGORY[category] × f(confidence)

où confidence = exp(logprob du token catégorie). Pour "important",
on applique une formule quadratique (`conf²`) qui pénalise plus
fortement les faibles confiances : un email classé "important" à 0.70
de confiance donne score 4 (et non 7), ce qui élimine les faux positifs
type "alerte emploi automatisée" observés en Phase 0 bis.

Pour les autres catégories, formule linéaire douce :
`0.5 + 0.5 × confidence` — le score reste dans la fourchette attendue
même à faible confiance.
"""

from __future__ import annotations

from typing import Any, Dict


# ─────────────────────────────────────────────────────────────────────────────
# System prompt — anti-CoT, anti-biais, few-shot inline.
# Validé sur 50 emails Phase 0 bis : |Δ|=1.00, needs_reply 90%, 70%
# du trafic absorbé par rules avant d'atteindre ce prompt.
# ─────────────────────────────────────────────────────────────────────────────

SYSTEM = """Tu classifies des emails français en JSON. Pas de markdown, pas de commentaire, pas de texte hors JSON.

CATÉGORIES (5, exactement) :
- important    : email personnel ou professionnel nominatif qui attend lecture ou action humaine
- newsletter   : marketing, promotion, abonnement, contenu envoyé en masse, digest, suggestions automatiques
- transactional: confirmation de commande, reçu, livraison, notification automatique de service (banque, plateforme)
- spam         : non sollicité, suspect, frauduleux
- other        : ne tombe pas clairement dans les 4 ci-dessus

EXEMPLES (matche par analogie) :
1. Twitch <no-reply@twitch.tv> "SUBtember est arrivé !" → {"category":"newsletter","needs_reply":false,"summary":"Promotion d'abonnements Twitch."}
2. Amazon <auto-confirm@amazon.fr> "Votre commande a été expédiée" → {"category":"transactional","needs_reply":false,"summary":"Confirmation d'expédition d'une commande Amazon."}
3. Jean Dupont <jean@entreprise.com> "Peux-tu regarder le devis ?" → {"category":"important","needs_reply":true,"summary":"Collègue demande de réviser un devis."}
4. Google <no-reply@accounts.google.com> "Vérifiez les paramètres de sécurité" → {"category":"other","needs_reply":false,"summary":"Notification Google sur les paramètres de confidentialité."}

RÈGLES ANTI-BIAIS :
- Un expéditeur "no-reply", "noreply", "notifications", "digest", "newsletter", "marketing", "info" → JAMAIS important.
- Un objet contenant promo, -XX%, réduction, soldes, exclusivité, dernière chance → newsletter.
- Un body contenant "unsubscribe", "se désabonner", "view in browser" → newsletter ou transactional.
- needs_reply=true UNIQUEMENT si un humain identifiable t'attend pour une réponse rédigée. Pas pour les notifications. Pas pour les newsletters. Pas pour les confirmations automatiques.

FORMAT DE SORTIE (JSON strict, rien d'autre) :
{"category":"...","needs_reply":true/false,"summary":"une phrase française"}"""


USER = """De: {sender}
À: {recipient}
Objet: {subject}
Corps:
{body}

JSON:"""


# ─────────────────────────────────────────────────────────────────────────────
# JSON Schema — converti en GBNF par llama_cpp.server. Empêche les
# valeurs hors enum et les types non int/bool. Élimine 100% des erreurs
# de parsing côté provider.
# ─────────────────────────────────────────────────────────────────────────────

RESPONSE_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "category": {
            "type": "string",
            "enum": ["important", "newsletter", "transactional", "spam", "other"],
        },
        "needs_reply": {"type": "boolean"},
        "summary": {"type": "string"},
    },
    "required": ["category", "needs_reply", "summary"],
}


# ─────────────────────────────────────────────────────────────────────────────
# Score dérivé. Base score par catégorie + modulation par confidence
# (= exp(logprob du token catégorie)). Validé sur 50 emails Phase 0 bis :
# |Δ| moyen = 1.00 (sous le seuil 1.5).
# ─────────────────────────────────────────────────────────────────────────────

SCORE_BY_CATEGORY = {
    "important":     8,
    "transactional": 4,
    "newsletter":    2,
    "spam":          1,
    "other":         3,
}


def derive_score(category: str, confidence: float) -> int:
    """Dérive un score 1-10 à partir de (catégorie LLM, confidence logprob).

    Spécial "important" : formule quadratique `base × conf²` qui pénalise
    plus fortement les faibles confiances. Empêche le LLM de hisser un
    email à "important/8" quand il n'a que 0.70 de confiance (le pattern
    qui sortait sur les newsletters "alertes emploi automatisées" en
    Phase 0 bis).
      - confidence 0.95 → 8 × 0.9025 = 7.2 → 7   (presque inchangé)
      - confidence 0.70 → 8 × 0.49   = 3.9 → 4   (au lieu de 7)
      - confidence 0.50 → 8 × 0.25   = 2  → 2   (très conservatif)

    Pour les autres catégories, formule linéaire douce :
        score = base × (0.5 + 0.5 × confidence)
    """
    conf = max(0.0, min(1.0, confidence))
    base = SCORE_BY_CATEGORY.get(category, 3)
    if category == "important":
        raw = base * (conf * conf)
    else:
        raw = base * (0.5 + 0.5 * conf)
    return max(1, min(10, round(raw)))


# ─────────────────────────────────────────────────────────────────────────────
# Builder de payload OpenAI-compat.
# ─────────────────────────────────────────────────────────────────────────────


def build_classification_request(
    row: Dict[str, Any],
    *,
    model: str = "local",
    max_tokens: int = 300,
    temperature: float = 0.1,
) -> Dict[str, Any]:
    """Construit le payload exact à passer à `OpenAI(...).chat.completions.create`."""
    import re

    body = (row.get("body_text") or "").strip()
    if not body and row.get("body_html"):
        html = row["body_html"]
        html = re.sub(r"<style[^>]*>.*?</style>", " ", html, flags=re.S | re.I)
        html = re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=re.S | re.I)
        html = re.sub(r"<[^>]+>", " ", html)
        body = re.sub(r"\s+", " ", html).strip()
    body = body[:800]

    user_msg = USER.format(
        sender=str(row.get("sender") or "")[:200],
        recipient=str(row.get("recipient") or "")[:200],
        subject=str(row.get("subject") or "")[:200],
        body=body,
    )

    return {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user_msg},
        ],
        "response_format": {"type": "json_object", "schema": RESPONSE_SCHEMA},
        "temperature": temperature,
        "max_tokens": max_tokens,
        "logprobs": True,
        "top_logprobs": 5,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Prompt pour la rédaction de brouillon (Level-4).
# Le drafter est un modèle plus gros (7B) — pas besoin d'autant de bridage.
# On garde la structure proche du prompt OpenAI mais en français explicite
# parce que Mistral 7B v0.3 / Qwen 7B sont meilleurs avec des consignes
# en français qu'en anglais sur du contenu français.
# ─────────────────────────────────────────────────────────────────────────────


SYSTEM_DRAFT = (
    "Tu es un assistant de rédaction d'emails français. Tu réponds "
    "UNIQUEMENT avec du JSON valide, sans markdown, sans commentaire."
)


USER_DRAFT = """Rédige une réponse polie et professionnelle à cet email.

De      : {sender}
À       : {recipient}
Objet   : {subject}
Corps   :
{body}

Réponds UNIQUEMENT avec ce JSON (rien d'autre) :
{{"draft_response": "<brouillon complet dans la même langue que l'email>"}}"""


DRAFT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "draft_response": {"type": "string"},
    },
    "required": ["draft_response"],
}


def build_draft_request(
    row: Dict[str, Any],
    *,
    model: str = "local",
    max_tokens: int = 500,
    temperature: float = 0.3,
) -> Dict[str, Any]:
    import re

    body = (row.get("body_text") or "").strip()
    if not body and row.get("body_html"):
        html = row["body_html"]
        html = re.sub(r"<style[^>]*>.*?</style>", " ", html, flags=re.S | re.I)
        html = re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=re.S | re.I)
        html = re.sub(r"<[^>]+>", " ", html)
        body = re.sub(r"\s+", " ", html).strip()
    body = body[:4000]

    user_msg = USER_DRAFT.format(
        sender=str(row.get("sender") or "")[:200],
        recipient=str(row.get("recipient") or "")[:200],
        subject=str(row.get("subject") or "")[:200],
        body=body,
    )

    return {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_DRAFT},
            {"role": "user", "content": user_msg},
        ],
        "response_format": {"type": "json_object", "schema": DRAFT_SCHEMA},
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

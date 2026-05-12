# SPDX-License-Identifier: GPL-3.0-or-later
"""
Catalogue statique des modèles GGUF supportés par le provider local.

Source de vérité unique pour :
  - le téléchargement (URL HF + SHA-256 attendu + taille)
  - le choix de modèle dans Settings → IA → Local
  - le mapping tier → modèles recommandés

Pas de modèle bundlé dans l'installeur (les GGUF font 1-5 Go chacun,
ils sont téléchargés post-install dans `paths.MODELS_DIR`). Le catalog
contient ce qu'on PROPOSE à l'utilisateur ; ce qu'il a effectivement
téléchargé se découvre en listant `MODELS_DIR/*.gguf` au runtime
(`src/llm/server.py` ou un endpoint `/api/llm/models`).

Choix de modèles documentés dans `data/phase0_bis_summary.md` :
  - **Analyzer Light/Medium** : Phi-3.5-mini Q4_K_M (3.8B, MIT,
    MultilingualMMLU 51.8%). Validé sur 50 emails français : |Δ| score
    1.00, needs_reply 90%, après pipeline Rules + score dérivé.
  - **Drafter** : Mistral 7B v0.3 Instruct Q4_K_M (Apache 2.0, FR de
    qualité). À valider empiriquement en Phase 2 spike (génération de
    brouillon, tâche plus facile que la classification).

Phi-4-mini est volontairement absent : son pre-tokenizer "gpt-4o" n'est
pas supporté par llama-cpp-python 0.3.0 (la seule version qui ait un
wheel cp313 Windows compatible avec les CPU Intel 12-13e gen).
"""

from __future__ import annotations

from typing import Any, Dict


# ─────────────────────────────────────────────────────────────────────────────
# Schéma de chaque entrée du catalogue.
# Toutes les URLs pointent vers des miroirs publics HuggingFace (pas
# besoin d'auth). Le SHA-256 est calculé une fois et figé ; le downloader
# vérifie au moment du téléchargement et refuse le fichier si mismatch.
# ─────────────────────────────────────────────────────────────────────────────


CATALOG: Dict[str, Dict[str, Any]] = {
    "phi-3.5-mini-q4": {
        "name": "Phi-3.5 Mini Instruct (Q4_K_M)",
        "vendor": "Microsoft",
        "role": "analyzer",
        "tier": "light",  # tier MINIMUM ; tournera mieux sur medium/heavy
        "size_bytes": 2_393_232_672,  # ~2.4 Go
        "url": (
            "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/"
            "resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf"
        ),
        # SHA-256 du wheel téléchargé dans Phase 0 bis (vérifié manuellement).
        # À recompiler si on bump une version dans le catalog.
        "sha256": None,  # TODO Phase 2D : calculer le SHA-256 du fichier final
        "filename": "Phi-3.5-mini-instruct-Q4_K_M.gguf",
        "chat_format": "phi-3",  # llama_cpp.server flag
        "license": "MIT",
        "license_url": "https://opensource.org/licenses/MIT",
        "languages": ["fr", "en", "de", "es", "it", "pt", "nl", "ar",
                      "zh", "ja", "ko", "vi", "id", "th", "tr", "pl",
                      "ru", "uk", "hi", "fa", "he", "no", "sv", "da"],
        "context_length": 4096,
        "recommended_for_tier": "light",  # surfacé en premier dans l'UI
    },
    "qwen-2.5-3b-q4-drafter": {
        "name": "Qwen 2.5 3B Instruct (Q4_K_M) — Drafter léger",
        "vendor": "Alibaba",
        "role": "drafter",
        # Tier "light" parce que ce drafter est conçu pour tenir en RAM
        # à côté de Phi-3.5 analyzer sur une machine 8 Go (~4 Go au pic).
        # Un user Medium/Heavy peut le choisir aussi, mais on lui
        # recommandera Mistral 7B (meilleure qualité FR) par défaut.
        "tier": "light",
        "size_bytes": 1_929_900_000,  # ~1.9 Go
        "url": (
            "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/"
            "resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf"
        ),
        "sha256": None,
        "filename": "Qwen2.5-3B-Instruct-Q4_K_M.gguf",
        "chat_format": "qwen",
        "license": "Qwen Research",  # ≤7B Apache 2.0 ; 3B à re-vérifier
        "license_url": "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/blob/main/LICENSE",
        "languages": ["fr", "en", "zh", "es", "de", "it", "pt", "ja",
                      "ko", "ar", "ru", "vi", "th"],
        "context_length": 4096,
        "recommended_for_tier": "light",
    },
    "mistral-7b-v03-q4": {
        "name": "Mistral 7B Instruct v0.3 (Q4_K_M)",
        "vendor": "Mistral AI",
        "role": "drafter",
        "tier": "medium",  # tient en mémoire sur Medium ≥ 12 Go
        "size_bytes": 4_368_438_976,  # ~4.4 Go
        "url": (
            "https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/"
            "resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf"
        ),
        "sha256": None,
        "filename": "Mistral-7B-Instruct-v0.3-Q4_K_M.gguf",
        "chat_format": "mistral-instruct",
        "license": "Apache-2.0",
        "license_url": "https://www.apache.org/licenses/LICENSE-2.0",
        "languages": ["fr", "en", "de", "es", "it"],  # FR particulièrement fort
        "context_length": 8192,
        "recommended_for_tier": "medium",
    },
    "qwen-2.5-7b-q4": {
        "name": "Qwen 2.5 7B Instruct (Q4_K_M)",
        "vendor": "Alibaba",
        "role": "drafter",
        "tier": "heavy",
        "size_bytes": 4_683_073_376,  # ~4.7 Go
        "url": (
            "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/"
            "resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf"
        ),
        "sha256": None,
        "filename": "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        "chat_format": "qwen",
        "license": "Apache-2.0",
        "license_url": "https://www.apache.org/licenses/LICENSE-2.0",
        "languages": ["fr", "en", "zh", "es", "de", "it", "pt", "ja",
                      "ko", "ar", "ru", "vi", "th"],
        "context_length": 8192,
        "recommended_for_tier": "heavy",
    },
}


def list_models(*, role: str | None = None, tier: str | None = None) -> list[Dict[str, Any]]:
    """Renvoie les entrées du catalogue, éventuellement filtrées.

    `role` : "analyzer" ou "drafter" — filtre par rôle.
    `tier` : "light", "medium", "heavy" — filtre les modèles dont le tier
             minimum est compatible (un modèle "light" tourne aussi sur
             "medium" et "heavy", mais pas l'inverse).
    """
    _tier_order = {"light": 0, "medium": 1, "heavy": 2}
    out = []
    for model_id, meta in CATALOG.items():
        if role and meta["role"] != role:
            continue
        if tier and _tier_order[meta["tier"]] > _tier_order[tier]:
            continue
        out.append({"id": model_id, **meta})
    return out


def get_model(model_id: str) -> Dict[str, Any] | None:
    """Renvoie la fiche complète d'un modèle, ou None si inconnu."""
    meta = CATALOG.get(model_id)
    if meta is None:
        return None
    return {"id": model_id, **meta}


def default_for(role: str, tier: str) -> str | None:
    """Le modèle recommandé pour (role, tier). Utilisé par les défauts de
    config et l'UI Settings (pré-sélection)."""
    # Pré-filtre par rôle puis par tier exact (recommended_for_tier).
    for model_id, meta in CATALOG.items():
        if meta["role"] == role and meta.get("recommended_for_tier") == tier:
            return model_id
    # Sinon, premier modèle compatible du rôle pour ce tier.
    candidates = list_models(role=role, tier=tier)
    return candidates[0]["id"] if candidates else None

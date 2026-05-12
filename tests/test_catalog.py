# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests du catalog GGUF. Vérifie que chaque entrée a les champs requis,
et que `list_models` / `default_for` respectent la sémantique tier."""

from __future__ import annotations

import pytest

from src.llm import catalog


_REQUIRED_FIELDS = {
    "name", "vendor", "role", "tier", "size_bytes", "url",
    "filename", "chat_format", "license", "languages",
    "context_length", "recommended_for_tier",
}


def test_every_entry_has_required_fields():
    for model_id, meta in catalog.CATALOG.items():
        missing = _REQUIRED_FIELDS - set(meta.keys())
        assert not missing, f"{model_id} manque les champs : {missing}"


def test_role_is_valid_enum():
    for model_id, meta in catalog.CATALOG.items():
        assert meta["role"] in ("analyzer", "drafter"), (
            f"{model_id} role invalide : {meta['role']!r}"
        )


def test_tier_is_valid_enum():
    for model_id, meta in catalog.CATALOG.items():
        assert meta["tier"] in ("light", "medium", "heavy"), (
            f"{model_id} tier invalide : {meta['tier']!r}"
        )
        assert meta["recommended_for_tier"] in ("light", "medium", "heavy")


def test_filename_matches_url():
    """Le `filename` doit être le dernier segment de l'URL — sinon le
    downloader écrit dans un fichier que `get_model` ne retrouvera pas."""
    for model_id, meta in catalog.CATALOG.items():
        url_basename = meta["url"].rstrip("/").split("/")[-1]
        assert url_basename == meta["filename"], (
            f"{model_id} : filename {meta['filename']!r} ne matche pas "
            f"l'URL {meta['url']}"
        )


def test_size_bytes_is_sensible():
    """Bornes plausibles : 100 Mo < x < 10 Go (les GGUF Q4 typiques)."""
    for model_id, meta in catalog.CATALOG.items():
        assert 100_000_000 < meta["size_bytes"] < 10_000_000_000, (
            f"{model_id} : taille suspecte {meta['size_bytes']}"
        )


def test_languages_contains_french():
    """v1 cible des utilisateurs FR — chaque modèle proposé doit le
    supporter explicitement."""
    for model_id, meta in catalog.CATALOG.items():
        assert "fr" in meta["languages"], f"{model_id} ne supporte pas 'fr'"


def test_each_tier_has_at_least_one_analyzer_and_drafter():
    """Garantit qu'aucun tier n'est orphelin — l'UI Settings se base sur
    `default_for(role, tier)` pour pré-sélectionner les modèles."""
    for tier in ("light", "medium", "heavy"):
        analyzers = catalog.list_models(role="analyzer", tier=tier)
        drafters = catalog.list_models(role="drafter", tier=tier)
        assert analyzers, f"Aucun analyzer compatible {tier}"
        assert drafters, f"Aucun drafter compatible {tier}"


def test_list_models_filters_by_tier_inclusively():
    """Un modèle 'light' doit aussi apparaître dans la liste 'medium' et
    'heavy' (un modèle plus petit tourne sur une machine plus grosse)."""
    light_only = catalog.list_models(tier="light")
    medium_inc = catalog.list_models(tier="medium")
    light_ids = {m["id"] for m in light_only}
    medium_ids = {m["id"] for m in medium_inc}
    assert light_ids.issubset(medium_ids), (
        "Les modèles light doivent être inclus dans la liste medium"
    )


def test_default_for_recommends_expected_models():
    """Sanity check sur les recommandations par défaut (alignées avec
    les findings Phase 0 bis)."""
    # Analyzer recommandé sur Light : Phi-3.5-mini-q4 (Phase 0 bis :
    # validé avec |Δ|=1.0 sur 50 emails).
    assert catalog.default_for("analyzer", "light") == "phi-3.5-mini-q4"
    # Drafter recommandé sur Medium : Mistral 7B v0.3 (Phase 0 bis : à
    # valider en spike générateur).
    assert catalog.default_for("drafter", "medium") == "mistral-7b-v03-q4"


def test_get_model_returns_none_for_unknown_id():
    assert catalog.get_model("does-not-exist") is None


def test_get_model_returns_dict_with_id():
    m = catalog.get_model("phi-3.5-mini-q4")
    assert m is not None
    assert m["id"] == "phi-3.5-mini-q4"
    assert m["role"] == "analyzer"

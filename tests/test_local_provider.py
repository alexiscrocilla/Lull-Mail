# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests `LocalLLMProvider` + `registry.get_provider` branching.

Le provider est testé avec un AnalyzerServer mocké (pas de subprocess
réel ni d'inférence). On vérifie que :
  - le payload envoyé au serveur est conforme au prompt v3
    (no-CoT, JSON Schema avec enum, logprobs activés)
  - le score est dérivé via la formule `derive_score`, pas demandé au LLM
  - `analyzed_by` est tagué `local-<model_id>`
  - le drafter est lazy (pas démarré tant qu'enrich_draft n'est pas appelé)
  - le registry switche bien selon `cfg.llm.provider`
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from src.llm import local_provider as lp
from src.llm import prompts_local as plocal
from src.llm import registry


# ─────────────────────────────────────────────────────────────────────────────
# derive_score — la formule de scoring
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("cat, conf, expected", [
    # important : quadratique conf²
    ("important", 1.00, 8),     # 8 * 1.00 = 8
    ("important", 0.95, 7),     # 8 * 0.9025 = 7.22 → 7
    ("important", 0.70, 4),     # 8 * 0.49 = 3.92 → 4 (vs 7 en linéaire — élimine FP)
    ("important", 0.50, 2),     # 8 * 0.25 = 2
    ("important", 0.30, 1),     # 8 * 0.09 = 0.72 → 1 (clamp)
    # autres : linéaire 0.5 + 0.5*conf
    ("transactional", 1.00, 4),     # 4 * 1.0 = 4
    ("transactional", 0.70, 3),     # 4 * 0.85 = 3.4 → 3
    ("newsletter", 1.00, 2),
    ("newsletter", 0.70, 2),        # 2 * 0.85 = 1.7 → 2
    ("spam", 0.95, 1),               # 1 * 0.975 → 1
    ("other", 1.00, 3),
    # catégorie inconnue → tombe sur le défaut 3
    ("unknown_cat", 0.95, 3),
])
def test_derive_score_formula(cat, conf, expected):
    assert plocal.derive_score(cat, conf) == expected


def test_derive_score_clamps_bounds():
    """Confidence en dehors de [0,1] doit être clampée."""
    assert plocal.derive_score("important", 1.5) == 8  # clamped à 1.0
    assert plocal.derive_score("important", -0.5) == 1  # clamped à 0.0 → 0 → clamp à 1


# ─────────────────────────────────────────────────────────────────────────────
# Prompts v3 — vérifications de structure
# ─────────────────────────────────────────────────────────────────────────────


def test_local_prompt_has_no_chain_of_thought_markers():
    """Le prompt v3 doit être plat — pas de 'étape 1', 'puis', etc.
    Wei et al. 2022 démontre que CoT handicape les modèles ≤10B."""
    sys = plocal.SYSTEM
    forbidden = ["étape 1", "step 1", "réfléchis", "raisonne", "step by step"]
    for word in forbidden:
        assert word.lower() not in sys.lower(), (
            f"Le prompt local ne doit pas contenir {word!r} (CoT)"
        )


def test_local_prompt_does_not_request_score():
    """Le score 1-10 doit être ABSENT du JSON demandé — il est dérivé
    côté Python via derive_score()."""
    sys = plocal.SYSTEM
    # On veut explicitly que le schéma JSON dans le prompt mentionne
    # category + needs_reply + summary, MAIS PAS importance_score.
    assert '"importance_score"' not in sys
    assert '"category"' in sys
    assert '"needs_reply"' in sys
    assert '"summary"' in sys


def test_local_response_schema_constrains_category_enum():
    """Le JSON Schema doit avoir un enum strict sur category — sinon le
    modèle peut halluciner 'Important' majuscule ou 'promo'."""
    schema = plocal.RESPONSE_SCHEMA
    cat_schema = schema["properties"]["category"]
    assert cat_schema["type"] == "string"
    assert set(cat_schema["enum"]) == {
        "important", "newsletter", "transactional", "spam", "other"
    }


def test_local_build_request_includes_logprobs():
    """Le payload OpenAI-compat doit avoir logprobs=True pour qu'on
    puisse récupérer la confidence côté provider."""
    payload = plocal.build_classification_request(
        {"sender": "x", "subject": "y", "body_text": "z"},
        model="phi-3.5-mini",
    )
    assert payload["logprobs"] is True
    assert payload["top_logprobs"] >= 1
    assert payload["response_format"]["type"] == "json_object"
    assert "schema" in payload["response_format"]


# ─────────────────────────────────────────────────────────────────────────────
# LocalLLMProvider — process_email + enrich_draft avec serveurs mockés
# ─────────────────────────────────────────────────────────────────────────────


def _fake_chat_response(content: dict, category_token: str = "newsletter",
                        category_logprob: float = -0.1):
    """Construit une fausse `ChatCompletion` avec logprobs.

    `category_token` apparaîtra dans `choice.logprobs.content` avec le
    logprob fourni — ce que `_extract_category_confidence` parse.
    """
    tok = MagicMock()
    tok.token = category_token
    tok.logprob = category_logprob
    logprobs_content = MagicMock()
    logprobs_content.content = [tok]

    choice = MagicMock()
    choice.message.content = json.dumps(content)
    choice.logprobs = logprobs_content

    usage = MagicMock()
    usage.prompt_tokens = 100
    usage.completion_tokens = 50

    resp = MagicMock()
    resp.choices = [choice]
    resp.usage = usage
    return resp


def test_process_email_returns_none_when_uninitialized():
    p = lp.LocalLLMProvider()
    assert p.process_email({"sender": "s", "subject": "t", "body_text": "b"}) is None


def test_process_email_derives_score_and_tags_analyzed_by(monkeypatch):
    p = lp.LocalLLMProvider()
    p.analyzer_model_id = "phi-3.5-mini-q4"

    # Mock serveur running
    fake_server = MagicMock()
    fake_server.running = True
    fake_server.base_url = "http://127.0.0.1:51234/v1"
    fake_server.api_key = "tok"
    p.analyzer_server = fake_server

    # Mock client OpenAI : retourne newsletter avec conf ~0.9
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = _fake_chat_response(
        {"category": "newsletter", "needs_reply": False,
         "summary": "Promotion d'abonnements."},
        category_token="newsletter",
        category_logprob=-0.10,  # exp(-0.1) ≈ 0.905
    )
    p._analyzer_client = fake_client

    out = p.process_email({"sender": "no-reply@twitch.tv",
                           "subject": "SUBtember",
                           "body_text": "Promotion in-app."})

    assert out is not None
    assert out["category"] == "newsletter"
    assert out["needs_reply"] is False
    assert out["summary"] == "Promotion d'abonnements."
    # Score newsletter avec conf ~0.905 : 2 × (0.5 + 0.5×0.905) = 1.905 → 2
    assert out["importance_score"] == 2
    assert out["analyzed_by"] == "local-phi-3.5-mini-q4"
    assert out["tokens_in"] == 100
    assert out["tokens_out"] == 50

    # Le client a été appelé avec le payload v3 (schema + logprobs)
    call_kwargs = fake_client.chat.completions.create.call_args[1]
    assert call_kwargs["logprobs"] is True
    assert call_kwargs["response_format"]["type"] == "json_object"
    assert "schema" in call_kwargs["response_format"]
    # Pas de field "importance_score" dans le system prompt
    sys_msg = call_kwargs["messages"][0]["content"]
    assert '"importance_score"' not in sys_msg


def test_process_email_handles_important_with_low_confidence(monkeypatch):
    """Reproduit le cas Phase 0 bis : LLM dit "important" mais avec
    conf 0.70 → derive_score doit donner 4 (pas 7). C'est ce qui
    empêche les faux positifs type "AFJV emploi automatisé"."""
    p = lp.LocalLLMProvider()
    p.analyzer_model_id = "phi-3.5-mini-q4"

    fake_server = MagicMock()
    fake_server.running = True
    fake_server.base_url = "http://localhost/v1"
    fake_server.api_key = "tok"
    p.analyzer_server = fake_server

    import math
    low_conf_logprob = math.log(0.70)  # ≈ -0.357

    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = _fake_chat_response(
        {"category": "important", "needs_reply": True,
         "summary": "Alerte emploi quotidienne."},
        category_token="important",
        category_logprob=low_conf_logprob,
    )
    p._analyzer_client = fake_client

    out = p.process_email({"sender": "job@afjv.com",
                           "subject": "Alerte emploi", "body_text": "..."})

    # Sans la formule quadratique on aurait : 8 × (0.5 + 0.5×0.7) = 6.8 → 7
    # Avec la formule quadratique : 8 × 0.49 = 3.92 → 4
    assert out["importance_score"] == 4


def test_enrich_draft_skips_when_drafter_gguf_missing(monkeypatch, tmp_path):
    """Si le drafter GGUF n'est pas téléchargé, enrich_draft retourne
    sans crasher et laisse `existing_result` intact."""
    from src import paths
    monkeypatch.setattr(paths, "MODELS_DIR", tmp_path)

    p = lp.LocalLLMProvider()
    p.drafter_model_id = "mistral-7b-v03-q4"  # filename n'existe pas dans tmp_path

    existing = {"category": "important", "draft_response": ""}
    out = p.enrich_draft({"sender": "x", "subject": "y", "body_text": "z"}, existing)

    assert out is existing
    assert out["draft_response"] == ""  # inchangé
    assert p.drafter_server is None      # pas spawn


def test_enrich_draft_no_op_when_draft_already_present():
    p = lp.LocalLLMProvider()
    existing = {"draft_response": "Bonjour, déjà rédigé"}
    out = p.enrich_draft({"sender": "x"}, existing)
    assert out is existing
    assert out["draft_response"] == "Bonjour, déjà rédigé"


def test_extract_category_confidence_falls_back_to_default():
    """Pas de logprobs dans la réponse → 0.7 par défaut.
    Garantit qu'on ne crashe pas si le serveur ignore logprobs."""
    resp_no_logprobs = MagicMock()
    choice = MagicMock()
    choice.logprobs = None
    resp_no_logprobs.choices = [choice]
    conf = lp.LocalLLMProvider._extract_category_confidence(resp_no_logprobs, "important")
    assert conf == 0.7


# ─────────────────────────────────────────────────────────────────────────────
# registry — branchement sur cfg.llm.provider
# ─────────────────────────────────────────────────────────────────────────────


def test_registry_returns_openai_provider_by_default(monkeypatch):
    """Pas de config → fallback OpenAI. On compare via l'attribut `name`
    plutôt que `isinstance` parce que certains tests précédents peuvent
    avoir invalidé `sys.modules['src.llm.openai_provider']` via la
    fixture `fresh_app` du conftest, ce qui donne deux objets-classes
    distincts pour la même définition."""
    from src import config as cfg
    monkeypatch.setattr(cfg, "_config", {"llm": {"provider": "openai"}})
    registry.reset()
    p = registry.get_provider()
    assert p.name == "openai"
    assert type(p).__name__ == "OpenAIProvider"


def test_registry_returns_local_provider_when_configured(monkeypatch):
    from src import config as cfg
    monkeypatch.setattr(cfg, "_config", {"llm": {"provider": "local"}})
    registry.reset()
    p = registry.get_provider()
    assert p.name == "local"
    assert type(p).__name__ == "LocalLLMProvider"


def test_registry_caches_provider(monkeypatch):
    """Deux appels successifs doivent retourner la MEME instance pour
    éviter de respawn le subprocess llama_cpp à chaque tick."""
    from src import config as cfg
    monkeypatch.setattr(cfg, "_config", {"llm": {"provider": "openai"}})
    registry.reset()
    p1 = registry.get_provider()
    p2 = registry.get_provider()
    assert p1 is p2


def test_registry_reset_then_switch_provider(monkeypatch):
    """Après reset(), un changement de config doit ré-instancier."""
    from src import config as cfg
    monkeypatch.setattr(cfg, "_config", {"llm": {"provider": "openai"}})
    registry.reset()
    p_openai = registry.get_provider()
    assert p_openai.name == "openai"

    monkeypatch.setattr(cfg, "_config", {"llm": {"provider": "local"}})
    registry.reset()
    p_local = registry.get_provider()
    assert p_local.name == "local"
    assert p_openai is not p_local

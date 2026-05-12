# SPDX-License-Identifier: GPL-3.0-or-later
"""
Snapshot tests : verrouille le contenu EXACT des prompts envoyés à OpenAI.

Tout changement (typo, reformulation, ajout de catégorie) doit aussi
mettre à jour les assertions ci-dessous. C'est intentionnel : on veut
qu'une PR qui touche au prompt force la review, parce qu'un drift même
mineur peut changer significativement les sorties du modèle (et donc le
score d'importance que voit l'utilisateur).

Le test ne fait AUCUN appel réseau — on mocke le SDK OpenAI et on
vérifie que le payload assemblé est conforme à ce qu'on attend.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

from src.llm import base
from src.llm.openai_provider import OpenAIProvider


# ─────────────────────────────────────────────────────────────────────────────
# Snapshot du SYSTEM prompt — modifie ces lignes uniquement si tu mets
# à jour `src/llm/base.SYSTEM_CLASSIFICATION` en parallèle.
# ─────────────────────────────────────────────────────────────────────────────


def test_system_classification_snapshot():
    """Le system prompt de classification doit rester strictement
    identique. Sa structure (catégories + barème 1-10) est ce sur quoi
    GPT s'aligne ; toute modif silencieuse change le scoring observé."""
    sys = base.SYSTEM_CLASSIFICATION
    assert sys.startswith("Tu es un assistant expert en gestion d'emails.")
    assert "UNIQUEMENT du JSON valide" in sys
    # Catégories — 5 valeurs exactes, l'ordre compte (l'enum côté DB
    # s'attend à ces strings, le frontend i18n.js les utilise comme keys).
    for cat in ("important", "newsletter", "transactional", "spam", "other"):
        assert f"- {cat:<12}" in sys or f"- {cat} " in sys
    # Barème 1-10 — 5 bandes décrites
    assert "9-10" in sys
    assert "7-8" in sys
    assert "5-6" in sys
    assert "3-4" in sys
    assert "1-2" in sys


def test_user_classification_template_snapshot():
    """Le user-prompt template doit accepter les placeholders fixes
    `{sender}`, `{recipient}`, `{subject}`, `{body}`. Tout autre nom
    casserait `build_classification_prompt`."""
    tmpl = base.USER_CLASSIFICATION
    assert "{sender}" in tmpl
    assert "{recipient}" in tmpl
    assert "{subject}" in tmpl
    assert "{body}" in tmpl
    # Schéma JSON dans le prompt — clés requises par `update_email_ai`
    for key in ("category", "importance_score", "importance_reason",
                "summary", "needs_reply", "draft_response"):
        assert f'"{key}"' in tmpl


def test_user_draft_template_snapshot():
    tmpl = base.USER_DRAFT
    assert tmpl.startswith("Rédige une réponse à cet email")
    for placeholder in ("{sender}", "{recipient}", "{subject}", "{body}"):
        assert placeholder in tmpl
    assert '"draft_response"' in tmpl


# ─────────────────────────────────────────────────────────────────────────────
# Helpers extraits de l'ancien ai_processor.py : on s'assure que la
# logique de troncature + le fallback HTML → texte sont préservés.
# ─────────────────────────────────────────────────────────────────────────────


def test_strip_html_removes_script_and_style():
    html = ("<html><head><style>body{}</style></head><body>"
            "Bonjour <script>alert(1)</script> monde</body></html>")
    assert base.strip_html(html) == "Bonjour monde"


def test_build_classification_prompt_truncates_body_to_800():
    row = {
        "sender": "Alice <a@example.com>",
        "recipient": "me@me.com",
        "subject": "S",
        "body_text": "x" * 5000,
    }
    prompt = base.build_classification_prompt(row)
    # body_limit=800 par défaut ; les autres champs ne contribuent pas
    # plus de quelques centaines de caractères, donc on borne large.
    body_part = prompt.split("Corps   :\n", 1)[1]
    # Le morceau body est suivi de "\n\nRéponds UNIQUEMENT…" — on extrait juste
    # la portion de body.
    body_only = body_part.split("\n\nRéponds", 1)[0]
    assert len(body_only) == 800


def test_build_classification_prompt_falls_back_to_html():
    row = {
        "sender": "s", "recipient": "r", "subject": "sub",
        "body_text": "",
        "body_html": "<p>Hello <b>world</b></p>",
    }
    prompt = base.build_classification_prompt(row)
    assert "Hello world" in prompt


def test_build_draft_prompt_uses_4000_char_limit():
    row = {"sender": "s", "recipient": "r", "subject": "sub",
           "body_text": "y" * 5000}
    prompt = base.build_draft_prompt(row)
    body_only = prompt.split("Corps   :\n", 1)[1].split("\n\nRéponds", 1)[0]
    assert len(body_only) == 4000


def test_validate_clamps_score_and_defaults():
    out = base.validate_classification_result({"category": "BOGUS",
                                                "importance_score": 99})
    assert out["category"] == "other"
    assert out["importance_score"] == 10
    assert out["needs_reply"] is False
    assert out["summary"] == ""
    assert out["importance_reason"] == ""

    out = base.validate_classification_result({"category": "important",
                                                "importance_score": -3})
    assert out["importance_score"] == 1

    out = base.validate_classification_result({})
    assert out["category"] == "other"
    assert out["importance_score"] == 3


def test_validate_handles_non_int_score():
    """Un modèle local mal calibré pourrait renvoyer 'high' ou '7.5' :
    on doit toujours produire un int dans [1, 10]."""
    out = base.validate_classification_result({"category": "important",
                                                "importance_score": "not a number"})
    assert out["importance_score"] == 3  # default

    out = base.validate_classification_result({"category": "newsletter",
                                                "importance_score": None})
    assert out["importance_score"] == 3


# ─────────────────────────────────────────────────────────────────────────────
# Tests OpenAIProvider avec SDK mocké — pas d'appel réseau.
# ─────────────────────────────────────────────────────────────────────────────


def test_openai_provider_returns_none_when_not_initialized():
    p = OpenAIProvider()
    assert p.process_email({"sender": "s", "subject": "t",
                             "body_text": "b"}) is None


def test_openai_provider_init_with_empty_key_clears_client():
    p = OpenAIProvider()
    p.init(api_key="sk-test-fake")
    assert p._client is not None
    p.init(api_key="")
    assert p._client is None


def test_openai_provider_process_email_sets_analyzed_by(monkeypatch):
    """Vérifie que process_email :
      1. envoie le bon system + user prompt à l'API,
      2. emploie response_format=json_object + temperature=0.1 + max_tokens=600,
      3. tag le résultat avec analyzed_by='openai' (utilisé par
         update_email_ai pour tracer le provider).
    """
    p = OpenAIProvider()
    p.init(api_key="sk-fake")

    captured = {}

    def fake_create(**kwargs):
        captured.update(kwargs)
        usage = MagicMock()
        usage.prompt_tokens = 123
        usage.completion_tokens = 45
        choice = MagicMock()
        choice.message.content = json.dumps({
            "category": "important",
            "importance_score": 7,
            "importance_reason": "raison",
            "summary": "résumé",
            "needs_reply": True,
            "draft_response": None,
        })
        resp = MagicMock()
        resp.choices = [choice]
        resp.usage = usage
        return resp

    monkeypatch.setattr(p._client.chat.completions, "create", fake_create)

    out = p.process_email({"sender": "Alice <a@a.com>",
                            "recipient": "me@me.com",
                            "subject": "Hello",
                            "body_text": "Body content"})

    # Sortie normalisée
    assert out["category"] == "important"
    assert out["importance_score"] == 7
    assert out["tokens_in"] == 123
    assert out["tokens_out"] == 45
    assert out["analyzed_by"] == "openai"

    # Payload envoyé au SDK
    assert captured["temperature"] == 0.1
    assert captured["max_tokens"] == 600
    assert captured["response_format"] == {"type": "json_object"}
    assert captured["messages"][0]["role"] == "system"
    assert captured["messages"][0]["content"] == base.SYSTEM_CLASSIFICATION
    assert captured["messages"][1]["role"] == "user"
    assert "Alice <a@a.com>" in captured["messages"][1]["content"]
    assert "Body content" in captured["messages"][1]["content"]


def test_openai_provider_enrich_draft_skips_if_already_present():
    p = OpenAIProvider()
    p.init(api_key="sk-fake")
    existing = {"draft_response": "already there"}
    out = p.enrich_draft({"body_text": "x"}, existing)
    assert out is existing
    assert out["draft_response"] == "already there"


def test_openai_provider_enrich_draft_uses_4000_char_body(monkeypatch):
    """Level-4 (draft) doit utiliser le full-body (limite 4000 chars)
    là où Level-3 (classification) trunque à 800."""
    p = OpenAIProvider()
    p.init(api_key="sk-fake")

    captured = {}

    def fake_create(**kwargs):
        captured.update(kwargs)
        choice = MagicMock()
        choice.message.content = json.dumps({"draft_response": "Bonjour"})
        resp = MagicMock()
        resp.choices = [choice]
        resp.usage = None
        return resp

    monkeypatch.setattr(p._client.chat.completions, "create", fake_create)

    long_body = "z" * 5000
    out = p.enrich_draft({"sender": "s", "subject": "t",
                           "body_text": long_body},
                          {"draft_response": ""})
    assert out["draft_response"] == "Bonjour"
    user_msg = captured["messages"][1]["content"]
    body_only = user_msg.split("Corps   :\n", 1)[1].split("\n\nRéponds", 1)[0]
    assert len(body_only) == 4000
    assert captured["temperature"] == 0.3
    assert captured["max_tokens"] == 400


def test_openai_provider_returns_none_on_invalid_json(monkeypatch):
    """JSON parse error → log + return None (le scheduler retentera 3
    fois puis abandonne, donc un crash ici ne bloque pas la queue)."""
    p = OpenAIProvider()
    p.init(api_key="sk-fake")

    def fake_create(**kwargs):
        choice = MagicMock()
        choice.message.content = "not json at all"
        resp = MagicMock()
        resp.choices = [choice]
        resp.usage = None
        return resp

    monkeypatch.setattr(p._client.chat.completions, "create", fake_create)
    assert p.process_email({"sender": "s", "subject": "t",
                             "body_text": "b"}) is None

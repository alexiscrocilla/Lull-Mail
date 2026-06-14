"""AI draft verifier (src/draft_verify.py)."""

from __future__ import annotations

import types

from src import draft_verify


def _fake_client(content=None, raises=False):
    """Build a stand-in for ai_processor._client whose chat.completions.create
    returns `content` (or raises)."""
    def create(**kwargs):
        if raises:
            raise RuntimeError("api down")
        msg = types.SimpleNamespace(content=content)
        choice = types.SimpleNamespace(message=msg)
        return types.SimpleNamespace(choices=[choice])
    completions = types.SimpleNamespace(create=create)
    return types.SimpleNamespace(chat=types.SimpleNamespace(completions=completions))


def test_short_text_returned_asis(monkeypatch):
    import src.ai_processor as ai
    monkeypatch.setattr(ai, "_client", _fake_client(content="x"))
    assert draft_verify.verify_draft("trop court") == "trop court"


def test_no_client_returns_original(monkeypatch):
    import src.ai_processor as ai
    monkeypatch.setattr(ai, "_client", None)
    text = "Bonjour, merci pour votre message, je reviens vers vous vite."
    assert draft_verify.verify_draft(text) == text


def test_removes_artifact(monkeypatch):
    import src.ai_processor as ai
    original = ("Bonjour Tim, merci pour le retour, c'est noté pour vendredi.\n"
                "Draft saved. L'opérateur pourra envoyer.")
    cleaned = "Bonjour Tim, merci pour le retour, c'est noté pour vendredi."
    monkeypatch.setattr(ai, "_client", _fake_client(content=cleaned))
    assert draft_verify.verify_draft(original) == cleaned


def test_over_aggressive_falls_back_to_original(monkeypatch):
    import src.ai_processor as ai
    original = "Bonjour, voici le devis détaillé que vous avez demandé hier soir."
    monkeypatch.setattr(ai, "_client", _fake_client(content="ok"))  # <50%
    assert draft_verify.verify_draft(original) == original


def test_api_error_returns_original(monkeypatch):
    import src.ai_processor as ai
    original = "Bonjour, merci beaucoup pour votre patience sur ce dossier."
    monkeypatch.setattr(ai, "_client", _fake_client(raises=True))
    assert draft_verify.verify_draft(original) == original

# SPDX-License-Identifier: GPL-3.0-or-later
"""
Rétro-compatibilité : `src/ai_processor.py` est devenu un shim qui
re-exporte les noms `init_client`, `process_email`, `enrich_draft`
depuis `src.llm`.

Les call sites historiques :
  - src/scheduler.py:10  `from src.ai_processor import init_client, process_email, enrich_draft`
  - src/lifecycle.py:66  appelle `init_client(api_key)`
  - src/api.py:421/443   appellent `process_email` et `enrich_draft`

doivent continuer à fonctionner sans modification. Ce test verrouille
ce contrat.
"""

from __future__ import annotations


def test_shim_reexports_three_public_names():
    """Les trois noms publics doivent être importables exactement comme
    avant le refactor."""
    from src.ai_processor import init_client, process_email, enrich_draft  # noqa: F401

    assert callable(init_client)
    assert callable(process_email)
    assert callable(enrich_draft)


def test_shim_names_are_same_objects_as_src_llm():
    """Les noms du shim doivent référencer les mêmes objets que
    `src.llm.*` — pas une copie indépendante. Garantit que monkey-patcher
    `src.llm.process_email` dans un test (ou un hot-reload de provider en
    Phase 2) affecte aussi les call sites qui passent par le shim.
    """
    from src import ai_processor
    from src import llm

    assert ai_processor.init_client is llm.init_client
    assert ai_processor.process_email is llm.process_email
    assert ai_processor.enrich_draft is llm.enrich_draft


def test_shim_init_client_routes_to_openai_provider(monkeypatch):
    """init_client(api_key) doit configurer le client sur le provider
    OpenAI quand cfg.llm.provider == "openai" (défaut).

    On force `cfg._config` parce qu'un fichier config.yaml local sur
    le poste du dev peut porter `provider: local` et casser le test —
    le shim ne doit JAMAIS faire l'hypothèse implicite sur l'env."""
    from src import config as cfg
    monkeypatch.setattr(cfg, "_config", {"llm": {"provider": "openai"}})

    from src.llm.registry import get_provider, reset
    reset()  # forcer la re-instanciation
    from src.ai_processor import init_client

    provider = get_provider()
    assert provider.name == "openai"
    # init avec clé vide : le client doit être None
    init_client("")
    assert provider._client is None
    # init avec clé : le client doit être instancié
    init_client("sk-fake-test-key")
    assert provider._client is not None


def test_shim_process_email_returns_none_when_no_client(monkeypatch):
    """Mode no-AI (clé vide) : process_email retourne None proprement."""
    from src import config as cfg
    monkeypatch.setattr(cfg, "_config", {"llm": {"provider": "openai"}})

    from src.llm.registry import reset
    from src.ai_processor import init_client, process_email
    reset()
    init_client("")  # vider le client
    out = process_email({"sender": "s", "subject": "t", "body_text": "b"})
    assert out is None

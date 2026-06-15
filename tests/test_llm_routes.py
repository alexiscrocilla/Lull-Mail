# SPDX-License-Identifier: GPL-3.0-or-later
"""Routes /api/llm/* — smoke tests via TestClient.

On vérifie le wiring + les codes d'erreur sur les cas off-the-happy-path.
Aucun téléchargement réel ni subprocess llama_cpp.server — c'est du
test d'API surface, pas du test d'inférence."""

from __future__ import annotations


def test_hardware_endpoint_returns_required_fields(client):
    r = client.get("/api/llm/hardware")
    assert r.status_code == 200
    body = r.json()
    for k in ("ram_gb", "cpu_cores", "gpu", "vram_gb", "platform",
              "is_apple_silicon", "recommended_tier"):
        assert k in body
    assert body["recommended_tier"] in ("light", "medium", "heavy")


def test_models_endpoint_lists_catalog_with_download_state(client):
    r = client.get("/api/llm/models")
    assert r.status_code == 200
    models = r.json()
    assert isinstance(models, list)
    assert len(models) >= 4  # 4 modèles dans catalog.CATALOG
    for m in models:
        assert "id" in m
        assert m["role"] in ("analyzer", "drafter")
        assert m["tier"] in ("light", "medium", "heavy")
        assert isinstance(m["downloaded"], bool)
        # Aucun modèle n'est sur disque en environnement de test
        # (tmp_data_dir donne un MODELS_DIR vierge)
        assert m["downloaded"] is False
        assert m["downloaded_bytes"] == 0


def test_status_endpoint_in_openai_mode(client):
    """Quand provider=openai (défaut), on ne renvoie pas d'info
    analyzer/drafter — juste le name du provider actif."""
    r = client.get("/api/llm/status")
    assert r.status_code == 200
    body = r.json()
    assert body["provider"] == "openai"
    assert body["analyzer"] is None
    assert body["drafter"] is None


def test_delete_unknown_model_returns_404(client):
    r = client.delete("/api/llm/models/does-not-exist")
    assert r.status_code == 404


def test_delete_known_but_not_downloaded_returns_ok(client):
    """Supprimer un modèle qui n'est pas sur disque est un no-op
    succès — idempotent, simplifie le frontend."""
    r = client.delete("/api/llm/models/phi-3.5-mini-q4")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_activate_unknown_analyzer_returns_400(client):
    r = client.post("/api/llm/activate", json={
        "analyzer_model_id": "nope",
        "drafter_model_id": "mistral-7b-v03-q4",
    })
    assert r.status_code == 400


def test_activate_with_drafter_id_for_analyzer_role_returns_400(client):
    """Inverser les rôles doit échouer côté serveur."""
    r = client.post("/api/llm/activate", json={
        "analyzer_model_id": "mistral-7b-v03-q4",  # est un drafter
        "drafter_model_id": "phi-3.5-mini-q4",     # est un analyzer
    })
    assert r.status_code == 400


def test_activate_without_downloaded_analyzer_returns_400(client):
    """Activer avec un GGUF qui n'est pas téléchargé doit échouer —
    sinon le start des services planterait silencieusement."""
    r = client.post("/api/llm/activate", json={
        "analyzer_model_id": "phi-3.5-mini-q4",
        "drafter_model_id": "mistral-7b-v03-q4",
    })
    assert r.status_code == 400


def test_setup_llm_accepts_openai_and_local(client):
    """POST /api/setup/llm bascule entre les deux providers et persiste."""
    r = client.post("/api/setup/llm", json={"provider": "local"})
    assert r.status_code == 200
    r = client.post("/api/setup/llm", json={"provider": "openai"})
    assert r.status_code == 200


def test_setup_llm_rejects_invalid_provider(client):
    # ollama + anthropic are now valid providers; only an unknown one is rejected.
    r = client.post("/api/setup/llm", json={"provider": "bogus"})
    assert r.status_code == 400


def test_setup_llm_accepts_ollama_and_anthropic(client):
    for prov in ("ollama", "anthropic"):
        r = client.post("/api/setup/llm", json={"provider": prov})
        assert r.status_code == 200, r.text


def test_download_endpoint_streams_sse_for_already_present(client, tmp_path):
    """Modèle déjà sur disque → mini-flux SSE avec `done:True,
    already_present:True`. Le frontend court-circuite la barre de
    progression dans ce cas."""
    from src import paths
    # On stub le filename pour avoir un fichier déjà présent.
    (paths.MODELS_DIR).mkdir(parents=True, exist_ok=True)
    (paths.MODELS_DIR / "Phi-3.5-mini-instruct-Q4_K_M.gguf").write_bytes(b"\0")
    r = client.post("/api/llm/models/phi-3.5-mini-q4/download")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    body = r.text
    assert "data: " in body
    assert '"done": true' in body
    assert '"already_present": true' in body

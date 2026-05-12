# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests du supervisor `src.llm.server`.

On ne lance JAMAIS de vrai subprocess `llama_cpp.server` ici (~15s par
spawn + dépend de la RAM dispo). Le `Popen` et le healthcheck HTTP sont
mockés pour rester rapides et hermetic."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from src.llm import server as srv


@pytest.fixture
def tmp_model(tmp_path):
    """Crée un faux fichier GGUF (1 octet) pour passer la vérif
    `model_path.is_file()` sans dépendre d'un vrai modèle."""
    f = tmp_path / "fake.gguf"
    f.write_bytes(b"\0")
    return f


def test_raises_when_model_path_missing(tmp_path):
    """Tentative de start() sur un GGUF inexistant → LLMServerError clair."""
    fake = tmp_path / "does-not-exist.gguf"
    server = srv.LLMServer(model_path=fake)
    with pytest.raises(srv.LLMServerError, match="introuvable"):
        server.start()


def test_picks_ephemeral_port_when_zero(tmp_model, monkeypatch):
    """`port=0` (default) doit déclencher l'attribution d'un port libre
    via la stack TCP avant le subprocess."""
    server = srv.LLMServer(model_path=tmp_model, port=0)
    fake_proc = MagicMock()
    fake_proc.poll.return_value = None
    fake_proc.stdout = iter([])
    monkeypatch.setattr(srv.subprocess, "Popen", MagicMock(return_value=fake_proc))
    monkeypatch.setattr(srv, "_wait_for_port", lambda *a, **k: True)
    monkeypatch.setattr(srv, "_http_get_models",
                        lambda *a, **k: {"data": [{"id": "fake"}]})

    server.start(ready_timeout=2)
    assert server.port != 0
    assert 1024 < server.port < 65536
    server._proc = None  # éviter le cleanup réel dans le teardown


def test_generates_unique_api_key_per_instance(tmp_model):
    """Deux instances doivent avoir des tokens différents (sécurité :
    pas de réutilisation si on relance après crash)."""
    s1 = srv.LLMServer(model_path=tmp_model)
    s2 = srv.LLMServer(model_path=tmp_model)
    assert s1.api_key != s2.api_key
    assert len(s1.api_key) >= 32


def test_base_url_format(tmp_model):
    server = srv.LLMServer(model_path=tmp_model, port=12345)
    assert server.base_url == "http://127.0.0.1:12345/v1"


def test_start_calls_popen_with_correct_args(tmp_model, monkeypatch):
    """Vérifie que le subprocess est lancé avec --model, --port,
    --n_ctx, --n_threads, --api_key — pas d'arguments manquants qui
    feraient crasher llama_cpp.server au démarrage."""
    captured_cmd = []

    def fake_popen(cmd, **kwargs):
        captured_cmd[:] = cmd
        proc = MagicMock()
        proc.poll.return_value = None
        proc.stdout = iter([])
        return proc

    monkeypatch.setattr(srv.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(srv, "_wait_for_port", lambda *a, **k: True)
    monkeypatch.setattr(srv, "_http_get_models",
                        lambda *a, **k: {"data": [{"id": "fake"}]})

    server = srv.LLMServer(model_path=tmp_model, n_ctx=8192, n_threads=4,
                            port=51000, api_key="test-token-abc")
    server.start(ready_timeout=2)

    cmd_str = " ".join(captured_cmd)
    assert "-m llama_cpp.server" in cmd_str
    assert "--model" in captured_cmd
    assert str(tmp_model) in captured_cmd
    assert "--port" in captured_cmd
    assert "51000" in captured_cmd
    assert "--n_ctx" in captured_cmd
    assert "8192" in captured_cmd
    assert "--n_threads" in captured_cmd
    assert "4" in captured_cmd
    assert "--api_key" in captured_cmd
    assert "test-token-abc" in captured_cmd
    server._proc = None


def test_start_raises_on_port_timeout(tmp_model, monkeypatch):
    """Si le port ne s'ouvre pas dans le délai imparti, on doit raise
    `LLMServerError` ET tuer le subprocess pour ne pas laisser un zombie."""
    proc = MagicMock()
    proc.poll.return_value = None
    proc.stdout = iter([])
    monkeypatch.setattr(srv.subprocess, "Popen", MagicMock(return_value=proc))
    monkeypatch.setattr(srv, "_wait_for_port", lambda *a, **k: False)

    server = srv.LLMServer(model_path=tmp_model)
    with pytest.raises(srv.LLMServerError, match="timeout"):
        server.start(ready_timeout=0.1)
    proc.terminate.assert_called()


def test_start_raises_on_healthcheck_timeout(tmp_model, monkeypatch):
    """Port ouvert mais /v1/models qui ne répond pas → on doit raise
    quand même (cas typique : modèle plus gros que la RAM, swap massif)."""
    proc = MagicMock()
    proc.poll.return_value = None
    proc.stdout = iter([])
    monkeypatch.setattr(srv.subprocess, "Popen", MagicMock(return_value=proc))
    monkeypatch.setattr(srv, "_wait_for_port", lambda *a, **k: True)
    monkeypatch.setattr(srv, "_http_get_models", lambda *a, **k: None)

    # On patch monotonic pour fast-forward le délai healthcheck.
    fake_clock = iter([0, 0, 0, 100, 100])
    monkeypatch.setattr(srv.time, "monotonic", lambda: next(fake_clock))
    monkeypatch.setattr(srv.time, "sleep", lambda _t: None)

    server = srv.LLMServer(model_path=tmp_model)
    with pytest.raises(srv.LLMServerError, match="healthcheck"):
        server.start(ready_timeout=1)


def test_stop_terminates_then_kills(tmp_model, monkeypatch):
    """Si terminate() ne suffit pas dans le timeout, on doit kill()."""
    proc = MagicMock()
    proc.poll.return_value = None
    proc.wait.side_effect = [
        srv.subprocess.TimeoutExpired(cmd="x", timeout=1),  # terminate timeout
        None,  # kill OK
    ]
    server = srv.LLMServer(model_path=tmp_model)
    server._proc = proc
    server.stop(timeout=0.1)
    proc.terminate.assert_called_once()
    proc.kill.assert_called_once()


def test_drafter_idle_logic():
    """`DrafterServer.is_idle` doit retourner True après le timeout,
    False si jamais utilisé, False si timeout=0 (config Heavy permanent)."""
    d = srv.DrafterServer(model_path=Path("fake"))
    # Jamais utilisé → pas idle (rien à décharger)
    assert d.is_idle(timeout_min=5) is False
    # Pas running → pas idle
    d.touch()
    assert d.is_idle(timeout_min=5) is False
    # Force running + timestamp ancien
    d._proc = MagicMock()
    d._proc.poll.return_value = None
    d.last_used_at = srv.time.monotonic() - (10 * 60)  # 10 min ago
    assert d.is_idle(timeout_min=5) is True
    # Récent → pas idle
    d.touch()
    assert d.is_idle(timeout_min=5) is False
    # timeout=0 (always-on) → jamais idle
    d.last_used_at = srv.time.monotonic() - (60 * 60)
    assert d.is_idle(timeout_min=0) is False


def test_analyzer_and_drafter_have_distinct_labels(tmp_model):
    a = srv.AnalyzerServer(model_path=tmp_model)
    d = srv.DrafterServer(model_path=tmp_model)
    assert a.label == "analyzer"
    assert d.label == "drafter"


def test_running_is_false_after_proc_exits(tmp_model):
    server = srv.LLMServer(model_path=tmp_model)
    fake_proc = MagicMock()
    fake_proc.poll.return_value = 0  # process exited cleanly
    server._proc = fake_proc
    assert server.running is False

# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests du downloader : SHA streaming, rename atomique, callbacks de
progression. Aucun appel réseau réel — on monkey-patche urlopen."""

from __future__ import annotations

import hashlib
import io
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from src.llm import downloader


def _fake_response(content: bytes):
    """Construit un objet qui ressemble à ce que `urlopen()` renvoie :
    context manager + `headers` + `read(n)` qui yieldd les bytes par
    chunks de la taille demandée."""
    obj = MagicMock()
    obj.headers = {"Content-Length": str(len(content))}
    # io.BytesIO supporte read(n) avec la sémantique attendue.
    obj.read = io.BytesIO(content).read
    obj.__enter__ = lambda self=obj: self
    obj.__exit__ = lambda *a, **k: False
    return obj


def test_streaming_download_writes_correct_bytes(tmp_path, monkeypatch):
    payload = b"x" * (3 * 1024 * 1024)  # 3 Mo
    expected_sha = hashlib.sha256(payload).hexdigest()

    monkeypatch.setattr(
        downloader, "urlopen",
        MagicMock(return_value=_fake_response(payload)),
    )

    dst = tmp_path / "model.gguf"
    events = list(downloader.stream_download(
        url="https://example.com/model.gguf",
        dst=dst,
        expected_sha256=expected_sha,
        expected_size=len(payload),
    ))

    assert dst.is_file()
    assert dst.read_bytes() == payload
    assert events[-1].done is True
    assert events[-1].sha_ok is True
    assert events[-1].error is None


def test_part_file_is_renamed_atomically_after_sha_check(tmp_path, monkeypatch):
    """Pendant le téléchargement, le fichier final ne doit PAS exister
    — seul le .part est sur disque. Le rename ne se fait qu'à la fin
    APRES la vérif SHA."""
    payload = b"y" * (2 * 1024 * 1024)
    expected_sha = hashlib.sha256(payload).hexdigest()
    monkeypatch.setattr(
        downloader, "urlopen",
        MagicMock(return_value=_fake_response(payload)),
    )

    dst = tmp_path / "phi.gguf"
    seen_part_only = False
    seen_final = False
    for event in downloader.stream_download(
        url="https://example.com/phi.gguf",
        dst=dst,
        expected_sha256=expected_sha,
    ):
        if not event.done:
            # Pendant le streaming : .part existe, final n'existe pas
            if (dst.with_suffix(".gguf.part")).exists() and not dst.exists():
                seen_part_only = True
        else:
            if dst.exists() and not dst.with_suffix(".gguf.part").exists():
                seen_final = True

    assert seen_part_only, ".part file should exist during streaming"
    assert seen_final, "final file should exist after completion"


def test_sha_mismatch_deletes_part_and_reports_error(tmp_path, monkeypatch):
    payload = b"a" * (1024 * 1024)
    wrong_sha = "0" * 64  # SHA bidon → mismatch garanti
    monkeypatch.setattr(
        downloader, "urlopen",
        MagicMock(return_value=_fake_response(payload)),
    )

    dst = tmp_path / "corrupt.gguf"
    events = list(downloader.stream_download(
        url="https://example.com/c.gguf",
        dst=dst,
        expected_sha256=wrong_sha,
    ))

    last = events[-1]
    assert last.done is True
    assert last.sha_ok is False
    assert last.error is not None
    assert "SHA-256 invalide" in last.error
    # Le .part doit être supprimé en cas de SHA mismatch (pas de
    # corruption silencieuse sur disque).
    assert not dst.exists()
    assert not dst.with_suffix(".gguf.part").exists()


def test_progress_events_throttled(tmp_path, monkeypatch):
    """Sur un fichier d'1 Mo, on ne doit pas yield plus que ~4-5 events
    (chunks de 1 Mo, MIN_PROGRESS_BYTES de 256 ko). Évite de saturer SSE."""
    payload = b"z" * (5 * 1024 * 1024)  # 5 Mo
    sha = hashlib.sha256(payload).hexdigest()
    monkeypatch.setattr(
        downloader, "urlopen",
        MagicMock(return_value=_fake_response(payload)),
    )

    dst = tmp_path / "x.gguf"
    events = list(downloader.stream_download(
        url="https://example.com/x.gguf",
        dst=dst,
        expected_sha256=sha,
    ))
    # Compte des events intermédiaires (hors le `done` final).
    intermediate = [e for e in events if not e.done]
    # 5 Mo / chunk 1 Mo = 5 chunks. Chaque chunk dépasse MIN_PROGRESS_BYTES
    # (256 ko), donc on yieldd chaque fois → 4 ou 5 events intermédiaires.
    assert 0 <= len(intermediate) <= 6


def test_http_error_is_reported_cleanly(tmp_path, monkeypatch):
    from urllib.error import HTTPError
    err = HTTPError("https://x/y", 404, "Not Found", {}, None)
    monkeypatch.setattr(downloader, "urlopen", MagicMock(side_effect=err))

    dst = tmp_path / "missing.gguf"
    events = list(downloader.stream_download(
        url="https://x/y",
        dst=dst,
        expected_sha256="abc",
    ))
    assert events[-1].done is True
    assert events[-1].sha_ok is False
    assert "HTTP 404" in (events[-1].error or "")
    assert not dst.exists()


def test_verify_local_file_matches_sha(tmp_path):
    f = tmp_path / "g.gguf"
    f.write_bytes(b"hello world")
    expected = hashlib.sha256(b"hello world").hexdigest()
    assert downloader.verify_local_file(f, expected) is True
    assert downloader.verify_local_file(f, "f" * 64) is False
    assert downloader.verify_local_file(tmp_path / "missing", expected) is False

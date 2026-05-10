# SPDX-License-Identifier: GPL-3.0-or-later
"""
Shared pytest fixtures.

Every test that touches the FastAPI app or the SQLite DB pulls these
in. The fixtures isolate state by:

  • Pointing `LULLMAIL_DATA` at a fresh tempdir per test (so the real
    `%APPDATA%\\LullMail` is never touched).
  • Replacing the system keyring with the in-memory backend from
    `keyrings.alt` so writing a secret in a test doesn't pollute the
    Windows Credential Manager / macOS Keychain / Linux Secret Service.
  • Re-importing src.api each test so the rate-limit counters and the
    in-memory _config dict reset between cases.
"""

from __future__ import annotations

import importlib
import os
import sys
import tempfile
from pathlib import Path

import pytest


@pytest.fixture
def tmp_data_dir(monkeypatch, tmp_path):
    """Force LULLMAIL_DATA to a per-test tempdir.

    `src.paths` resolves the data directory at import time, so we have
    to set the env var BEFORE the first import. This fixture is meant
    to run as a precondition of every test — order it before any
    `from src…` import, or use the autouse `_isolate_state` fixture
    below which handles the import dance.
    """
    monkeypatch.setenv("LULLMAIL_DATA", str(tmp_path))
    return tmp_path


@pytest.fixture
def tmp_keyring(monkeypatch):
    """Swap the OS keyring backend for the in-memory file backend
    shipped by `keyrings.alt`. Tests can read/write secrets through
    `src.secrets_store` without touching the user's real keyring."""
    import keyring
    from keyrings.alt.file import PlaintextKeyring
    backend = PlaintextKeyring()
    # PlaintextKeyring writes to a file under the user dir by default.
    # Redirect that file to a tempdir so the test is hermetic.
    backend.file_path = os.path.join(
        tempfile.mkdtemp(prefix="lullmail-kr-"), "kr.cfg"
    )
    monkeypatch.setattr(keyring, "get_keyring", lambda: backend)
    monkeypatch.setattr(keyring, "set_password", backend.set_password)
    monkeypatch.setattr(keyring, "get_password", backend.get_password)
    monkeypatch.setattr(keyring, "delete_password", backend.delete_password)
    yield backend


@pytest.fixture
def fresh_app(tmp_data_dir, tmp_keyring):
    """Return a freshly-imported FastAPI app + an initialised DB.

    Re-imports `src.paths`, `src.config`, `src.database`, and `src.api`
    in order so each test gets a clean module state (no leftover
    config dict, no rate-limit counters, no shared DB connection).
    """
    # Drop cached modules so they pick up the new LULLMAIL_DATA.
    for mod in list(sys.modules):
        if mod == "src" or mod.startswith("src."):
            del sys.modules[mod]
    paths = importlib.import_module("src.paths")
    paths.ensure_dirs()
    db = importlib.import_module("src.database")
    db.init_db()
    api_module = importlib.import_module("src.api")
    api_module.app.state.bound_port = 8000
    return api_module.app


@pytest.fixture
def client(fresh_app):
    """`TestClient` over the freshly-imported app. Uses the
    same-origin header so the origin-check middleware doesn't 403."""
    from fastapi.testclient import TestClient
    c = TestClient(fresh_app)
    c.headers.update({"Origin": "http://127.0.0.1:8000"})
    return c

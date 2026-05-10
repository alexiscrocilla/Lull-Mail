# SPDX-License-Identifier: GPL-3.0-or-later
"""
Pydantic schema for config.yaml — covers the constraints that catch
hand-edited misconfigurations before they hit the runtime.
"""

from __future__ import annotations

import pytest


def _valid_minimum() -> dict:
    """A complete config that should always validate."""
    return {
        "openai": {"api_key": "sk-x", "model": "gpt-4o-mini"},
        "accounts": [{
            "email": "u@example.com",
            "imap_host": "imap.example.com",
            "imap_port": 993,
            "username": "u@example.com",
            "password": "secret",
            "enabled": True,
        }],
    }


def test_minimal_valid():
    from src.config import _validate
    _validate(_valid_minimum())  # no raise


def test_empty_openai_key_accepted():
    """Empty `api_key` is the explicit signal for no-AI mode and must
    pass validation. The runtime treats missing-or-empty key as "skip
    every OpenAI call"."""
    from src.config import _validate
    conf = _valid_minimum()
    conf["openai"]["api_key"] = ""
    _validate(conf)  # no raise


def test_todo_placeholder_rejected():
    from src.config import _validate, ConfigError
    conf = _valid_minimum()
    conf["openai"]["api_key"] = "TODO_REPLACE_ME"
    with pytest.raises(ConfigError):
        _validate(conf)


def test_port_out_of_range():
    from src.config import _validate, ConfigError
    conf = _valid_minimum()
    conf["accounts"][0]["imap_port"] = 70000
    with pytest.raises(ConfigError):
        _validate(conf)


def test_invalid_email_format():
    from src.config import _validate, ConfigError
    conf = _valid_minimum()
    conf["accounts"][0]["email"] = "not-an-email"
    with pytest.raises(ConfigError):
        _validate(conf)


def test_no_accounts():
    from src.config import _validate, ConfigError
    conf = _valid_minimum()
    conf["accounts"] = []
    with pytest.raises(ConfigError):
        _validate(conf)


def test_disabled_account_with_empty_fields_ok():
    """Disabled accounts can carry partial state — only the enabled
    rows must satisfy the required-field check."""
    from src.config import _validate
    conf = _valid_minimum()
    conf["accounts"].append({
        "email": "", "imap_host": "", "username": "",
        "password": "", "enabled": False,
    })
    _validate(conf)  # no raise


def test_polling_interval_zero_rejected():
    from src.config import _validate, ConfigError
    conf = _valid_minimum()
    conf["polling"] = {"interval_minutes": 0}
    with pytest.raises(ConfigError):
        _validate(conf)


def test_string_port_coerced_to_int():
    """A YAML quirk: `imap_port: "993"` (string) should still load."""
    from src.config import _validate
    conf = _valid_minimum()
    conf["accounts"][0]["imap_port"] = "993"
    _validate(conf)

"""
YAML config loader. Resolves paths via src.paths so the same code works
in dev (project root) and packaged (.exe → %APPDATA%\\LullMail).

The module is intentionally lenient at import time so the API can boot
into "setup mode" with no config at all — the wizard then writes the
first valid config via save().
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

import yaml

from src import paths

logger = logging.getLogger(__name__)

# Re-exported for backwards compat with code that referenced cfg.CONFIG_PATH.
CONFIG_PATH = paths.CONFIG_PATH

_config: Dict[str, Any] = {}


class ConfigError(Exception):
    """Raised by validate() when the loaded config is unusable."""


def load() -> Dict[str, Any]:
    """Load + validate config.yaml. Raises if missing or invalid.

    Use try_load() if you want to keep going on failure (server boot).
    """
    global _config
    if not CONFIG_PATH.exists():
        raise FileNotFoundError(
            "config.yaml introuvable. Lancez l'app et utilisez l'assistant "
            "de configuration pour le créer."
        )
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        _config = yaml.safe_load(f) or {}

    _validate(_config)
    return _config


def try_load() -> Optional[Dict[str, Any]]:
    """Same as load() but returns None on any failure instead of raising.
    The error is logged so the user/dev can find it in the log file."""
    global _config
    try:
        return load()
    except (FileNotFoundError, ConfigError, ValueError, yaml.YAMLError) as e:
        logger.warning("Config indisponible (%s) — démarrage en mode setup", e)
        _config = {}
        return None


def get() -> Dict[str, Any]:
    if not _config:
        return load()
    return _config


def reload() -> Optional[Dict[str, Any]]:
    """Force a re-read from disk. Used by the setup API after save()."""
    global _config
    _config = {}
    return try_load()


def is_configured() -> bool:
    """Cheap check: does a usable config exist on disk right now?"""
    if not CONFIG_PATH.exists():
        return False
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        _validate(data)
        return True
    except (ConfigError, ValueError, yaml.YAMLError):
        return False


def save(data: Dict[str, Any]) -> None:
    """Atomically write config.yaml. Validates first so we never persist
    something the loader would refuse on next boot."""
    _validate(data)
    paths.ensure_dirs()
    tmp = CONFIG_PATH.with_suffix(".yaml.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, allow_unicode=True, sort_keys=False)
    tmp.replace(CONFIG_PATH)


def default_skeleton() -> Dict[str, Any]:
    """Empty-but-valid-shape config returned to the wizard when no file
    exists yet. Filled in step-by-step before the first save()."""
    return {
        "openai": {"api_key": "", "model": "gpt-4o-mini"},
        "ntfy": {"server": "https://ntfy.sh", "topic": "", "min_importance": 7},
        "polling": {"interval_minutes": 10, "initial_fetch_count": 100,
                    "max_age_days": 30},
        "server": {"host": "127.0.0.1", "port": 8000},
        "attachments": {
            "enabled": True,
            "max_size_mb": 25,
            "max_total_mb_per_email": 50,
            "max_count_per_email": 25,
            "block_dangerous": True,
            "block_suspicious": False,
            "download_requires_confirm": True,
        },
        "accounts": [],
    }


def _validate(conf: Dict[str, Any]) -> None:
    api_key = (conf.get("openai") or {}).get("api_key", "")
    if not api_key or str(api_key).startswith("TODO"):
        raise ConfigError("Clé API OpenAI manquante (openai.api_key)")

    accounts = conf.get("accounts") or []
    if not accounts:
        raise ConfigError("Aucun compte email configuré")

    enabled = [a for a in accounts if a.get("enabled", True)]
    for acc in enabled:
        for field in ("email", "imap_host", "imap_port", "username", "password"):
            val = str(acc.get(field, ""))
            if not val or val.startswith("TODO"):
                raise ConfigError(
                    f"Compte '{acc.get('name', acc.get('email'))}' : "
                    f"champ '{field}' non configuré"
                )

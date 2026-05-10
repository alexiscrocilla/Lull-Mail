# SPDX-License-Identifier: GPL-3.0-or-later
"""
YAML config loader.

Resolves paths via src.paths so the same code works in dev (project
root) and packaged (frozen build → OS per-user data directory).

The module is intentionally lenient at import time so the API can boot
into "setup mode" with no config at all — the wizard then writes the
first valid config via save().

Validation is delegated to a Pydantic schema (`FullConfig`) which:
  • coerces types (port strings → int, "yes"/"no" → bool, …) so a
    hand-edited config doesn't crash the loader on a trivial typo,
  • enforces ranges on every numeric field (ports 1-65535, polling
    1-1440 min, attachment sizes capped) so invalid values are
    rejected at save time rather than tripping a runtime exception,
  • validates each *enabled* account's required fields. Disabled
    accounts may carry empty placeholders without breaking the load,
  • rejects "TODO" placeholders that the wizard skeleton uses.

Errors are surfaced as `ConfigError` (a normal exception subclass) so
callers don't need to know about Pydantic.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional

import yaml
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

from src import paths

logger = logging.getLogger(__name__)

# Re-exported for backwards compat with code that referenced cfg.CONFIG_PATH.
CONFIG_PATH = paths.CONFIG_PATH

_config: Dict[str, Any] = {}


class ConfigError(Exception):
    """Raised when the loaded config is unusable. Wraps Pydantic's
    `ValidationError` into a single human-readable message — callers
    only need to catch this one class."""


# Loose RFC-5322-ish email regex. Used instead of `pydantic.EmailStr`
# to avoid pulling in the optional `email-validator` package (~50 KB,
# but Lull Mail aims to keep the dependency footprint tight). Catches
# the obvious mistakes — copy-pasted spaces, missing @, missing dot.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

_TODO_PLACEHOLDER = "TODO"


# ── Pydantic schema ──────────────────────────────────────────────────────────


class OpenAIConfig(BaseModel):
    # Optional: an empty key signals "no-AI mode" — Lull Mail then runs
    # only the local rules-based classifier and disables every feature
    # that needs OpenAI (summaries, draft replies, on-demand re-analysis).
    api_key: str = ""
    model: str = "gpt-4o-mini"

    @field_validator("api_key")
    @classmethod
    def _no_todo(cls, v: str) -> str:
        if v.startswith(_TODO_PLACEHOLDER):
            raise ValueError("clé API OpenAI non configurée (placeholder TODO)")
        return v


class NtfyConfig(BaseModel):
    server: str = "https://ntfy.sh"
    topic: str = ""
    min_importance: int = Field(default=7, ge=1, le=10)


class PollingConfig(BaseModel):
    interval_minutes: int = Field(default=10, ge=1, le=1440)
    initial_fetch_count: int = Field(default=500, ge=1, le=2000)
    max_age_days: int = Field(default=30, ge=0, le=3650)
    ai_batch_size: int = Field(default=200, ge=1, le=2000)


class ServerConfig(BaseModel):
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)


class AttachmentsConfig(BaseModel):
    enabled: bool = True
    max_size_mb: int = Field(default=25, ge=1, le=500)
    max_total_mb_per_email: int = Field(default=50, ge=1, le=2000)
    max_count_per_email: int = Field(default=25, ge=1, le=500)
    block_dangerous: bool = True
    block_suspicious: bool = False
    download_requires_confirm: bool = True


class AccountConfig(BaseModel):
    """One IMAP account. Required fields are only enforced when the
    account is enabled — a disabled row may keep partial state without
    blocking the rest of the config from loading."""

    # We accept extra keys so a future schema addition (e.g. a new test
    # status snapshot) doesn't make older versions choke on the YAML.
    model_config = {"extra": "allow"}

    name: str = ""
    type: str = "imap"
    email: str = ""
    imap_host: str = ""
    imap_port: int = Field(default=993, ge=1, le=65535)
    username: str = ""
    password: str = ""
    ssl: bool = True
    starttls: bool = False
    verify_ssl: bool = True
    enabled: bool = True
    # SMTP outbound. Optional at the schema level — when blank, the
    # sender resolves the provider's preset at runtime (Gmail → smtp.
    # gmail.com:587, OVH → ssl0.ovh.net:465, …). Same `username` /
    # `password` as IMAP are reused; only host/port/transport differ.
    smtp_host: str = ""
    smtp_port: int = Field(default=0, ge=0, le=65535)
    smtp_ssl: bool = False
    smtp_starttls: bool = True

    @field_validator("email")
    @classmethod
    def _email_format(cls, v: str) -> str:
        # Empty is allowed (lenient for disabled accounts) but a non-
        # empty value must look like an email.
        if v and not _EMAIL_RE.match(v):
            raise ValueError(f"format d'email invalide : '{v}'")
        return v

    @model_validator(mode="after")
    def _required_when_enabled(self):
        if not self.enabled:
            return self
        problems = []
        for field_name in ("email", "imap_host", "username", "password"):
            val = getattr(self, field_name) or ""
            if not val:
                problems.append(f"'{field_name}' vide")
            elif val.startswith(_TODO_PLACEHOLDER):
                problems.append(f"'{field_name}' non configuré (placeholder TODO)")
        if problems:
            label = self.email or self.name or "(sans nom)"
            raise ValueError(f"compte '{label}' : {', '.join(problems)}")
        return self


class FullConfig(BaseModel):
    """Top-level shape of config.yaml."""

    # Setup-mode-friendly: every section has a default. The wizard
    # writes a partial config between steps, and `_persist()` in
    # setup_api.py tolerates a save that wouldn't pass the runtime
    # `load()` validation. The two endpoints that DO require a usable
    # config (`load()` and `is_configured()`) check the result of
    # `model_validate` directly; an incomplete config never goes
    # through `cfg.save()` because that one runs validation first.

    model_config = {"extra": "allow"}

    openai: OpenAIConfig
    ntfy: NtfyConfig = Field(default_factory=NtfyConfig)
    polling: PollingConfig = Field(default_factory=PollingConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)
    attachments: AttachmentsConfig = Field(default_factory=AttachmentsConfig)
    accounts: List[AccountConfig] = Field(min_length=1)


def _format_validation_error(exc: ValidationError) -> str:
    """Flatten Pydantic's structured errors into a single sentence so
    `ConfigError(str)` reads like the previous handcrafted messages."""
    parts = []
    for err in exc.errors():
        loc = ".".join(str(x) for x in err.get("loc", ()) if x != "__root__")
        msg = err.get("msg", "champ invalide")
        if loc:
            parts.append(f"{loc} : {msg}")
        else:
            parts.append(msg)
    return " ; ".join(parts) or str(exc)


def _validate(conf: Dict[str, Any]) -> None:
    """Run the Pydantic schema. Raises `ConfigError` with a flattened
    message on failure. The validated model isn't returned — callers
    keep working with the raw dict (consumers across the codebase rely
    on `acc["password"]`-style access; switching them to attribute
    access would be a much larger refactor)."""
    try:
        FullConfig.model_validate(conf)
    except ValidationError as e:
        raise ConfigError(_format_validation_error(e)) from e


# ── Public API ───────────────────────────────────────────────────────────────


def load() -> Dict[str, Any]:
    """Load + validate config.yaml. Raises if missing or invalid.

    After validation we resolve every keyring sentinel
    (`keyring:user@host`) into the real secret pulled from the OS
    keyring. The resolved dict only ever lives in memory — what's on
    disk stays in sentinel form.

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
    _resolve_secrets(_config)
    return _config


def _resolve_secrets(conf: Dict[str, Any]) -> None:
    """In-place: replace every `keyring:…` sentinel with the real
    secret from the OS keyring. Touches `openai.api_key` and each
    account's `password`. Raises `ConfigError` when a sentinel can't
    be resolved — that's a corrupted state (entry deleted from
    keyring outside the app) and silently continuing would mean
    fetches start failing without telling the user why.
    """
    from src import secrets_store as _ss

    openai = conf.get("openai") or {}
    api_key = openai.get("api_key", "")
    if _ss.is_sentinel(api_key):
        try:
            openai["api_key"] = _ss.resolve(api_key, _ss.SERVICE_OPENAI)
        except _ss.SecretsBackendError as e:
            raise ConfigError(f"clé OpenAI : {e}") from e

    for acc in conf.get("accounts") or []:
        pwd = acc.get("password", "")
        if _ss.is_sentinel(pwd):
            try:
                acc["password"] = _ss.resolve(pwd, _ss.SERVICE_IMAP)
            except _ss.SecretsBackendError as e:
                raise ConfigError(
                    f"mot de passe '{acc.get('email', '?')}' : {e}"
                ) from e


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


def ai_enabled() -> bool:
    """True when the loaded config carries a non-empty OpenAI key.

    Used by every code path that has to choose between calling OpenAI
    and running in degraded "no-AI" mode (rule-based classifier only).
    Reads the in-memory `_config` so callers don't pay a disk hit on
    each check — it's already kept in sync by `load()` / `reload()`.
    """
    conf = _config or {}
    key = (conf.get("openai") or {}).get("api_key", "")
    return bool(key)


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
        "polling": {"interval_minutes": 10, "initial_fetch_count": 500,
                    "max_age_days": 30, "ai_batch_size": 200},
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

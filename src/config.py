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
from typing import Any, Dict, List, Literal, Optional

import yaml
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

from src import paths

logger = logging.getLogger(__name__)

# Re-exported for backwards compat with code that referenced cfg.CONFIG_PATH.
CONFIG_PATH = paths.CONFIG_PATH

# Three states:
#   None  → never attempted (cfg.get() must trigger load())
#   {}    → try_load() ran and failed → app is in setup mode; cfg.get()
#           must return this empty dict, NOT retry load() and re-raise
#           (otherwise every API request crashes after an orphaned
#           keyring secret takes the config offline).
#   dict  → successfully loaded
_config: Optional[Dict[str, Any]] = None


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


class LocalLLMConfig(BaseModel):
    """Sous-config du mode `provider == "local"`.

    `analyzer_model_id` et `drafter_model_id` doivent correspondre à
    des clés du `src.llm.catalog.CATALOG`. La validation que le fichier
    GGUF est effectivement sur disque se fait au runtime
    (`ai_enabled()` + `LocalLLMServer.start()`), pas ici — un user qui
    coche "Local" sans avoir téléchargé le modèle reste dans un état
    "setup mode partiel" jusqu'à ce qu'il complète le download.

    `drafter_idle_timeout_min` : combien de minutes sans appel avant de
    décharger le Drafter de la RAM. 0 = jamais décharger (recommandé
    sur tier Heavy).
    """

    tier: Literal["light", "medium", "heavy"] = "medium"
    analyzer_model_id: str = "phi-3.5-mini-q4"
    drafter_model_id: str = "mistral-7b-v03-q4"
    # GPU offload : 0 = CPU only. Phase 2 v1 reste CPU-only ; le GPU
    # NVIDIA est un opt-in v2 (nécessite la wheel CUDA séparée).
    gpu_layers: int = Field(default=0, ge=0, le=999)
    context_size: int = Field(default=4096, ge=512, le=131072)
    drafter_idle_timeout_min: int = Field(default=5, ge=0, le=1440)


class OllamaConfig(BaseModel):
    """Sous-config du provider `ollama` (serveur Ollama installé par
    l'utilisateur sur sa machine ou son réseau). Ollama expose une API
    compatible OpenAI sur `<base_url>/v1`, donc on parle au serveur via le
    SDK OpenAI. `model` est l'un des modèles `ollama pull`-és (ex. `llama3.1`,
    `qwen2.5`). Vide tant que l'utilisateur n'a pas choisi un modèle."""

    base_url: str = "http://localhost:11434"
    model: str = ""


class AnthropicConfig(BaseModel):
    """Sous-config du provider `anthropic` (Claude). La clé vit dans le
    keyring (sentinel `keyring:default` résolu avec SERVICE_ANTHROPIC) ;
    `config.yaml` ne porte que le sentinel."""

    api_key: str = ""
    model: str = "claude-3-5-haiku-latest"

    @field_validator("api_key")
    @classmethod
    def _no_todo(cls, v: str) -> str:
        if v.startswith(_TODO_PLACEHOLDER):
            raise ValueError("clé API Anthropic non configurée (placeholder TODO)")
        return v


class OpenRouterConfig(BaseModel):
    """Sous-config du provider `openrouter` (agrégateur cloud multi-modèles,
    API compatible OpenAI sur https://openrouter.ai/api/v1). La clé vit dans
    le keyring (sentinel résolu avec SERVICE_OPENROUTER) ; `config.yaml` ne
    porte que le sentinel. `model` est un slug OpenRouter `vendeur/modèle`."""

    api_key: str = ""
    model: str = "openai/gpt-4o-mini"

    @field_validator("api_key")
    @classmethod
    def _no_todo(cls, v: str) -> str:
        if v.startswith(_TODO_PLACEHOLDER):
            raise ValueError("clé API OpenRouter non configurée (placeholder TODO)")
        return v


class LLMConfig(BaseModel):
    """Sélecteur de provider LLM.

    - `openai`     : API OpenAI cloud (clé dans `openai.api_key`).
    - `local`      : `LocalLLMProvider` (llama.cpp embarqué + GGUF téléchargé).
    - `ollama`     : serveur Ollama local de l'utilisateur (API OpenAI-compat).
    - `anthropic`  : API Claude (clé dans `llm.anthropic.api_key`).
    - `openrouter` : agrégateur OpenRouter (clé dans `llm.openrouter.api_key`).

    Le champ est tolérant : un YAML sans section `llm:` retombe sur les
    défauts, donc les installations antérieures ne cassent pas.
    """

    provider: Literal["openai", "local", "ollama", "anthropic", "openrouter"] = "openai"
    local: LocalLLMConfig = Field(default_factory=LocalLLMConfig)
    ollama: OllamaConfig = Field(default_factory=OllamaConfig)
    anthropic: AnthropicConfig = Field(default_factory=AnthropicConfig)
    openrouter: OpenRouterConfig = Field(default_factory=OpenRouterConfig)


class NtfyConfig(BaseModel):
    server: str = "https://ntfy.sh"
    topic: str = ""
    min_importance: int = Field(default=7, ge=1, le=10)


class PollingConfig(BaseModel):
    interval_minutes: int = Field(default=10, ge=1, le=1440)
    initial_fetch_count: int = Field(default=500, ge=1, le=2000)
    max_age_days: int = Field(default=30, ge=0, le=3650)
    ai_batch_size: int = Field(default=200, ge=1, le=2000)
    # IMAP accounts fetched concurrently per sync (network only; DB writes
    # stay single-threaded).
    fetch_workers: int = Field(default=4, ge=1, le=16)


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


class InjectionScanConfig(BaseModel):
    """Prompt-injection scanner mode (src/injection_guard.py). Runs over
    every email body before it reaches the LLM.

    - hybrid : local heuristic first, escalate ambiguous cases to gpt-4o-mini.
    - local  : regex only — 0 token, 0 network, fully on-device.
    - llm    : one gpt-4o-mini YES/NO per email.
    - off    : disabled.
    """

    mode: Literal["hybrid", "local", "llm", "off"] = "hybrid"


class SecurityConfig(BaseModel):
    injection_scan: InjectionScanConfig = Field(default_factory=InjectionScanConfig)


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
    # Per-account AI profile. ai_importance_threshold=0 inherits the global
    # ntfy.min_importance (avoids silently overriding it). auto_draft opts the
    # account into pre-written reply drafts (never sent).
    ai_account_enabled: bool = True
    ai_importance_threshold: int = Field(default=0, ge=0, le=10)
    auto_draft: bool = False

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
    llm: LLMConfig = Field(default_factory=LLMConfig)
    ntfy: NtfyConfig = Field(default_factory=NtfyConfig)
    polling: PollingConfig = Field(default_factory=PollingConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)
    attachments: AttachmentsConfig = Field(default_factory=AttachmentsConfig)
    security: SecurityConfig = Field(default_factory=SecurityConfig)
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

    # Anthropic (Claude) key lives in the keyring too, under its own service.
    anthropic = (conf.get("llm") or {}).get("anthropic") or {}
    a_key = anthropic.get("api_key", "")
    if _ss.is_sentinel(a_key):
        try:
            anthropic["api_key"] = _ss.resolve(a_key, _ss.SERVICE_ANTHROPIC)
        except _ss.SecretsBackendError as e:
            raise ConfigError(f"clé Anthropic : {e}") from e

    # OpenRouter key: same keyring scheme, its own service.
    openrouter = (conf.get("llm") or {}).get("openrouter") or {}
    or_key = openrouter.get("api_key", "")
    if _ss.is_sentinel(or_key):
        try:
            openrouter["api_key"] = _ss.resolve(or_key, _ss.SERVICE_OPENROUTER)
        except _ss.SecretsBackendError as e:
            raise ConfigError(f"clé OpenRouter : {e}") from e

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
    # `_config is None` = "never touched" — first caller triggers the
    # initial load(). An empty dict means try_load() ran and failed
    # (setup mode); callers handle that gracefully via conf.get(...).
    # Re-raising here would crash every request that hits cfg.get()
    # after a single broken secret takes the config offline.
    if _config is None:
        return load()
    return _config


def reload() -> Optional[Dict[str, Any]]:
    """Force a re-read from disk. Used by the setup API after save()."""
    global _config
    _config = None
    return try_load()


def ai_enabled() -> bool:
    """True when an LLM backend is operationally available.

    Two paths today :
      - provider="openai"  : besoin d'une clé non vide dans `openai.api_key`.
      - provider="local"   : besoin que le GGUF de l'analyzer existe dans
                             `paths.MODELS_DIR`. Si l'utilisateur a coché
                             "Local" mais pas encore téléchargé le modèle,
                             on retombe en mode no-AI (le scheduler utilise
                             alors le fallback rules-based).

    Used by every code path that has to choose between calling the LLM
    and running in degraded "no-AI" mode (rule-based classifier only).
    Reads the in-memory `_config` so callers don't pay a disk hit on
    each check — it's already kept in sync by `load()` / `reload()`.
    """
    conf = _config or {}
    llm = conf.get("llm") or {}
    provider = llm.get("provider", "openai")
    if provider == "ollama":
        # Reachability isn't checked here (no network call on a hot path);
        # a configured model is the "ready" signal. An unreachable server
        # surfaces as a sync error, not a silent no-AI.
        return bool((llm.get("ollama") or {}).get("model"))
    if provider == "anthropic":
        return bool((llm.get("anthropic") or {}).get("api_key"))
    if provider == "openrouter":
        return bool((llm.get("openrouter") or {}).get("api_key"))
    if provider == "local":
        # Lazy imports — `paths` est toujours présent, `catalog` peut être
        # absent pendant la transition Phase 1 → Phase 2 si quelqu'un fait
        # un checkout intermédiaire.
        try:
            from src import paths  # noqa: WPS433
            from src.llm import catalog as _catalog  # noqa: WPS433
        except ImportError:
            return False
        model_id = (
            (conf.get("llm") or {}).get("local", {})
            .get("analyzer_model_id", "phi-3.5-mini-q4")
        )
        meta = _catalog.get_model(model_id)
        if not meta:
            return False
        return (paths.MODELS_DIR / meta["filename"]).is_file()

    # provider == "openai" (défaut)
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
        "llm": {
            "provider": "openai",
            "local": {
                # `tier` est positionné par l'UI Settings au moment où
                # l'user clique "Activer" — pas en dur ici, sinon la
                # recommandation du tier détecté par `src.hardware` ne
                # serait jamais reflétée.
                "tier": "medium",
                # Vide tant que l'user n'a pas activé le mode local
                # depuis Settings → IA → Local. Quand vide, la UI
                # pré-sélectionne le modèle recommandé pour le tier
                # matériel détecté. ai_enabled() retourne False tant
                # qu'un model_id valide n'est pas posé ici, ce qui
                # garde le système en mode no-AI propre.
                "analyzer_model_id": "",
                "drafter_model_id": "",
                "gpu_layers": 0,
                "context_size": 4096,
                "drafter_idle_timeout_min": 5,
            },
            "ollama": {"base_url": "http://localhost:11434", "model": ""},
            "anthropic": {"api_key": "", "model": "claude-3-5-haiku-latest"},
        },
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
        "security": {"injection_scan": {"mode": "hybrid"}},
        "accounts": [],
    }

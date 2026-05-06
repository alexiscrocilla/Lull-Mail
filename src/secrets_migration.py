"""
One-shot migration of in-config plain-text secrets to the OS keyring.

Runs at app boot (called from main.py / app_gui.py BEFORE the first
config load). Walks `config.yaml` and, for every account whose
`password` is a real secret (not a sentinel), pushes the value into
the OS keyring, then rewrites the YAML so the password becomes
`keyring:<email>`. Same for `openai.api_key` → `keyring:default`.

Properties
----------
• Idempotent — accounts already migrated (sentinel value) are skipped.
• Atomic per account — if the keyring write fails for one entry, the
  YAML stays unchanged for that account and the in-flight password
  keeps working at runtime; we log a warning and move on.
• Fail-soft on missing backend — when the OS has no keyring at all
  (very rare; some Linux containers), the migration logs a warning
  and exits without touching anything. Lull Mail keeps working with
  the legacy clear-text path.
• Single pass — once every value is a sentinel, subsequent boots
  short-circuit (`needs_migration()` returns False after a quick
  in-place scan of the YAML).

The wizard in `setup_api.py` calls into `secrets_store.store_imap` /
`store_openai` directly when a NEW account is added, so the file
written from that point on is already sentinel-only.
"""

from __future__ import annotations

import logging
from typing import Any, Dict

import yaml

from src import paths
from src import secrets_store

logger = logging.getLogger(__name__)


def needs_migration(data: Dict[str, Any]) -> bool:
    """True iff at least one openai key or account password is still
    in clear text. Cheap — no I/O, no keyring round-trip."""
    api_key = (data.get("openai") or {}).get("api_key", "")
    if api_key and not secrets_store.is_sentinel(api_key):
        return True
    for acc in data.get("accounts") or []:
        pwd = acc.get("password", "")
        if pwd and not secrets_store.is_sentinel(pwd):
            return True
    return False


def _read_raw_yaml() -> Dict[str, Any]:
    """Read config.yaml from disk WITHOUT going through cfg.load —
    we need to operate on the file even when it's invalid (e.g.
    incomplete during onboarding) and we don't want to trigger
    Pydantic validation on a half-migrated state."""
    if not paths.CONFIG_PATH.exists():
        return {}
    try:
        with open(paths.CONFIG_PATH, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError) as e:
        logger.warning("Migration secrets : lecture YAML impossible (%s)", e)
        return {}


def _write_raw_yaml(data: Dict[str, Any]) -> None:
    """Atomic-ish write — same pattern as cfg.save but without
    validation, so we can persist a partially-migrated config that
    the strict loader might otherwise reject."""
    paths.ensure_dirs()
    tmp = paths.CONFIG_PATH.with_suffix(".yaml.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, allow_unicode=True, sort_keys=False)
    tmp.replace(paths.CONFIG_PATH)


def run() -> int:
    """Migrate any clear-text secrets found in config.yaml.

    Returns the number of secrets moved into the keyring (0 when
    nothing to do, including the no-config-yet case).
    """
    if not paths.CONFIG_PATH.exists():
        return 0

    data = _read_raw_yaml()
    if not data:
        return 0
    if not needs_migration(data):
        return 0

    # Probe the keyring before touching anything. If the backend is
    # broken on this machine we'd rather leave the YAML alone than
    # half-migrate and end up with neither a working clear-text path
    # nor working sentinels.
    ok, msg = secrets_store.healthcheck()
    if not ok:
        logger.warning(
            "Migration secrets ignorée : keyring indisponible (%s). "
            "Les mots de passe restent en clair dans config.yaml — "
            "la sécurité s'aligne sur celle d'Outlook/Thunderbird "
            "sans master password. Relancez après avoir installé / "
            "déverrouillé un trousseau pour bénéficier du chiffrement.",
            msg,
        )
        return 0

    moved = 0

    # OpenAI key
    openai = data.get("openai") or {}
    api_key = openai.get("api_key", "")
    if api_key and not secrets_store.is_sentinel(api_key):
        try:
            sentinel = secrets_store.store_openai(api_key)
            openai["api_key"] = sentinel
            data["openai"] = openai
            moved += 1
            logger.info("Migration : clé OpenAI déplacée vers le keyring")
        except secrets_store.SecretsBackendError as e:
            logger.warning("Migration OpenAI ignorée (%s)", e)

    # Per-account passwords
    accounts = data.get("accounts") or []
    for acc in accounts:
        email = acc.get("email", "")
        pwd = acc.get("password", "")
        if not email or not pwd or secrets_store.is_sentinel(pwd):
            continue
        try:
            sentinel = secrets_store.store_imap(email, pwd)
            acc["password"] = sentinel
            moved += 1
            logger.info("Migration : mot de passe '%s' déplacé vers le keyring", email)
        except secrets_store.SecretsBackendError as e:
            logger.warning("Migration de '%s' ignorée (%s)", email, e)

    if moved == 0:
        return 0

    try:
        _write_raw_yaml(data)
        logger.info("Migration terminée : %d secret(s) déplacé(s)", moved)
    except OSError as e:
        # Keyring entries were created but YAML write failed — next boot
        # will see the same clear-text values, hit the keyring with
        # `set_password` again (idempotent), and retry the YAML write.
        logger.error(
            "Migration : écriture YAML échouée (%s). Les entrées keyring "
            "existent mais config.yaml conserve l'ancien format. Réessai "
            "au prochain démarrage.", e,
        )
    return moved

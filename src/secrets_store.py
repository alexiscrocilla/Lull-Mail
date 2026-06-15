# SPDX-License-Identifier: GPL-3.0-or-later
"""
Cross-platform secret storage for Lull Mail.

Wraps the OS keyring so passwords never sit in plain text on disk:

  • Windows  → Credential Manager (Windows Vault)
  • macOS    → Keychain
  • Linux    → Secret Service (gnome-keyring, kwallet, …)

In `config.yaml` we store opaque sentinels of the form
    password: keyring:user@host
so the file remains readable and grep-friendly while leaking nothing.
At load time `resolve()` swaps each sentinel for the real value pulled
from the keyring; that resolved dict only ever lives in memory.

If the OS keyring is unavailable (headless Linux without gnome-keyring,
broken macOS keychain access, corporate-restricted Windows…) the
helpers raise `SecretsBackendError`. The caller decides whether to
fail closed (refuse to start) or fall back to a less-safe path. In
practice we fail closed — running with passwords randomly missing
would silently break IMAP fetches without telling the user why.

Service names
-------------
We use two services so we can ``keyring.delete_password`` them
independently when the user removes an account or rotates the
OpenAI key:

  • ``lull-mail-imap``    — entry per IMAP account (key = email)
  • ``lull-mail-openai``  — single entry (key = "default")
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)


SERVICE_IMAP = "lull-mail-imap"
SERVICE_OPENAI = "lull-mail-openai"
OPENAI_USERNAME = "default"
SERVICE_ANTHROPIC = "lull-mail-anthropic"
ANTHROPIC_USERNAME = "default"

# Sentinel marker stored in config.yaml. The colon-delimited form is
# easy to grep, easy to spot, and unambiguous (a real IMAP password is
# extraordinarily unlikely to start with `keyring:`). We still extract
# the username via `value[len(SENTINEL_PREFIX):]` rather than splitting
# on `:` because a password the user MIGHT one day pick could legally
# contain colons after the prefix.
SENTINEL_PREFIX = "keyring:"


class SecretsBackendError(RuntimeError):
    """Raised when the OS keyring is missing or refuses to cooperate.

    Distinct from the values themselves being absent — this signals
    "the keyring layer is broken", not "no entry exists for that key".
    """


def is_sentinel(value: object) -> bool:
    """True iff `value` is a sentinel pointing at the keyring rather
    than a real secret. Accepts non-strings and returns False so it's
    safe to call on `None` / dict values from a half-loaded config."""
    return isinstance(value, str) and value.startswith(SENTINEL_PREFIX)


def _key_from_sentinel(sentinel: str) -> str:
    """Extract the lookup key from a sentinel. ``keyring:foo@bar`` →
    ``foo@bar``. Caller MUST have checked `is_sentinel` first."""
    return sentinel[len(SENTINEL_PREFIX):]


def _keyring():
    """Lazy import + backend sanity check. Raises `SecretsBackendError`
    when the keyring lib isn't installed or no working backend was
    detected (e.g. Linux without Secret Service)."""
    try:
        import keyring as _kr
        from keyring import backends as _bk  # noqa: F401  (force backend import)
        from keyring.errors import NoKeyringError  # noqa: F401
    except ImportError as e:
        raise SecretsBackendError(
            "Le module `keyring` n'est pas installé. "
            "Lancez `pip install keyring` ou réinstallez Lull Mail."
        ) from e
    return _kr


def store_imap(email: str, password: str) -> str:
    """Persist `password` for `email` in the OS keyring and return the
    sentinel to write back to config.yaml."""
    if not email:
        raise ValueError("email vide — impossible de stocker le secret")
    if not password:
        raise ValueError("mot de passe vide — rien à stocker")
    kr = _keyring()
    try:
        kr.set_password(SERVICE_IMAP, email, password)
    except Exception as e:
        raise SecretsBackendError(
            f"Impossible d'écrire le mot de passe dans le keyring : {e}"
        ) from e
    return f"{SENTINEL_PREFIX}{email}"


def store_openai(api_key: str) -> str:
    """Persist the OpenAI API key in the keyring under a single
    well-known username. Returns the sentinel."""
    if not api_key:
        raise ValueError("clé API vide — rien à stocker")
    kr = _keyring()
    try:
        kr.set_password(SERVICE_OPENAI, OPENAI_USERNAME, api_key)
    except Exception as e:
        raise SecretsBackendError(
            f"Impossible d'écrire la clé OpenAI dans le keyring : {e}"
        ) from e
    return f"{SENTINEL_PREFIX}{OPENAI_USERNAME}"


def delete_imap(email: str) -> None:
    """Remove the keyring entry for `email`. Idempotent — silently
    succeeds when the entry was already missing (`PasswordDeleteError`
    in keyring 25+)."""
    if not email:
        return
    kr = _keyring()
    try:
        kr.delete_password(SERVICE_IMAP, email)
    except Exception as e:
        # PasswordDeleteError if the entry didn't exist; we don't care.
        logger.debug("delete_imap(%s) ignored: %s", email, e)


def delete_openai() -> None:
    """Remove the OpenAI key entry. Idempotent."""
    kr = _keyring()
    try:
        kr.delete_password(SERVICE_OPENAI, OPENAI_USERNAME)
    except Exception as e:
        logger.debug("delete_openai ignored: %s", e)


def store_anthropic(api_key: str) -> str:
    """Persist the Anthropic (Claude) API key in the keyring. Returns the
    sentinel (resolved later with SERVICE_ANTHROPIC)."""
    if not api_key:
        raise ValueError("clé API vide — rien à stocker")
    kr = _keyring()
    try:
        kr.set_password(SERVICE_ANTHROPIC, ANTHROPIC_USERNAME, api_key)
    except Exception as e:
        raise SecretsBackendError(
            f"Impossible d'écrire la clé Anthropic dans le keyring : {e}"
        ) from e
    return f"{SENTINEL_PREFIX}{ANTHROPIC_USERNAME}"


def delete_anthropic() -> None:
    """Remove the Anthropic key entry. Idempotent."""
    kr = _keyring()
    try:
        kr.delete_password(SERVICE_ANTHROPIC, ANTHROPIC_USERNAME)
    except Exception as e:
        logger.debug("delete_anthropic ignored: %s", e)


def resolve(value: Optional[str], service: str) -> str:
    """Return the real secret behind a sentinel, or `value` itself if
    not a sentinel (transparent passthrough for legacy in-flight
    values).

    Raises `SecretsBackendError` when the sentinel points at an entry
    that vanished from the keyring — that's a corrupted state worth
    surfacing rather than silently treating as empty.
    """
    if not is_sentinel(value):
        return value or ""
    key = _key_from_sentinel(value)
    kr = _keyring()
    try:
        retrieved = kr.get_password(service, key)
    except Exception as e:
        raise SecretsBackendError(
            f"Lecture du keyring impossible pour {service}/{key} : {e}"
        ) from e
    if retrieved is None:
        raise SecretsBackendError(
            f"Aucun secret dans le keyring pour {service}/{key} — "
            "la valeur a été effacée ailleurs ; relancez l'assistant "
            "de configuration pour la ré-enregistrer."
        )
    return retrieved


def healthcheck() -> tuple[bool, str]:
    """Round-trip a temporary value to confirm the keyring works on
    this machine. Returns `(ok, message)`. Used by the migration step
    to fail fast if the user's system has no functional backend."""
    PROBE_KEY = "__lullmail_healthcheck__"
    PROBE_VALUE = "ok"
    try:
        kr = _keyring()
        kr.set_password(SERVICE_IMAP, PROBE_KEY, PROBE_VALUE)
        got = kr.get_password(SERVICE_IMAP, PROBE_KEY)
        kr.delete_password(SERVICE_IMAP, PROBE_KEY)
        if got != PROBE_VALUE:
            return (False, f"valeur lue ({got!r}) != écrite ({PROBE_VALUE!r})")
        backend = type(kr.get_keyring()).__name__
        return (True, f"backend OK : {backend}")
    except SecretsBackendError as e:
        return (False, str(e))
    except Exception as e:
        return (False, f"erreur inattendue : {e}")

# SPDX-License-Identifier: GPL-3.0-or-later
"""
TLS verification guard.

`verify_ssl=False` legitimately exists for one scenario: ProtonMail
Bridge on `127.0.0.1`, which terminates TLS with a self-signed cert.
For any *remote* IMAP host, disabling cert verification means accepting
any certificate — handing every IMAP password (and every email body)
to whoever sits in the middle of the connection. We refuse it.

This module is the single choke-point: every code path that creates
an IMAP connection (the wizard's "test connection" button + the
fetcher's runtime connection) calls `assert_verify_ssl_allowed`
before opening the socket. Behaviour is fail-closed: if the helper
isn't called, nothing happens (the existing behaviour still permits
the dangerous combination), so a code review can grep for
`assert_verify_ssl_allowed` to confirm coverage.

`UnsafeTLSError` is a subclass of `cfg.ConfigError` so the API layer
can let it propagate as a 400 without special-casing the type.
"""

from __future__ import annotations

from src.config import ConfigError


# Hosts where self-signed / unverified TLS is tolerated. Loopback only
# — anything else means the cert chain isn't being checked over a
# network the user doesn't fully control.
_LOOPBACK_HOSTS = frozenset({
    "127.0.0.1",
    "::1",
    "localhost",
})


class UnsafeTLSError(ConfigError):
    """Raised when a non-loopback host is configured with verify_ssl=False."""


def is_loopback(host: str) -> bool:
    """True iff the host string targets the local machine."""
    return (host or "").strip().lower() in _LOOPBACK_HOSTS


def assert_verify_ssl_allowed(host: str, verify_ssl: bool) -> None:
    """Raise `UnsafeTLSError` when verify_ssl is False on a remote host.

    Called from:
      • src/setup_api.py — `add_account`, `update_account`, `test_account`
        (rejects bad config at save-time, so the value never reaches the
        runtime fetcher).
      • src/email_fetcher.py — `_make_connection` (defence-in-depth: even
        if a stale/manual config.yaml carried the dangerous combination,
        the connection refuses to open).
    """
    if verify_ssl:
        return
    if is_loopback(host):
        return
    raise UnsafeTLSError(
        f"verify_ssl=False refusé pour le serveur distant '{host}'. "
        "Cette option n'est tolérée que pour les serveurs locaux "
        "(ex : ProtonMail Bridge sur 127.0.0.1) où l'absence de "
        "vérification du certificat ne pose pas de risque "
        "d'interception. Sur un serveur réseau, désactiver la "
        "vérification permettrait à un attaquant de lire vos emails."
    )

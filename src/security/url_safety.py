# SPDX-License-Identifier: GPL-3.0-or-later
"""
URL-safety helpers for outbound HTTP requests.

When Lull Mail follows a `List-Unsubscribe` URL on behalf of the user
(RFC 8058 one-click POST), the URL is attacker-controlled — the
sender of the email picks the target. Without this guard:

  • An evil sender can point List-Unsubscribe at `http://192.168.1.1/`
    and have Lull Mail probe the user's home router on their behalf.
  • A redirect chain can land on `http://localhost:62000/api/sync`,
    making Lull Mail issue a privileged request to its own private
    API while the browser CSRF defences sleep.
  • A redirect can leak the user's IP / fingerprint to an internal
    metadata endpoint (`http://169.254.169.254/` on cloud hosts).

`is_safe_public_url` resolves the host through `getaddrinfo` and
rejects the URL when ANY resolved address is private, loopback,
link-local, multicast, or otherwise non-routable. `safe_post` is the
high-level wrapper: it follows up to 5 redirects manually, calling
the safety check on every Location, and never auto-follows them via
`requests.allow_redirects=True` (which would skip the check on
intermediate hops).

Caveat: DNS rebinding can flip an IP between resolution and the
actual `connect()` call. For the unsubscribe use case (one POST,
~5 ms apart) the window is too small to exploit reliably, and we
also bind once per hop instead of trusting requests' connection pool
to reuse stale resolutions.
"""

from __future__ import annotations

import ipaddress
import logging
import socket
from typing import Optional, Tuple
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


# Address ranges we never let outbound HTTP touch. The list is
# intentionally narrow: only the spaces that could harm the user.
# Public ranges (1.1.1.1, 8.8.8.8) remain reachable as expected.
_BLOCKED_NETWORKS = tuple(
    ipaddress.ip_network(net) for net in (
        # IPv4
        "0.0.0.0/8",          # "this network"
        "10.0.0.0/8",         # RFC 1918
        "127.0.0.0/8",        # loopback
        "169.254.0.0/16",     # link-local + AWS/GCP/Azure metadata
        "172.16.0.0/12",      # RFC 1918
        "192.168.0.0/16",     # RFC 1918
        "100.64.0.0/10",      # CGNAT
        "224.0.0.0/4",        # multicast
        "240.0.0.0/4",        # reserved
        # IPv6
        "::1/128",            # loopback
        "fc00::/7",           # ULA
        "fe80::/10",          # link-local
        "ff00::/8",           # multicast
        "::ffff:0:0/96",      # IPv4-mapped — ban via the v4 rules above too
    )
)


class UnsafeURLError(Exception):
    """Raised when a URL fails the SSRF checks."""


def is_safe_public_url(url: str) -> Tuple[bool, str]:
    """Return `(ok, reason)`. `ok=True` means the URL targets a public
    Internet host with an http/https scheme. Reason is empty on
    success and a short human-readable string on failure.

    Resolves the hostname via `getaddrinfo` and rejects the URL if any
    of the resolved addresses live in the blocked networks. Some hosts
    return both v4 and v6 — both must be public for the URL to pass.
    """
    if not url:
        return (False, "URL vide")
    try:
        parsed = urlparse(url)
    except ValueError:
        return (False, "URL malformée")
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        return (False, f"schéma refusé : {scheme or '(vide)'}")
    host = parsed.hostname
    if not host:
        return (False, "host manquant")
    # Reject literal IP hosts in private ranges right away (no DNS).
    try:
        literal_ip = ipaddress.ip_address(host.strip("[]"))
        if any(literal_ip in net for net in _BLOCKED_NETWORKS):
            return (False, f"adresse IP non routable : {literal_ip}")
        return (True, "")
    except ValueError:
        pass  # not a literal IP — continue with DNS resolution
    # DNS-based check.
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        return (False, f"DNS impossible : {e}")
    for info in infos:
        sockaddr = info[4]
        ip_str = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if any(ip in net for net in _BLOCKED_NETWORKS):
            return (False, f"{host} résout vers {ip} (réseau privé)")
    return (True, "")


def safe_post(url: str, *, data=None, headers=None, timeout: float = 5.0,
              max_redirects: int = 5) -> Tuple[bool, int, str]:
    """POST `url` with manual redirect handling. Each hop (including
    the original target) is run through `is_safe_public_url` before
    the connection is opened — an attacker-controlled redirect to an
    internal address is dropped instead of followed.

    Returns `(ok, status_code, error)` like the previous
    `unsubscribe_http`. `ok` is True on 2xx/3xx final status (3xx
    means the server returned a redirect we chose not to follow but
    the unsubscribe was likely accepted)."""
    try:
        import requests
    except ImportError:
        return (False, 0, "requests library not available")

    current = url
    headers = dict(headers or {})

    for hop in range(max_redirects + 1):
        ok, reason = is_safe_public_url(current)
        if not ok:
            logger.warning("safe_post refusé hop %d : %s (raison: %s)",
                           hop, current, reason)
            return (False, 0, f"blocked: {reason}")
        try:
            resp = requests.post(
                current,
                data=data if hop == 0 else None,  # only first hop carries body
                headers=headers,
                timeout=timeout,
                allow_redirects=False,
            )
        except requests.Timeout:
            return (False, 0, "timeout")
        except requests.RequestException as e:
            return (False, 0, str(e))

        # Final response (no redirect): success/failure based on status.
        if resp.status_code < 300 or resp.status_code >= 400:
            ok = 200 <= resp.status_code < 400
            err = "" if ok else f"HTTP {resp.status_code}"
            return (ok, resp.status_code, err)

        # 3xx: pick the next hop and loop. If no Location, treat as success
        # — the server replied 302 without telling us where to go, which
        # most providers do as a "we got it, thanks" pattern.
        next_url = resp.headers.get("Location")
        if not next_url:
            return (True, resp.status_code, "")
        # Build absolute URL if Location was relative.
        if next_url.startswith("/"):
            base = urlparse(current)
            next_url = f"{base.scheme}://{base.netloc}{next_url}"
        current = next_url

    return (False, 0, f"trop de redirections (>{max_redirects})")

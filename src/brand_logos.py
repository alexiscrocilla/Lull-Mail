# SPDX-License-Identifier: GPL-3.0-or-later
"""
Sender-domain brand logos, fetched and cached **locally**.

The mailbox shows a small logo next to each email. The old approach pulled
that favicon straight from Google's favicon service, which leaked the domain
of every correspondent to a third party. This module keeps the same visual
result without the leak: the *local* backend fetches the favicon from the
sender's own domain (which already knows it emailed the user), caches it on
disk, and the frontend only ever talks to `127.0.0.1`.

Design notes
------------
* **Untrusted input.** The domain comes from email headers, so every
  outbound fetch is a potential SSRF vector. `_host_is_public()` resolves
  the host and refuses anything pointing at private / loopback / link-local
  / reserved space, and redirects are followed manually with the same check
  at each hop.
* **Best-effort.** No logo is not an error — the UI falls back to the
  coloured initials bubble. Failures are cached (a `.miss` marker) so a dead
  host isn't hammered on every inbox repaint.
* **Bounded.** Short timeouts, a small response cap, a couple of candidate
  URLs per domain, and magic-byte sniffing so an HTML error page served as
  `favicon.ico` never reaches the browser.
"""

from __future__ import annotations

import ipaddress
import logging
import re
import socket
import threading
import time
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional, Tuple
from urllib.parse import urljoin, urlparse

import requests

from src import paths
from src.brands import registrable

log = logging.getLogger(__name__)

# ── Tunables ───────────────────────────────────────────────────────────────
_MAX_BYTES = 512 * 1024          # 512 KB — a favicon is tiny; anything bigger
                                 # is almost certainly not one.
_CONNECT_TIMEOUT = 3.0
_READ_TIMEOUT = 4.0
_MAX_REDIRECTS = 3
_NEGATIVE_TTL = 7 * 24 * 3600    # re-try a domain that had no logo weekly
_UA = "LullMail-logo-fetch/1.0 (+local favicon cache)"

# A conservative hostname shape: labels of [a-z0-9-], at least one dot, a
# 2+ char alpha-ish TLD (punycode `xn--…` allowed). Rejects paths, ports,
# credentials, IP literals and `..` traversal.
_DOMAIN_RE = re.compile(r"^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$")

# Image magic numbers we are willing to hand back to the browser. SVG is
# deliberately excluded — serving attacker-authored SVG, even inside <img>,
# is more surface than a favicon is worth.
_SNIFFERS: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x00\x00\x01\x00", "image/x-icon"),   # ICO
    (b"\x00\x00\x02\x00", "image/x-icon"),   # CUR (rare, still an icon)
    (b"BM", "image/bmp"),
)

# Serialise concurrent fetches for the same domain so an inbox full of the
# same sender doesn't fire N identical outbound requests on first paint.
_locks_guard = threading.Lock()
_locks: dict[str, threading.Lock] = {}


def normalise_domain(raw: str) -> str:
    """Lower-case + strip a domain, returning '' if it isn't a plausible host."""
    d = (raw or "").strip().strip(".").lower()
    # Strip an accidental leading scheme or trailing path/port if one slips in.
    if "/" in d:
        d = d.split("/", 1)[0]
    if "@" in d:
        d = d.rsplit("@", 1)[-1]
    if ":" in d:
        d = d.split(":", 1)[0]
    return d if _DOMAIN_RE.match(d) else ""


def _sniff_content_type(data: bytes) -> Optional[str]:
    for magic, ct in _SNIFFERS:
        if data.startswith(magic):
            return ct
    # WebP: "RIFF????WEBP"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _host_is_public(host: str) -> bool:
    """True only if `host` resolves exclusively to globally-routable IPs.

    Any private / loopback / link-local / reserved / multicast address — or a
    resolution failure — fails closed. This is the SSRF gate: the host comes
    from untrusted mail, so it must never be able to make the backend reach
    into the local network or cloud metadata endpoints.
    """
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    saw_one = False
    for info in infos:
        addr = info[4][0]
        # Drop an IPv6 scope id if present (fe80::1%eth0).
        addr = addr.split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return False
        saw_one = True
    return saw_one


class _IconLinkParser(HTMLParser):
    """Pull candidate icon hrefs out of a homepage <head>."""

    def __init__(self) -> None:
        super().__init__()
        self.icons: list[str] = []
        self._done = False

    def handle_starttag(self, tag: str, attrs) -> None:
        if self._done or tag != "link":
            if tag == "body":
                self._done = True
            return
        a = {k.lower(): (v or "") for k, v in attrs}
        rel = a.get("rel", "").lower()
        href = a.get("href", "").strip()
        if href and ("icon" in rel):
            self.icons.append(href)


def _fetch(url: str) -> Optional[Tuple[bytes, str]]:
    """SSRF-guarded single GET. Follows redirects by hand, re-checking the
    host at each hop. Returns (bytes, content_type) for a real image, else
    None."""
    seen = 0
    current = url
    while True:
        parsed = urlparse(current)
        if parsed.scheme not in ("http", "https"):
            return None
        if not _host_is_public(parsed.hostname or ""):
            return None
        try:
            resp = requests.get(
                current,
                timeout=(_CONNECT_TIMEOUT, _READ_TIMEOUT),
                stream=True,
                allow_redirects=False,
                headers={"User-Agent": _UA, "Accept": "image/*,*/*;q=0.5"},
            )
        except requests.RequestException:
            return None
        try:
            if resp.status_code in (301, 302, 303, 307, 308):
                loc = resp.headers.get("Location", "")
                if not loc or seen >= _MAX_REDIRECTS:
                    return None
                seen += 1
                current = urljoin(current, loc)
                continue
            if resp.status_code != 200:
                return None
            clen = resp.headers.get("Content-Length")
            if clen and clen.isdigit() and int(clen) > _MAX_BYTES:
                return None
            # Read with a hard cap so a lying / missing Content-Length can't
            # stream us an unbounded body.
            chunks = bytearray()
            for chunk in resp.iter_content(8192):
                chunks.extend(chunk)
                if len(chunks) > _MAX_BYTES:
                    return None
            data = bytes(chunks)
        finally:
            resp.close()
        if not data:
            return None
        ct = _sniff_content_type(data)
        if not ct:
            return None
        return data, ct


def _fetch_from_homepage(domain: str) -> Optional[Tuple[bytes, str]]:
    """Parse `https://domain/` for a <link rel=icon> and fetch it."""
    home = f"https://{domain}/"
    parsed = urlparse(home)
    if not _host_is_public(parsed.hostname or ""):
        return None
    try:
        resp = requests.get(
            home,
            timeout=(_CONNECT_TIMEOUT, _READ_TIMEOUT),
            allow_redirects=True,
            headers={"User-Agent": _UA},
        )
    except requests.RequestException:
        return None
    if resp.status_code != 200 or "html" not in resp.headers.get("Content-Type", ""):
        return None
    parser = _IconLinkParser()
    try:
        parser.feed(resp.text[:200_000])
    except Exception:
        return None
    for href in parser.icons[:4]:
        icon_url = urljoin(resp.url, href)
        got = _fetch(icon_url)
        if got:
            return got
    return None


def fetch_logo(domain: str) -> Optional[Tuple[bytes, str]]:
    """Try the usual favicon spots for `domain` (and its registrable root)."""
    root = registrable(domain)
    candidates = [f"https://{domain}/favicon.ico"]
    if root and root != domain:
        candidates.append(f"https://{root}/favicon.ico")
    for url in candidates:
        got = _fetch(url)
        if got:
            return got
    # Fall back to the homepage <link rel=icon> — many sites don't keep a
    # bare /favicon.ico anymore.
    got = _fetch_from_homepage(domain)
    if got:
        return got
    if root and root != domain:
        got = _fetch_from_homepage(root)
        if got:
            return got
    return None


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _locks[key] = lock
        return lock


def get_logo(domain: str) -> Optional[Tuple[bytes, str]]:
    """Return (bytes, content_type) for `domain`'s logo, or None.

    Reads the on-disk cache first; on a miss (and past the negative TTL)
    fetches once, then records either the image or a `.miss` marker.
    """
    domain = normalise_domain(domain)
    if not domain:
        return None

    # Domain is validated to a safe charset, but hash it anyway so the cache
    # filename can never be anything but hex — no path games.
    import hashlib
    key = hashlib.sha256(domain.encode("utf-8")).hexdigest()
    cache_dir = paths.BRAND_LOGOS_DIR
    hit = cache_dir / f"{key}.bin"
    miss = cache_dir / f"{key}.miss"

    if hit.is_file():
        try:
            data = hit.read_bytes()
            ct = _sniff_content_type(data) or "image/x-icon"
            return data, ct
        except OSError:
            pass  # fall through and re-fetch

    lock = _lock_for(key)
    with lock:
        # Re-check inside the lock: another request may have just filled it.
        if hit.is_file():
            try:
                data = hit.read_bytes()
                return data, (_sniff_content_type(data) or "image/x-icon")
            except OSError:
                pass
        if miss.is_file():
            try:
                if (time.time() - miss.stat().st_mtime) < _NEGATIVE_TTL:
                    return None
            except OSError:
                pass

        got = fetch_logo(domain)
        try:
            cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            return got[0:2] if got else None  # can't cache, still serve once
        if got:
            data, _ct = got
            try:
                hit.write_bytes(data)
                if miss.exists():
                    miss.unlink()
            except OSError:
                pass
            return got
        # Record the miss so we don't re-hit a dead host every repaint.
        try:
            miss.write_bytes(b"")
        except OSError:
            pass
        return None

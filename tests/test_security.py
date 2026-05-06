"""
End-to-end security guards — origin-check, TLS lock, SSRF block.
Each test exercises the live FastAPI app via TestClient so a
regression in middleware or endpoint wiring is caught.
"""

from __future__ import annotations

import socket
from unittest.mock import patch


# ── Origin-check middleware ──────────────────────────────────────────────────


def test_origin_check_get_always_allowed(client):
    """Read-only endpoints don't enforce origin — even foreign caller."""
    r = client.get("/api/sync/status",
                   headers={"Origin": "https://evil.example"})
    assert r.status_code == 200


def test_origin_check_post_loopback_accepted(client):
    """Same-origin POST with our bound-port loopback → allowed."""
    # The fixture client already injects Origin: http://127.0.0.1:8000
    r = client.post("/api/sync")
    # 200 (sync triggered) or 503-ish (no config) — anything that
    # is NOT 403 means the middleware let it through.
    assert r.status_code != 403


def test_origin_check_post_foreign_refused(client):
    """POST with foreign origin → 403 + structured JSON body."""
    r = client.post("/api/sync",
                    headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    body = r.json()
    assert body["error"] == "origin_refused"
    assert "Lull Mail" in body["detail"]


def test_origin_check_no_origin_allowed(client):
    """Origin-less POST passes (server-side redirects, native webview)."""
    headers = dict(client.headers)
    headers.pop("origin", None)
    r = client.post("/api/sync", headers=headers)
    assert r.status_code != 403


# ── TLS verification gate ────────────────────────────────────────────────────


def test_tls_lock_refuses_remote_with_unverified_ssl(client):
    """Saving an account that combines `verify_ssl=False` with a
    non-loopback host returns 400 with a clear error."""
    # Bootstrap a usable openai section first so /accounts can persist.
    client.post("/api/setup/openai",
                json={"api_key": "sk-fake1234", "model": "gpt-4o-mini"})
    r = client.post("/api/setup/accounts", json={
        "name": "Bad", "type": "imap",
        "email": "x@example.com",
        "imap_host": "imap.example.com",
        "imap_port": 993,
        "username": "x@example.com", "password": "fake",
        "ssl": True, "starttls": False,
        "verify_ssl": False,    # <-- the unsafe combo
        "enabled": True,
    })
    assert r.status_code == 400
    body = r.json()
    assert "verify_ssl=False" in body["detail"]


def test_tls_lock_allows_loopback_with_unverified_ssl(client):
    """ProtonMail Bridge case: 127.0.0.1 + verify_ssl=False is fine."""
    client.post("/api/setup/openai",
                json={"api_key": "sk-fake1234", "model": "gpt-4o-mini"})
    r = client.post("/api/setup/accounts", json={
        "name": "Bridge", "type": "proton",
        "email": "me@proton.me",
        "imap_host": "127.0.0.1",
        "imap_port": 1143,
        "username": "me@proton.me", "password": "bridge",
        "ssl": False, "starttls": True,
        "verify_ssl": False,
        "enabled": True,
    })
    # Save succeeds (200). The auto-test bundled in the response will
    # be ok=False because Proton Bridge isn't actually running, but
    # that's a TEST failure, not a SAVE failure.
    assert r.status_code == 200, r.text


# ── SSRF guard for outbound HTTP ─────────────────────────────────────────────


def test_ssrf_block_private_ipv4():
    """Private IPv4 ranges are refused before any socket opens."""
    from src.security.url_safety import is_safe_public_url
    for url in (
        "http://10.0.0.1/",
        "http://172.16.0.1/",
        "http://192.168.1.1/",
        "http://127.0.0.1:8000/api/sync",
        "http://169.254.169.254/latest/meta-data/",
    ):
        ok, reason = is_safe_public_url(url)
        assert not ok, f"{url} should have been refused"
        assert reason


def test_ssrf_block_loopback_ipv6():
    from src.security.url_safety import is_safe_public_url
    ok, reason = is_safe_public_url("http://[::1]/")
    assert not ok
    assert "::1" in reason


def test_ssrf_block_dangerous_schemes():
    from src.security.url_safety import is_safe_public_url
    for url in (
        "javascript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,<script>",
        "ftp://example.com/",
    ):
        ok, _ = is_safe_public_url(url)
        assert not ok, url


def test_ssrf_allow_public_url():
    from src.security.url_safety import is_safe_public_url
    # Mock getaddrinfo to avoid an actual DNS lookup in CI.
    with patch.object(socket, "getaddrinfo",
                      return_value=[(2, 1, 6, "", ("142.250.74.142", 0))]):
        ok, _ = is_safe_public_url("https://google.com/")
        assert ok


# ── Sandbox iframe — no allow-scripts ────────────────────────────────────────


def test_iframe_sandbox_does_not_allow_scripts():
    """Static check on the JS source: the email-body iframe must not
    carry `allow-scripts` in its sandbox attribute. Catches a copy-
    paste regression. We look only at strings that follow `sandbox=`
    so a comment or a docstring mentioning the keyword doesn't false-
    positive."""
    import re
    from pathlib import Path
    src_dir = Path(__file__).resolve().parent.parent / "frontend"
    mailbox_js = (src_dir / "mailbox.js").read_text(encoding="utf-8")
    sandbox_values = re.findall(r'sandbox=["\']([^"\']*)["\']', mailbox_js)
    assert sandbox_values, "no sandbox attribute found at all — this would mean the iframe lost its hardening"
    for value in sandbox_values:
        tokens = value.split()
        assert "allow-scripts" not in tokens, (
            f"sandbox attribute {value!r} re-introduces `allow-scripts` — "
            "that opens the JS execution surface back up."
        )
    # Make sure the safe variant is still present (catches accidental
    # full removal of the sandbox attribute).
    assert any("allow-popups-to-escape-sandbox" in v for v in sandbox_values)

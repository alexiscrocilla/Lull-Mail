"""
Anti-phishing /safe-link interstitial — analyzer + endpoint behaviour.
"""

from __future__ import annotations


# ── analyze() — pattern detection ────────────────────────────────────────────


def test_homoglyph_cyrillic_detected():
    from src.safe_link import analyze
    threats = analyze("https://раypal.com/")  # 'р' = U+0440 Cyrillic
    types = {t.type for t in threats}
    assert "homoglyph" in types


def test_punycode_detected():
    from src.safe_link import analyze
    threats = analyze("https://xn--ypal-43d9g.com/")
    types = {t.type for t in threats}
    assert "punycode" in types


def test_userinfo_trick_detected():
    from src.safe_link import analyze
    threats = analyze("https://paypal.com@evil.com/login")
    types = {t.type for t in threats}
    assert "userinfo" in types


def test_ip_host_detected():
    from src.safe_link import analyze
    threats = analyze("http://192.0.2.1/admin")
    types = {t.type for t in threats}
    assert "ip_host" in types


def test_shortener_detected():
    from src.safe_link import analyze
    threats = analyze("https://bit.ly/abc")
    types = {t.type for t in threats}
    assert "shortener" in types


def test_suspicious_tld_detected():
    from src.safe_link import analyze
    threats = analyze("https://promo.xyz/coupon")
    types = {t.type for t in threats}
    assert "suspicious_tld" in types


def test_typosquat_detected():
    from src.safe_link import analyze
    # paypa1.com — '1' instead of 'l'. Distance 1 from paypal.com.
    threats = analyze("https://paypa1.com/login")
    types = {t.type for t in threats}
    assert "typosquat" in types


def test_typosquat_transposition():
    from src.safe_link import analyze
    threats = analyze("https://googel.com/")  # transposed e/l
    types = {t.type for t in threats}
    assert "typosquat" in types


def test_subdomain_spoof_detected():
    from src.safe_link import analyze
    threats = analyze("https://paypal.evil.com/login")
    types = {t.type for t in threats}
    assert "subdomain_spoof" in types


def test_legitimate_url_no_threats():
    from src.safe_link import analyze
    assert analyze("https://github.com/") == []
    assert analyze("https://www.google.com/search?q=hi") == []


# ── /safe-link endpoint ──────────────────────────────────────────────────────


def test_safe_link_redirects_when_clean(client):
    """A clean URL → 302 to the original target, no warning page."""
    r = client.get("/safe-link", params={"url": "https://github.com/"},
                   follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "https://github.com/"


def test_safe_link_renders_page_when_dirty(client):
    """A homograph URL → HTML page with the warning UI."""
    r = client.get("/safe-link",
                   params={"url": "https://раypal.com/"},
                   follow_redirects=False)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    body = r.text
    assert "Caractères trompeurs" in body
    # Highlighted characters must appear marked-up.
    assert "bad" in body  # the .bad CSS class around suspect chars


def test_safe_link_refuses_javascript_scheme(client):
    r = client.get("/safe-link", params={"url": "javascript:alert(1)"})
    assert r.status_code == 400


def test_safe_link_refuses_too_long_url(client):
    r = client.get("/safe-link", params={"url": "https://" + "x" * 5000})
    assert r.status_code == 400

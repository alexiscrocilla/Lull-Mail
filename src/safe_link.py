# SPDX-License-Identifier: GPL-3.0-or-later
"""
Safe-link interstitial.

When a user clicks an email link whose hostname looks suspicious
(homograph spoof, IDN punycode, userinfo trick, raw IP, link shortener,
sketchy TLD, …), we don't open the URL directly — instead we route them
to `/safe-link?url=…` where this module renders a full-page warning.

The frontend rewrites `<a href>` on every flagged link
(see `markSuspiciousLinksInHtml` in mailbox.js and `linkify` in
api.js). This file is only the server side of that contract.

Security notes
--------------
• `url` is attacker-controlled. Every string written into the response
  goes through `html.escape` first.
• Only `http://` and `https://` are accepted. Anything else returns 400.
• When `analyze()` finds no threat, we 302 to the destination directly —
  no fake warning, no desensitisation.
"""

from __future__ import annotations

import html
import ipaddress
import re
from dataclasses import dataclass
from typing import List, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse

from src.brands import BRANDS, BRAND_ROOTS, registrable, subdomain
from src.i18n import tr, get_locale


router = APIRouter()


# ── Threat catalogue ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Threat:
    """One detected red flag. Rendered as a card with the visual on the
    left and the explanation on the right. `severity` controls colour
    only (danger=red, warning=amber); the threat is shown either way."""
    type: str
    severity: str           # "danger" | "warning"
    title: str
    body: str               # plain-French explanation
    visual_html: str        # pre-built, pre-escaped HTML for the left column


# Cyrillic + Greek ranges — same as frontend HOMOGLYPH_RE in api.js and
# the rule for attachment filenames in
# src/attachment_security.py:425-429.
def _is_homoglyph_char(c: str) -> bool:
    n = ord(c)
    return (0x0400 <= n <= 0x04FF) or (0x0370 <= n <= 0x03FF)


def _has_homoglyphs(host: str) -> bool:
    return any(_is_homoglyph_char(c) for c in host or "")


def _is_punycoded(host: str) -> bool:
    if not host:
        return False
    low = host.lower()
    return low.startswith("xn--") or ".xn--" in low


def _is_ip_host(host: str) -> bool:
    if not host:
        return False
    try:
        ipaddress.ip_address(host.strip("[]"))
        return True
    except ValueError:
        return False


# Curated list of common URL shorteners. We mark them as suspicious not
# because they are malicious by themselves, but because they hide the
# real destination — a phishing email using `bit.ly/xyz` is much easier
# to click on than a raw spoofed domain. Users can always continue.
_SHORTENERS = frozenset({
    "bit.ly", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "is.gd",
    "buff.ly", "rebrand.ly", "shorturl.at", "cutt.ly", "lnkd.in",
    "rb.gy", "soo.gd", "x.co", "v.gd", "tiny.cc", "tr.im",
    "shorte.st", "adf.ly",
})

# Free / abused TLDs heavily over-represented in phishing/spam. Same
# logic as src/local_classifier.py spam patterns.
_SUSPICIOUS_TLDS = frozenset({
    "xyz", "top", "click", "loan", "work", "tk", "ml", "ga", "cf",
    "gq", "country", "cricket", "win", "stream", "download", "men",
    "review", "racing", "party", "trade", "date", "faith", "science",
})


def _has_userinfo(url: str) -> bool:
    m = re.match(r"^https?://([^/?#\s]+)", url, re.I)
    if not m:
        return False
    return "@" in m.group(1)


def _tld_of(host: str) -> str:
    parts = (host or "").rsplit(".", 1)
    return parts[-1].lower() if len(parts) == 2 else ""


def _damerau_levenshtein(a: str, b: str, max_d: int = 2) -> int:
    """Damerau-Levenshtein distance with early termination.

    Damerau-Levenshtein adds *transposition* of two adjacent characters
    as a single operation, which is what makes "googel.com" reachable
    from "google.com" at distance 1 (a real-world common typo). Plain
    Levenshtein would put it at distance 2.

    Returns `max_d + 1` instead of the true distance when the result
    would clearly exceed `max_d` (length-difference shortcut). Good
    enough for our compare-against-list use case.
    """
    n, m = len(a), len(b)
    if abs(n - m) > max_d:
        return max_d + 1
    if not a:
        return m
    if not b:
        return n
    # Full DP table — n, m are tiny (domain names ≤ ~30 chars), no need
    # to optimise to two-row form.
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        d[i][0] = i
    for j in range(m + 1):
        d[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(
                d[i - 1][j] + 1,        # deletion
                d[i][j - 1] + 1,        # insertion
                d[i - 1][j - 1] + cost,  # substitution
            )
            if (i > 1 and j > 1
                    and a[i - 1] == b[j - 2]
                    and a[i - 2] == b[j - 1]):
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + cost)  # transposition
    return d[n][m]


def _detect_typosquat(host: str) -> Optional[str]:
    """Return the brand domain that `host` is impersonating, or None.

    Threshold is **distance ≤ 1** (Damerau-Levenshtein). Most real
    phishing typos are single-character: substitution (paypa1.com),
    insertion (paypall.com), deletion (paypa.com), or transposition
    (googel.com). The threshold is intentionally tight to avoid
    false-positives — single-edit collisions are already very common
    in the real world (`paypay.com`, `paypale.fr`, etc., are real).

    Skips when `host`'s registrable IS a known brand: legitimate
    visits to `paypal.com` shouldn't trigger.
    """
    reg = registrable(host)
    if not reg or reg in BRANDS:
        return None
    for brand in BRANDS:
        if _damerau_levenshtein(reg, brand, max_d=1) <= 1:
            return brand
    return None


def _detect_subdomain_spoof(host: str) -> Optional[str]:
    """Return the brand whose name appears as a subdomain when the
    registrable domain isn't the brand itself.

    Catches `paypal.com.evil.com` (subdomain="paypal.com",
    registrable="evil.com") and `paypal.evil.com` (subdomain="paypal").
    Skips legitimate hosts where the registrable IS the brand — a
    `mybanking.bnpparibas.fr` URL is fine because the registrable IS
    bnpparibas.fr.
    """
    reg = registrable(host)
    if not reg or reg in BRANDS:
        return None
    sub = subdomain(host)
    if not sub:
        return None
    for label in sub.split("."):
        if label in BRAND_ROOTS:
            return label
    return None


def _to_punycode(host: str) -> Optional[str]:
    """Return the IDN punycode form of `host`, or None when the host is
    already pure ASCII (in which case the encoded form would be
    identical and showing it adds no value)."""
    if not host:
        return None
    try:
        encoded = host.encode("idna").decode("ascii")
    except (UnicodeError, UnicodeDecodeError):
        return None
    return encoded if encoded.lower() != host.lower() else None


# ── Per-threat visual builders ───────────────────────────────────────────────


def _visual_glyphs(host: str) -> str:
    """Big tiles of each non-Latin char with its codepoint underneath.
    Far more readable than a sentence listing them."""
    seen = []
    for c in host:
        if _is_homoglyph_char(c) and c not in seen:
            seen.append(c)
    tiles = "".join(
        f'<div class="glyph-tile">'
        f'<div class="glyph-char">{html.escape(c)}</div>'
        f'<div class="glyph-cp">U+{ord(c):04X}</div>'
        f'</div>'
        for c in seen
    )
    return f'<div class="visual visual-glyphs">{tiles}</div>'


def _visual_mono(text: str, *, size: str = "lg") -> str:
    """Generic monospace block — used for punycode hostname, raw IP,
    shortener domain, suspicious TLD."""
    klass = "visual-mono visual-mono-" + size
    return (
        f'<div class="visual {klass}">'
        f'<code>{html.escape(text)}</code>'
        f'</div>'
    )


def _visual_userinfo(before: str, after: str, locale: str = "fr") -> str:
    """The `@` trick: emphasise that whatever is BEFORE the `@` is just
    decoration, the real host is what comes after."""
    real_domain_label = tr("safe_link.visual.real_domain", locale)
    return (
        '<div class="visual visual-userinfo">'
        f'<div class="ui-row"><span class="ui-fake">{html.escape(before) or "…"}</span>'
        '<span class="ui-at">@</span></div>'
        f'<div class="ui-real" title="{html.escape(real_domain_label)}">{html.escape(after) or "?"}</div>'
        '</div>'
    )


def _visual_typosquat(fake: str, real: str, locale: str = "fr") -> str:
    """Show the suspicious domain side-by-side with the brand it's
    trying to imitate. The diff is implicit: the user sees both at
    once and intuitively spots the swapped/missing/inserted char."""
    imitates_label = tr("safe_link.visual.imitates", locale)
    return (
        '<div class="visual visual-typosquat">'
        f'<div class="ts-fake"><code>{html.escape(fake)}</code></div>'
        '<div class="ts-arrow" aria-hidden="true">↓</div>'
        f'<div class="ts-label">{html.escape(imitates_label)}</div>'
        f'<div class="ts-real"><code>{html.escape(real)}</code></div>'
        '</div>'
    )


def _visual_subdomain_spoof(host: str, brand_root: str, locale: str = "fr") -> str:
    """Render the host with the brand label highlighted, then arrow
    down to the actual registrable domain. Makes "ah so the REAL host
    is at the end" obvious."""
    reg = registrable(host)
    sub = subdomain(host)
    real_domain_label = tr("safe_link.visual.real_domain", locale)
    sub_html = ""
    for i, label in enumerate(sub.split(".")):
        sep = "." if i > 0 else ""
        if label == brand_root:
            sub_html += f'{sep}<span class="ss-brand">{html.escape(label)}</span>'
        else:
            sub_html += f'{sep}<span class="ss-sub">{html.escape(label)}</span>'
    return (
        '<div class="visual visual-subdomain">'
        f'<div class="ss-line"><code>{sub_html}.<span class="ss-real">{html.escape(reg)}</span></code></div>'
        f'<div class="ss-caption">{html.escape(real_domain_label)}</div>'
        '</div>'
    )


# ── Analysis ─────────────────────────────────────────────────────────────────


def analyze(url: str, locale: str = "fr") -> List[Threat]:
    """Return every red flag detected on `url`. Pure function, no I/O."""
    parsed = urlparse(url)
    host_raw = parsed.hostname or ""
    host = host_raw.lower()
    threats: List[Threat] = []

    if _has_homoglyphs(host_raw):
        threats.append(Threat(
            type="homoglyph",
            severity="danger",
            title=tr("safe_link.threat.homoglyph.title", locale),
            body=tr("safe_link.threat.homoglyph.body", locale),
            visual_html=_visual_glyphs(host_raw),
        ))

    # Punycode card fires both when the URL arrived already xn--encoded
    # AND when the visible host is non-ASCII (browser will encode it
    # before resolving). Both cases benefit from showing the resolved
    # form prominently.
    encoded = _to_punycode(host_raw)
    if _is_punycoded(host) or encoded:
        if _is_punycoded(host):
            shown = host
            body = tr("safe_link.threat.punycode_pre.body", locale)
        else:
            shown = encoded or host
            body = tr("safe_link.threat.punycode_enc.body", locale)
        threats.append(Threat(
            type="punycode",
            severity="warning",
            title=tr("safe_link.threat.punycode.title", locale),
            body=body,
            visual_html=_visual_mono(shown, size="lg"),
        ))

    if _has_userinfo(url):
        m = re.match(r"^https?://([^/?#\s]+)", url, re.I)
        userinfo_blob = m.group(1) if m else ""
        before, _, after = userinfo_blob.partition("@")
        threats.append(Threat(
            type="userinfo",
            severity="danger",
            title=tr("safe_link.threat.userinfo.title", locale),
            body=tr("safe_link.threat.userinfo.body", locale),
            visual_html=_visual_userinfo(before, after, locale),
        ))

    if _is_ip_host(host):
        threats.append(Threat(
            type="ip_host",
            severity="danger",
            title=tr("safe_link.threat.ip_host.title", locale),
            body=tr("safe_link.threat.ip_host.body", locale),
            visual_html=_visual_mono(host, size="lg"),
        ))

    if host in _SHORTENERS:
        threats.append(Threat(
            type="shortener",
            severity="warning",
            title=tr("safe_link.threat.shortener.title", locale),
            body=tr("safe_link.threat.shortener.body", locale),
            visual_html=_visual_mono(host, size="lg"),
        ))

    tld = _tld_of(host)
    if tld in _SUSPICIOUS_TLDS:
        threats.append(Threat(
            type="suspicious_tld",
            severity="warning",
            title=tr("safe_link.threat.suspicious_tld.title", locale),
            body=tr("safe_link.threat.suspicious_tld.body", locale, tld=tld),
            visual_html=_visual_mono(f".{tld}", size="xl"),
        ))

    typo_brand = _detect_typosquat(host)
    if typo_brand:
        threats.append(Threat(
            type="typosquat",
            severity="danger",
            title=tr("safe_link.threat.typosquat.title", locale),
            body=tr("safe_link.threat.typosquat.body", locale, brand=typo_brand),
            visual_html=_visual_typosquat(registrable(host), typo_brand, locale),
        ))

    spoof_brand = _detect_subdomain_spoof(host)
    if spoof_brand:
        threats.append(Threat(
            type="subdomain_spoof",
            severity="danger",
            title=tr("safe_link.threat.subdomain_spoof.title", locale),
            body=tr("safe_link.threat.subdomain_spoof.body", locale,
                    brand=spoof_brand, registrable=registrable(host)),
            visual_html=_visual_subdomain_spoof(host, spoof_brand, locale),
        ))

    return threats


# ── Page rendering ───────────────────────────────────────────────────────────


def _highlight_host_inline(host: str) -> str:
    """Used in the URL preview at the top — wraps non-Latin chars in
    a small red badge so the user can spot them at a glance."""
    parts: List[str] = []
    for c in host:
        if _is_homoglyph_char(c):
            parts.append(
                f'<span class="bad" title="U+{ord(c):04X}">{html.escape(c)}</span>'
            )
        else:
            parts.append(html.escape(c))
    return "".join(parts)


def _render_threat_card(t: Threat) -> str:
    return f"""
    <article class="card threat threat--{html.escape(t.severity)}">
      <div class="card-visual">{t.visual_html}</div>
      <div class="card-body">
        <h3>{html.escape(t.title)}</h3>
        <p>{html.escape(t.body)}</p>
      </div>
    </article>"""


def render_page(url: str, locale: str = "fr") -> str:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    host_html = _highlight_host_inline(host)
    threats = analyze(url, locale)

    scheme_html = html.escape(parsed.scheme + "://")
    tail = parsed.path or ""
    if parsed.query:
        tail += "?" + parsed.query
    if parsed.fragment:
        tail += "#" + parsed.fragment
    tail_html = html.escape(tail)
    url_pretty = (
        f'<span class="dim">{scheme_html}</span>'
        f'<span class="host">{host_html}</span>'
        f'<span class="dim">{tail_html}</span>'
    )

    cards_html = "\n".join(_render_threat_card(t) for t in threats)

    severity_top = "danger" if any(t.severity == "danger" for t in threats) else "warning"
    title_key = "safe_link.page.title_danger" if severity_top == "danger" else "safe_link.page.title_warning"
    title_text = tr(title_key, locale)

    safe_url = html.escape(url, quote=True)
    lang_attr = "en" if locale == "en" else "fr"

    return _PAGE_TEMPLATE.format(
        title_text=html.escape(title_text),
        severity_top=severity_top,
        url_pretty=url_pretty,
        cards_html=cards_html,
        safe_url=safe_url,
        lang_attr=lang_attr,
        lead_text=html.escape(tr("safe_link.page.lead", locale)),
        btn_cancel=html.escape(tr("safe_link.page.btn_cancel", locale)),
        btn_continue=html.escape(tr("safe_link.page.btn_continue", locale)),
        footer_text=html.escape(tr("safe_link.page.footer", locale)),
    )


_PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="{lang_attr}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>{title_text} — Lull Mail</title>
<style>
  :root {{
    --bg: #f4f5f7; --surface: #ffffff; --surface-2: #fafbfc;
    --text: #111827; --muted: #6b7280; --border: #e5e7eb;
    --danger: #dc2626; --danger-bg: #fef2f2; --danger-soft: #fee2e2;
    --warning: #d97706; --warning-bg: #fffbeb; --warning-soft: #fef3c7;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{
      --bg: #0b0d12; --surface: #14181f; --surface-2: #1a1f29;
      --text: #e5e7eb; --muted: #9ca3af; --border: #2a2f3a;
      --danger: #f87171; --danger-bg: rgba(220,38,38,0.18);
      --danger-soft: rgba(220,38,38,0.10);
      --warning: #fbbf24; --warning-bg: rgba(217,119,6,0.18);
      --warning-soft: rgba(217,119,6,0.10);
    }}
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; padding: 32px 16px; min-height: 100vh;
    /* Center vertically AND horizontally. `safe-area` keeps the card from
       being clipped at the top when its height exceeds the viewport
       (long URLs + many cards) — content scrolls instead of getting cut. */
    display: flex; align-items: safe center; justify-content: center;
    font-family: "Plus Jakarta Sans", system-ui, -apple-system,
                 "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--text);
    -webkit-font-smoothing: antialiased;
  }}
  .wrap {{ width: 100%; max-width: 720px; }}

  /* ── Hero ───────────────────────────────────────────── */
  .hero {{
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 18px; padding: 28px 32px;
    box-shadow: 0 12px 32px -8px rgba(15,23,42,0.10);
  }}

  .hero-head {{
    display: flex; gap: 14px; align-items: center; margin-bottom: 6px;
  }}
  .hero-icon {{
    width: 44px; height: 44px; flex: 0 0 auto;
    border-radius: 12px; display: grid; place-items: center;
    background: var(--danger-bg); color: var(--danger);
  }}
  .severity-warning .hero-icon {{
    background: var(--warning-bg); color: var(--warning);
  }}
  .hero h1 {{
    margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.01em;
  }}
  .hero .lead {{
    margin: 8px 0 22px; color: var(--muted); font-size: 14.5px;
    line-height: 1.6;
  }}

  .url-box {{
    margin: 0 0 22px; padding: 14px 16px;
    background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 12px;
    font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 13.5px; word-break: break-all; line-height: 1.55;
  }}
  .url-box .dim {{ color: var(--muted); }}
  .url-box .host {{ color: var(--text); font-weight: 600; }}
  .url-box .bad {{
    background: var(--danger); color: #ffffff;
    padding: 1px 4px; margin: 0 1px; border-radius: 3px;
    font-weight: 700; cursor: help;
  }}

  /* ── Threat cards ──────────────────────────────────── */
  .threats {{ display: grid; gap: 10px; margin: 22px 0 24px; }}
  .card.threat {{
    display: grid; grid-template-columns: 140px 1fr; gap: 16px;
    align-items: stretch;
    padding: 14px; border-radius: 14px;
    border: 1px solid var(--border); background: var(--surface-2);
  }}
  .threat--danger {{ background: var(--danger-soft); }}
  .threat--warning {{ background: var(--warning-soft); }}

  .card-visual {{
    display: grid; place-items: center; min-height: 100px;
    background: var(--surface);
    border: 1px solid var(--border); border-radius: 10px;
    padding: 10px;
  }}
  .card-body {{ display: flex; flex-direction: column; justify-content: center; }}
  .card-body h3 {{
    margin: 0 0 6px; font-size: 15px; font-weight: 700;
    letter-spacing: -0.005em;
  }}
  .card-body p {{
    margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--text);
  }}

  /* ── Visuals (per-threat) ───────────────────────────── */
  .visual {{
    width: 100%; display: flex; align-items: center; justify-content: center;
    color: var(--text);
  }}
  .visual-glyphs {{ gap: 8px; flex-wrap: wrap; }}
  .glyph-tile {{
    display: flex; flex-direction: column; align-items: center;
    padding: 6px 10px; border-radius: 8px;
    background: var(--danger); color: #fff;
    box-shadow: 0 1px 2px rgba(0,0,0,0.15);
  }}
  .glyph-char {{
    font-family: "Plus Jakarta Sans", ui-sans-serif, sans-serif;
    font-size: 32px; font-weight: 800; line-height: 1; letter-spacing: 0;
  }}
  .glyph-cp {{
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 9.5px; opacity: 0.85; margin-top: 4px; letter-spacing: 0.02em;
  }}

  .visual-mono code {{
    font-family: "JetBrains Mono", ui-monospace, monospace;
    word-break: break-all; text-align: center; font-weight: 600;
  }}
  .visual-mono-lg code {{ font-size: 16px; }}
  .visual-mono-xl code {{ font-size: 28px; font-weight: 700;
    letter-spacing: -0.01em; color: var(--danger); }}
  .threat--warning .visual-mono-xl code {{ color: var(--warning); }}

  .visual-userinfo {{
    flex-direction: column; gap: 6px; text-align: center;
  }}
  .ui-row {{ display: flex; align-items: baseline; gap: 4px;
    color: var(--muted); font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 13px; }}
  .ui-fake {{ text-decoration: line-through; }}
  .ui-at {{
    font-size: 28px; color: var(--danger); font-weight: 800; line-height: 1;
  }}
  .ui-real {{
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 16px; font-weight: 700; color: var(--danger);
    word-break: break-all;
  }}

  /* Typosquat: fake vs. real, stacked, arrow between. */
  .visual-typosquat {{
    flex-direction: column; gap: 4px; text-align: center;
  }}
  .visual-typosquat code {{
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 14px; word-break: break-all;
  }}
  .ts-fake code {{
    color: var(--danger); font-weight: 700;
    text-decoration: line-through; text-decoration-thickness: 2px;
  }}
  .ts-arrow {{ font-size: 16px; color: var(--muted); line-height: 1; }}
  .ts-label {{
    font-size: 10px; color: var(--muted); text-transform: uppercase;
    letter-spacing: 0.08em; margin-top: -2px; margin-bottom: 2px;
  }}
  .ts-real code {{ color: var(--text); font-weight: 600; }}

  /* Subdomain spoof: full host with brand label highlighted, true
     registrable domain underscored. */
  .visual-subdomain {{
    flex-direction: column; gap: 6px; text-align: center;
  }}
  .ss-line code {{
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 13px; word-break: break-all;
  }}
  .ss-brand {{
    background: rgba(220,38,38,0.15); color: var(--danger);
    font-weight: 700; padding: 1px 4px; border-radius: 3px;
    text-decoration: line-through; text-decoration-thickness: 1.5px;
  }}
  .ss-sub {{ color: var(--muted); }}
  .ss-real {{
    color: var(--danger); font-weight: 700;
    text-decoration: underline; text-decoration-thickness: 2px;
    text-underline-offset: 2px;
  }}
  .ss-caption {{
    font-size: 10px; color: var(--muted); text-transform: uppercase;
    letter-spacing: 0.08em;
  }}

  /* ── Actions ──────────────────────────────────────── */
  .actions {{
    display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap;
    margin-top: 4px;
  }}
  .btn {{
    appearance: none; cursor: pointer;
    padding: 11px 20px; border-radius: 10px; font-size: 14px;
    font-weight: 600; text-decoration: none;
    border: 1px solid var(--border); background: var(--surface);
    color: var(--text); transition: filter 0.1s ease, transform 0.05s ease;
  }}
  .btn:hover {{ filter: brightness(1.05); }}
  .btn:active {{ transform: translateY(1px); }}
  .btn-cancel {{ background: var(--surface); }}
  .btn-danger {{
    background: var(--danger); border-color: var(--danger); color: #fff;
  }}

  .footer {{
    margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border);
    font-size: 12px; color: var(--muted); line-height: 1.5;
  }}

  /* ── Responsive ───────────────────────────────────── */
  @media (max-width: 540px) {{
    .card.threat {{ grid-template-columns: 1fr; }}
    .card-visual {{ min-height: 80px; }}
    .hero {{ padding: 22px; }}
  }}
</style>
</head>
<body>
  <main class="wrap">
    <section class="hero severity-{severity_top}" role="alertdialog"
             aria-labelledby="title">
      <div class="hero-head">
        <div class="hero-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>
        <h1 id="title">{title_text}</h1>
      </div>
      <p class="lead">{lead_text}</p>

      <div class="url-box">{url_pretty}</div>

      <div class="threats">{cards_html}</div>

      <div class="actions">
        <button class="btn btn-cancel" onclick="window.history.length>1?window.history.back():window.close()">
          {btn_cancel}
        </button>
        <a class="btn btn-danger" href="{safe_url}" rel="noopener noreferrer">
          {btn_continue}
        </a>
      </div>

      <p class="footer">{footer_text}</p>
    </section>
  </main>
</body>
</html>"""


@router.get("/safe-link")
def safe_link(url: str, locale: str = Depends(get_locale)):
    """Render the interstitial — but only when at least one threat is
    detected. If the URL is clean, we 302 to the destination directly:
    the user wanted to go there, and showing a fake warning would
    desensitize them to the real ones. Refuses anything that isn't
    http(s) up front."""
    if not url or len(url) > 4096:
        raise HTTPException(400, tr("safe_link.url_missing", locale))
    parsed = urlparse(url)
    if parsed.scheme.lower() not in ("http", "https"):
        raise HTTPException(400, tr("safe_link.scheme_unsupported", locale, scheme=parsed.scheme))
    if not parsed.hostname:
        raise HTTPException(400, tr("safe_link.url_malformed", locale))

    if not analyze(url, locale):
        return RedirectResponse(url, status_code=302)

    return HTMLResponse(render_page(url, locale))

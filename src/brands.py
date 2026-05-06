"""
Curated list of brands frequently impersonated in phishing emails.

This list powers two detections in `src/safe_link.py`:

  1. **Typosquatting** — `paypa1.com`, `arnazon.com`, `googel.com` —
     the registrable domain has a tiny edit distance from a real brand.
  2. **Subdomain spoofing** — `paypal.com.evil.com` — the brand name
     appears as a subdomain even though the registrable domain belongs
     to someone else.

The list is intentionally small (~80 entries) and curated for FR + EU
users:

  • Tech / SaaS giants targeted globally (Microsoft, Google, Apple,
    Meta, Amazon, …).
  • Banks operating in France.
  • Public services (impots, ameli, …) — heavily targeted by
    "remboursement", "amende" and "compte bloqué" scams.
  • Telco / utilities (Orange, Free, EDF, …).
  • Major e-commerce / classifieds (Vinted, Leboncoin, Amazon).
  • Logistics (Chronopost, Colissimo, DHL, FedEx, UPS) — package
    notification scams are extremely common.
  • Crypto (Binance, Coinbase, Kraken).

Maintenance: review every 6 months. PRs welcome to add regional
brands. Each entry must be the canonical registrable domain — NOT a
subdomain (so `paypal.com`, NOT `www.paypal.com`).

Frontend mirror: `frontend/api.js` keeps an identical list inlined.
Update both together — there is a comment in api.js calling this file
out as the source of truth.
"""

from __future__ import annotations


BRANDS: frozenset[str] = frozenset({
    # ── Tech / global SaaS ──────────────────────────────────────────────
    "paypal.com", "google.com", "microsoft.com", "amazon.com",
    "apple.com", "icloud.com",
    "facebook.com", "instagram.com", "linkedin.com", "whatsapp.com",
    "twitter.com", "x.com", "tiktok.com",
    "netflix.com", "spotify.com", "dropbox.com", "adobe.com",
    "github.com", "openai.com", "chatgpt.com", "anthropic.com",

    # ── E-commerce / classifieds ────────────────────────────────────────
    "ebay.com", "amazon.fr", "leboncoin.fr", "vinted.fr",
    "fnac.com", "darty.com", "cdiscount.com", "zalando.fr",
    "aliexpress.com", "shein.com",

    # ── FR — banques ────────────────────────────────────────────────────
    "bnpparibas.fr", "credit-agricole.fr", "societegenerale.fr",
    "lcl.fr", "banquepostale.fr", "boursorama.com", "fortuneo.fr",
    "creditmutuel.fr", "caisse-epargne.fr", "labanquepostale.fr",
    "hellobank.fr", "n26.com", "revolut.com", "monabanq.com",
    "nickel.eu", "qonto.com",

    # ── FR — services publics (très visés) ──────────────────────────────
    "ameli.fr", "impots.gouv.fr", "caf.fr", "pole-emploi.fr",
    "francetravail.fr", "service-public.fr", "ants.gouv.fr",
    "secu-independants.fr", "info-coronavirus.gouv.fr",
    "demarches-simplifiees.fr", "msa.fr",

    # ── FR — telco / utilities ──────────────────────────────────────────
    "orange.fr", "free.fr", "sfr.fr", "bouyguestelecom.fr",
    "edf.fr", "engie.fr", "totalenergies.fr",

    # ── Logistique (scams "votre colis attend") ────────────────────────
    "laposte.fr", "colissimo.fr", "chronopost.fr", "mondialrelay.fr",
    "ups.com", "dhl.com", "fedex.com", "tnt.com", "dpd.fr",
    "gls-france.com", "amazonlogistics.fr",

    # ── Crypto ─────────────────────────────────────────────────────────
    "binance.com", "coinbase.com", "kraken.com", "ledger.com",
    "metamask.io", "bitstamp.net",
})


# Brand "root" tokens for subdomain spoof detection.
# `paypal.com` → root = `paypal`. We compare `host.subdomain` parts
# against this set. Built once at import.
BRAND_ROOTS: frozenset[str] = frozenset(
    domain.split(".", 1)[0] for domain in BRANDS
)


# eTLD entries longer than 1 segment that we need to handle to compute
# the registrable domain correctly. Without these, `impots.gouv.fr`
# would be mis-extracted as `gouv.fr` (which IS in the gov-suffix
# bucket but not a real registrable). Limited to the suffixes likely
# to appear in our brand list — full PSL is overkill here.
MULTI_PART_TLDS: frozenset[str] = frozenset({
    "co.uk", "co.jp", "co.kr", "co.nz", "co.za", "co.in", "co.id",
    "com.au", "com.br", "com.cn", "com.fr", "com.mx", "com.tr",
    "ac.uk", "gov.uk", "org.uk", "ne.jp", "or.jp",
    "gouv.fr", "asso.fr", "tm.fr",
})


def registrable(host: str) -> str:
    """Return the eTLD+1 (the "registrable domain") of `host`. Strips
    any subdomain. Falls back to the input if the host has < 2 dots.

    Examples:
      paypal.com               → paypal.com
      www.paypal.com           → paypal.com
      foo.bar.impots.gouv.fr   → impots.gouv.fr
      foo.bar.example.co.uk    → example.co.uk
    """
    if not host:
        return ""
    parts = host.lower().rstrip(".").split(".")
    if len(parts) < 2:
        return host.lower()
    last_two = ".".join(parts[-2:])
    if last_two in MULTI_PART_TLDS and len(parts) >= 3:
        return ".".join(parts[-3:])
    return last_two


def subdomain(host: str) -> str:
    """Return everything before the registrable domain. Empty string
    when `host` IS the registrable. Always lowercased."""
    host = (host or "").lower().rstrip(".")
    reg = registrable(host)
    if host == reg or not reg:
        return ""
    if not host.endswith("." + reg):
        return ""
    return host[: -(len(reg) + 1)]

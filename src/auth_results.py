"""
Authentication-Results / Received-SPF parser.

The receiving IMAP server stamps every incoming email with one or more
`Authentication-Results:` headers (RFC 8601) summarising what each
authentication mechanism — SPF, DKIM, DMARC — concluded about the
message. Lull Mail surfaces those results as colour-coded badges in
the read pane so the user can spot a sender that lies about its
identity (the bog-standard "AppleID" or "Banque" phishing email).

Trust model
-----------
We only trust the LAST `Authentication-Results` header. RFC 8601
specifies that headers must be added by the receiving MTA at the top
of the message, so the bottom-most one is the closest to the actual
delivery. A previous hop's "pass" can be replayed by an attacker, so
we ignore it. In practice, mail providers (Gmail, Outlook, OVH, …)
add a single header from their inbound MTA — the simple case.

What we extract
---------------
For each of `spf`, `dkim`, `dmarc` we report one of:
  • "pass"     — authentication succeeded
  • "fail"     — authentication failed (very likely spoofed)
  • "softfail" — SPF only: the domain explicitly says "probably
                 spoofed but I'm not sure"
  • "neutral"  — explicitly neutral verdict
  • "none"     — no policy published (DMARC) / no record (SPF)
  • "policy"   — DMARC quarantined/rejected at policy time
  • None       — not present in the headers

The frontend collapses these into a single overall colour:
  green  → all three pass
  red    → any fail
  amber  → mixed (some pass, some none)
  grey   → no Authentication-Results header at all
"""

from __future__ import annotations

import re
from typing import Dict, Iterable, List, Optional


# Match `mech=verdict` allowing whitespace, where mech is one of our
# three targets and verdict is the bare word followed by either
# whitespace, semicolon, end-of-string, or a comment in parens.
_MECH_RE = re.compile(
    r"\b(spf|dkim|dmarc)\s*=\s*([a-z]+)\b",
    re.IGNORECASE,
)


def _parse_one(header_value: str) -> Dict[str, Optional[str]]:
    """Pull out spf/dkim/dmarc verdicts from a single header value.
    A header may carry multiple results separated by `;` (RFC 8601);
    we keep the first verdict for each mechanism since that's the
    one the MTA decided to emit first."""
    out: Dict[str, Optional[str]] = {"spf": None, "dkim": None, "dmarc": None}
    if not header_value:
        return out
    for match in _MECH_RE.finditer(header_value):
        mech = match.group(1).lower()
        verdict = match.group(2).lower()
        if mech in out and out[mech] is None:
            out[mech] = verdict
    return out


def parse(headers: Iterable[str]) -> Dict[str, Optional[str]]:
    """Parse a list of `Authentication-Results` header values (in the
    order returned by `Message.get_all('Authentication-Results')`).
    Returns a dict with `spf`, `dkim`, `dmarc` keys.

    We trust ONLY the last header — see module docstring. An empty or
    None input returns the all-None dict so the frontend can render the
    grey "non vérifié" badge.
    """
    result: Dict[str, Optional[str]] = {"spf": None, "dkim": None, "dmarc": None}
    if not headers:
        return result
    items = [h for h in headers if h]
    if not items:
        return result
    return _parse_one(items[-1])


def parse_received_spf(header_value: Optional[str]) -> Optional[str]:
    """A common fallback when no Authentication-Results header is
    present: the SPF check sometimes lands in a dedicated
    `Received-SPF:` header. Returns the SPF verdict or None."""
    if not header_value:
        return None
    # Format: "pass (domain of sender designates …)" — verdict is the
    # very first word.
    first = header_value.strip().split(None, 1)[0].lower().rstrip(":")
    if first in {"pass", "fail", "softfail", "neutral", "none", "policy"}:
        return first
    return None


def parse_email(msg) -> Dict[str, Optional[str]]:
    """Convenience wrapper: takes an `email.message.Message` instance
    and pulls Authentication-Results + Received-SPF in one go.

    `Received-SPF` is only consulted when the Authentication-Results
    header didn't yield an SPF verdict — most MTAs emit both, and we
    trust Authentication-Results more (machine-readable, designed for
    this purpose)."""
    ar_values = msg.get_all("Authentication-Results") or []
    result = parse(ar_values)
    if result["spf"] is None:
        result["spf"] = parse_received_spf(msg.get("Received-SPF"))
    return result


def overall(results: Dict[str, Optional[str]]) -> str:
    """Roll up the three verdicts into a single overall status — used
    by the frontend to pick a single colour for the badge.

    Returns one of: "pass" / "fail" / "warn" / "unknown".
    """
    verdicts = [v for v in (results or {}).values() if v]
    if not verdicts:
        return "unknown"
    if any(v in ("fail", "policy") for v in verdicts):
        return "fail"
    if all(v == "pass" for v in verdicts):
        return "pass"
    if any(v == "softfail" for v in verdicts):
        return "fail"
    # mix of pass / none / neutral — partial coverage
    return "warn"

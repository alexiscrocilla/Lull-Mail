import logging
from typing import Dict

import requests

logger = logging.getLogger(__name__)

# ntfy priority 1 (min) … 5 (urgent)
_PRIORITY = {10: 5, 9: 5, 8: 4, 7: 4, 6: 3, 5: 3, 4: 2, 3: 2, 2: 1, 1: 1}


def _sender_name(raw: str) -> str:
    """Extract display name from a From header, falling back to the address."""
    if not raw:
        return "Inconnu"
    if "<" in raw:
        name = raw.split("<")[0].strip().strip('"').strip("'")
        if name:
            return name
        addr = raw.split("<")[1].rstrip(">").strip()
        return addr
    return raw.strip()


def send(email_data: Dict, server: str, topic: str) -> bool:
    score      = email_data.get("importance_score", 0)
    category   = email_data.get("category", "other")
    subject    = (email_data.get("subject") or "(Sans objet)").strip()
    sender_raw = email_data.get("sender", "")
    summary    = (email_data.get("summary") or "").strip()
    account    = email_data.get("account_email", "")
    needs_reply= bool(email_data.get("needs_reply"))

    sender_name = _sender_name(sender_raw)

    # ── Title: "Sender — Subject" ─────────────────────────────────
    subject_short = subject[:60] + ("…" if len(subject) > 60 else "")
    title = f"{sender_name} — {subject_short}"

    # ── Body: summary first, then account + reply flag ────────────
    body_parts = []
    if summary:
        body_parts.append(summary[:300] + ("…" if len(summary) > 300 else ""))
    footer = account
    if needs_reply:
        footer += " — réponse attendue"
    body_parts.append(footer)
    body = "\n\n".join(body_parts)

    url = f"{server.rstrip('/')}/{topic}"
    try:
        resp = requests.post(
            url,
            data=body.encode("utf-8"),
            headers={
                "Title":        title.encode("utf-8"),
                "Priority":     str(_PRIORITY.get(score, 3)),
                "Content-Type": "text/plain; charset=utf-8",
            },
            timeout=10,
        )
        resp.raise_for_status()
        logger.info(f"Notification envoyée : {sender_name} — {subject[:40]}")
        return True
    except Exception as e:
        logger.error(f"Erreur notification ntfy : {e}")
        return False

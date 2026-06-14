"""Parse a Gmail-style search query into structured filters.

Port of cloudflare/agentic-inbox ``app/lib/search-parser.ts`` to Python.

Supported operators::

    from:user@example.com     filter by sender
    to:user@example.com       filter by recipient
    subject:hello             filter by subject
    in:inbox / in:sent        filter by folder
    is:unread / is:read       filter by read status
    is:starred / is:unstarred filter by starred status
    has:attachment            filter by attachment presence
    before:2025-01-01         emails on/before a date
    after:2025-01-01          emails on/after a date

Quoted values are supported: ``from:"John Doe" subject:"Re: Hello"``.
Everything that isn't an operator becomes the free-text ``query``.
"""

import re
from datetime import datetime
from typing import Optional

# operator:value  OR  operator:"quoted value"
_OP = re.compile(
    r'\b(from|to|subject|in|is|has|before|after):(?:"([^"]*)"|(\S+))',
    re.IGNORECASE,
)


def parse_search_query(text: str) -> dict:
    out = {
        "query": "",
        "from": None,
        "to": None,
        "subject": None,
        "folder": None,
        "is_read": None,
        "is_starred": None,
        "has_attachment": None,
        "date_start": None,
        "date_end": None,
    }
    text = text or ""
    matches = list(_OP.finditer(text))

    remaining = text
    for m in matches:
        remaining = remaining.replace(m.group(0), "", 1)
        op = m.group(1).lower()
        val = m.group(2) if m.group(2) is not None else m.group(3)
        if op == "from":
            out["from"] = val
        elif op == "to":
            out["to"] = val
        elif op == "subject":
            out["subject"] = val
        elif op == "in":
            out["folder"] = val.lower()
        elif op == "is":
            v = val.lower()
            if v in ("unread", "read"):
                out["is_read"] = (v == "read")
            elif v in ("starred", "unstarred"):
                out["is_starred"] = (v == "starred")
        elif op == "has":
            if val.lower() == "attachment":
                out["has_attachment"] = True
        elif op == "before":
            out["date_end"] = _norm_date(val)
        elif op == "after":
            out["date_start"] = _norm_date(val)

    out["query"] = re.sub(r"\s+", " ", remaining).strip()
    return out


def _norm_date(value: str) -> Optional[str]:
    """Normalise a date string to ISO (YYYY-MM-DD). Accepts common
    separators; returns None on an unparseable value (the filter is then
    simply dropped rather than erroring the whole search)."""
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            continue
    return None

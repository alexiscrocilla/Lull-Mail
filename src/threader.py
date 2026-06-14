"""Conversation threading — resolve a stable ``thread_id`` for each email.

Modelled on cloudflare/agentic-inbox's threading (``workers/durableObject``):
primary key on RFC 2822 ``Message-ID`` / ``In-Reply-To`` / ``References``,
with a normalised-subject fallback so a reply that lost its threading
headers still lands in the right conversation.
"""

import re
from datetime import datetime, timedelta, timezone

# Strip leading reply/forward prefixes (FR + EN), possibly repeated:
#   "Re: Fwd: TR: hello" -> "hello"
_RE_PREFIX = re.compile(r"^\s*(re|ref|fwd?|fw|tr|rép|rep|aw)\s*:\s*", re.IGNORECASE)


def normalize_subject(subject: str) -> str:
    """Lowercased subject with every leading Re:/Fwd:/TR: prefix removed."""
    s = subject or ""
    while True:
        s2 = _RE_PREFIX.sub("", s)
        if s2 == s:
            break
        s = s2
    return s.strip().lower()


def resolve_thread_id(con, *, message_id, in_reply_to, references,
                      norm_subject, account, date_iso=None):
    """Return the thread_id this message belongs to.

    ``con`` is an open sqlite connection (so the lookup runs inside the
    same transaction as the INSERT). Resolution order:
      1. direct parent via In-Reply-To
      2. first Message-ID in the References chain
      3. fallback: same account + same normalised subject, within 30 days
         of this message's date (``date_iso``) — bounds an over-eager match
         on a generic subject reused years apart
      4. new thread → the message is its own root
    """
    if in_reply_to:
        row = con.execute(
            "SELECT thread_id FROM emails WHERE message_id = ?", (in_reply_to,)
        ).fetchone()
        if row and row["thread_id"]:
            return row["thread_id"]

    if references:
        first = references.split()[0]
        row = con.execute(
            "SELECT thread_id FROM emails WHERE message_id = ?", (first,)
        ).fetchone()
        if row and row["thread_id"]:
            return row["thread_id"]
        return first

    if norm_subject:
        # Fetch same-subject candidates and compare ACTUAL INSTANTS in Python.
        # date_received_iso is tz-aware (offsets vary by sender), so a SQL
        # lexicographic string compare would order by the offset suffix, not
        # by true chronology — wrong across timezones. We parse to aware
        # datetimes and bound a 30-day window before this message's date.
        rows = con.execute(
            "SELECT thread_id, date_received_iso FROM emails "
            "WHERE account_email = ? AND normalized_subject = ? "
            "AND thread_id IS NOT NULL "
            "ORDER BY COALESCE(date_received_iso, '0000') DESC LIMIT 50",
            (account, norm_subject),
        ).fetchall()
        base = _parse_aware(date_iso)
        best = None  # (instant, thread_id)
        for r in rows:
            if not r["thread_id"]:
                continue
            if base is None:
                # No date to bound against → first same-subject match wins.
                return r["thread_id"]
            cand = _parse_aware(r["date_received_iso"])
            if cand is None:
                continue
            # Candidate must be at/before this message and within 30 days.
            if cand <= base and (base - cand) <= timedelta(days=30):
                if best is None or cand > best[0]:
                    best = (cand, r["thread_id"])
        if best is not None:
            return best[1]

    return message_id


def _parse_aware(iso):
    """Parse an ISO timestamp to a timezone-aware datetime in UTC, or None."""
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

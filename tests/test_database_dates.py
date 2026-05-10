"""
Date ordering — `date_received` is an RFC 2822 string, sorting it as
text ranks by weekday name first ("W" > "S" > "M" > "F"), which
silently hides recent mail. The schema now stores a parallel ISO 8601
column `date_received_iso`, and `get_emails` orders by that column.

This test guards against any future regression where the ORDER BY
slips back to the raw RFC 2822 string.
"""

from __future__ import annotations


def test_get_emails_orders_chronologically(fresh_app):
    """Sun 10 May > Wed 06 May chronologically, but the lex order on the
    raw RFC 2822 prefix ("Sun" vs "Wed") would put Wednesday first.
    The new ORDER BY on date_received_iso must put Sunday first.
    """
    from src import database as db

    # Wednesday — lex prefix "Wed" sorts AFTER "Sun" alphabetically,
    # so a string ORDER BY would surface this row first.
    db.insert_email({
        "message_id": "<old-wed@test>",
        "account": "x@y.tld",
        "uid": "1",
        "date_str": "Wed, 06 May 2026 12:00:00 +0200",
    })
    # Sunday — chronologically newer (10 May > 06 May).
    db.insert_email({
        "message_id": "<new-sun@test>",
        "account": "x@y.tld",
        "uid": "2",
        "date_str": "Sun, 10 May 2026 12:00:00 +0200",
    })

    rows = db.get_emails(limit=10)
    assert len(rows) == 2
    # Newer date must come first regardless of weekday-name lex order.
    assert rows[0]["message_id"] == "<new-sun@test>"
    assert rows[1]["message_id"] == "<old-wed@test>"


def test_insert_email_populates_iso_column(fresh_app):
    """The ISO column is computed at INSERT time so existing reads are fast."""
    from src import database as db

    db.insert_email({
        "message_id": "<iso@test>",
        "account": "x@y.tld",
        "uid": "9",
        "date_str": "Mon, 04 May 2026 09:30:00 +0000",
    })
    rows = db.get_emails(limit=10)
    assert rows[0]["message_id"] == "<iso@test>"
    iso = rows[0]["date_received_iso"]
    # Should round-trip through fromisoformat without error.
    from datetime import datetime
    parsed = datetime.fromisoformat(iso)
    assert parsed.year == 2026 and parsed.month == 5 and parsed.day == 4


def test_parse_email_date_accepts_iso_and_rfc2822():
    """The hardened parser must accept both formats — backfill emits ISO,
    new ingests have RFC 2822, and downstream callers must not care."""
    from src import database as db

    iso = db._parse_email_date("2026-05-10T12:00:00+02:00")
    assert iso is not None and iso.year == 2026

    rfc = db._parse_email_date("Sun, 10 May 2026 12:00:00 +0200")
    assert rfc is not None and rfc.day == 10

    assert db._parse_email_date("") is None
    assert db._parse_email_date("not a date at all") is None


def test_backfill_idempotent(fresh_app):
    """Re-running the backfill on a fully-migrated base must update zero rows."""
    from src import database as db

    db.insert_email({
        "message_id": "<bf@test>",
        "account": "x@y.tld",
        "uid": "1",
        "date_str": "Tue, 05 May 2026 08:00:00 +0000",
    })
    with db._conn() as con:
        # First call: nothing to do (insert_email already set the column).
        n1 = db._backfill_date_received_iso(con)
        # Second call: still nothing.
        n2 = db._backfill_date_received_iso(con)
    assert n1 == 0
    assert n2 == 0

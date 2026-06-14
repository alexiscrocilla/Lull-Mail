"""Gmail-style search query parser (src/search_query.py)."""

from __future__ import annotations

from src.search_query import parse_search_query


def test_plain_text_only():
    p = parse_search_query("facture mars")
    assert p["query"] == "facture mars"
    assert p["from"] is None and p["folder"] is None


def test_from_to_subject():
    p = parse_search_query("from:bob@x.com to:me@y.com subject:devis bonjour")
    assert p["from"] == "bob@x.com"
    assert p["to"] == "me@y.com"
    assert p["subject"] == "devis"
    assert p["query"] == "bonjour"


def test_quoted_values():
    p = parse_search_query('from:"John Doe" subject:"Re: Hello"')
    assert p["from"] == "John Doe"
    assert p["subject"] == "Re: Hello"
    assert p["query"] == ""


def test_is_and_has_flags():
    p = parse_search_query("is:unread has:attachment")
    assert p["is_read"] is False
    assert p["has_attachment"] is True
    p2 = parse_search_query("is:read is:starred")
    assert p2["is_read"] is True
    assert p2["is_starred"] is True
    p3 = parse_search_query("is:unstarred")
    assert p3["is_starred"] is False


def test_in_folder_lowercased():
    assert parse_search_query("in:SENT")["folder"] == "sent"


def test_dates_normalised():
    p = parse_search_query("after:2025-01-01 before:2025/12/31")
    assert p["date_start"] == "2025-01-01"
    assert p["date_end"] == "2025-12-31"


def test_bad_date_dropped():
    assert parse_search_query("before:notadate")["date_end"] is None


def test_empty_input():
    p = parse_search_query("")
    assert p["query"] == "" and all(
        p[k] is None for k in p if k != "query"
    )

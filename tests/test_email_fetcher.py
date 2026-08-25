# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests for email_fetcher resilience, UIDVALIDITY, and MIME parsing."""

from __future__ import annotations

import email
from unittest.mock import MagicMock

import pytest

from src import email_fetcher
from src.attachment_security import AttachmentPolicy


def test_safe_decode_payload():
    # Standard utf-8
    assert email_fetcher._safe_decode_payload(b"Hello world", "utf-8") == "Hello world"
    # Unknown/bogus charset falls back gracefully without raising
    raw = "Café au lait".encode("latin-1")
    res = email_fetcher._safe_decode_payload(raw, "x-non-existent-charset-123")
    assert "Caf" in res
    # Empty or None
    assert email_fetcher._safe_decode_payload(None, "utf-8") == ""
    assert email_fetcher._safe_decode_payload(b"", "utf-8") == ""


def test_extract_uidvalidity_from_select_response():
    conn = MagicMock()
    conn.response.return_value = ("OK", [b"987654321"])
    val = email_fetcher._extract_uidvalidity(conn)
    assert val == "987654321"


def test_extract_uidvalidity_from_untagged_responses():
    conn = MagicMock()
    conn.response.return_value = ("NO", [])
    conn.untagged_responses = {"UIDVALIDITY": [b"12345"]}
    val = email_fetcher._extract_uidvalidity(conn)
    assert val == "12345"


def test_extract_uidvalidity_from_status_command():
    conn = MagicMock()
    conn.response.return_value = ("NO", [])
    conn.untagged_responses = {}
    conn.status.return_value = ("OK", [b'"INBOX" (UIDVALIDITY 456789)'])
    val = email_fetcher._extract_uidvalidity(conn)
    assert val == "456789"


def test_parse_flags():
    seen_flagged = [b"1 (FLAGS (\\Seen \\Flagged) UID 123)"]
    is_read, is_fav = email_fetcher._parse_flags(seen_flagged)
    assert is_read is True
    assert is_fav is True

    unread_unflagged = [b"2 (FLAGS (\\Recent) UID 124)"]
    is_read2, is_fav2 = email_fetcher._parse_flags(unread_unflagged)
    assert is_read2 is False
    assert is_fav2 is False


def test_hydrate_email_bodies(fresh_app, monkeypatch):
    from src import database as db

    db.insert_email({
        "message_id": "<hydrate-test@mail>",
        "account": "user@example.com",
        "uid": "100",
        "subject": "Test Hydrate",
        "date_str": "Mon, 05 May 2026 10:00:00 +0000",
        "body_state": "envelope",
    })

    # Verify initial state is envelope with empty body
    row = db.get_email_by_id(1)
    assert row["body_state"] == "envelope"
    assert row["body_text"] == ""

    # Mock IMAP connection returning full RFC822 message
    fake_conn = MagicMock()
    fake_conn.select.return_value = ("OK", [b"1"])
    sample_mime = (
        b"From: sender@test.com\r\n"
        b"To: user@example.com\r\n"
        b"Subject: Test Hydrate\r\n"
        b"Message-ID: <hydrate-test@mail>\r\n"
        b"Content-Type: text/plain; charset=utf-8\r\n\r\n"
        b"Full hydrated message body content."
    )
    fake_conn.uid.return_value = ("OK", [(b"1 (UID 100)", sample_mime)])

    monkeypatch.setattr(email_fetcher, "_make_connection", lambda acc: fake_conn)

    policy = AttachmentPolicy(enabled=False)
    account = {"email": "user@example.com", "imap_host": "imap.test.com", "imap_port": 993, "username": "u", "password": "p"}
    
    count = email_fetcher.hydrate_email_bodies(account, [{"message_id": "<hydrate-test@mail>", "uid": "100", "int_id": 1}], policy)
    assert count == 1

    updated_row = db.get_email_by_id(1)
    assert updated_row["body_state"] == "full"
    assert "Full hydrated message body content." in updated_row["body_text"]

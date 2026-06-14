"""Conversation threading (src/threader.py + database insert/query)."""

from __future__ import annotations

from src.threader import normalize_subject


# ── normalize_subject ───────────────────────────────────────────────

def test_normalize_strips_single_prefix():
    assert normalize_subject("Re: Hello") == "hello"


def test_normalize_strips_nested_prefixes():
    assert normalize_subject("Re: Fwd: TR: Le Devis") == "le devis"


def test_normalize_no_prefix():
    assert normalize_subject("Facture 2025") == "facture 2025"


def test_normalize_empty():
    assert normalize_subject("") == ""


# ── thread resolution via insert_email ──────────────────────────────

def _ins(db, mid, subject, account="a@x.fr", in_reply_to=None,
         references=None, date="Mon, 05 May 2025 10:00:00 +0000"):
    db.insert_email({
        "message_id": mid, "account": account, "uid": mid,
        "subject": subject, "sender": "s@x.fr", "recipient": account,
        "body_text": "x", "date_str": date,
        "in_reply_to": in_reply_to, "references": references,
    })


def _thread_id(db, mid):
    rows = db.get_emails(limit=100)
    return next(r["thread_id"] for r in rows if r["message_id"] == mid)


def test_reply_inherits_thread_via_in_reply_to(fresh_app):
    from src import database as db
    _ins(db, "<root@t>", "Question")
    _ins(db, "<reply@t>", "Re: Question", in_reply_to="<root@t>")
    assert _thread_id(db, "<reply@t>") == _thread_id(db, "<root@t>")


def test_reply_inherits_thread_via_references(fresh_app):
    from src import database as db
    _ins(db, "<root2@t>", "Sujet")
    _ins(db, "<reply2@t>", "Re: Sujet", references="<root2@t> <other@t>")
    assert _thread_id(db, "<reply2@t>") == _thread_id(db, "<root2@t>")


def test_subject_fallback_groups_when_no_headers(fresh_app):
    from src import database as db
    _ins(db, "<m1@t>", "Projet Alpha")
    _ins(db, "<m2@t>", "RE: Projet Alpha")  # no headers → subject fallback
    assert _thread_id(db, "<m2@t>") == _thread_id(db, "<m1@t>")


def test_unrelated_email_is_own_thread(fresh_app):
    from src import database as db
    _ins(db, "<x@t>", "Topic A")
    _ins(db, "<y@t>", "Topic B")
    assert _thread_id(db, "<x@t>") != _thread_id(db, "<y@t>")


def test_root_thread_id_is_own_message_id(fresh_app):
    from src import database as db
    _ins(db, "<solo@t>", "Hello")
    assert _thread_id(db, "<solo@t>") == "<solo@t>"


# ── get_threads aggregation ─────────────────────────────────────────

def test_get_threads_collapses_and_counts(fresh_app):
    from src import database as db
    _ins(db, "<r@t>", "Devis", date="Mon, 05 May 2025 10:00:00 +0000")
    _ins(db, "<a@t>", "Re: Devis", in_reply_to="<r@t>",
         date="Tue, 06 May 2025 10:00:00 +0000")
    _ins(db, "<b@t>", "Re: Devis", in_reply_to="<r@t>",
         date="Wed, 07 May 2025 10:00:00 +0000")
    threads = db.get_threads(folder="inbox")
    assert len(threads) == 1
    t = threads[0]
    assert t["thread_count"] == 3
    assert t["message_id"] == "<b@t>"          # latest is representative
    assert t["thread_unread"] == 3             # none read yet


def test_subject_fallback_handles_differing_timezones(fresh_app):
    """The 30-day fallback window compares true instants, not ISO strings, so
    a same-subject reply threads even when the offset differs from the root."""
    from src import database as db
    # Root in +09:00, reply in +00:00 a few hours later in UTC, same day.
    _ins(db, "<tzr@t>", "Réunion", date="Mon, 05 May 2025 10:00:00 +0900")
    _ins(db, "<tza@t>", "RE: Réunion", date="Mon, 05 May 2025 10:00:00 +0000")
    assert _thread_id(db, "<tza@t>") == _thread_id(db, "<tzr@t>")


def test_subject_fallback_excludes_outside_window(fresh_app):
    """A same-subject email more than 30 days earlier is NOT merged."""
    from src import database as db
    _ins(db, "<old@t>", "Point hebdo", date="Mon, 06 Jan 2025 10:00:00 +0000")
    _ins(db, "<new@t>", "Point hebdo", date="Mon, 05 May 2025 10:00:00 +0000")
    assert _thread_id(db, "<new@t>") != _thread_id(db, "<old@t>")


def test_thread_endpoint(client):
    from src import database as db
    _ins(db, "<r2@t>", "Sujet")
    _ins(db, "<a2@t>", "Re: Sujet", in_reply_to="<r2@t>")
    rows = db.get_emails(limit=10)
    int_id = next(r["int_id"] for r in rows if r["message_id"] == "<a2@t>")
    resp = client.get(f"/api/emails/{int_id}/thread")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    ids = [m["message_id"] for m in body["messages"]]
    assert ids == ["<r2@t>", "<a2@t>"]         # oldest first

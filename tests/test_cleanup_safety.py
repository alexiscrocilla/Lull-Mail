# SPDX-License-Identifier: GPL-3.0-or-later
"""Lot 2 — the Nettoyage page must not be able to destroy a mailbox, and
everything it does must be undoable.

Covers: the empty-filter guard on every write path, bulk actions routed
through the delayed pending_ops queue, undo restoring the folder each message
actually came from, SQL-variable chunking on big selections, and the
unsubscribe-header backfill (which must not mark a message "checked" when the
connection died).
"""

from __future__ import annotations

import pytest


# ── helpers ───────────────────────────────────────────────────────────────────

def _mail(db, mid, sender="Promo <news@shop.fr>", account="u@x.fr", uid="1",
          folder="inbox", is_read=False):
    db.insert_email({
        "message_id": mid, "account": account, "uid": uid,
        "subject": "hi", "sender": sender, "recipient": account,
        "date_str": "Mon, 05 May 2025 10:00:00 +0000",
        "body_text": "x", "is_read": is_read,
    })
    if folder != "inbox":
        db.update_email_folder(mid, folder)
    return db.get_email_by_message_id(mid) if hasattr(db, "get_email_by_message_id") else None


def _pending_ops(db):
    with db._conn() as con:
        return [dict(r) for r in con.execute(
            "SELECT email_int_id, operation, desired_value, next_attempt_at FROM pending_ops"
        ).fetchall()]


def _folders_of(db):
    with db._conn() as con:
        return {r["message_id"]: r["folder"] for r in
                con.execute("SELECT message_id, folder FROM emails").fetchall()}


# ── empty-filter guard ────────────────────────────────────────────────────────

EMPTY_FILTERS = [
    {},
    {"categories": []},
    {"subject_keywords": []},
    {"account": "u@x.fr"},          # picking a mailbox narrows nothing inside it
    {"older_than_days": 0},         # 0 is "no age constraint" in find_by_filter
]


@pytest.mark.parametrize("flt", EMPTY_FILTERS)
def test_empty_filter_is_refused_everywhere(client, flt):
    """A filter with no clause matches every live message; "delete" on it used
    to trash the whole mailbox behind one confirm."""
    assert client.post("/api/cleanup/rules/preview", json=flt).status_code == 400
    r = client.post("/api/cleanup/rules/run", json={"filter": flt, "action": "delete"})
    assert r.status_code == 400
    assert client.post("/api/cleanup/custom-rules",
                       json={"name": "R", "filter": flt}).status_code == 400


def test_empty_filter_run_touches_nothing(client, fresh_app):
    from src import database as db

    _mail(db, "<keep@x>")
    client.post("/api/cleanup/rules/run", json={"filter": {}, "action": "delete"})
    assert _folders_of(db) == {"<keep@x>": "inbox"}


@pytest.mark.parametrize("flt", [
    {"categories": ["spam"]},
    {"is_read": False},
    {"max_score": 3},
    {"older_than_days": 30},
    {"subject_keywords": ["promo"]},
    {"sender_keywords": ["noreply"]},
])
def test_real_filters_are_accepted(client, flt):
    assert client.post("/api/cleanup/rules/preview", json=flt).status_code == 200
    assert client.post("/api/cleanup/custom-rules",
                       json={"name": "R", "filter": flt}).status_code == 201


def test_patching_a_rule_to_an_empty_filter_is_refused(client):
    created = client.post("/api/cleanup/custom-rules",
                          json={"name": "R", "filter": {"categories": ["spam"]}})
    assert created.status_code == 201
    rule_id = created.json()["id"]
    assert client.patch(f"/api/cleanup/custom-rules/{rule_id}",
                        json={"filter": {}}).status_code == 400
    # A patch that leaves the filter alone still works.
    assert client.patch(f"/api/cleanup/custom-rules/{rule_id}",
                        json={"enabled": False}).status_code == 200


# ── bulk actions are queued and undoable ──────────────────────────────────────

def test_sender_delete_is_queued_with_a_delay_and_undoable(client, fresh_app):
    from src import database as db

    for i in range(3):
        _mail(db, f"<m{i}@x>", uid=str(10 + i))
    db.create_folder("Archive")
    _mail(db, "<arch@x>", uid="20", folder="Archive")

    r = client.post("/api/cleanup/sender",
                    json={"sender": "news@shop.fr", "action": "delete"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["affected"] == 4

    # Everything moved, and the IMAP side is queued rather than already done.
    assert set(_folders_of(db).values()) == {"deleted"}
    ops = _pending_ops(db)
    assert len(ops) == 4 and {o["operation"] for o in ops} == {"trash"}
    assert all(o["next_attempt_at"] for o in ops), "trash ops must be delayed so undo can cancel them"

    # The undo payload remembers where each message actually was.
    folders = body["undo"]["folders"]
    assert sorted(folders) == ["Archive", "inbox"]
    assert len(folders["inbox"]) == 3 and len(folders["Archive"]) == 1

    undo = client.post("/api/cleanup/undo", json={"folders": folders})
    assert undo.status_code == 200 and undo.json()["restored"] == 4
    assert _folders_of(db) == {
        "<m0@x>": "inbox", "<m1@x>": "inbox", "<m2@x>": "inbox", "<arch@x>": "Archive",
    }
    assert _pending_ops(db) == [], "undo must cancel the queued trash, not add to it"


def test_rule_delete_is_undoable(client, fresh_app):
    from src import database as db

    _mail(db, "<a@x>", uid="1")
    _mail(db, "<b@x>", uid="2")
    db.update_email_ai("<a@x>", {"category": "spam", "importance_score": 1})
    db.update_email_ai("<b@x>", {"category": "important", "importance_score": 9})

    r = client.post("/api/cleanup/rules/run",
                    json={"filter": {"categories": ["spam"]}, "action": "delete"})
    assert r.status_code == 200, r.text
    assert r.json()["affected"] == 1
    assert _folders_of(db) == {"<a@x>": "deleted", "<b@x>": "inbox"}

    client.post("/api/cleanup/undo", json=r.json()["undo"])
    assert _folders_of(db) == {"<a@x>": "inbox", "<b@x>": "inbox"}


def test_mark_read_is_undoable(client, fresh_app):
    from src import database as db

    _mail(db, "<a@x>", uid="1", is_read=False)
    _mail(db, "<b@x>", uid="2", is_read=True)

    r = client.post("/api/cleanup/sender",
                    json={"sender": "news@shop.fr", "action": "mark_read"})
    assert r.status_code == 200
    # Only the unread one counted, and only it can be put back.
    assert r.json()["affected"] == 1
    unread_ids = r.json()["undo"]["unread_ids"]
    assert len(unread_ids) == 1
    with db._conn() as con:
        assert [r["is_read"] for r in con.execute(
            "SELECT is_read FROM emails ORDER BY message_id")] == [1, 1]

    client.post("/api/cleanup/undo", json={"unread_ids": unread_ids})
    with db._conn() as con:
        assert [r["is_read"] for r in con.execute(
            "SELECT is_read FROM emails ORDER BY message_id")] == [0, 1]


def test_undo_refuses_an_unknown_folder(client, fresh_app):
    from src import database as db

    _mail(db, "<a@x>", uid="1")
    r = client.post("/api/cleanup/undo", json={"folders": {"../etc": [1]}})
    assert r.status_code == 400
    assert _folders_of(db) == {"<a@x>": "inbox"}


def test_nothing_to_do_returns_no_undo(client, fresh_app):
    from src import database as db

    _mail(db, "<a@x>", uid="1", is_read=True)
    r = client.post("/api/cleanup/sender",
                    json={"sender": "news@shop.fr", "action": "mark_read"})
    assert r.status_code == 200
    assert r.json()["affected"] == 0 and r.json()["undo"] is None


# ── SQL variable chunking ─────────────────────────────────────────────────────

def test_bulk_helpers_survive_more_ids_than_sqlite_allows(fresh_app):
    """SQLite caps bound variables per statement — 999 on plenty of shipped
    builds. A "delete every newsletter" on a real mailbox exceeds that."""
    from src import database as db

    n = 2500
    with db._conn() as con:
        con.executemany(
            "INSERT INTO emails (message_id, account_email, uid, sender, folder, is_read) "
            "VALUES (?, 'u@x.fr', ?, 'a@b.c', 'inbox', 0)",
            [(f"<bulk-{i}@x>", str(i)) for i in range(n)],
        )
        ids = [r["int_id"] for r in con.execute("SELECT int_id FROM emails")]
    assert len(ids) == n

    rows = db.bulk_set_folder_tx(ids, "deleted")
    assert len(rows) == n
    with db._conn() as con:
        assert con.execute(
            "SELECT COUNT(*) FROM emails WHERE folder = 'deleted'").fetchone()[0] == n
        assert con.execute("SELECT COUNT(*) FROM pending_ops").fetchone()[0] == n

    assert len(db.bulk_set_folder_tx(ids, "inbox")) == n
    with db._conn() as con:
        assert con.execute("SELECT COUNT(*) FROM pending_ops").fetchone()[0] == 0

    assert len(db.bulk_set_read_tx(ids, True)) == n
    assert db.bulk_mark_read([f"<bulk-{i}@x>" for i in range(n)], False) == n
    assert db.bulk_set_folder([f"<bulk-{i}@x>" for i in range(n)], "deleted") == n


# ── unsubscribe header backfill ───────────────────────────────────────────────

def _envelope_without_header(db, mid, uid):
    db.insert_email({
        "message_id": mid, "account": "u@x.fr", "uid": uid, "subject": "s",
        "sender": "News <n@shop.fr>", "date_str": "Mon, 05 May 2025 10:00:00 +0000",
    })
    # Older builds left the column NULL; that is what marks a row "never inspected".
    with db._conn() as con:
        con.execute("UPDATE emails SET list_unsubscribe = NULL WHERE message_id = ?", (mid,))


def test_backfill_runs_by_itself_and_finds_links(fresh_app, monkeypatch):
    """The unsubscribe list used to stay empty until the user found a button
    labelled "Analyser les en-têtes" and pressed it."""
    from src import scheduler, database as db, email_fetcher as ef

    _envelope_without_header(db, "<n1@x>", "1")

    def fake_batch(account, uids, on_each=None):
        for uid in uids:
            on_each(uid, True, {
                "list_unsubscribe": "<https://shop.fr/u>",
                "list_unsubscribe_post": "List-Unsubscribe=One-Click",
                "unsubscribe_url": "https://shop.fr/u",
                "unsubscribe_mailto": None,
            })
        return []

    monkeypatch.setattr(ef, "batch_fetch_headers", fake_batch)
    done = scheduler._backfill_unsubscribe_headers(
        [{"email": "u@x.fr"}], deadline=float("inf"))

    assert done == 1
    assert db.count_emails_missing_headers() == 0
    assert db.get_kv("unsubscribe_backfill_done_at")
    senders = db.unsubscribe_senders()
    assert len(senders) == 1 and senders[0]["has_one_click"] is True

    # Second pass is a no-op — it must not re-walk the mailbox every minute.
    monkeypatch.setattr(ef, "batch_fetch_headers",
                        lambda *a, **k: pytest.fail("backfill ran twice"))
    assert scheduler._backfill_unsubscribe_headers(
        [{"email": "u@x.fr"}], deadline=float("inf")) == 0


def test_backfill_connection_failure_does_not_mark_rows_checked(fresh_app, monkeypatch):
    """A dead connection calls back with a bare {"uid": …}. Writing that stamps
    the "checked, no header" sentinel and hides the sender for good."""
    from src import scheduler, database as db, email_fetcher as ef

    _envelope_without_header(db, "<n1@x>", "1")

    def dead_connection(account, uids, on_each=None):
        for uid in uids:
            on_each(uid, False, {"uid": uid})
        return []

    monkeypatch.setattr(ef, "batch_fetch_headers", dead_connection)
    scheduler._backfill_unsubscribe_headers([{"email": "u@x.fr"}], deadline=float("inf"))

    with db._conn() as con:
        assert con.execute(
            "SELECT list_unsubscribe FROM emails WHERE message_id = '<n1@x>'"
        ).fetchone()[0] is None, "a failed fetch must leave the row inspectable"


def test_manual_unsubscribe_can_be_marked_done(client, fresh_app):
    """Senders with no one-click link send the user to their own page, which
    the app cannot observe. Without this they stayed listed as subscribed for
    good and the list never got shorter."""
    from src import database as db

    db.insert_email({
        "message_id": "<n1@x>", "account": "u@x.fr", "uid": "1", "subject": "s",
        "sender": "News <n@shop.fr>", "date_str": "Mon, 05 May 2025 10:00:00 +0000",
        "list_unsubscribe": "<https://shop.fr/u>", "unsubscribe_url": "https://shop.fr/u",
    })
    assert db.unsubscribe_senders()[0]["unsubscribed_at"] is None

    r = client.post("/api/cleanup/unsubscribe/mark", json={"sender": "n@shop.fr"})
    assert r.status_code == 200 and r.json()["marked"] == 1
    assert db.unsubscribe_senders()[0]["unsubscribed_at"] is not None


def test_backfill_skips_accounts_in_backoff(fresh_app, monkeypatch):
    from src import scheduler, database as db, email_fetcher as ef

    _envelope_without_header(db, "<n1@x>", "1")
    db.set_sync_error("u@x.fr", "unreachable", backoff_seconds=3600)

    monkeypatch.setattr(ef, "batch_fetch_headers",
                        lambda *a, **k: pytest.fail("fetched an account in backoff"))
    assert scheduler._backfill_unsubscribe_headers(
        [{"email": "u@x.fr"}], deadline=float("inf")) == 0

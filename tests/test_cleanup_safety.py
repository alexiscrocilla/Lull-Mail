# SPDX-License-Identifier: GPL-3.0-or-later
"""Safety of the cleanup machinery below the suggestion engine.

The guard that stops a card reaching a protected message lives in
tests/test_cleanup_suggestions.py, where the cards are. What is left here is
everything underneath: the bulk writes must survive a selection larger than
SQLite's bound-variable limit, the unsubscribe purge must not move a message
twice, and the unsubscribe-link search must not mark a message "checked"
because the network dropped.

This file used to assert that a rule with an empty filter was refused. That
guard is gone with the rules engine: the apply endpoint takes a card id and
re-runs the card's own query, so there is no user-supplied filter left to be
empty.
"""

from __future__ import annotations

import pytest


# ── helpers ───────────────────────────────────────────────────────────────────

def _mail(db, mid, sender="Promo <news@shop.fr>", account="u@x.fr", uid="1",
          folder="inbox", is_read=False, **extra):
    data = {
        "message_id": mid, "account": account, "uid": uid,
        "subject": "hi", "sender": sender, "recipient": account,
        "date_str": "Mon, 05 May 2025 10:00:00 +0000",
        "body_text": "x", "is_read": is_read,
    }
    data.update(extra)
    db.insert_email(data)
    if folder != "inbox":
        db.update_email_folder(mid, folder)


def _pending_ops(db):
    with db._conn() as con:
        return [dict(r) for r in con.execute(
            "SELECT email_int_id, operation, desired_value, next_attempt_at"
            " FROM pending_ops"
        ).fetchall()]


def _folders_of(db):
    with db._conn() as con:
        return {r["message_id"]: r["folder"] for r in
                con.execute("SELECT message_id, folder FROM emails").fetchall()}


# ── SQL variable chunking ─────────────────────────────────────────────────────

def test_bulk_writes_survive_more_ids_than_sqlite_allows(fresh_app):
    """SQLite stops at 999 bound variables on plenty of shipped builds, and a
    card on a real mailbox selects thousands."""
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
    assert db.mark_sender_unsubscribed("a@b.c") == n


# ── the unsubscribe purge ─────────────────────────────────────────────────────

def test_purge_queues_each_message_once(fresh_app):
    """The purge used to move the rows itself AND add hand-built trash steps
    to the unsubscribe job, so every message went to the server twice."""
    from src import api, database as db

    for i in range(4):
        _mail(db, f"<p{i}@x>", uid=str(i))
    _mail(db, "<other@x>", sender="Someone <s@e.fr>", uid="9")
    db.update_email_folder("<p3@x>", "deleted")

    ids = api._purge_sender("news@shop.fr", None)

    assert len(ids) == 3, "the one already in the trash is not moved again"
    folders = _folders_of(db)
    assert folders["<other@x>"] == "inbox", "a different sender is untouched"
    ops = _pending_ops(db)
    assert len(ops) == 3 and {o["operation"] for o in ops} == {"trash"}
    assert len({o["email_int_id"] for o in ops}) == 3, "one queued move per message"
    assert all(o["next_attempt_at"] for o in ops), "delayed, so it can still be cancelled"


def test_purge_of_an_unknown_sender_does_nothing(fresh_app):
    from src import api, database as db

    _mail(db, "<a@x>")
    assert api._purge_sender("nobody@nowhere.tld", None) == []
    assert _pending_ops(db) == []


# ── unsubscribe stamping ──────────────────────────────────────────────────────

def test_manual_unsubscribe_can_be_marked_done(client, fresh_app):
    """Senders with no one-click link send the user to their own page, which
    the app cannot observe. Without this they stayed listed as subscribed for
    good and the list never got shorter."""
    from src import database as db

    _mail(db, "<n1@x>", sender="News <n@shop.fr>",
          list_unsubscribe="<https://shop.fr/u>", unsubscribe_url="https://shop.fr/u")
    assert db.unsubscribe_senders()[0]["unsubscribed_at"] is None

    r = client.post("/api/cleanup/unsubscribe/mark", json={"sender": "n@shop.fr"})
    assert r.status_code == 200 and r.json()["marked"] == 1
    assert db.unsubscribe_senders()[0]["unsubscribed_at"] is not None


def test_a_stamp_that_fails_is_reported_as_a_failure(fresh_app, monkeypatch):
    """The POST going through while the stamp fails told the user they had
    unsubscribed, then showed the sender again a minute later."""
    from src import api, database as db, email_fetcher as ef

    monkeypatch.setattr(ef, "unsubscribe_http", lambda url, timeout_s=5.0: (True, 200, None))
    monkeypatch.setattr(db, "mark_sender_unsubscribed",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("disk full")))

    job_id = api._make_job("unsubscribe", "unsubscribe:test", 1)
    api._run_unsubscribe_job(job_id, [{"kind": "http_post", "sender": "n@shop.fr",
                                       "url": "https://shop.fr/u", "account": None}])
    job = api._jobs[job_id]
    assert job["failed"] == 1 and job["done"] == 0


# ── unsubscribe header search ─────────────────────────────────────────────────

def _envelope_without_header(db, mid, uid):
    db.insert_email({
        "message_id": mid, "account": "u@x.fr", "uid": uid, "subject": "s",
        "sender": "News <n@shop.fr>", "date_str": "Mon, 05 May 2025 10:00:00 +0000",
    })
    # Older builds left the column NULL; that is what marks a row "never
    # inspected". insert_email writes the empty-string sentinel instead.
    with db._conn() as con:
        con.execute("UPDATE emails SET list_unsubscribe = NULL WHERE message_id = ?", (mid,))


def test_the_search_runs_by_itself_and_finds_links(fresh_app, monkeypatch):
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
                        lambda *a, **k: pytest.fail("the search ran twice"))
    assert scheduler._backfill_unsubscribe_headers(
        [{"email": "u@x.fr"}], deadline=float("inf")) == 0


def test_a_dropped_connection_does_not_mark_rows_checked(fresh_app, monkeypatch):
    """A dead connection calls back with a bare {"uid": …}. Writing that
    stamps the "checked, no header" sentinel and hides the sender for good."""
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


def test_the_search_skips_accounts_in_backoff(fresh_app, monkeypatch):
    from src import scheduler, database as db, email_fetcher as ef

    _envelope_without_header(db, "<n1@x>", "1")
    db.set_sync_error("u@x.fr", "unreachable", backoff_seconds=3600)

    monkeypatch.setattr(ef, "batch_fetch_headers",
                        lambda *a, **k: pytest.fail("fetched an account in backoff"))
    assert scheduler._backfill_unsubscribe_headers(
        [{"email": "u@x.fr"}], deadline=float("inf")) == 0


# ── the rules engine is gone ──────────────────────────────────────────────────

@pytest.mark.parametrize("method,path", [
    ("post", "/api/cleanup/rules/preview"),
    ("post", "/api/cleanup/rules/run"),
    ("post", "/api/cleanup/sender"),
    ("get", "/api/cleanup/senders"),
    ("get", "/api/cleanup/custom-rules"),
    ("post", "/api/cleanup/custom-rules"),
    ("get", "/api/cleanup/unsubscribe/senders"),
    ("get", "/api/cleanup/unsubscribe/stats"),
])
def test_the_retired_routes_are_really_gone(client, method, path):
    r = client.post(path, json={}) if method == "post" else client.get(path)
    assert r.status_code == 404, f"{path} still answers {r.status_code}"


def test_custom_rules_are_kept_but_out_of_the_way(fresh_app):
    """Somebody spent time building those rules. They are renamed rather than
    dropped, and counted so the page can say once that they are gone."""
    from src import database as db, cleanup_suggestions as sug

    with db._conn() as con:
        con.execute("""CREATE TABLE custom_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
            description TEXT DEFAULT '', icon TEXT DEFAULT 'filter',
            accent TEXT DEFAULT '', filter_json TEXT NOT NULL DEFAULT '{}',
            actions_json TEXT NOT NULL DEFAULT '[]', enabled INTEGER DEFAULT 1,
            position INTEGER DEFAULT 0)""")
        con.execute("INSERT INTO custom_rules (name) VALUES ('Promos')")
        con.execute("INSERT INTO custom_rules (name) VALUES ('Recrutement')")

    db.init_db()

    with db._conn() as con:
        tables = {r["name"] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert "custom_rules" not in tables
        assert "custom_rules_removed_v1" in tables
        assert con.execute(
            "SELECT COUNT(*) FROM custom_rules_removed_v1").fetchone()[0] == 2

    assert sug.compute()["migrated_rules"] == 2
    # And it is said once: dismissing it is the same gesture as hiding a card.
    sug.hide_card("migrated_rules")
    assert sug.compute()["migrated_rules"] == 0

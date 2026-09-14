# SPDX-License-Identifier: GPL-3.0-or-later
"""The `sender_addr` generated column and the aggregations built on it.

Grouping by sender moved out of Python and into SQLite. Two things can now go
wrong silently: the SQL canonicalisation can drift from `_canonical_sender`,
splitting one sender into two buckets and making every count wrong; and the
migration can re-run, because generated columns are invisible to the pragma
every other migration in the file uses.
"""

from __future__ import annotations

import random
import string
import time

import pytest


def _sql_addr(db, raw: str) -> str:
    """Evaluate the generated column's expression against one raw header."""
    with db._conn() as con:
        return con.execute(
            f"SELECT {db._SENDER_ADDR_SQL} AS a FROM (SELECT ? AS sender)", (raw,)
        ).fetchone()["a"]


def _mail(db, mid, sender, **kw):
    data = {
        "message_id": mid, "account": kw.pop("account", "u@x.fr"),
        "uid": kw.pop("uid", mid.strip("<>")), "subject": kw.pop("subject", "s"),
        "sender": sender, "recipient": "u@x.fr",
        "date_str": kw.pop("date_str", "Mon, 05 May 2025 10:00:00 +0000"),
    }
    data.update(kw)
    db.insert_email(data)


# ── the SQL must agree with the Python it replaced ───────────────────────────

ADVERSARIAL = [
    '"a>b" <x@y.z>',
    'nested <<a@b>>',
    'name <  >',
    'no closing <angle',
    '',
    '   ',
    '\tTab <t@t.t>\n',
    '<only@brackets.com>',
    'Plain plain@example.com',
    'PLAIN@EXAMPLE.COM',
    '  Spaced Out  <  spaced@example.com  >  ',
    'Two <a@b.c> <d@e.f>',
    '<>',
    '>backwards<',
    'Name Only',
    '"Quoted, Name" <q@n.io>',
]


@pytest.mark.parametrize("raw", ADVERSARIAL)
def test_sql_matches_canonical_sender_on_the_hard_cases(fresh_app, raw):
    from src import database as db
    assert _sql_addr(db, raw) == db._canonical_sender(raw)[1], repr(raw)


def test_sql_matches_canonical_sender_on_realistic_headers(fresh_app):
    """Fuzz over the shapes a From header actually takes. ASCII only: SQLite's
    lower() does not fold non-ASCII, one of the two documented divergences."""
    from src import database as db

    rnd = random.Random(20260913)
    words = ["Le Monde", "Decathlon", "Dr. Lemaire", "Jean-Luc", "ACME, Inc.",
             "no-reply", "Support", "", "  ", "Équipe".encode("ascii", "ignore").decode()]
    locals_ = ["news", "no-reply", "a.b+tag", "Contact", "SUPPORT", "x"]
    domains = ["lemonde.fr", "Shop.example", "mail.acme.co.uk", "EXAMPLE.COM"]

    bad = []
    for _ in range(4000):
        addr = f"{rnd.choice(locals_)}@{rnd.choice(domains)}"
        name = rnd.choice(words)
        raw = rnd.choice([
            f"{name} <{addr}>",
            f'"{name}" <{addr}>',
            f"<{addr}>",
            addr,
            f"  {name}  <  {addr}  >  ",
            f"{name}\t<{addr}>",
        ])
        if _sql_addr(db, raw) != db._canonical_sender(raw)[1]:
            bad.append(raw)
    assert bad == [], f"{len(bad)} divergences, first: {bad[:5]!r}"


def test_the_two_known_divergences_are_still_exactly_these(fresh_app):
    """Pinned, not hidden. If someone makes the SQL backtrack like the regex,
    this test says so instead of the change passing unnoticed."""
    from src import database as db

    # 1. an empty <> before the real address: SQL takes the first '<'.
    raw = "Bounce <> <real@x.fr>"
    assert db._canonical_sender(raw)[1] == "real@x.fr"
    assert _sql_addr(db, raw) == "bounce <> <real@x.fr>"

    # 2. non-ASCII case folding: SQLite's lower() leaves the É alone.
    raw = "Équipe <ÉQUIPE@x.fr>"
    assert db._canonical_sender(raw)[1] == "équipe@x.fr"
    assert _sql_addr(db, raw) == "Équipe@x.fr"

    # What matters in both cases: the header still lands in exactly one
    # bucket, so no count can be wrong — only a label can be ugly.
    with db._conn() as con:
        for i, r in enumerate(("Bounce <> <real@x.fr>", "Équipe <ÉQUIPE@x.fr>")):
            db.insert_email({"message_id": f"<div{i}@x>", "account": "u@x.fr",
                             "uid": str(i), "sender": r,
                             "date_str": "Mon, 05 May 2025 10:00:00 +0000"})
        buckets = con.execute(
            "SELECT COUNT(DISTINCT sender_addr) AS n FROM emails").fetchone()["n"]
    assert buckets == 2, "two headers, two buckets — neither was split"


def test_generated_column_populates_for_existing_and_new_rows(fresh_app):
    from src import database as db

    _mail(db, "<a@x>", '"Le Monde" <NEWSLETTER@LeMonde.FR>')
    _mail(db, "<b@x>", 'bare@example.com')
    with db._conn() as con:
        got = dict(con.execute(
            "SELECT message_id, sender_addr FROM emails ORDER BY int_id").fetchall()
            and {r["message_id"]: r["sender_addr"] for r in
                 con.execute("SELECT message_id, sender_addr FROM emails")})
    assert got == {"<a@x>": "newsletter@lemonde.fr", "<b@x>": "bare@example.com"}


# ── the migration must survive a restart ─────────────────────────────────────

def test_init_db_is_idempotent_with_the_generated_column(fresh_app):
    """PRAGMA table_info does not list generated columns. With the guard every
    other migration uses, the ALTER re-runs and kills init_db on the second
    launch with "duplicate column name"."""
    from src import database as db

    _mail(db, "<a@x>", 'Someone <s@e.fr>')
    for _ in range(3):
        db.init_db()
    with db._conn() as con:
        assert con.execute(
            "SELECT sender_addr FROM emails").fetchone()["sender_addr"] == "s@e.fr"
        names = {r["name"] for r in con.execute("PRAGMA table_xinfo(emails)")}
        assert "sender_addr" in names
        # And it really is hidden from the pragma the old guards use.
        plain = {r["name"] for r in con.execute("PRAGMA table_info(emails)")}
        assert "sender_addr" not in plain


# ── the aggregations keep their contract ─────────────────────────────────────

def test_top_senders_groups_case_insensitively_and_keeps_every_key(fresh_app):
    from src import database as db

    _mail(db, "<a@x>", '"Le Monde" <news@lemonde.fr>', account="u@x.fr")
    _mail(db, "<b@x>", 'Le Monde Matinale <NEWS@LEMONDE.FR>', account="two@x.fr",
          date_str="Tue, 06 May 2025 10:00:00 +0000")
    _mail(db, "<c@x>", 'Someone Else <s@e.fr>')
    db.update_email_ai("<a@x>", {"category": "newsletter", "importance_score": 2})
    db.update_email_ai("<b@x>", {"category": "newsletter", "importance_score": 4})
    db.mark_read("<a@x>")

    rows = db.top_senders(limit=10)
    top = next(r for r in rows if r["email"] == "news@lemonde.fr")
    assert top["total"] == 2 and top["unread"] == 1
    assert top["newsletter"] == 2
    assert top["avg_score"] == 3.0
    # Display name comes from the most recent message.
    assert top["name"] == "Le Monde Matinale"
    assert top["accounts"] == ["two@x.fr", "u@x.fr"]
    assert top["first_seen"] and top["last_seen"] > top["first_seen"]
    for key in ("important", "transactional", "other", "spam", "pending"):
        assert key in top
    assert rows[0]["email"] == "news@lemonde.fr", "ordered by volume"


def test_find_by_sender_matches_the_canonical_address(fresh_app):
    from src import database as db

    _mail(db, "<a@x>", '"Shop" <News@Shop.FR>')
    _mail(db, "<b@x>", 'news@shop.fr')
    _mail(db, "<c@x>", 'other@shop.fr')
    got = db.find_by_sender("NEWS@SHOP.FR")
    assert {r["message_id"] for r in got} == {"<a@x>", "<b@x>"}
    assert all("int_id" in r for r in got), "callers need int_id for the queued path"
    db.update_email_folder("<a@x>", "deleted")
    assert {r["message_id"] for r in db.find_by_sender("news@shop.fr")} == {"<b@x>"}


def test_one_click_comes_from_the_freshest_message(fresh_app):
    """has_one_click used to be true if *any* message ever carried the header,
    while the action read the newest one. A sender whose latest campaign
    dropped it was advertised as one-click, then silently skipped."""
    from src import database as db

    _mail(db, "<old@x>", 'News <n@shop.fr>',
          date_str="Mon, 05 May 2025 10:00:00 +0000",
          list_unsubscribe="<https://shop.fr/u>", unsubscribe_url="https://shop.fr/u",
          list_unsubscribe_post="List-Unsubscribe=One-Click")
    _mail(db, "<new@x>", 'News <n@shop.fr>',
          date_str="Tue, 06 May 2025 10:00:00 +0000",
          list_unsubscribe="<https://shop.fr/u2>", unsubscribe_url="https://shop.fr/u2")

    sender = db.unsubscribe_senders()[0]
    assert sender["has_one_click"] is False
    assert sender["http_url"] == "https://shop.fr/u2", "freshest endpoint"
    target = db.unsubscribe_sender_target("n@shop.fr")
    assert target["one_click"] is False and target["url"] == "https://shop.fr/u2"
    assert sender["has_one_click"] == target["one_click"], "list and action must agree"


def test_agent_tool_reports_one_click(fresh_app):
    """agent_tools read `one_click` while the DB emits `has_one_click`, so the
    tool told the assistant no sender in the mailbox was one-click."""
    from src import database as db, agent_tools

    _mail(db, "<a@x>", 'News <n@shop.fr>',
          list_unsubscribe="<https://shop.fr/u>", unsubscribe_url="https://shop.fr/u",
          list_unsubscribe_post="List-Unsubscribe=One-Click")
    out = agent_tools.unsubscribe_candidates()
    assert out["senders"][0]["one_click"] is True


def test_mark_sender_unsubscribed_stamps_every_row_including_trash(fresh_app):
    from src import database as db

    _mail(db, "<a@x>", 'News <n@shop.fr>')
    _mail(db, "<b@x>", '"News" <N@Shop.fr>')
    _mail(db, "<c@x>", 'other@shop.fr')
    db.update_email_folder("<b@x>", "deleted")
    assert db.mark_sender_unsubscribed("n@shop.fr") == 2
    with db._conn() as con:
        stamped = {r["message_id"] for r in con.execute(
            "SELECT message_id FROM emails WHERE unsubscribed_at IS NOT NULL")}
    assert stamped == {"<a@x>", "<b@x>"}


def test_count_emails_missing_headers_agrees_with_the_row_query(fresh_app):
    from src import database as db

    for i in range(5):
        _mail(db, f"<m{i}@x>", "n@shop.fr", uid=str(i))
    # insert_email writes the empty-string "checked, no header" sentinel;
    # NULL is what marks a row as never inspected.
    with db._conn() as con:
        con.execute("UPDATE emails SET list_unsubscribe = NULL WHERE uid IN ('0','1','2')")
    assert db.count_emails_missing_headers() == 3
    assert len(db.find_uids_missing_headers()) == 3


# ── and it has to be fast ────────────────────────────────────────────────────

def test_sender_lookups_are_indexed_not_scanned(fresh_app):
    from src import database as db

    n = 20_000
    with db._conn() as con:
        con.executemany(
            "INSERT INTO emails (message_id, account_email, uid, sender, folder, is_read,"
            " date_received_iso) VALUES (?, 'u@x.fr', ?, ?, 'inbox', 0, ?)",
            [(f"<perf-{i}@x>", str(i), f'Name {i % 900} <s{i % 900}@bulk.example>',
              f"2026-01-{(i % 28) + 1:02d}T10:00:00+00:00") for i in range(n)],
        )
    with db._conn() as con:
        plan = " ".join(r[3] for r in con.execute(
            "EXPLAIN QUERY PLAN SELECT int_id FROM emails"
            " WHERE folder != 'deleted' AND sender_addr = 's1@bulk.example'"))
    # Any index whose leading column is sender_addr will do; today that is
    # idx_emails_unsub_sender_acc, which also answers after_unsub. What must
    # never come back is the table scan.
    assert "SEARCH" in plan and "sender_addr=?" in plan, plan

    t0 = time.perf_counter()
    rows = db.find_by_sender("s1@bulk.example")
    elapsed = time.perf_counter() - t0
    assert len(rows) == n // 900 + (1 if n % 900 > 1 else 0)
    assert elapsed < 0.5, f"find_by_sender took {elapsed*1000:.0f} ms on {n} rows"

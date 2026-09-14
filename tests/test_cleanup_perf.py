# SPDX-License-Identifier: GPL-3.0-or-later
"""The cleanup aggregates must be answered from a covering partial index.

SQLite matches a partial index by comparing the query's WHERE clause term by
term against the index predicate. Re-spelling or reordering the predicate
drops the index with no error and no warning — the page just gets slow again,
which is the failure this page was rewritten to escape. These tests read the
query plan rather than trusting the SQL to look right.
"""

from __future__ import annotations

import io
import time
from datetime import datetime, timedelta, timezone

import pytest


def _plan(con, sql: str, params=()) -> str:
    return " ".join(str(r[3]) for r in con.execute("EXPLAIN QUERY PLAN " + sql, params))


def _seed(db, n: int = 4000) -> None:
    """A mailbox with the shape the cards care about."""
    now = datetime(2026, 9, 13, tzinfo=timezone.utc)
    rows = []
    for i in range(n):
        cat = ("spam", "newsletter", "important", "other", "transactional")[i % 5]
        rows.append((
            f"<perf-{i}@x>", "u@x.fr", str(i),
            f'Sender {i % 300} <s{i % 300}@bulk.example>',
            cat, i % 3 == 0, "inbox",
            (now - timedelta(days=i % 400)).isoformat(),
            f"https://bulk.example/u/{i % 300}" if cat == "newsletter" else None,
            i % 4 == 0,
        ))
    with db._conn() as con:
        con.executemany(
            "INSERT INTO emails (message_id, account_email, uid, sender, category,"
            " is_read, folder, date_received_iso, unsubscribe_url, local_classified)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
        con.execute("ANALYZE")


def _cutoff(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


# The queries the suggestions endpoint runs, built from the shared predicate
# exactly the way the endpoint builds them.
def _queries(db):
    live = db._CLEANUP_LIVE
    return {
        "Q1_mailbox": (f"SELECT is_read, COUNT(*) AS n FROM emails WHERE {live}"
                       " GROUP BY is_read", ()),
        "Q2_spam": (f"SELECT COUNT(*), COALESCE(SUM(local_classified = 0), 0)"
                    f" FROM emails WHERE {live} AND category = 'spam'", ()),
        "Q3_old_news": (
            f"SELECT COUNT(*), COALESCE(SUM(local_classified = 0), 0) FROM emails"
            f" WHERE {live} AND category = 'newsletter' AND is_read = 1"
            "  AND date_received_iso IS NOT NULL AND date_received_iso < ?"
            "  AND (unsubscribe_url IS NOT NULL OR unsubscribe_mailto IS NOT NULL)",
            (_cutoff(90),)),
        "Q4_old_unread": (
            f"SELECT COUNT(*) FROM emails WHERE {live} AND is_read = 0"
            "  AND date_received_iso IS NOT NULL AND date_received_iso < ?",
            (_cutoff(180),)),
        "Q5_unsub_senders": (
            "SELECT sender_addr, COUNT(*) AS total, MIN(date_received_iso),"
            " MAX(date_received_iso), MAX(unsubscribed_at)"
            f" FROM emails WHERE {live}"
            "   AND (unsubscribe_url IS NOT NULL OR unsubscribe_mailto IS NOT NULL)"
            "   AND sender_addr <> ''"
            " GROUP BY sender_addr HAVING COUNT(*) >= 4 LIMIT 40", ()),
        "Q6_freshest": (
            "SELECT sender, unsubscribe_url FROM emails"
            f" WHERE sender_addr = ? AND {live}"
            "   AND (unsubscribe_url IS NOT NULL OR unsubscribe_mailto IS NOT NULL)"
            " ORDER BY date_received_iso DESC LIMIT 1", ("s1@bulk.example",)),
    }


# Which partial index each aggregate is written for.
INTENDED = {
    "Q1_mailbox": "idx_cleanup_unread",
    "Q2_spam": "idx_cleanup_cat",
    "Q3_old_news": "idx_cleanup_cat",
    "Q4_old_unread": "idx_cleanup_unread",
    "Q5_unsub_senders": "idx_cleanup_unsub",
    "Q6_freshest": "idx_cleanup_unsub",
}


@pytest.mark.parametrize("name", list(INTENDED))
def test_each_aggregate_can_be_answered_by_its_partial_index(fresh_app, name):
    """INDEXED BY makes SQLite prove the partial index is *usable* for the
    query — it raises "no query solution" when the WHERE clause no longer
    implies the index predicate.

    That is the regression worth pinning. Which index the planner actually
    picks depends on the shape of the data (on a mailbox that is mostly
    archived, the partial index is far smaller and wins on its own), so
    asserting the unforced choice would be asserting the cost model.
    """
    from src import database as db

    _seed(db, 2000)
    sql, params = _queries(db)[name]
    forced = sql.replace("FROM emails", f"FROM emails INDEXED BY {INTENDED[name]}", 1)
    with db._conn() as con:
        plan = _plan(con, forced, params)
        con.execute(forced, params).fetchall()
    assert INTENDED[name] in plan, plan


@pytest.mark.parametrize("name", list(INTENDED))
def test_no_aggregate_falls_back_to_a_bare_table_scan(fresh_app, name):
    from src import database as db

    _seed(db, 2000)
    sql, params = _queries(db)[name]
    with db._conn() as con:
        plan = _plan(con, sql, params)
    assert "USING" in plan and "INDEX" in plan, f"{name} scans the table:\n{plan}"


def test_the_predicate_is_written_exactly_once(fresh_app):
    """Two copies of the predicate is how it drifts, and drift is invisible."""
    from src import database as db

    src = io.open(db.__file__, encoding="utf-8").read()
    literal = "folder = 'inbox' AND is_favourite = 0 AND needs_reply = 0"
    assert src.count(literal) == 1, (
        f"the cleanup predicate appears {src.count(literal)} times; it must be "
        "referenced through _CLEANUP_LIVE so the partial indexes keep matching"
    )


def test_dead_indexes_are_gone(fresh_app):
    from src import database as db

    with db._conn() as con:
        names = {r["name"] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index'")}
    # Indexed the raw RFC 2822 header (sorts on the weekday name) and a pair
    # of URL columns no query can seek on.
    assert "idx_emails_date" not in names
    assert "idx_emails_unsub" not in names
    # A strict prefix of idx_emails_unsub_sender_acc, on a VIRTUAL generated
    # column: it answered nothing the wider one cannot and paid to
    # materialise the same expression a second time on every insert.
    assert "idx_emails_sender_addr" not in names
    assert {"idx_cleanup_cat", "idx_cleanup_unread", "idx_cleanup_sender",
            "idx_cleanup_unsub", "idx_emails_unsub_sender_acc"} <= names


def test_analyze_is_recorded_and_does_not_re_run_on_every_launch(fresh_app):
    from src import database as db

    assert db.get_kv("cleanup_analyze_at"), "ANALYZE must be stamped so it does not re-run"
    stamp = db.get_kv("cleanup_analyze_at")
    db.init_db()
    assert db.get_kv("cleanup_analyze_at") == stamp, "ANALYZE re-ran on a later launch"


def test_analyze_re_runs_once_the_mailbox_has_outgrown_its_statistics(fresh_app):
    """It used to run once, ever -- on a first launch that means over an
    empty database, and never again. Every install has since been planning a
    grown mailbox with the statistics of a 0-row one, which is how the
    obvious after_unsub rewrite measures 6.8 ms in a test and 89 seconds on
    a real machine."""
    from src import database as db

    stamp = db.get_kv("cleanup_analyze_at")
    assert db.get_kv("cleanup_analyze_rows") == "0"

    _seed(db, 2000)
    db.init_db()

    assert db.get_kv("cleanup_analyze_at") != stamp, "statistics were never refreshed"
    assert db.get_kv("cleanup_analyze_rows") == "2000"

    # And it settles: a launch that adds nothing does not ANALYZE again.
    stamp2 = db.get_kv("cleanup_analyze_at")
    db.init_db()
    assert db.get_kv("cleanup_analyze_at") == stamp2


def test_the_whole_payload_is_answered_quickly(fresh_app):
    """The page mount used to fire six full-table Python aggregations."""
    from src import database as db

    _seed(db, 4000)
    qs = _queries(db)
    with db._conn() as con:
        t0 = time.perf_counter()
        for sql, params in qs.values():
            con.execute(sql, params).fetchall()
        elapsed = time.perf_counter() - t0
    assert elapsed < 0.5, f"the six aggregates took {elapsed*1000:.0f} ms on 4 000 rows"


# ── after_unsub, the one card whose cost is not bounded by an index alone ──

def _seed_unsub(db, n: int, analyze: bool) -> None:
    """A mailbox where a third of the (sender, account) pairs unsubscribed."""
    now = datetime.now(timezone.utc)
    rows = []
    for i in range(n):
        acct = ("a@x.fr", "b@x.fr", "c@x.fr")[i % 3]
        rows.append((
            f"<unsub-{i}@x>", acct, str(i),
            f"Lettre <news{i % 120}@list.example>", "newsletter", i % 3 == 0,
            "inbox", (now - timedelta(minutes=i * 3)).isoformat(),
            f"https://list.example/u/{i % 120}", 1,
        ))
    with db._conn() as con:
        con.executemany(
            "INSERT INTO emails (message_id, account_email, uid, sender, category,"
            " is_read, folder, date_received_iso, unsubscribe_url, local_classified)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
        con.execute(
            "UPDATE emails SET unsubscribed_at = ? WHERE rowid % 3 = 0"
            "  AND date_received_iso < ?",
            ((now - timedelta(days=30)).isoformat(),
             (now - timedelta(days=30)).isoformat()))
        if analyze:
            con.execute("ANALYZE")


@pytest.mark.parametrize("analyze", [True, False], ids=["fresh-stats", "stale-stats"])
def test_after_unsub_stays_cheap_whatever_the_planner_knows(fresh_app, analyze):
    """The budget has to hold on BOTH sides of the statistics question.

    The obvious rewrite -- joining a grouped derived table -- is 6.8 ms with
    fresh statistics and 89 SECONDS without, and ANALYZE has historically run
    once, over an empty database, at first launch. This test exists so that
    plan cannot be adopted by accident: it is the stale-stats case that
    catches it.
    """
    from src import database as db, cleanup_suggestions as sug

    _seed_unsub(db, 20_000, analyze=analyze)
    where, params = sug._card_where("after_unsub", None)
    sql = f"SELECT COUNT(*) FROM emails WHERE {where}"
    with db._conn() as con:
        t0 = time.perf_counter()
        n = con.execute(sql, params).fetchone()[0]
        elapsed = (time.perf_counter() - t0) * 1000
    assert n > 0, "the fixture produced no candidates, so the timing means nothing"
    assert elapsed < 500, f"after_unsub took {elapsed:.0f} ms with analyze={analyze}"


def test_the_unsubscribe_lookup_has_an_index_to_answer_from(fresh_app):
    from src import database as db, cleanup_suggestions as sug

    _seed_unsub(db, 2000, analyze=True)
    where, params = sug._card_where("after_unsub", None)
    with db._conn() as con:
        plan = _plan(con, f"SELECT COUNT(*) FROM emails WHERE {where}", params)
    # The correlated lookup is per candidate row: without the composite index
    # it re-scans, and the card costs the better part of a second.
    assert "idx_emails_unsub_sender_acc" in plan, plan

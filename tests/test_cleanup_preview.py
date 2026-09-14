# SPDX-License-Identifier: GPL-3.0-or-later
"""The preview, and the promise it has to keep: what the press touches is a
subset of what the preview showed.

That promise is easy to break in a way nothing on screen reports. `select_rows`
is `ORDER BY … LIMIT cap`; append any exclusion to it and the LIMIT backfills
from BELOW the cap, so the press still takes `cap` rows -- some of which were
never in the preview -- and `affected` still equals the number the user was
promised. Every fixture here seeds ABOVE the cap, because that is the only
shape in which the failure can appear.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest


def _seed(db, n, account="perso@x.fr", senders=6, category="spam", days=2):
    now = datetime.now(timezone.utc)
    for i in range(n):
        mid = f"<{account}-{category}-{i}>"
        db.insert_email({
            "message_id": mid, "account": account, "uid": str(i),
            "subject": f"Sujet {i}",
            "sender": f"Expediteur {i % senders} <s{i % senders}@bulk.example>",
            "recipient": account,
            "date_str": (now - timedelta(days=days, minutes=i)).strftime(
                "%a, %d %b %Y %H:%M:%S +0000"),
            "body_text": "corps", "body_html": "<p>corps</p>",
            "is_read": i % 2 == 0,
        })
    with db._conn() as con:
        con.execute("UPDATE emails SET category = ? WHERE account_email = ?",
                    (category, account))


@pytest.fixture
def sug(fresh_app):
    from src import cleanup_suggestions as sug
    return sug


def test_preview_groups_by_sender_and_says_what_it_covers(sug, fresh_app):
    from src import database as db
    _seed(db, 60, senders=6)

    out = sug.preview("spam", limit=60)
    assert out["unit"] == "senders"
    assert len(out["senders"]) == 6
    assert out["matched"] == 60
    # An invariant the client asserts: if these diverge the preview is
    # lying about how much of the press it accounts for.
    assert out["covered"] == out["n"] == 60
    assert sum(s["n"] for s in out["senders"]) == 60
    assert out["per_account"] == {"perso@x.fr": 60}


def test_preview_describes_the_capped_set_not_the_whole_pile(sug, fresh_app):
    from src import database as db
    _seed(db, 60)

    out = sug.preview("spam", limit=20)
    # `matched` is the pile; `n` is what one press takes. Grouping over the
    # whole match would name senders the press will not reach.
    assert out["matched"] == 60
    assert out["covered"] == 20
    assert sum(s["n"] for s in out["senders"]) == 20


def test_no_message_row_leaves_the_server(sug, fresh_app):
    from src import database as db
    _seed(db, 30)

    out = sug.preview("spam", limit=30)
    for row in out["senders"]:
        assert set(row) == {"sender", "name", "account", "n", "unread", "last"}


def test_an_apply_only_touches_rows_the_preview_showed(sug, fresh_app):
    """The failure this whole mechanism exists to prevent."""
    from src import database as db
    _seed(db, 60, senders=6)

    cap = 20
    view = sug.preview("spam", limit=cap)
    shown = {(s["sender"], s["account"]) for s in view["senders"]}
    previewed_ids = {r["int_id"] for r in sug.select_rows(
        "spam", limit=cap, window=view["window"])}

    # The user unticks two of the six senders.
    keep = [{"sender": s["sender"], "account": s["account"]}
            for s in view["senders"][:2]]
    rows = sug.select_rows("spam", limit=cap, window=view["window"],
                           keep_senders=keep)
    touched = {r["int_id"] for r in rows}

    # Without the window, the LIMIT backfills: the press takes 20 rows again,
    # and the ones that replaced the unticked senders were never on screen.
    assert touched <= previewed_ids, "the press reached rows the preview never showed"
    assert len(touched) < cap, "unticking two senders changed nothing"

    with db._conn() as con:
        for int_id in touched:
            row = con.execute(
                "SELECT sender_addr, account_email FROM emails WHERE int_id = ?",
                (int_id,)).fetchone()
            assert (row["sender_addr"], row["account_email"]) in shown
            assert (row["sender_addr"], row["account_email"]) not in {
                (k["sender"], k["account"]) for k in keep}


def test_mail_that_arrives_between_preview_and_press_is_not_touched(sug, fresh_app):
    from src import database as db
    _seed(db, 30)

    view = sug.preview("spam", limit=30)
    before = {r["int_id"] for r in sug.select_rows("spam", limit=30,
                                                    window=view["window"])}

    # Something lands after the user looked.
    now = datetime.now(timezone.utc)
    db.insert_email({
        "message_id": "<late@x>", "account": "perso@x.fr", "uid": "999",
        "subject": "Arrivé après", "sender": "Tard <tard@bulk.example>",
        "recipient": "perso@x.fr",
        "date_str": now.strftime("%a, %d %b %Y %H:%M:%S +0000"),
        "body_text": "b", "body_html": "<p>b</p>",
    })
    with db._conn() as con:
        con.execute("UPDATE emails SET category = 'spam' WHERE message_id = '<late@x>'")

    after = {r["int_id"] for r in sug.select_rows("spam", limit=30,
                                                  window=view["window"])}
    assert after == before, "a message that arrived after the preview was deleted by it"


def test_an_empty_exclusion_excludes_nothing(sug, fresh_app):
    """The degenerate case has to invert safely: the worst a broken client
    can do is delete FEWER messages, never more."""
    from src import database as db
    _seed(db, 30)

    plain = {r["int_id"] for r in sug.select_rows("spam", limit=30)}
    empty = {r["int_id"] for r in sug.select_rows("spam", limit=30,
                                                  window=None, keep_senders=[])}
    assert empty == plain


def test_keeping_every_sender_touches_nothing(sug, fresh_app):
    from src import database as db
    _seed(db, 30, senders=4)

    view = sug.preview("spam", limit=30)
    keep = [{"sender": s["sender"], "account": s["account"]} for s in view["senders"]]
    assert sug.select_rows("spam", limit=30, window=view["window"],
                           keep_senders=keep) == []


def test_the_exclusion_is_per_mailbox_not_per_address(sug, fresh_app):
    from src import database as db
    _seed(db, 20, account="perso@x.fr", senders=2)
    _seed(db, 20, account="boulot@x.fr", senders=2)

    view = sug.preview("spam", limit=40)
    target = view["senders"][0]
    rows = sug.select_rows("spam", limit=40, window=view["window"],
                           keep_senders=[{"sender": target["sender"],
                                          "account": target["account"]}])
    with db._conn() as con:
        kept_elsewhere = 0
        for r in rows:
            row = con.execute(
                "SELECT sender_addr, account_email FROM emails WHERE int_id = ?",
                (r["int_id"],)).fetchone()
            assert not (row["sender_addr"] == target["sender"]
                        and row["account_email"] == target["account"])
            if row["sender_addr"] == target["sender"]:
                kept_elsewhere += 1
    # Sparing "Le Monde" in the personal mailbox must not spare it at work.
    assert kept_elsewhere > 0


def test_a_long_exclusion_list_does_not_blow_the_parameter_limit(sug, fresh_app):
    from src import database as db
    _seed(db, 40, senders=8)

    keep = [{"sender": f"s{i}@bulk.example", "account": "perso@x.fr"}
            for i in range(500)]
    rows = sug.select_rows("spam", limit=40, keep_senders=keep)
    # 8 senders, all named in the first 8 entries: everything is spared.
    assert rows == []


def test_the_preview_endpoint_refuses_a_card_it_cannot_run(client):
    assert client.get("/api/cleanup/preview?card=unsub_bulk").status_code == 400
    assert client.get("/api/cleanup/preview?card=nonsense").status_code == 400


def test_after_unsub_always_asks_before_it_deletes(sug, fresh_app):
    """Floor 5, so it is always far under CONFIRM_ABOVE -- and it is the only
    card with no peek link, so without the dialog there is no way to see what
    it means before pressing it."""
    from src import database as db

    now = datetime.now(timezone.utc)
    for i in range(12):
        mid = f"<au-{i}>"
        db.insert_email({
            "message_id": mid, "account": "perso@x.fr", "uid": str(i),
            "subject": "S", "sender": "Lettre <news@list.example>",
            "recipient": "perso@x.fr",
            "date_str": (now - timedelta(days=i)).strftime("%a, %d %b %Y %H:%M:%S +0000"),
            "body_text": "b", "body_html": "<p>b</p>",
        })
    with db._conn() as con:
        con.execute("UPDATE emails SET unsubscribed_at = ? WHERE message_id = ?",
                    ((now - timedelta(days=30)).isoformat(), "<au-0>"))

    cards = {c["id"]: c for c in sug.compute()["cards"]}
    if "after_unsub" in cards:
        assert cards["after_unsub"]["confirm"] is True

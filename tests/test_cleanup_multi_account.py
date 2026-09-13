# SPDX-License-Identifier: GPL-3.0-or-later
"""Nettoyage suggestions across several mailboxes.

Two things in the suggestion engine were written as if there were one
mailbox: the "still writing after you unsubscribed" card read the
unsubscribe date of any account, and a dismissal was global.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone


def _insert(db, mid, account, sender, days_ago, **extra):
    when = datetime.now(timezone.utc) - timedelta(days=days_ago)
    db.insert_email({
        "message_id": mid, "account": account, "uid": mid.strip("<>"),
        "subject": "Votre sélection", "sender": sender, "recipient": account,
        "date_str": when.strftime("%a, %d %b %Y %H:%M:%S +0000"),
        "body_text": "b", "body_html": "<p>b</p>",
        "list_unsubscribe": "<https://news.example/unsub>",
        **extra,
    })


def _mark_unsubscribed(db, account, sender_addr, days_ago):
    when = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()
    with db._conn() as con:
        con.execute(
            "UPDATE emails SET unsubscribed_at = ? "
            "WHERE account_email = ? AND sender_addr = ?",
            (when, account, sender_addr))


def test_after_unsub_does_not_read_another_accounts_unsubscribe_date(fresh_app):
    from src import database as db, cleanup_suggestions as sug

    sender = "Lettre <news@news.example>"
    # Both mailboxes get the same newsletter.
    for i in range(4):
        _insert(db, f"<perso-{i}>", "perso@x.fr", sender, days_ago=30 - i * 5)
        _insert(db, f"<pro-{i}>", "pro@x.fr", sender, days_ago=30 - i * 5)
    # Only the personal one unsubscribed, a while back.
    _mark_unsubscribed(db, "perso@x.fr", "news@news.example", days_ago=25)

    where_pro, params_pro = sug._card_where("after_unsub", "pro@x.fr")
    with db._conn() as con:
        n_pro = con.execute(
            f"SELECT COUNT(*) FROM emails WHERE {where_pro}", params_pro).fetchone()[0]
        where_perso, params_perso = sug._card_where("after_unsub", "perso@x.fr")
        n_perso = con.execute(
            f"SELECT COUNT(*) FROM emails WHERE {where_perso}", params_perso).fetchone()[0]

    # The work mailbox never unsubscribed. Its mail arriving is the
    # subscription working, not a sender ignoring a request.
    assert n_pro == 0
    # The personal one did, and the sender kept writing.
    assert n_perso > 0


def test_dismissing_a_card_for_one_account_leaves_it_for_the_others(fresh_app):
    from src import cleanup_suggestions as sug

    sug.hide_card("old_news", "perso@x.fr")

    assert "old_news" in sug._hidden_cards("perso@x.fr")
    # A different mailbox is a different pile and a different decision.
    assert "old_news" not in sug._hidden_cards("pro@x.fr")
    assert "old_news" not in sug._hidden_cards(None)


def test_dismissing_while_looking_at_everything_dismisses_everywhere(fresh_app):
    from src import cleanup_suggestions as sug

    sug.hide_card("old_news", None)

    assert "old_news" in sug._hidden_cards(None)
    assert "old_news" in sug._hidden_cards("perso@x.fr")
    assert "old_news" in sug._hidden_cards("pro@x.fr")


def test_a_dismissal_written_before_accounts_existed_stays_global(fresh_app):
    """One release shipped bare card ids in that key."""
    import json
    from src import database as db, cleanup_suggestions as sug

    db.set_kv(sug.HIDDEN_KV_KEY,
              json.dumps({"old_news": datetime.now(timezone.utc).isoformat()}))

    assert "old_news" in sug._hidden_cards(None)
    assert "old_news" in sug._hidden_cards("perso@x.fr")


def test_unhide_clears_every_scope(fresh_app):
    from src import cleanup_suggestions as sug

    sug.hide_card("old_news", "perso@x.fr")
    sug.hide_card("spam", None)
    assert sug.unhide_all() == 2
    assert sug._hidden_cards("perso@x.fr") == {}
    assert sug._hidden_cards(None) == {}

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


def _seed_one_click(db, account, sender, n=8):
    """A one-click-unsubscribable sender writing regularly into `account`."""
    for i in range(n):
        mid = f"<{account}-{sender}-{i}>"
        _insert(db, mid, account, f"Lettre <{sender}>", days_ago=60 - i * 7,
                list_unsubscribe_post="List-Unsubscribe=One-Click")
    with db._conn() as con:
        con.execute(
            "UPDATE emails SET unsubscribe_url = ?, list_unsubscribe_post = ? "
            "WHERE account_email = ?",
            (f"https://news.example/u/{account}", "List-Unsubscribe=One-Click",
             account))


def test_one_newsletter_on_three_accounts_is_three_subscriptions(fresh_app):
    from src import database as db, cleanup_suggestions as sug

    for acct in ("perso@x.fr", "boulot@x.fr", "asso@x.fr"):
        _seed_one_click(db, acct, "news@news.example")

    with db._conn() as con:
        senders = sug._unsub_senders(con, None)

    # One row per (sender, mailbox). Collapsed into one, the page offered a
    # single button, fired one POST with one account's token, and then hid
    # the sender from all three -- two live subscriptions the page had just
    # said were gone.
    assert len(senders) == 3
    assert {s["account"] for s in senders} == {
        "perso@x.fr", "boulot@x.fr", "asso@x.fr"}
    assert {s["email"] for s in senders} == {"news@news.example"}

    payload = sug.compute()
    bulk = next(c for c in payload["cards"] if c["id"] == "unsub_bulk")
    assert bulk["vars"]["n"] == 3
    assert bulk["vars"]["accounts"] == 3
    # The address list is deduplicated for display; the entries are not,
    # because the entries are what the action iterates.
    assert bulk["senders"] == ["news@news.example"]
    assert sorted(e["account"] for e in bulk["entries"]) == [
        "asso@x.fr", "boulot@x.fr", "perso@x.fr"]


def test_the_unsubscribe_link_is_resolved_inside_its_own_mailbox(client, monkeypatch):
    import src.api as api_module
    from src import database as db

    for acct in ("perso@x.fr", "boulot@x.fr"):
        _seed_one_click(db, acct, "news@news.example")

    # The endpoint queues a background job that would POST to the real
    # internet. Capture the plan instead: the plan is what this test is about.
    plans = []
    monkeypatch.setattr(api_module, "_run_unsubscribe_job",
                        lambda job_id, plan: plans.append(plan))

    r = client.post("/api/cleanup/unsubscribe/bulk", json={
        "entries": [
            {"sender": "news@news.example", "account": "perso@x.fr"},
            {"sender": "news@news.example", "account": "boulot@x.fr"},
        ],
    })
    assert r.status_code == 200, r.text
    # Two subscriptions, two POSTs -- not one press that unsubscribes the
    # same mailbox twice.
    assert r.json()["total"] == 2
    assert r.json()["skipped"] == []
    # Each POST goes to the link captured in its own mailbox. Resolved
    # without the account, both would have used whichever mailbox happened
    # to hold the freshest message.
    assert len(plans) == 1
    assert sorted((p["account"], p["url"]) for p in plans[0]) == [
        ("boulot@x.fr", "https://news.example/u/boulot@x.fr"),
        ("perso@x.fr", "https://news.example/u/perso@x.fr"),
    ]


def test_the_suggestions_endpoint_scopes_to_the_account_it_is_given(client):
    from src import database as db

    _seed_one_click(db, "perso@x.fr", "news@news.example")
    _seed_one_click(db, "boulot@x.fr", "autre@news.example")

    r = client.get("/api/cleanup/suggestions?account=perso@x.fr")
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["account"] == "perso@x.fr"
    cards = {c["id"]: c for c in payload["cards"]}
    if "unsub_bulk" in cards:
        assert {e["account"] for e in cards["unsub_bulk"]["entries"]} == {"perso@x.fr"}
    elif "unsub_one" in cards:
        assert cards["unsub_one"]["entries"][0]["account"] == "perso@x.fr"
    else:
        raise AssertionError("no unsubscribe card for the scoped account")

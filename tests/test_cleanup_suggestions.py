# SPDX-License-Identifier: GPL-3.0-or-later
"""The suggestion engine behind the Nettoyage page.

The most important test in this file is the guard one: no card, and no press
of a card's button, may touch a starred message, one flagged as needing a
reply, or anything the user filed away. That is what replaces "refuse a filter
that matches everything" — there is no user-supplied filter any more, so the
safety has to live in what the cards can see at all.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import pytest

NOW = datetime.now(timezone.utc)


def _iso(days_ago: int) -> str:
    return (NOW - timedelta(days=days_ago)).isoformat()


def _insert(db, rows):
    """rows: list of dicts of column -> value."""
    with db._conn() as con:
        for i, r in enumerate(rows):
            cols = {
                "message_id": r.get("message_id", f"<seed-{i}-{id(rows)}@x>"),
                "account_email": r.get("account", "u@x.fr"),
                "uid": r.get("uid", str(9000 + i)),
                "sender": r.get("sender", "News <n@shop.fr>"),
                "category": r.get("category", "other"),
                "is_read": int(r.get("is_read", 0)),
                "is_favourite": int(r.get("is_favourite", 0)),
                "needs_reply": int(r.get("needs_reply", 0)),
                "folder": r.get("folder", "inbox"),
                "date_received_iso": r.get("iso", _iso(1)),
                "unsubscribe_url": r.get("url"),
                "unsubscribe_mailto": r.get("mailto"),
                "list_unsubscribe_post": r.get("post"),
                "unsubscribed_at": r.get("unsubscribed_at"),
                # 0 = the model read it, which is the schema default. Pass 1
                # for the rules-only case, which the engine trusts less.
                "local_classified": int(r.get("local_classified", 0)),
            }
            names = ",".join(cols)
            marks = ",".join("?" for _ in cols)
            con.execute(f"INSERT INTO emails ({names}) VALUES ({marks})",
                        list(cols.values()))


def _cards(payload):
    return {c["id"]: c for c in payload["cards"]}


# ── the guard ────────────────────────────────────────────────────────────────

PROTECTED = [
    ("starred", {"is_favourite": 1}),
    ("needs a reply", {"needs_reply": 1}),
    ("already in the trash", {"folder": "deleted"}),
    ("in Sent", {"folder": "sent"}),
    ("in Drafts", {"folder": "draft"}),
    ("in a folder of their own", {"folder": "Archive"}),
]


@pytest.mark.parametrize("label,attrs", PROTECTED, ids=[p[0] for p in PROTECTED])
def test_no_card_can_see_a_protected_message(fresh_app, label, attrs):
    """Each of these otherwise matches every card. None may be counted."""
    from src import cleanup_suggestions as sug, database as db

    db.create_folder("Archive")
    rows = []
    for i in range(300):
        rows.append({
            "message_id": f"<p{i}@x>", "uid": str(i),
            "category": "spam", "is_read": 1, "iso": _iso(400),
            "url": "https://s.example/u", "unsubscribed_at": _iso(200),
            **attrs,
        })
    _insert(db, rows)

    payload = sug.compute()
    assert payload["cards"] == [], f"a {label} message produced a card"
    for card in sug.APPLIABLE:
        assert sug.select_rows(card) == [], f"{card} would act on a {label} message"


def test_the_guard_is_the_shared_predicate(fresh_app):
    from src import cleanup_suggestions as sug, database as db

    where, _ = sug._card_where("spam", None)
    assert where.startswith(db._CLEANUP_LIVE), where


# ── floors ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("card,floor,attrs", [
    ("spam", 10, {"category": "spam"}),
    ("old_news", 25, {"category": "newsletter", "is_read": 1, "iso": _iso(120),
                      "url": "https://s.example/u"}),
    ("old_unread", 50, {"is_read": 0, "iso": _iso(200)}),
])
def test_a_card_below_its_floor_is_not_offered(fresh_app, card, floor, attrs):
    from src import cleanup_suggestions as sug, database as db

    _insert(db, [{"message_id": f"<u{i}@x>", "uid": str(i), **attrs}
                 for i in range(floor - 1)])
    assert card not in _cards(sug.compute())

    _insert(db, [{"message_id": f"<o{i}@x>", "uid": str(500 + i), **attrs}
                 for i in range(60)])
    assert card in _cards(sug.compute())


def test_an_empty_mailbox_produces_no_cards_and_no_crash(fresh_app):
    """SUM() over zero rows is NULL, not 0."""
    from src import cleanup_suggestions as sug

    payload = sug.compute()
    assert payload["cards"] == [] and payload["more"] == 0
    assert payload["mailbox"] == {"live": 0, "unread": 0}
    assert payload["computed_in_ms"] >= 0


# ── unsubscribe cards ────────────────────────────────────────────────────────

def _newsletter(sender, n, *, one_click, spread_days=90, url="https://s.example/u"):
    return [{
        "message_id": f"<{sender}-{i}@x>", "uid": f"{sender}-{i}",
        "sender": f"{sender.title()} <{sender}@shop.fr>",
        "category": "newsletter", "is_read": 1,
        "iso": _iso(int(i * spread_days / max(n - 1, 1))),
        "url": url,
        "post": "List-Unsubscribe=One-Click" if one_click else None,
    } for i in range(n)]


def test_one_click_senders_become_the_bulk_card(fresh_app):
    from src import cleanup_suggestions as sug, database as db

    _insert(db, _newsletter("alpha", 12, one_click=True))
    _insert(db, _newsletter("beta", 8, one_click=True))
    card = _cards(sug.compute())["unsub_bulk"]
    assert card["vars"]["n"] == 2
    assert set(card["senders"]) == {"alpha@shop.fr", "beta@shop.fr"}
    assert card["confirm"] is True and card["reversible"] is False
    assert card["gain"]["unit"] == "mails_per_year" and card["gain"]["value"] > 0


def test_a_sender_who_barely_writes_is_not_worth_a_decision(fresh_app):
    from src import cleanup_suggestions as sug, database as db

    # 5 messages spread over two years: under the 12-a-year floor.
    _insert(db, [{
        "message_id": f"<slow-{i}@x>", "uid": f"s{i}",
        "sender": "Slow <slow@shop.fr>", "category": "newsletter", "is_read": 1,
        "iso": _iso(i * 140), "url": "https://s.example/u",
        "post": "List-Unsubscribe=One-Click",
    } for i in range(5)])
    assert "unsub_bulk" not in _cards(sug.compute())


def test_an_already_unsubscribed_sender_drops_off_the_card(fresh_app):
    from src import cleanup_suggestions as sug, database as db

    _insert(db, _newsletter("alpha", 12, one_click=True))
    assert "unsub_bulk" in _cards(sug.compute())
    db.mark_sender_unsubscribed("alpha@shop.fr")
    assert "unsub_bulk" not in _cards(sug.compute())


def test_a_sender_without_one_click_gets_the_manual_card_instead(fresh_app):
    from src import cleanup_suggestions as sug, database as db

    _insert(db, _newsletter("gamma", 14, one_click=False))
    cards = _cards(sug.compute())
    assert "unsub_bulk" not in cards
    card = cards["unsub_one"]
    assert card["senders"] == ["gamma@shop.fr"]
    assert card["confirm"] is False
    assert card["peek"]["query"] == "in:inbox from:gamma@shop.fr"


def test_messages_arriving_after_an_unsubscribe_get_their_own_card(fresh_app):
    """Row-derived, this card would match nothing forever: unsubscribed_at is
    stamped on the rows that existed at that instant, and new mail never
    carries it."""
    from src import cleanup_suggestions as sug, database as db

    # Mail that arrived before the unsubscribe…
    _insert(db, [{"message_id": f"<before-{i}@x>", "uid": f"b{i}",
                  "sender": "Delta <delta@shop.fr>", "category": "newsletter",
                  "iso": _iso(30 + i * 5), "url": "https://s.example/u"}
                 for i in range(6)])
    db.mark_sender_unsubscribed("delta@shop.fr")
    with db._conn() as con:
        con.execute("UPDATE emails SET unsubscribed_at = ? WHERE unsubscribed_at IS NOT NULL",
                    (_iso(20),))
    # …and mail that arrived after it.
    _insert(db, [{"message_id": f"<after-{i}@x>", "uid": f"a{i}",
                  "sender": "Delta <delta@shop.fr>", "category": "newsletter",
                  "iso": _iso(i), "url": "https://s.example/u"} for i in range(6)])

    card = _cards(sug.compute())["after_unsub"]
    assert card["vars"]["n"] == 6 and card["verb"] == "trash"

    # Mail from the same calendar day as the unsubscribe stays out: the two
    # timestamps carry different zones and there is no honest ordering inside
    # a day, so the comparison is deliberately conservative.
    _insert(db, [{"message_id": "<sameday@x>", "uid": "sd",
                  "sender": "Delta <delta@shop.fr>", "iso": _iso(20),
                  "url": "https://s.example/u"}])
    assert _cards(sug.compute())["after_unsub"]["vars"]["n"] == 6


# ── ranking ──────────────────────────────────────────────────────────────────

def test_the_score_matches_the_design_table(fresh_app):
    from src import cleanup_suggestions as sug

    # The worked example from the design brief, to two decimals.
    assert round(sug._score(3 * 620, 1.0), 2) == 7.53
    assert round(sug._score(0.3 * 1000, 0.90), 2) == 5.14
    assert round(sug._score(1240, sug._category_confidence(1240, 372)), 2) == 3.67
    assert round(sug._score(340, sug._category_confidence(340, 75)), 2) == 2.75
    # Unsubscribing is weighted three times a deletion, and marking read a
    # third: freeing an arrival beats moving a row, moving a row beats
    # changing a flag.
    assert sug._score(3 * 100, 1.0) > sug._score(100, 1.0) > sug._score(0.3 * 100, 1.0)


def test_manual_unsubscribe_is_discounted_for_leaving_the_app(fresh_app):
    from src import cleanup_suggestions as sug
    assert sug._score(300, 1.0, friction=0.35) < sug._score(300, 1.0)


def test_unsubscribing_outranks_a_bigger_pile_of_spam(fresh_app):
    from src import cleanup_suggestions as sug, database as db

    _insert(db, _newsletter("alpha", 20, one_click=True))
    _insert(db, [{"message_id": f"<sp{i}@x>", "uid": f"sp{i}", "category": "spam",
                  "sender": f"Win{i} <w{i}@prize.biz>", "local_classified": 1}
                 for i in range(120)])
    ids = [c["id"] for c in sug.compute()["cards"]]
    assert ids[0] == "unsub_bulk", ids


def test_at_most_three_cards_and_the_rest_are_counted(fresh_app):
    from src import cleanup_suggestions as sug, database as db

    _insert(db, _newsletter("alpha", 20, one_click=True))
    _insert(db, [{"message_id": f"<sp{i}@x>", "uid": f"sp{i}", "category": "spam",
                  "local_classified": 0} for i in range(300)])
    _insert(db, [{"message_id": f"<on{i}@x>", "uid": f"on{i}",
                  "category": "newsletter", "is_read": 1, "iso": _iso(200),
                  "url": "https://s.example/u", "local_classified": 0}
                 for i in range(300)])
    _insert(db, [{"message_id": f"<ou{i}@x>", "uid": f"ou{i}", "is_read": 0,
                  "iso": _iso(300)} for i in range(300)])

    payload = sug.compute()
    assert len(payload["cards"]) == 3
    assert payload["more"] >= 1
    scores = [c["score"] for c in payload["cards"]]
    assert scores == sorted(scores, reverse=True)


def test_a_rules_only_verdict_is_trusted_less_than_the_model(fresh_app):
    from src import cleanup_suggestions as sug
    assert sug._category_confidence(100, 0) == pytest.approx(0.35)
    assert sug._category_confidence(100, 100) == pytest.approx(0.90)
    assert sug._category_confidence(0, 0) == pytest.approx(0.35)


# ── the cap ──────────────────────────────────────────────────────────────────

def test_a_huge_pile_is_capped_and_says_so(fresh_app):
    from src import cleanup_suggestions as sug, database as db

    _insert(db, [{"message_id": f"<sp{i}@x>", "uid": f"sp{i}", "category": "spam"}
                 for i in range(sug.APPLY_CAP + 250)])
    card = _cards(sug.compute())["spam"]
    assert card["vars"]["n"] == sug.APPLY_CAP
    assert card["vars"]["matched"] == sug.APPLY_CAP + 250
    assert len(sug.select_rows("spam")) == sug.APPLY_CAP


def test_peek_links_use_the_same_cutoff_as_the_count(fresh_app):
    from src import cleanup_suggestions as sug, database as db

    _insert(db, [{"message_id": f"<ou{i}@x>", "uid": f"ou{i}", "is_read": 0,
                  "iso": _iso(300)} for i in range(60)])
    card = _cards(sug.compute())["old_unread"]
    cutoff = sug._cutoff(sug.OLD_UNREAD_DAYS)[:10]
    assert card["peek"]["query"] == f"in:inbox is:unread before:{cutoff}"

    from src.search_query import parse_search_query
    parsed = parse_search_query(card["peek"]["query"])
    assert parsed["folder"] == "inbox" and parsed["is_read"] is False
    assert parsed["date_end"] == cutoff


# ── the endpoints ────────────────────────────────────────────────────────────

def test_apply_acts_on_the_set_it_recounts_not_the_one_you_read(client, fresh_app):
    """Mail arrives between the render and the press. The endpoint takes a
    card id and re-runs its query, so the two can never disagree."""
    from src import database as db, cleanup_suggestions as sug

    _insert(db, [{"message_id": f"<sp{i}@x>", "uid": f"sp{i}", "category": "spam"}
                 for i in range(20)])
    assert _cards(client.get("/api/cleanup/suggestions").json())["spam"]["vars"]["n"] == 20

    _insert(db, [{"message_id": f"<late{i}@x>", "uid": f"l{i}", "category": "spam"}
                 for i in range(5)])
    r = client.post("/api/cleanup/apply", json={"card": "spam"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["affected"] == 25, "acted on the fresh count, not the rendered one"
    # And the response already carries the new state.
    assert "spam" not in _cards(body["suggestions"])


def test_apply_then_undo_puts_everything_back(client, fresh_app):
    from src import database as db

    db.create_folder("Archive")
    _insert(db, [{"message_id": f"<sp{i}@x>", "uid": f"sp{i}", "category": "spam"}
                 for i in range(15)])
    _insert(db, [{"message_id": "<arch@x>", "uid": "arch", "category": "spam",
                  "folder": "Archive"}])

    r = client.post("/api/cleanup/apply", json={"card": "spam"}).json()
    assert r["affected"] == 15, "the archived one is protected"
    with db._conn() as con:
        assert con.execute(
            "SELECT COUNT(*) FROM emails WHERE folder = 'deleted'").fetchone()[0] == 15

    back = client.post("/api/cleanup/undo", json=r["undo"]).json()
    assert back["restored"] == 15
    with db._conn() as con:
        assert con.execute(
            "SELECT COUNT(*) FROM emails WHERE folder = 'inbox'").fetchone()[0] == 15
    assert "spam" in _cards(back["suggestions"]), "the card is back after an undo"


def test_marking_read_is_reversible_and_deletes_nothing(client, fresh_app):
    from src import database as db

    _insert(db, [{"message_id": f"<ou{i}@x>", "uid": f"ou{i}", "is_read": 0,
                  "iso": _iso(300)} for i in range(60)])
    r = client.post("/api/cleanup/apply", json={"card": "old_unread"}).json()
    assert r["affected"] == 60
    with db._conn() as con:
        assert con.execute(
            "SELECT COUNT(*) FROM emails WHERE folder = 'deleted'").fetchone()[0] == 0
        assert con.execute(
            "SELECT COUNT(*) FROM emails WHERE is_read = 1").fetchone()[0] == 60
    client.post("/api/cleanup/undo", json=r["undo"])
    with db._conn() as con:
        assert con.execute(
            "SELECT COUNT(*) FROM emails WHERE is_read = 0").fetchone()[0] == 60


def test_apply_refuses_a_card_it_does_not_know(client, fresh_app):
    for bad in ("unsub_bulk", "everything", "", "../etc"):
        r = client.post("/api/cleanup/apply", json={"card": bad})
        assert r.status_code == 400, bad


def test_the_endpoint_answers_in_one_request(client, fresh_app):
    from src import database as db

    _insert(db, [{"message_id": f"<sp{i}@x>", "uid": f"sp{i}", "category": "spam"}
                 for i in range(30)])
    payload = client.get("/api/cleanup/suggestions").json()
    for key in ("generated_at", "cards", "more", "hidden", "mailbox", "analysing"):
        assert key in payload
    card = _cards(payload)["spam"]
    for key in ("id", "verb", "gain", "vars", "reversible", "confirm", "score"):
        assert key in card
    # No localised text ever crosses the wire: the page composes it from the
    # id and vars, which is how FR/EN parity stays mechanical.
    assert "title" not in card and "body" not in card

"""Server-side search (database.search_emails) driven by the parser."""

from __future__ import annotations

from src.search_query import parse_search_query


def _seed(db):
    db.insert_email({
        "message_id": "<a@t>", "account": "alice@corp.fr", "uid": "1",
        "sender": "Bob <bob@client.com>", "recipient": "alice@corp.fr",
        "subject": "Devis pour le projet", "body_text": "Voici le devis demandé.",
        "date_str": "Mon, 05 May 2025 10:00:00 +0000",
    })
    db.insert_email({
        "message_id": "<b@t>", "account": "alice@corp.fr", "uid": "2",
        "sender": "Newsletter <news@promo.xyz>", "recipient": "alice@corp.fr",
        "subject": "Soldes d'été", "body_text": "Profitez des soldes.",
        "date_str": "Tue, 10 Jun 2025 10:00:00 +0000",
    })
    db.insert_email({
        "message_id": "<c@t>", "account": "perso@gmail.com", "uid": "3",
        "sender": "Bob <bob@client.com>", "recipient": "perso@gmail.com",
        "subject": "Re: Devis", "body_text": "Merci pour le devis.",
        "date_str": "Wed, 11 Jun 2025 10:00:00 +0000",
    })


def test_free_text_matches_subject_and_body(fresh_app):
    from src import database as db
    _seed(db)
    res = db.search_emails(parse_search_query("devis"))
    ids = {r["message_id"] for r in res}
    assert ids == {"<a@t>", "<c@t>"}


def test_from_operator(fresh_app):
    from src import database as db
    _seed(db)
    res = db.search_emails(parse_search_query("from:client.com"))
    assert {r["message_id"] for r in res} == {"<a@t>", "<c@t>"}


def test_account_isolation(fresh_app):
    from src import database as db
    _seed(db)
    res = db.search_emails(parse_search_query("devis"), account="perso@gmail.com")
    assert {r["message_id"] for r in res} == {"<c@t>"}


def test_date_range(fresh_app):
    from src import database as db
    _seed(db)
    res = db.search_emails(parse_search_query("after:2025-06-01"))
    assert {r["message_id"] for r in res} == {"<b@t>", "<c@t>"}


def test_combined_operators(fresh_app):
    from src import database as db
    _seed(db)
    res = db.search_emails(parse_search_query("from:client.com subject:Re"))
    assert {r["message_id"] for r in res} == {"<c@t>"}


def test_in_favourite_virtual_folder(fresh_app):
    from src import database as db
    _seed(db)
    db.set_favourite("<a@t>", True)
    res = db.search_emails(parse_search_query("in:favourite"))
    assert {r["message_id"] for r in res} == {"<a@t>"}


def test_date_end_includes_end_of_day_across_offset(fresh_app):
    """before:<day> must keep a 23:59:59 +02:00 email on that day (the old
    full-ISO string compare dropped it)."""
    from src import database as db
    db.insert_email({
        "message_id": "<eod@t>", "account": "u@x.fr", "uid": "9",
        "subject": "tard", "sender": "a@b.c", "recipient": "u@x.fr",
        "body_text": "x", "date_str": "Sat, 14 Jun 2025 23:59:59 +0200",
    })
    res = db.search_emails(parse_search_query("before:2025-06-14"))
    assert "<eod@t>" in {r["message_id"] for r in res}


def test_search_endpoint_scopes_to_folder(client):
    """A `folder` param scopes results to that folder unless the query already
    carries an explicit in: operator."""
    from src import database as db
    db.insert_email({
        "message_id": "<inb@t>", "account": "u@x.fr", "uid": "1",
        "subject": "rapport", "sender": "a@b.c", "recipient": "u@x.fr",
        "body_text": "x", "date_str": "Mon, 05 May 2025 10:00:00 +0000",
    })
    db.insert_email({
        "message_id": "<snt@t>", "account": "u@x.fr", "uid": "2",
        "subject": "rapport", "sender": "u@x.fr", "recipient": "c@d.e",
        "body_text": "x", "date_str": "Tue, 06 May 2025 10:00:00 +0000",
    })
    db.update_email_folder("<snt@t>", "sent")
    r = client.get("/api/emails/search", params={"q": "rapport", "folder": "inbox"})
    assert {row["message_id"] for row in r.json()["results"]} == {"<inb@t>"}
    # An explicit in: operator wins over the folder scope.
    r2 = client.get("/api/emails/search", params={"q": "rapport in:sent", "folder": "inbox"})
    assert {row["message_id"] for row in r2.json()["results"]} == {"<snt@t>"}


def test_search_endpoint(client):
    """The /api/emails/search endpoint returns {parsed, results}."""
    from src import database as db
    _seed(db)
    r = client.get("/api/emails/search", params={"q": "from:client.com devis"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["parsed"]["from"] == "client.com"
    assert {row["message_id"] for row in body["results"]} == {"<a@t>", "<c@t>"}


# ── the two holes the clickable filters made visible ────────────────────────

def _seed_folder(db, account, folder="inbox", n=3, subject="Sujet"):
    ids = []
    for i in range(n):
        mid = f"<{account}-{folder}-{i}>"
        db.insert_email({
            "message_id": mid, "account": account, "uid": str(abs(hash(mid)) % 9999),
            "subject": f"{subject} {i}", "sender": f"S <s{i}@x.fr>",
            "recipient": account, "date_str": "Mon, 14 Sep 2026 09:00:00 +0000",
            "body_text": "corps", "body_html": "<p>corps</p>",
        })
        ids.append(mid)
    # insert_email always lands in the inbox; the folder is a later move.
    if folder != "inbox":
        with db._conn() as con:
            con.executemany("UPDATE emails SET folder = ? WHERE message_id = ?",
                            [(folder, m) for m in ids])


def test_search_can_reach_the_trash(fresh_app):
    """`in:deleted` is the one folder value the search help taught, and the
    opening `folder != 'deleted'` made it permanently empty."""
    from src import database as db
    from src.search_query import parse_search_query

    _seed_folder(db, "a@x.fr", folder="inbox", n=2)
    _seed_folder(db, "a@x.fr", folder="deleted", n=3)

    trashed = db.search_emails(parse_search_query("in:deleted Sujet"))
    assert len(trashed) == 3
    assert {r["folder"] for r in trashed} == {"deleted"}

    # And the default is unchanged: no folder named, no trash.
    assert len(db.search_emails(parse_search_query("Sujet"))) == 2


def test_favourites_search_still_excludes_the_trash(fresh_app):
    from src import database as db
    from src.search_query import parse_search_query

    _seed_folder(db, "a@x.fr", folder="deleted", n=2)
    with db._conn() as con:
        con.execute("UPDATE emails SET is_favourite = 1")

    # A starred message that was thrown away is still thrown away. This used
    # to come free from the opening clause.
    assert db.search_emails(parse_search_query("in:favourite Sujet")) == []


def test_search_accepts_several_accounts(fresh_app):
    """A multi-selection used to be sent as no filter at all: past the row
    cap that returns the busier mailbox's mail and none of the other's."""
    from src import database as db
    from src.search_query import parse_search_query

    _seed_folder(db, "a@x.fr", n=2)
    _seed_folder(db, "b@x.fr", n=2)
    _seed_folder(db, "c@x.fr", n=2)

    parsed = parse_search_query("Sujet")
    both = db.search_emails(parsed, account=["a@x.fr", "b@x.fr"])
    assert {r["account_email"] for r in both} == {"a@x.fr", "b@x.fr"}
    assert len(both) == 4

    # A one-element list behaves like the scalar it used to be.
    solo = db.search_emails(parsed, account=["c@x.fr"])
    assert {r["account_email"] for r in solo} == {"c@x.fr"}

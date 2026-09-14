# SPDX-License-Identifier: GPL-3.0-or-later
"""What the Nettoyage page offers to do, computed from the mailbox.

One ranked list of at most three cards. Everything here is derived from
columns already in SQLite, so the page is correct the moment it paints and
there is nothing for the user to configure.

Two rules hold the whole design together:

* **`database._CLEANUP_LIVE` is the only thing a card can touch.** A starred
  message, one the AI flagged as needing a reply, anything already in the
  trash, and anything filed into Sent, Drafts or a folder of the user's own
  are out of reach of every card, at every step. This replaces the old
  "refuse a filter that matches everything" guard, because there is no
  user-supplied filter left to be empty.
* **The apply endpoint takes a card id, never a filter.** It re-runs the
  card's own query, so the set acted on is produced by the same SQL as the
  number displayed, even if mail arrived in between.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from src import database as db

# Only these are actionable from a button. unsub_* run through the existing
# unsubscribe routes instead, because an HTTP POST to a third party is not
# something the offline mutation queue can replay or take back.
APPLIABLE = ("spam", "old_news", "old_unread", "after_unsub")

# Rows per press. bulk_set_folder_tx reads the matched rows back with
# SELECT *, body included, so a few thousand of them is hundreds of megabytes
# in one transaction — and the IMAP side has to drain afterwards.
APPLY_CAP = 1000

# A card below its floor is noise: nobody opens a cleanup page to deal with
# four spams.
FLOOR_SPAM = 10
FLOOR_OLD_NEWS = 25
FLOOR_OLD_UNREAD = 50
FLOOR_AFTER_UNSUB = 5
# A sender has to write enough, and for long enough, to be worth a decision.
UNSUB_MIN_TOTAL = 4
UNSUB_MIN_RATE = 12          # messages a year
UNSUB_MAX_SENDERS = 40

OLD_NEWS_DAYS = 90
OLD_UNREAD_DAYS = 180

# Below this a card is not worth a row on screen. ~4 items at full confidence.
SCORE_FLOOR = 1.6
MAX_CARDS = 3

# A confirm dialog for a trash action only past this many messages: at three
# spams the dialog is the friction, not the safety. `after_unsub` is the one
# exception: its floor is 5, so it is always under this, and it is the only
# card with no peek link -- without the dialog there is no way at all to see
# what it means before pressing it.
CONFIRM_ABOVE = 200
ALWAYS_CONFIRM = {"after_unsub"}

# How many (sender, mailbox) pairs an apply will honour as exclusions, and
# how many fit in one statement's host parameters.
KEEP_MAX = 200
KEEP_CHUNK = 100


# A card the user dismissed stays out of the way for this long. One rule, one
# key: every competitor offers a dismiss, and without one the only way to
# reject a card is to ignore it — which teaches the user to ignore the page.
HIDE_DAYS = 30
HIDDEN_KV_KEY = "cleanup.hidden"


def _cutoff(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


# A dismissal is stored under "<account>|<card_id>", with "*" standing for
# "dismissed while looking at every mailbox at once". Without the account
# half, saying no to a card about the personal newsletters also silenced the
# work ones -- a different pile, a different decision.
_ALL = "*"


def _hide_key(card_id: str, account: Optional[str]) -> str:
    return f"{account or _ALL}|{card_id}"


def _stored_hidden() -> Dict[str, str]:
    """Every live dismissal, keyed as written. Expired entries dropped."""
    import json
    raw = db.get_kv(HIDDEN_KV_KEY)
    if not raw:
        return {}
    try:
        stored = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    floor = _cutoff(HIDE_DAYS)
    out = {}
    for k, v in stored.items():
        if not isinstance(v, str) or v <= floor:
            continue
        # Entries written before dismissals carried an account. They were
        # global by construction, so that is what they stay.
        out[k if "|" in k else f"{_ALL}|{k}"] = v
    return out


def _hidden_cards(account: Optional[str] = None) -> Dict[str, str]:
    """{card_id: iso} for the cards dismissed in *this* scope.

    A card dismissed with no account selected is dismissed everywhere: the
    user was looking at the whole mailbox when they said no. One dismissed
    while scoped to an account is dismissed for that account only.
    """
    out: Dict[str, str] = {}
    for key, iso in _stored_hidden().items():
        scope, _, card_id = key.partition("|")
        if scope == _ALL or (account and scope == account):
            out[card_id] = iso
    return out


def hide_card(card_id: str, account: Optional[str] = None) -> None:
    import json
    current = _stored_hidden()
    current[_hide_key(card_id, account)] = datetime.now(timezone.utc).isoformat()
    db.set_kv(HIDDEN_KV_KEY, json.dumps(current))


def unhide_all() -> int:
    n = len(_stored_hidden())
    db.set_kv(HIDDEN_KV_KEY, "{}")
    return n


def _live(extra: str = "") -> str:
    return db._CLEANUP_LIVE + (f" AND {extra}" if extra else "")


def _acct(where: str, account: Optional[str], params: list) -> str:
    if account:
        params.append(account)
        return where + " AND account_email = ?"
    return where


# ── the rows each actionable card owns ───────────────────────────────────────

# One place per card, used to count it and to act on it, so the two can never
# describe different sets.
def _card_where(card_id: str, account: Optional[str]) -> Tuple[str, list]:
    params: list = []
    if card_id == "spam":
        where = _live("category = 'spam'")
    elif card_id == "old_news":
        where = _live(
            "category = 'newsletter' AND is_read = 1"
            " AND date_received_iso IS NOT NULL AND date_received_iso < ?"
            " AND (unsubscribe_url IS NOT NULL OR unsubscribe_mailto IS NOT NULL)")
        params.append(_cutoff(OLD_NEWS_DAYS))
    elif card_id == "old_unread":
        where = _live(
            "is_read = 0 AND date_received_iso IS NOT NULL AND date_received_iso < ?")
        params.append(_cutoff(OLD_UNREAD_DAYS))
    elif card_id == "after_unsub":
        # Sender-derived, not row-derived: unsubscribed_at is stamped onto the
        # rows that existed at that instant, and insert_email never writes it,
        # so "row.unsubscribed_at IS NOT NULL AND received after it" matches
        # nothing, ever. Compared by calendar day because unsubscribed_at is
        # datetime('now') with no offset while date_received_iso carries the
        # sender's — neither string-comparing nor normalising them is right.
        # Scoped to the row's own mailbox. Unsubscribing a newsletter from
        # the personal account said nothing about the work account, which
        # is still subscribed and still receiving -- and every one of those
        # perfectly expected messages was offered up for deletion as mail
        # that "kept coming after you unsubscribed".
        where = _live(
            "date_received_iso IS NOT NULL AND sender_addr <> ''"
            " AND substr(date_received_iso, 1, 10) > ("
            "   SELECT substr(MAX(u.unsubscribed_at), 1, 10) FROM emails u"
            "    WHERE u.sender_addr = emails.sender_addr"
            "      AND u.account_email = emails.account_email"
            "      AND u.unsubscribed_at IS NOT NULL)")
    else:
        raise ValueError(f"unknown card {card_id!r}")
    return _acct(where, account, params), params


# The order a capped press walks the pile in. Newest first, so it clears
# what the user is most likely looking at -- and `int_id` after the date,
# because without a tiebreak the cap boundary is not deterministic and
# "what the preview showed" and "what the press took" can differ by a row.
_APPLY_ORDER = "ORDER BY date_received_iso DESC, int_id DESC"


def _window_clause(window: Optional[Dict], params: list) -> str:
    """Restrict to the slice a preview actually showed.

    `window` is the (date, int_id) of the preview's first and last row. It is
    what makes "acted on ⊆ previewed" true by construction: mail that arrived
    since sorts above the top cursor, and rows below the cap sort under the
    bottom one. Without it, ANY exclusion lets the LIMIT backfill from below
    the cap -- the press still touches `limit` rows, three of which the user
    never saw, and `affected` still matches the promised number so nothing on
    screen says otherwise.
    """
    if not window:
        return ""
    out = ""
    top, bottom = window.get("top"), window.get("bottom")
    if top and top.get("date") is not None:
        out += " AND (date_received_iso, int_id) <= (?, ?)"
        params.extend([top["date"], int(top["int_id"])])
    if bottom and bottom.get("date") is not None:
        out += " AND (date_received_iso, int_id) >= (?, ?)"
        params.extend([bottom["date"], int(bottom["int_id"])])
    return out


def _keep_clause(keep: Optional[List], params: list) -> str:
    """Drop the (sender, mailbox) pairs the user unticked.

    Chunked, because SQLite caps host parameters per statement. An AND of
    NOT IN chunks is the same set as one big NOT IN -- unlike an OR of IN
    chunks, which is not.
    """
    pairs = [(str(k.get("sender") or "").strip().lower(),
              str(k.get("account") or ""))
             for k in (keep or []) if k]
    pairs = [p for p in pairs if p[0]][:KEEP_MAX]
    if not pairs:
        return ""
    out = ""
    for i in range(0, len(pairs), KEEP_CHUNK):
        chunk = pairs[i:i + KEEP_CHUNK]
        values = ",".join("(?,?)" for _ in chunk)
        out += f" AND (sender_addr, account_email) NOT IN (VALUES {values})"
        for sender, acct in chunk:
            params.extend([sender, acct])
    return out


def select_rows(card_id: str, account: Optional[str] = None,
                limit: int = APPLY_CAP,
                window: Optional[Dict] = None,
                keep_senders: Optional[List[Dict]] = None) -> List[Dict]:
    """The rows the card's button acts on.

    `window` and `keep_senders` come from a preview the user just looked at.
    Neither is a filter in the sense the design forbade: the generator is
    still this card's own `_card_where`, re-run server-side, and these are AND
    terms over literal values. The degenerate case inverts safely -- an empty
    exclusion excludes nothing, so the worst a broken client can do is delete
    FEWER messages.
    """
    if card_id not in APPLIABLE:
        raise ValueError(f"{card_id!r} is not an appliable card")
    where, params = _card_where(card_id, account)
    where += _window_clause(window, params)
    where += _keep_clause(keep_senders, params)
    with db._conn() as con:
        return [dict(r) for r in con.execute(
            f"SELECT int_id, folder, is_read FROM emails WHERE {where}"
            f" {_APPLY_ORDER} LIMIT ?", [*params, int(limit)]
        ).fetchall()]


def preview(card_id: str, account: Optional[str] = None,
            limit: int = APPLY_CAP) -> Dict[str, Any]:
    """Who the card's button would touch, grouped by sender.

    The sender is the unit a false positive comes in -- "Le Monde should not
    be in there" -- and it compresses the list by about forty times, so the
    answer is readable where a thousand message rows would not be. The
    messages themselves stay one click away through the card's peek link, in
    the inbox, which already has search, selection and its own undo.

    No message row leaves the server: this returns aggregates only.
    """
    if card_id not in APPLIABLE:
        raise ValueError(f"{card_id!r} is not an appliable card")
    where, params = _card_where(card_id, account)
    cap = int(limit)
    with db._conn() as con:
        matched = con.execute(
            f"SELECT COUNT(*) FROM emails WHERE {where}", params).fetchone()[0]
        # Grouped over the CAPPED set: exactly the rows select_rows would
        # hand the action. Grouping over the full match would name senders
        # the press will not reach.
        rows = [dict(r) for r in con.execute(f"""
            SELECT sender_addr, account_email, sender,
                   COUNT(*) AS n,
                   COALESCE(SUM(is_read = 0), 0) AS unread,
                   MAX(date_received_iso) AS last
              FROM (SELECT int_id, sender_addr, account_email, sender, is_read,
                           date_received_iso
                      FROM emails WHERE {where}
                     {_APPLY_ORDER} LIMIT ?)
             GROUP BY sender_addr, account_email
             ORDER BY n DESC, last DESC
        """, [*params, cap]).fetchall()]
        # The slice's own bounds, so the press can be held to it.
        edges = con.execute(f"""
            SELECT MIN(date_received_iso) AS lo_d, MAX(date_received_iso) AS hi_d
              FROM (SELECT date_received_iso FROM emails WHERE {where}
                     {_APPLY_ORDER} LIMIT ?)
        """, [*params, cap]).fetchone()
        bounds = con.execute(f"""
            SELECT date_received_iso AS d, int_id FROM emails WHERE {where}
             {_APPLY_ORDER} LIMIT ?
        """, [*params, cap]).fetchall()

    covered = sum(r["n"] for r in rows)
    window = None
    if bounds:
        first, last = bounds[0], bounds[-1]
        window = {
            "top": {"date": first["d"], "int_id": int(first["int_id"])},
            "bottom": {"date": last["d"], "int_id": int(last["int_id"])},
        }
    per_account: Dict[str, int] = {}
    senders = []
    for r in rows:
        display, _ = db._canonical_sender(r["sender"] or "")
        per_account[r["account_email"]] = per_account.get(r["account_email"], 0) + r["n"]
        senders.append({
            "sender": r["sender_addr"],
            "name": display or r["sender_addr"],
            "account": r["account_email"],
            "n": int(r["n"]),
            "unread": int(r["unread"] or 0),
            "last": r["last"],
        })
    return {
        "card": card_id,
        "account": account,
        "unit": "senders",
        "matched": int(matched),
        # What the press will take, which past the cap is less than `matched`.
        "n": covered,
        "covered": covered,
        "per_account": per_account,
        "senders": senders,
        "window": window,
        "_edges": {"lo": edges["lo_d"], "hi": edges["hi_d"]} if edges else None,
    }


def _count(con, card_id: str, account: Optional[str]) -> Tuple[int, int]:
    """(matched, judged_by_llm) for a card."""
    where, params = _card_where(card_id, account)
    row = con.execute(
        f"SELECT COUNT(*) AS n, COALESCE(SUM(local_classified = 0), 0) AS llm"
        f"  FROM emails WHERE {where}", params).fetchone()
    return int(row["n"] or 0), int(row["llm"] or 0)


def _per_account(con, card_id: str, account: Optional[str]) -> Dict[str, int]:
    """{mailbox: how many of this card's messages are in it}.

    A card saying "412 spams" over three accounts is a press that reaches
    into three mailboxes, and nothing on its face said so.
    """
    where, params = _card_where(card_id, account)
    rows = con.execute(
        f"SELECT account_email, COUNT(*) AS n FROM emails WHERE {where}"
        f" GROUP BY account_email", params).fetchall()
    return {r["account_email"]: int(r["n"]) for r in rows}


# ── unsubscribable senders ───────────────────────────────────────────────────

def _months_observed(first: Optional[str], last: Optional[str]) -> float:
    try:
        a = datetime.fromisoformat(first)
        b = datetime.fromisoformat(last)
    except (TypeError, ValueError):
        return 1.0
    return max((b - a).days / 30.44, 1.0)


def _unsub_senders(con, account: Optional[str]) -> List[Dict]:
    """Senders still writing, still unsubscribable, worth a decision.

    One entry per (sender, mailbox), not per sender. A newsletter reaching
    three accounts is three subscriptions: three links, three tokens, three
    decisions. Collapsed into one, the page offered a single button, fired
    one POST with one account's token, and then -- because
    `HAVING MAX(unsubscribed_at) IS NULL` is evaluated over the group --
    dropped the sender from the list for all three, leaving two live
    subscriptions the page had just promised were gone.
    """
    where = _live("(unsubscribe_url IS NOT NULL OR unsubscribe_mailto IS NOT NULL)"
                  " AND sender_addr <> ''")
    params: list = []
    where = _acct(where, account, params)
    rows = [dict(r) for r in con.execute(f"""
        SELECT sender_addr,
               account_email,
               COUNT(*)                      AS total,
               COALESCE(SUM(is_read = 0), 0) AS unread,
               MIN(date_received_iso)        AS first_seen,
               MAX(date_received_iso)        AS last_seen
          FROM emails
         WHERE {where}
         GROUP BY sender_addr, account_email
        HAVING MAX(unsubscribed_at) IS NULL
           AND COUNT(*) >= ?
         ORDER BY total DESC
         LIMIT ?
    """, [*params, UNSUB_MIN_TOTAL, UNSUB_MAX_SENDERS]).fetchall()]
    if not rows:
        return []

    out = []
    for r in rows:
        # Endpoint, display name and one-click flag all come from the SAME
        # freshest message. Reading the flag from one row and the URL from
        # another is what used to advertise a sender as one-click and then
        # silently skip it. The row is picked inside the same mailbox: the
        # link is a per-subscription token, and the personal account's token
        # does not unsubscribe the work account.
        fresh = con.execute(f"""
            SELECT sender, unsubscribe_url, unsubscribe_mailto, list_unsubscribe_post
              FROM emails
             WHERE sender_addr = ? AND account_email = ? AND {where}
             ORDER BY date_received_iso DESC, int_id DESC LIMIT 1
        """, [r["sender_addr"], r["account_email"], *params]).fetchone()
        if fresh is None:
            continue
        months = _months_observed(r["first_seen"], r["last_seen"])
        rate = min(r["total"] / months * 12, r["total"] * 4)
        if rate < UNSUB_MIN_RATE:
            continue
        display, _ = db._canonical_sender(fresh["sender"] or "")
        post = (fresh["list_unsubscribe_post"] or "").lower()
        out.append({
            "email": r["sender_addr"],
            "account": r["account_email"],
            "name": display or r["sender_addr"],
            "total": r["total"],
            "unread": r["unread"],
            "rate": int(round(rate)),
            "one_click": "one-click" in post,
            "url": fresh["unsubscribe_url"],
            "mailto": fresh["unsubscribe_mailto"],
        })
    return out


# ── ranking ──────────────────────────────────────────────────────────────────

def _score(gain_weighted: float, confidence: float, friction: float = 0.0) -> float:
    # ln keeps one huge pile from permanently burying everything else.
    return math.log(1 + max(gain_weighted, 0)) * confidence * (1 - friction)


def _category_confidence(n: int, llm: int) -> float:
    """spam and old_news lean on the AI's category. Rules-only verdicts are
    a regex on the sender (`noreply|no-reply|…`), so a pile the model never
    read is worth less than a pile it did."""
    share = (llm / n) if n else 0.0
    return 0.35 + 0.55 * share


# ── the payload ──────────────────────────────────────────────────────────────

def compute(account: Optional[str] = None) -> Dict[str, Any]:
    started = datetime.now(timezone.utc)
    cards: List[Dict[str, Any]] = []

    with db._conn() as con:
        live_where = _acct(db._CLEANUP_LIVE, account, (p0 := []))
        totals = {int(r["is_read"] or 0): int(r["n"]) for r in con.execute(
            f"SELECT is_read, COUNT(*) AS n FROM emails WHERE {live_where}"
            " GROUP BY is_read", p0)}
        live = sum(totals.values())
        unread = totals.get(0, 0)

        senders = _unsub_senders(con, account)
        counts = {cid: _count(con, cid, account) for cid in APPLIABLE}
        per_account = {cid: _per_account(con, cid, account) for cid in APPLIABLE}

    # ── unsubscribe: the only action that stops mail arriving ────────────
    one_click = [s for s in senders if s["one_click"]]
    if one_click:
        rate = sum(s["rate"] for s in one_click)
        cards.append({
            "id": "unsub_bulk", "verb": "unsubscribe",
            "gain": {"value": rate, "unit": "mails_per_year"},
            "vars": {
                "n": len(one_click),
                "name": one_click[0]["name"],
                "total": sum(s["total"] for s in one_click),
                "read": sum(s["total"] - s["unread"] for s in one_click),
                "rate": rate,
                # Every one of them, not the first three. This is the
                # page's only action with no undo, and the sheet used to
                # name three senders and say "+ 6" about the rest.
                "names": [s["name"] for s in one_click],
                # How many mailboxes this press reaches into. A card saying
                # "9 senders" over three accounts is nine subscriptions on
                # three sets of credentials, which is worth knowing before
                # pressing something with no undo.
                "accounts": len({s["account"] for s in one_click}),
            },
            "senders": sorted({s["email"] for s in one_click}),
            # The unit the action actually works on: one link per mailbox.
            "entries": [{"sender": s["email"], "account": s["account"]}
                        for s in one_click],
            # What the sheet lists, one row per subscription.
            "detail": [{"name": s["name"], "sender": s["email"],
                        "account": s["account"], "total": s["total"],
                        "read": s["total"] - s["unread"]}
                       for s in one_click],
            "reversible": False, "confirm": True, "peek": None,
            "score": _score(3 * rate, 1.0),
        })
    else:
        manual = [s for s in senders if s["url"] or s["mailto"]]
        if manual:
            top = max(manual, key=lambda s: s["rate"])
            cards.append({
                "id": "unsub_one", "verb": "unsubscribe_manual",
                "gain": {"value": top["rate"], "unit": "mails_per_year"},
                "vars": {"n": 1, "name": top["name"], "total": top["total"],
                         "unread": top["unread"], "rate": top["rate"],
                         "account": top["account"], "accounts": 1},
                "senders": [top["email"]],
                "entries": [{"sender": top["email"], "account": top["account"]}],
                "reversible": False, "confirm": False,
                "peek": {"query": f"in:inbox from:{top['email']}"},
                # Leaving the app and coming back to say "it's done" is real
                # friction, and the app cannot verify the outcome.
                "score": _score(3 * top["rate"], 1.0, friction=0.35),
            })

    # ── the piles ────────────────────────────────────────────────────────
    def _pile(card_id, floor, weight, confidence, unit="mails", extra=None, peek=None):
        n, _llm = counts[card_id]
        if n < floor:
            return
        capped = min(n, APPLY_CAP)
        vars_ = {"n": capped, "matched": n,
                 "per_account": per_account.get(card_id, {})}
        if extra:
            vars_.update(extra)
        cards.append({
            "id": card_id,
            "verb": "mark_read" if card_id == "old_unread" else "trash",
            "gain": {"value": capped, "unit": unit},
            "vars": vars_,
            "reversible": True,
            "confirm": card_id in ALWAYS_CONFIRM or (
                card_id != "old_unread" and capped >= CONFIRM_ABOVE),
            "peek": {"query": peek} if peek else None,
            "score": _score(weight * capped, confidence),
        })

    spam_n, spam_llm = counts["spam"]
    _pile("spam", FLOOR_SPAM, 1.0, _category_confidence(spam_n, spam_llm),
          peek="in:inbox category:spam")

    news_n, news_llm = counts["old_news"]
    _pile("old_news", FLOOR_OLD_NEWS, 1.0, _category_confidence(news_n, news_llm),
          extra={"days": OLD_NEWS_DAYS},
          peek=f"in:inbox category:newsletter before:{_cutoff(OLD_NEWS_DAYS)[:10]}")

    unread_n, _ = counts["old_unread"]
    _pile("old_unread", FLOOR_OLD_UNREAD, 0.3, 0.90,
          extra={"days": OLD_UNREAD_DAYS, "before": unread,
                 "after": max(unread - min(unread_n, APPLY_CAP), 0)},
          peek=f"in:inbox is:unread before:{_cutoff(OLD_UNREAD_DAYS)[:10]}")

    _pile("after_unsub", FLOOR_AFTER_UNSUB, 1.0, 1.0)

    # ── rank ─────────────────────────────────────────────────────────────
    order = {cid: i for i, cid in enumerate(
        ("unsub_bulk", "unsub_one", "after_unsub", "spam", "old_news", "old_unread"))}
    dismissed = _hidden_cards(account)
    kept = [c for c in cards
            if c["score"] >= SCORE_FLOOR and c["id"] not in dismissed]
    kept.sort(key=lambda c: (-c["score"], -c["gain"]["value"], order[c["id"]]))

    return {
        "generated_at": started.isoformat(),
        "computed_in_ms": round(
            (datetime.now(timezone.utc) - started).total_seconds() * 1000, 1),
        "account": account,
        "analysing": db.count_pending(),
        "cards": kept[:MAX_CARDS],
        "more": max(len(kept) - MAX_CARDS, 0),
        "hidden": sum(1 for c in cards if c["id"] in dismissed),
        # Only ever grows, and only through the flagship card: the one forward
        # commitment this app can actually honour.
        "unsubscribed_total": db.count_unsubscribed_senders(),
        "missing_headers": db.count_emails_missing_headers(account),
        # Said once to anyone who had built custom rules, then dismissed like
        # a card. Their rows are renamed, not dropped.
        "migrated_rules": (0 if "migrated_rules" in dismissed
                           else int(db.get_kv("cleanup.migrated_rules") or 0)),
        "mailbox": {"live": live, "unread": unread},
    }

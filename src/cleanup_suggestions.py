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
# spams the dialog is the friction, not the safety.
CONFIRM_ABOVE = 200


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


def select_rows(card_id: str, account: Optional[str] = None,
                limit: int = APPLY_CAP) -> List[Dict]:
    """The rows the card's button acts on. Newest first, so a capped press
    clears what the user is most likely looking at."""
    if card_id not in APPLIABLE:
        raise ValueError(f"{card_id!r} is not an appliable card")
    where, params = _card_where(card_id, account)
    with db._conn() as con:
        return [dict(r) for r in con.execute(
            f"SELECT int_id, folder, is_read FROM emails WHERE {where}"
            f" ORDER BY date_received_iso DESC LIMIT ?", [*params, int(limit)]
        ).fetchall()]


def _count(con, card_id: str, account: Optional[str]) -> Tuple[int, int]:
    """(matched, judged_by_llm) for a card."""
    where, params = _card_where(card_id, account)
    row = con.execute(
        f"SELECT COUNT(*) AS n, COALESCE(SUM(local_classified = 0), 0) AS llm"
        f"  FROM emails WHERE {where}", params).fetchone()
    return int(row["n"] or 0), int(row["llm"] or 0)


# ── unsubscribable senders ───────────────────────────────────────────────────

def _months_observed(first: Optional[str], last: Optional[str]) -> float:
    try:
        a = datetime.fromisoformat(first)
        b = datetime.fromisoformat(last)
    except (TypeError, ValueError):
        return 1.0
    return max((b - a).days / 30.44, 1.0)


def _unsub_senders(con, account: Optional[str]) -> List[Dict]:
    """Senders still writing, still unsubscribable, worth a decision."""
    where = _live("(unsubscribe_url IS NOT NULL OR unsubscribe_mailto IS NOT NULL)"
                  " AND sender_addr <> ''")
    params: list = []
    where = _acct(where, account, params)
    rows = [dict(r) for r in con.execute(f"""
        SELECT sender_addr,
               COUNT(*)                      AS total,
               COALESCE(SUM(is_read = 0), 0) AS unread,
               MIN(date_received_iso)        AS first_seen,
               MAX(date_received_iso)        AS last_seen
          FROM emails
         WHERE {where}
         GROUP BY sender_addr
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
        # silently skip it.
        fresh = con.execute(f"""
            SELECT sender, unsubscribe_url, unsubscribe_mailto, list_unsubscribe_post
              FROM emails
             WHERE sender_addr = ? AND {where}
             ORDER BY date_received_iso DESC, int_id DESC LIMIT 1
        """, [r["sender_addr"], *params]).fetchone()
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
                "names": [s["name"] for s in one_click[:3]],
            },
            "senders": [s["email"] for s in one_click],
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
                         "unread": top["unread"], "rate": top["rate"]},
                "senders": [top["email"]],
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
        vars_ = {"n": capped, "matched": n}
        if extra:
            vars_.update(extra)
        cards.append({
            "id": card_id,
            "verb": "mark_read" if card_id == "old_unread" else "trash",
            "gain": {"value": capped, "unit": unit},
            "vars": vars_,
            "reversible": True,
            "confirm": card_id != "old_unread" and capped >= CONFIRM_ABOVE,
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

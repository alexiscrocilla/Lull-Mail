<!--
Design brief for the Nettoyage rewrite, kept because it records the decisions
AND the alternatives that were rejected — which is the part a diff cannot
show. Written before the seven commits that implement it (85b0a0f..937e53a);
line references point at the tree as it was then.

Two things it specified were deliberately not built, and neither is an
oversight: a retry button scoped to the senders whose unsubscribe was refused
(the card returns on the next load and says so, which covers it), and the
`unsub_one` "Pas encore" branch hides the card for 30 days rather than
tracking a separate state.
-->

# NETTOYAGE — IMPLEMENTATION BRIEF

Verified against working tree at HEAD `6bb705c` (`feat(cleanup): let a manual unsubscribe be marked as done`), which is **newer than every track saw**. `1a15e66` and `6bb705c` landed after the tracks were written and already fixed several things they argue about: `mark_sender_unsubscribed` now chunks (`src/database.py:2245`), `confirm.js` focuses Cancel on danger dialogs (`frontend/confirm.js:57`), `POST /api/cleanup/unsubscribe/mark` exists (`src/api.py:1978`). Every line reference below was re-read in that tree.

---

## 1. WHAT THE PAGE IS

Nettoyage is a single ranked list of at most three computed suggestions, each one a plain sentence, one number, one button. It has no tabs, no filters, no rule builder and nothing to configure: everything on it is derived from columns already in SQLite, so it is correct the moment the page paints. Its one irreplaceable job — unsubscribing, which exists nowhere else in the product — is the top card whenever it has anything to offer, because it is the only action that removes future mail rather than rows.

**Two seconds after opening, on a real mailbox:** a page title "Nettoyage", one line of subtitle ("3 choses à faire pour alléger votre boîte"), then three cards stacked vertically. Card one: *« Se désabonner de 9 listes que vous ne lisez pas »* — *« 620 mails reçus l'an dernier, 41 ouverts. »* — a button *« Se désabonner des 9 »* and a small grey link *« Voir ces messages »*. Card two: *« 1 000 messages jamais ouverts, reçus il y a plus de 6 mois »* — *« Les marquer comme lus n'en supprime aucun. »* — *« Marquer les 1 000 comme lus »*. Card three: *« 1 240 vieilles newsletters déjà lues »* — *« Reçues il y a plus de 3 mois. Elles partent à la corbeille, récupérables. »* — *« Mettre les 1 240 à la corbeille »*. Below them a single grey link *« Voir 1 suggestion de plus »*, and a footer line *« Vérifié à 09:41 · Les messages favoris et ceux à répondre ne sont jamais touchés. »* No tiles, no counters, no icons, no colours, no preview list.

---

## 2. SUGGESTION CATALOGUE

All triggers are ANDed with the cross-cutting guard, spelled **byte-identically everywhere** (§4.3):

```python
_CLEANUP_LIVE = "folder = 'inbox' AND is_favourite = 0 AND needs_reply = 0"
```

Six card types. At most three render.

| id | FR title | EN title | Trigger (real columns, all + `_CLEANUP_LIVE`) | Threshold | Gain number | Primary action | Confirm | Rank weight |
|---|---|---|---|---|---|---|---|---|
| `unsub_bulk` | Se désabonner de {n} listes que vous ne lisez pas | Unsubscribe from {n} lists you don't read | senders grouped on `sender_addr` having `(unsubscribe_url IS NOT NULL OR unsubscribe_mailto IS NOT NULL)`, freshest row's `list_unsubscribe_post` contains `one-click`, `MAX(unsubscribed_at) IS NULL`, `total >= 4`, `rate >= 12/yr`, `months_observed >= 1` | ≥ 1 sender | `{rate}` = Σ mails/year avoided, clamped to `total × 4` | `POST /api/cleanup/unsubscribe/bulk` (`src/api.py:1992`), `purge:false` | **YES** | `3 × rate`, conf 1.0 |
| `unsub_one` | Se désabonner de {name} | Unsubscribe from {name} | same aggregate, **not** one-click, has `http_url` or `mailto`, same floors; highest `rate` only, one card. Rendered only when `unsub_bulk` yields 0 senders | ≥ 1 sender | `{rate}`/yr | `POST /api/cleanup/unsubscribe` mode `auto` → `action_required: open_url\|open_mailto` (`src/api.py:1919-1932`) → `window.open`, then card asks « C'est fait ? » → `POST /api/cleanup/unsubscribe/mark` (`src/api.py:1978`) | no | `3 × rate`, conf 1.0, ×0.65 friction |
| `spam` | Envoyer {n} spams à la corbeille | Move {n} spam emails to the Trash | `category = 'spam'` | ≥ 10 | `{n}` mails | `POST /api/cleanup/apply {card:"spam"}` → trash | n ≥ 200 | `n`, conf = `0.35 + 0.55 × share(local_classified = 0)` |
| `old_news` | Vider {n} vieilles newsletters déjà lues | Clear {n} old newsletters you already read | `category = 'newsletter' AND is_read = 1 AND date_received_iso < :d90 AND (unsubscribe_url IS NOT NULL OR unsubscribe_mailto IS NOT NULL)` | ≥ 25 | `{n}` mails | same, trash | n ≥ 200 | `n`, conf = `0.35 + 0.55 × share(local_classified = 0)` |
| `old_unread` | Marquer {n} vieux messages non lus comme lus | Mark {n} old unread messages as read | `is_read = 0 AND date_received_iso IS NOT NULL AND date_received_iso < :d180` | ≥ 50 | `{n}` mails (capped, §4.6) | same, `mark_read` | no | `0.3 × n`, conf 0.9 |
| `after_unsub` | {n} messages d'expéditeurs que vous avez quittés | {n} messages from senders you left | `sender_addr IN (senders with MAX(unsubscribed_at) NOT NULL)` AND `substr(date_received_iso,1,10) > substr(max_unsub_day,1,10)` | ≥ 5 | `{n}` mails | same, trash | no | `n`, conf 1.0 |

### Decisions taken between tracks

- **`low_value_unread` / `max_score:3` is cut.** `skip_old_email`, `mark_ai_failed` and `skip_pending_emails` all write `category='other', importance_score=1` to mail the AI never read (`src/database.py:590`, `:613`, `:625`), and `analyzed_by` defaults to `'openai'` (`:183`) so no column separates "low value" from "never examined". The sql critique is right; the sql proposal loses. This also deletes the `max_score:` search-parser work item.
- **The per-sender "gros expéditeur" card is cut.** Every safe instance of it is already `unsub_bulk`/`unsub_one`; the unsafe instances are personal correspondents. `top_senders` scopes `folder != 'deleted'` (`src/database.py:1792`), so on the 500-mail mailbox the top row is a spouse and on any mailbox the user's own address groups from `folder='sent'`. The brief already says per-sender delete duplicates the inbox (`search from:` + select-all + delete, with its own undo at `frontend/mailbox.js:2977`). The interaction and sql tracks both shipped it; both lose.
- **`old_news` requires an unsubscribe header.** `_NEWSLETTER_SENDER` matches `noreply|no[_-]reply|donotreply` and is tested **before** transactional (`src/local_classifier.py:12-18`, `:88-95`), so `category='newsletter'` today contains bank notices, tax mail, GitHub and 2FA. Requiring `unsubscribe_url IS NOT NULL OR unsubscribe_mailto IS NOT NULL` removes them at zero cost and is self-consistent: a real newsletter has List-Unsubscribe. The catalogue critique's correction wins.
- **`after_unsub` is sender-derived, not row-derived.** The catalogue proposal's version (`WHERE unsubscribed_at IS NOT NULL AND date_received_iso > unsubscribed_at`) returns zero rows forever: `unsubscribed_at` is stamped only onto rows existing at that instant (`src/database.py:2245-2252`) and `insert_email` never writes it (column list `src/database.py:462-470`). The critique is right. The corrected form needs `sender_addr` (§4.4).
- **Timestamp comparison is by calendar day.** `unsubscribed_at` is `datetime('now')` → `2026-09-13 14:22:01`; `date_received_iso` is a Python `isoformat()` carrying the sender's offset. Neither normalising nor string-comparing them is correct. Compare `substr(...,1,10) >` — timezone-robust, conservative by at most one day, no migration.
- **`unread/total >= 0.7` is not a trigger on `unsub_bulk`.** `is_read` is the IMAP `\Seen` flag set by any client (`src/email_fetcher.py:837`), and `old_unread` sets it on 1 000 rows at a time — running one card would permanently kill the other. Trigger on volume and rate; keep "{total} reçus, {read} ouverts" as body copy, which is what the data actually is.

---

## 3. RANKING

```
gain_weighted = 3 × rate_per_year            (unsub_bulk, unsub_one)
              + 1 × mails_trashed            (spam, old_news, after_unsub)
              + 0.3 × mails_marked_read      (old_unread)

score = ln(1 + gain_weighted) × confidence × (1 − friction)

confidence: 1.00  header-derived (unsub_bulk, unsub_one, after_unsub)
            0.90  date/read-derived (old_unread)
            0.35 + 0.55 × share(local_classified = 0)  category-derived (spam, old_news)
friction:   0.00 everywhere except unsub_one = 0.35 (leaves the app, needs a manual "c'est fait")

floor: score >= 1.6   (≈ 4 items at full confidence — the catalogue's stated 0.7 admits a 2-item card)
render: top 3, then "Voir {n} de plus". Ties: gain desc, then fixed order
        unsub_bulk, unsub_one, after_unsub, spam, old_news, old_unread.
```

**Why these three constants.** `ln` stops one huge pile permanently burying everything else. `×3` on recurring mail is the editorial judgement the brief asks for: unsubscribing removes the arrival, not the row, and it is the only thing here the inbox cannot do. `×0.3` on mark-read is the correction the sql critique demanded — marking 4 000 mails read frees nothing, and must not rank like deleting 4 000.

**Worked example — 8 400 live inbox rows, 2 accounts, AI on, 14 months of history.**

| card | raw | gain_weighted | ln(1+g) | conf | score | rank |
|---|---|---|---|---|---|---|
| `unsub_bulk` | 9 senders, 620 mails/yr | 1 860 | 7.53 | 1.00 | **7.53** | 1 |
| `old_unread` | 2 900 → capped 1 000 | 300 | 5.71 | 0.90 | **5.14** | 2 |
| `old_news` | 1 240, 30 % LLM-judged | 1 240 | 7.12 | 0.515 | **3.67** | 3 |
| `spam` | 340, 22 % LLM-judged | 340 | 5.83 | 0.471 | **2.75** | 4 → "voir 1 de plus" |
| `after_unsub` | 0 | — | — | — | — | not rendered |

`old_unread` beating `old_news` on a smaller raw number is the confidence term working: 70 % of that newsletter pile is a regex verdict (`src/local_classifier.py:88`), and "mark as read" cannot be wrong.

**Second mailbox — 500 mails, mostly personal.** spam 4 (< 10), newsletters read >90 d with a header 6 (< 25), unread >180 d 18 (< 50), one unsubscribable sender at 9 mails over 10 months → `rate` 10.8 < 12. Every card is below its threshold: the page renders the all-clean state (§5.9). That is the design working, not a gap.

---

## 4. BACKEND

### 4.1 One endpoint replaces eight

`GET /api/cleanup/suggestions?account=<optional>` — the page's only mount request. Today's mount fires 8 (`getTopSenders`, 5 × `rules/preview`, `unsubscribe/senders`, `unsubscribe/stats`, `custom-rules`), 6 of them full-table Python aggregations.

### 4.2 Response shape

```json
{
  "generated_at": "2026-09-13T09:41:02.118431+00:00",
  "computed_in_ms": 12.7,
  "account": null,
  "analysing": 0,
  "cards": [
    {
      "id": "unsub_bulk",
      "verb": "unsubscribe",
      "gain": { "value": 620, "unit": "mails_per_year" },
      "vars": { "n": 9, "total": 743, "read": 41,
                "names": ["Le Monde", "Decathlon", "Medium"] },
      "senders": ["newsletter@lemonde.fr", "news@decathlon.fr", "noreply@medium.com",
                  "..." ],
      "reversible": false, "confirm": true,
      "peek": null,
      "score": 7.53
    },
    {
      "id": "old_unread",
      "verb": "mark_read",
      "gain": { "value": 1000, "unit": "mails" },
      "vars": { "n": 1000, "matched": 2900, "days": 180,
                "unread_before": 3411, "unread_after": 2411 },
      "reversible": true, "confirm": false,
      "peek": { "query": "in:inbox is:unread before:2026-03-17" },
      "score": 5.14
    },
    {
      "id": "old_news",
      "verb": "trash",
      "gain": { "value": 1000, "unit": "mails" },
      "vars": { "n": 1000, "matched": 1240, "days": 90 },
      "reversible": true, "confirm": true,
      "peek": { "query": "in:inbox category:newsletter before:2026-06-15" },
      "score": 3.67
    }
  ],
  "more": 1,
  "hidden": 0,
  "mailbox": { "live": 8412, "unread": 3411 }
}
```

Rules on this payload: **no field that is not rendered.** `mailbox.live/unread` exist only to compose `old_unread`'s "{before} → {after}" line and the all-clean sentence; there is no `trash`, no `undated`, no `coverage`. `computed_in_ms` is never rendered — it is the regression alarm. `analysing` is `db.count_pending()` (`src/database.py:1588`) and drives one banner, not a card. Card **text is composed client-side** from `id` + `vars` through `window.t` — the server never returns a localised string, which is how FR/EN parity stays mechanical.

### 4.3 The SQL

One module-level constant in `src/database.py`, interpolated, **never retyped**:

```python
_CLEANUP_LIVE = "folder = 'inbox' AND is_favourite = 0 AND needs_reply = 0"
```

Partial indexes are matched by term analysis on the query's WHERE clause. Reordering or re-spelling this predicate silently drops the index and costs ~100× with no error and no warning — this was measured by the sql track and reproduced by its critique. Hence one constant and the `EXPLAIN QUERY PLAN` test in §9.

Parameters `:d90`, `:d180` are UTC ISO cutoffs computed in Python (`datetime.now(timezone.utc) - timedelta(days=N)).isoformat()`), and the **same cutoff's first 10 characters** become the peek link's `before:` value, so the card count and the peek set cannot drift.

```sql
-- Q1  mailbox size + unread. Do NOT write this as COUNT(*), SUM(is_read=0):
--     with no equality prefix SQLite falls to a bare table scan.
SELECT is_read, COUNT(*) AS n
  FROM emails
 WHERE folder = 'inbox' AND is_favourite = 0 AND needs_reply = 0
 GROUP BY is_read;

-- Q2  spam, with the honesty term for the confidence factor
SELECT COUNT(*) AS n, COALESCE(SUM(local_classified = 0), 0) AS llm_judged
  FROM emails
 WHERE folder = 'inbox' AND is_favourite = 0 AND needs_reply = 0
   AND category = 'spam';

-- Q3  old read newsletters that really are newsletters
SELECT COUNT(*) AS n, COALESCE(SUM(local_classified = 0), 0) AS llm_judged
  FROM emails
 WHERE folder = 'inbox' AND is_favourite = 0 AND needs_reply = 0
   AND category = 'newsletter'
   AND is_read = 1
   AND date_received_iso IS NOT NULL AND date_received_iso < :d90
   AND (unsubscribe_url IS NOT NULL OR unsubscribe_mailto IS NOT NULL);

-- Q4  old unread
SELECT COUNT(*) AS n
  FROM emails
 WHERE folder = 'inbox' AND is_favourite = 0 AND needs_reply = 0
   AND is_read = 0
   AND date_received_iso IS NOT NULL AND date_received_iso < :d180;

-- Q5  unsubscribable senders (one GROUP BY replaces db.unsubscribe_senders'
--     full-table Python loop with one _parse_email_date per row)
SELECT sender_addr,
       COUNT(*)                     AS total,
       COALESCE(SUM(is_read = 0),0) AS unread,
       MIN(date_received_iso)       AS first_seen,
       MAX(date_received_iso)       AS last_seen,
       COUNT(DISTINCT account_email) AS n_accounts
  FROM emails
 WHERE folder = 'inbox' AND is_favourite = 0 AND needs_reply = 0
   AND (unsubscribe_url IS NOT NULL OR unsubscribe_mailto IS NOT NULL)
   AND sender_addr <> ''
 GROUP BY sender_addr
HAVING MAX(unsubscribed_at) IS NULL          -- partially-stamped sender: fully out
   AND COUNT(*) >= 4
 ORDER BY total DESC
 LIMIT 40;

-- Q6  per surviving sender (≤ 40 point lookups): freshest endpoint + display name.
--     Taking one_click from the SAME freshest row that supplies the URL fixes the
--     sticky has_one_click bug by construction (see §4.7).
SELECT sender, unsubscribe_url, unsubscribe_mailto, list_unsubscribe_post
  FROM emails
 WHERE sender_addr = :a
   AND folder = 'inbox' AND is_favourite = 0 AND needs_reply = 0
   AND (unsubscribe_url IS NOT NULL OR unsubscribe_mailto IS NOT NULL)
 ORDER BY date_received_iso DESC
 LIMIT 1;

-- Q7  they kept writing after you left
SELECT COUNT(*) AS n
  FROM emails e
  JOIN (SELECT sender_addr, MAX(unsubscribed_at) AS ua
          FROM emails WHERE unsubscribed_at IS NOT NULL AND sender_addr <> ''
         GROUP BY sender_addr) u ON u.sender_addr = e.sender_addr
 WHERE e.folder = 'inbox' AND e.is_favourite = 0 AND e.needs_reply = 0
   AND e.date_received_iso IS NOT NULL
   AND substr(e.date_received_iso, 1, 10) > substr(u.ua, 1, 10);
```

`rate_per_year = total / max(months_observed, 1) × 12`, clamped to `total × 4`, with `months_observed` derived from `first_seen`..`last_seen`. `first_seen` is the reason Q5 exists rather than a call to `db.unsubscribe_senders`, which does not return it (`src/database.py:2168-2181`) — `top_senders` does (`:1870`).

`NULL < x` is NULL is falsy, so an undated mail is never counted as old and never proposed for deletion. That preserves exactly the conservatism `find_by_filter` has today (`src/database.py:1968-1971`). Do **not** `COALESCE(date_received_iso, fetched_at)`: `fetched_at` is `datetime('now')` (space separator, no offset) and comparing it against an offset-bearing ISO string inverts same-day ordering.

### 4.4 The `sender_addr` column

Grouping by sender in Python is what makes the current page slow: `unsubscribe_senders` (`src/database.py:2102`), `unsubscribe_sender_target` (`:2183`), `find_by_sender` (`:1878`) and `mark_sender_unsubscribed` (`:2228`) each pull rows into Python and run `_canonical_sender` (`:1686`) per row — `mark_sender_unsubscribed` over **every row in the table including deleted**, on the flagship card's own path. One bulk unsubscribe of 9 senders is 27 full scans today.

Add a **VIRTUAL generated column**. Backfill: none. Write-path change: none. `sender` is never updated after insert, so the index is written once per row.

```sql
ALTER TABLE emails ADD COLUMN sender_addr TEXT
GENERATED ALWAYS AS (
  CASE
    WHEN instr(sender, '<') > 0
         AND instr(substr(sender, instr(sender, '<') + 1), '>') > 1
    THEN lower(trim(substr(sender,
                           instr(sender, '<') + 1,
                           instr(substr(sender, instr(sender, '<') + 1), '>') - 1),
                    ' ' || char(9) || char(10) || char(13) || char(11) || char(12)))
    ELSE lower(trim(sender,
                    ' ' || char(9) || char(10) || char(13) || char(11) || char(12)))
  END
) VIRTUAL;
```

**The guard must use `table_xinfo`, not `table_info`.** Generated columns are invisible to `PRAGMA table_info`, which is what every existing migration guard uses (`src/database.py:100`, `:159`). With the existing pattern the ALTER re-runs on the second launch and crashes `init_db()` with `duplicate column name`. This was verified by the sql track and reproduced by its critique:

```python
xcols = {row["name"] for row in con.execute("PRAGMA table_xinfo(emails)")}
if "sender_addr" not in xcols:
    con.execute("ALTER TABLE emails ADD COLUMN sender_addr TEXT GENERATED ALWAYS AS (...) VIRTUAL")
```

`STORED` is not available: `ALTER TABLE … ADD COLUMN … STORED` fails on a non-empty table.

**Visible side effect, stated rather than discovered in a diff:** `SELECT *` returns generated columns, and `get_emails` (`src/database.py:745`), `get_email_by_id` (`:946`) and the `_tx` helpers all use `SELECT *`. Every email JSON gains a `sender_addr` field. Additive; no code does `INSERT … SELECT *`; every insert uses an explicit column list (`src/database.py:462`).

Rewrite on `WHERE sender_addr = ?`: `find_by_sender` (`:1878`), `unsubscribe_sender_target` (`:2183`), `mark_sender_unsubscribed` (`:2228`). Keep `_canonical_sender` — it is still the right tool for the display name on ≤ 40 rows, and it is the reference implementation the SQL expression is tested against (§9).

### 4.5 Indexes and where the migration goes

All of this goes at the **end of `init_db()`, immediately after the composite block at `src/database.py:418-422`**, and the `ALTER` above goes immediately before it (the indexes reference the column).

```python
con.execute("CREATE INDEX IF NOT EXISTS idx_emails_sender_addr ON emails(sender_addr)")
con.execute(
    "CREATE INDEX IF NOT EXISTS idx_cleanup_cat ON emails("
    "  category, is_read, date_received_iso, unsubscribe_url, local_classified"
    f") WHERE {_CLEANUP_LIVE}")
con.execute(
    "CREATE INDEX IF NOT EXISTS idx_cleanup_unread ON emails("
    "  is_read, date_received_iso, account_email"
    f") WHERE {_CLEANUP_LIVE}")
con.execute(
    "CREATE INDEX IF NOT EXISTS idx_cleanup_sender ON emails("
    "  sender_addr, date_received_iso, is_read, unsubscribed_at, account_email"
    f") WHERE {_CLEANUP_LIVE}")
con.execute(
    "CREATE INDEX IF NOT EXISTS idx_cleanup_unsub ON emails("
    "  sender_addr, date_received_iso DESC, unsubscribed_at, is_read, account_email"
    f") WHERE {_CLEANUP_LIVE}"
    "   AND (unsubscribe_url IS NOT NULL OR unsubscribe_mailto IS NOT NULL)")
if not get_kv("cleanup_analyze_at"):
    con.execute("ANALYZE")
    set_kv("cleanup_analyze_at", datetime.now(timezone.utc).isoformat())
```

`account_email` is trailing everywhere so the index stays covering when the optional `account=` filter is set — it cannot be used to seek, but a residual filter over a covered scan is free, and without it the aggregates fall back to non-covering indexes.

`ANALYZE` is part of the migration, **not** a per-startup call: without statistics the planner picks `idx_emails_read` (2 distinct values, non-covering) over `idx_cleanup_unread`. The sql proposal put it unconditionally in `init_db()`, contradicting its own text; the critique is right. Re-run it from `analysis_pass` when `mailbox.live` has doubled since the stored value.

**Drop** `idx_emails_date` (`src/database.py:95`) — it indexes the raw RFC 2822 header, which sorts on the weekday name, and has been unusable since `date_received_iso` landed. **Drop** `idx_emails_unsub` (`:225`) — `(unsubscribe_url, unsubscribe_mailto)` is never usable because no query has an equality term on a URL; `idx_cleanup_unsub` supersedes it.

### 4.6 No cache

There is none, and none is needed. With these indexes the whole payload is five covered aggregates plus ≤ 40 point lookups; the sql track measured 13 ms on a 20 000-row / 338 MB database against 1 032 ms for today's eight requests, and the number is flat in body size because nothing touches a row payload. Invalidation is solved by returning the recomputed payload from the mutation itself:

```
POST /api/cleanup/apply  -> { ok, affected, undo, suggestions: {…} }
POST /api/cleanup/undo   -> { ok, restored,       suggestions: {…} }
```

Recomputing costs less than a second round-trip, and the response that confirms the deletion carries the new numbers, so a card can never claim a pile the user just emptied. No TTL, no `kv` epoch, no triggers (the sql track's trigger scheme costs +85 µs per insert on every fetch pass to solve a problem that recomputation solves for free), and `PRAGMA data_version` does not move under this connection-per-call pattern anyway.

### 4.7 The apply endpoint and the 1 000-row cap

```
POST /api/cleanup/apply   { "card": "spam" | "old_news" | "old_unread" | "after_unsub",
                            "account": null }
```

The **card id, not a filter**, is the request body. The server re-runs the card's own SQL projecting `int_id, folder, is_read` only, caps the id list at 1 000, and hands it to the existing `_apply_bulk_action` (`src/api.py:1602`). Two consequences: the number acted on is produced by the same query as the number displayed, and the whole empty-filter hazard class disappears — there is no user-supplied filter left to be empty, which retires `_reject_empty_filter` / `_filter_constrains_anything` (`src/api.py:1580-1600`) along with the Règles tab.

`_apply_bulk_action` reads `m.get("folder") != "deleted"` at `src/api.py:1610`; that guard becomes a tautology under `_CLEANUP_LIVE`. Keep `folder` in the projection so the line is still true rather than silently vacuous.

**Cap = 1 000 per press, and the card title states the capped number** ("Vider 1 000 vieilles newsletters" with body "1 240 au total, 1 000 à la fois"). Two independent reasons: `bulk_set_folder_tx` does `SELECT *` over the id list including `body_text`/`body_html` (`src/database.py:1325`), so 5 000 rows on a real mailbox is hundreds of MB in one transaction; and IMAP propagation is throttled (next section).

### 4.8 Which mechanism — and the one change it needs

**Trash and mark-read → the offline-mutation queue, already wired.** `_apply_bulk_action` (`src/api.py:1602`) already calls `bulk_set_folder_tx` / `bulk_set_read_tx` and returns the pre-update rows as an `undo` payload; `POST /api/cleanup/undo` (`src/api.py:1542`) already restores each message to the folder it actually came from and cancels the queued trash op. `_run_imap_batch` is gone — `src/api.py:1506-1512` is its tombstone, recording that the progress bar it drove was reporting IMAP propagation nobody asked to watch. Three of the five tracks proposed migrating to this; it is already done. **Nothing to build here.**

**Unsubscribe → the job registry.** `_make_job`/`_bump_job`/`GET /api/cleanup/jobs/{id}` (`src/api.py:1460`, `:1489`, `:1565`) already drive `_run_unsubscribe_job` (`src/api.py:1801`) with per-sender success/failure. Outbound HTTP has nothing to roll back and nothing to replay offline. Keep.

**Do not park undo payloads in the job registry.** `_make_job` re-inserts an unfinished job at the head of `_jobs_order` and `break`s out of the trim loop (`src/api.py:1479-1485`), so a job created only to hold a payload permanently stops eviction. 1 000 integers is ~8 KB of JSON; send them.

**The one required change: batch the trash drain.** `_drain_pending_ops` claims 50 ops per call (`src/scheduler.py:280`) on a 60-second tick (`src/lifecycle.py:43`) and calls `move_to_trash_on_server` **once per UID**, which opens and tears down a full IMAP connection each time (`src/email_fetcher.py:477` `_make_connection`, `:502` `conn.logout()`). A 1 000-row card is 1 000 logins over 20 minutes, and Gmail will throttle first. `batch_move_to_trash` already exists and does it correctly — one connection per account, trash folder resolved once (`src/email_fetcher.py:744-750`) — and `_run_unsubscribe_job` already uses it (`src/api.py:1836`). So:

- add `operation: Optional[str]` to `claim_pending_ops` (`src/database.py:1160`);
- in `_drain_pending_ops`, claim trash ops separately with `limit=250`, group them by `account_email`, and push each group through `batch_move_to_trash(acc, uids, on_each=…)`, completing/failing each op from the callback;
- leave `seen`/`flagged` on the existing per-UID path at limit 50.

1 000 rows then drains in ~4 ticks. This fixes the inbox's bulk delete too, and is why the priorart critique's objection (A2) is the most consequential finding in the five tracks.

### 4.9 Now-dead queries and routes

**Delete outright**

| symbol | line | why |
|---|---|---|
| `POST /api/cleanup/rules/preview` | `src/api.py:1644` | ~70 lines of Python aggregation, `_parse_email_date` up to 3× per row; replaced by the card SQL |
| `POST /api/cleanup/rules/run` | `src/api.py:1718` | replaced by `POST /api/cleanup/apply` |
| `GET /api/cleanup/senders` | `src/api.py:1514` | route only; `db.top_senders` survives for `src/agent_tools.py:104` |
| `POST /api/cleanup/sender` | `src/api.py:1519` | the per-sender card is cut |
| `GET /api/cleanup/unsubscribe/senders` | `src/api.py:1849` | route only |
| `GET /api/cleanup/unsubscribe/stats` | `src/api.py:1854` | fed only the status banner; runs `unsubscribe_senders()` **and** `count_emails_missing_headers()` — two full scans — for four integers |
| `GET/POST/PATCH/DELETE /api/cleanup/custom-rules` | `src/api.py:2706`, `:2723`, `:2739`, `:2765` | §7 |
| `db.find_by_filter` | `src/database.py:1906` | last callers were the two rules routes |
| `db.get_custom_rules` / `create_` / `update_` / `delete_custom_rule` | `src/database.py:2431`-`2463` | with the `custom_rules` table |
| `RuleFilter`, `RuleRunReq`, `CustomRuleBody`, `CustomRulePatch` | `src/api.py:120`, `:133`, `:2665`, `:2675` | |
| `_filter_kwargs`, `_filter_constrains_anything`, `_reject_empty_filter` | `src/api.py:1631`, `:1580`, `:1596` | moot once the card id is the request body |
| `idx_emails_date`, `idx_emails_unsub` | `src/database.py:95`, `:225` | §4.5 |

**Rewritten, not deleted** (callers outside the page): `db.top_senders` (`:1783`) and `db.unsubscribe_senders` (`:2102`) are AI tools (`src/agent_tools.py:104`, `:136`) — reimplement their bodies on `sender_addr` GROUP BYs, keeping every returned key including `first_seen` (`MIN(date_received_iso)`) and `accounts` (`GROUP_CONCAT(DISTINCT account_email)`). `db.count_emails_missing_headers` (`:2097`) is called by every analysis pass (`src/scheduler.py:717`) and currently materialises every matching row to take `len()` — make it a `COUNT(*)`, and keep its `folder != 'deleted'` scope aligned with `find_uids_missing_headers` (`:2076`), which feeds the same loop.

**Do not delete yet:** `db.bulk_set_folder` (`:1981`) and `db.bulk_mark_read` (`:1996`). `bulk_set_folder` still has two live callers, both in the unsubscribe purge path (`src/api.py:1950`, `:2016`); `bulk_mark_read` is exercised by `tests/test_cleanup_safety.py:225`. Both die in commit 7 (§9).

---

## 5. FRONTEND

### 5.1 DOM sketch

```
<section class="cln" role="region" aria-labelledby="cln-title">
  <header class="cln-head">
    <h1 id="cln-title">Nettoyage</h1>
    <p class="cln-head-sub">…{n} choses à faire…</p>
  </header>
  <p class="cln-live" aria-live="polite"></p>          <!-- visually hidden, owns every announcement -->
  <p class="cln-banner" hidden></p>                    <!-- first-run / no-AI / offline note -->
  <ol class="cln-list" aria-labelledby="cln-title"></ol>   <!-- 1–3 <li class="cln-card"> -->
  <div class="cln-state" hidden></div>                 <!-- replaces the list: loading / clean / error -->
  <footer class="cln-foot">
    <button class="cln-more" hidden></button>
    <button class="cln-unhide" hidden></button>
    <span class="cln-stamp"></span>
    <span class="cln-guard"></span>
  </footer>
</section>
```

### 5.2 Card anatomy

```
<li class="cln-card" data-card="old_news" data-state="idle">
  <h2 class="cln-card-title" id="cln-t-old_news">Vider 1 000 vieilles newsletters déjà lues</h2>
  <p  class="cln-card-gain">Reçues il y a plus de 3 mois et déjà ouvertes. Elles partent à la corbeille, récupérables.</p>
  <div class="cln-card-foot">
    <button class="cln-card-go">Mettre les 1 000 à la corbeille</button>
    <a class="cln-card-peek" href="#/inbox?q=in%3Ainbox%20category%3Anewsletter%20before%3A2026-06-15">Voir ces messages</a>
    <button class="cln-card-hide" aria-label="Masquer cette suggestion">Masquer</button>
  </div>
  <div class="cln-card-run"  hidden>…progress, unsubscribe cards only…</div>
  <div class="cln-card-done" hidden>…result text + Undo + "Ouvrir la corbeille"…</div>
  <p   class="cln-card-err"  hidden></p>
</li>
```

Three rules. Use the `hidden` **attribute**, never a `display:none` class — `[hidden]` leaves the accessibility tree and the global reset already honours it. The run/done/err rows are pre-rendered and toggled, so an action never destroys the node holding focus. The button's accessible name carries the number: a screen-reader user must hear three distinct buttons, not three identical « Supprimer » (which is exactly what `cleanup.act.delete` produces on 200 rows today, `frontend/i18n.js:635`).

Tab ring: three stops per card, ≤ 10 for the page, against 3 buttons × up to 200 rows today.

### 5.3 Click-to-done per suggestion

| card | clicks | path |
|---|---|---|
| `spam`, `old_news`, `after_unsub` | 1 (2 above 200) | `.cln-card-go` → `POST /api/cleanup/apply` → `data-state="done"` in the same frame → focus moves to `.cln-card-undo` |
| `old_unread` | 1 | same, `verb: mark_read` |
| `unsub_bulk` | 2 | `.cln-card-go` → review sheet (read-only list of sender names + one confirm carrying the number) → `POST /api/cleanup/unsubscribe/bulk` → in-card progress from `GET /api/cleanup/jobs/{id}` |
| `unsub_one` | 2 + a tab | `.cln-card-go` → `POST /api/cleanup/unsubscribe` → `window.open(target)` → card shows « Vous êtes désabonné ? » with « Oui, c'est fait » (`POST /api/cleanup/unsubscribe/mark`) and « Non » (hide 30 days) |

The unsubscribe sheet is a **read-only list, not a checklist**. Checkboxes, a live count, "décochez celles que vous voulez garder" and a per-item aria label are configuration in a costume — four extra states to build and test for a list nobody unticks. The interaction track proposed them; the critique is right and they are cut.

### 5.4 Undo — which mechanism and why

`POST /api/cleanup/undo` (`src/api.py:1542`), unchanged, with the payload `_apply_bulk_action` already returns (`{folders: {name: [int_id]}, unread_ids: []}`). It is the only mechanism that **cancels** rather than compensates: inside the window `cancel_pending_op` deletes the queued op (`src/database.py:1126`) and the IMAP server never sees the deletion at all. That is what makes the undo truthful. There is no untrash operation in the drain (`src/scheduler.py:288-303`), so once the op has fired, flipping `folder` back locally would leave the message in the server's Trash — which is why the window is a hard boundary, not a soft one.

Raise `_CLEANUP_UNDO_DELAY_SECONDS` from 12 to **20** (`src/api.py:1577`) — one constant, no call-site change, because `_apply_bulk_action` already passes it (`:1613`). Twenty seconds is the countdown shown in the button.

**The undo lives in the card, not in the toast.** `railToast` is single-slot: `show()` destroys the live toast (`frontend/rail-toast.js:174`). `_refreshBusyToast` (`:406`) fires a `loading` toast whenever `/api/sync/status` reports `running`, polled every 3 s (`:465`), and the analysis tick is 60 s with an IDLE watcher on top. An undo that lived only in the rail would be eaten by a background pass within seconds. The rail toast is still fired as a 20 000 ms echo with the same action (the rail default is 1 800 ms, `frontend/rail-toast.js:160`, and the inbox uses 5 000, `frontend/mailbox.js:2977` — neither is enough), but it is decoration. The interaction track's "disable the other cards for 12 s" rule is cut: it addresses the user's second click and does nothing about the busy toast, so it is complexity that does not work.

At expiry the button is **replaced**, not disabled, by « Ils sont dans la corbeille » + « Ouvrir la corbeille ». Mark-read expiry copy is calmer, and must not claim cancellation: `bulk_set_read_tx` queues `seen` with **no delay** (`src/database.py:1362`) and the route drains immediately (`src/api.py:1625`), so a mark-read undo is a second write that can itself fail.

### 5.5 Confirmation policy and focus

| action | dialog | why |
|---|---|---|
| `unsub_bulk` | **yes**, always | The POST leaves the machine. `mark_sender_unsubscribed` has no inverse and no 20 seconds exist for it. |
| `unsub_one` | no | It opens a tab; the third-party page is the confirm. |
| trash cards at n ≥ 200 | **yes** | `BULK_DELETE_CONFIRM_AT = 20` (`frontend/mailbox.js:3259`) exists because "above it, the reach is too large to be undone by hand if the toast is missed". A card's set is computed, described and previewable rather than hand-selected, so the threshold is 10× the inbox's — but deleting the gate entirely would be a regression against a decision this product already took. |
| trash cards below 200, all mark-read | no | Restorable, cancellable, described. A dialog here trains the reflex that dismisses the dialog that matters. |

All of it goes through the existing `confirmAsync` (`frontend/confirm.js`) — one dialog design for the whole page, against four today. Four fixes it needs, none of which exist:

1. Focus the dialog container (`.confirm-card`, `tabindex="-1"`) on open, never a button. `confirm.js:57` already lands on Cancel for `danger:true`; container focus makes the title and body the announcement.
2. A real focus trap — Tab from the last control wraps to the first. There is none today, so Tab walks the page behind the modal.
3. Restore focus to the triggering element on close. Today `close()` removes the node and focus falls to `<body>` (`frontend/confirm.js:44`).
4. `aria-describedby` on `.confirm-msg`.

Escape and backdrop-click already resolve to cancel (`:41`, `:50`) — keep.

### 5.6 Deep link into the inbox

`.cln-card-peek` is a real `<a href="#/inbox?q=…">` — middle-clickable, no JS needed.

| card | query |
|---|---|
| `spam` | `in:inbox category:spam` |
| `old_news` | `in:inbox category:newsletter before:<:d90 first 10 chars>` |
| `old_unread` | `in:inbox is:unread before:<:d180 first 10 chars>` |
| `unsub_one`, `after_unsub` | `in:inbox from:<address>` |
| `unsub_bulk` | none — no operator expresses "these 9 senders"; the sheet is the list |

**Every operator used already exists** (`src/search_query.py:33`): there is no `older:` and no `max_score:`, and none is needed — `before:` compares `substr(date_received_iso,1,10)` (`src/database.py:846`), which is exactly the cutoff the card computed. This retires the interaction track's four-place `max_score:` work item and the sql critique's "peek links land on an empty inbox" finding at the same time.

The leading `in:inbox` is load-bearing: `runServerSearch` injects `folder: state.folder || 'inbox'` (`frontend/mailbox.js:5613`) and `/api/emails/search` only fills `parsed["folder"]` when the query carries no `in:` (`src/api.py:337`). With `in:inbox` explicit, the peek is scoped to the same folder as `_CLEANUP_LIVE`, whatever view the user was in. This also retires the interaction track's proposed `folder=` hash param — no new parameter, no ordering problem against `_applyView`.

Two residuals to state rather than hide: `from:` is `lower(sender) LIKE '%addr%'` (`src/database.py:811`), so it is broader than the action's `sender_addr =`; and the peek does not apply the `is_favourite = 0 AND needs_reply = 0` half of the guard, so it can show a handful of rows the button will not touch. Both are over-inclusive, which is the safe direction for an inspection link.

One inbox fix ships with this: add `'q'` to the strip loop at `frontend/mailbox.js:5775`. `applyHashQuery` (`:5732`) sets `state.query` and never strips it, unlike every other deep-link param, so a user who follows a peek, clears the search box, then triggers any remount gets the query silently reapplied.

### 5.7 Progress

Trash and mark-read have **no progress and no bar**. The POST returns after one SQLite transaction; the number in the card is already true; the card goes `idle → done` in the same frame. What happens afterwards is the queue's business, surfaced once and quietly in `.cln-banner` when `pending_ops` is non-zero, driven by the `sync-status` CustomEvent the rail already broadcasts every 3 s (`frontend/rail-toast.js:451`) — **no new poll**. `src/api.py:1506-1512` records that a progress bar over IMAP propagation was built and removed; do not rebuild it.

Unsubscribe cards get a real bar because there is real waiting: `unsubscribe_http` is sequential with a 5 s timeout each (`src/api.py:1819`), so 9 senders is up to 45 s. `.cln-card-run` grows in place, the card keeps its rank, and the primary button is **replaced** by the run row rather than greyed. Poll `GET /api/cleanup/jobs/{id}`; stash the job id in `sessionStorage` keyed by card so a remount re-attaches instead of painting a stale idle card, and fall back to a fresh `/suggestions` if the id 404s (the registry is in-memory, capped at 100, and dies with the process).

Never express "working" with a spinning icon. `frontend/style.css:3951-3957` zeroes every `animation-duration` globally under `prefers-reduced-motion`, which freezes a spinner mid-frame — the inline `style="animation: spin…"` at `frontend/cleanup.js:1946` dies with the status row. The bar communicates through `width` set from JS (a layout value, unaffected by the override), always paired with a text count. The undo countdown is text in the button label, never a draining ring. And drop the `160ms` delay from `.cln-pane`'s `fade-up` (`frontend/style.css:4154`): `animation-delay` is **not** covered by the reduced-motion override, so a page that must be useful in two seconds currently spends its first sixth of a second deliberately blank for the user who asked for less motion.

### 5.8 Rate limiting

There is no rate-limit state, no countdown and no `slow_down` string. No cleanup mutation route is `10/minute`: `/sender` and `/undo` and `/rules/run` are 60 (`src/api.py:1520`, `:1543`, `:1719`), `/unsubscribe` and `/bulk` are 30 (`:1887`, `:1993`), `/unsubscribe/mark` is 60 (`:1979`), and the docstring at `src/api.py:1522-1527` records raising it from 10 precisely because "the eleventh click of a cleaning session answered « Échec »". `Retry-After` is hardcoded to `"10"` (`src/api.py:69`) so a countdown would be wrong anyway. The only guard kept is per-card: disable `.cln-card-go` for the duration of its own request.

### 5.9 Every state

| state | detection | what shows |
|---|---|---|
| **Loading** | before the first response | `.cln-state` with `cleanup.state.loading` and three skeleton cards at real card height — not a spinner |
| **Normal** | ≥ 1 card above the floor | 1–3 cards, ranked; `.cln-more` when more exist |
| **Still analysing** | `analysing > 0` (`db.count_pending()`, `src/database.py:1588`, already served as `queue_pending` at `src/api.py:2511`) | `.cln-banner` **above whatever cards exist** — not a substitute state. On 20 000 rows the queue sits at 14 000 while 6 000 classified mails already produce real cards; a first-run screen that hides them is wrong. Refresh off the `sync-status` event. |
| **First run, nothing yet** | 0 cards **and** `analysing > 0` | `cleanup.state.firstrun.*` with the live remaining count. Never worded like all-clean. `unsub_bulk`, `unsub_one` and `old_unread` depend only on columns written at INSERT (`src/database.py:466-469`) plus `is_read`/`date_received_iso`, so this state is short-lived on any mailbox with newsletters. |
| **All clean** | 0 cards and `analysing == 0` | `cleanup.state.clean.*` — one sentence and the number that proves it. Plus one quiet line when the user has ever unsubscribed: « Vous êtes désabonné de {n} expéditeurs. » That is the page remembering its own value, which is what earns the next visit. |
| **AI off** | `window.aiEnabled === false` (`frontend/app.js:444`) | Only `unsub_bulk`, `unsub_one` and `after_unsub` can ever compute — with AI off every mail is `other`/score 5 (`src/scheduler.py:822`). One line explaining why the page is short. `old_unread` still works (dates and `\Seen` need no model) and is kept. |
| **Backfill gave up** | `analysing == 0`, 0 unsubscribe cards, and `db.count_emails_missing_headers() > 0` | `.cln-banner` with a « Rechercher les liens » button calling `POST /api/cleanup/unsubscribe/backfill` (`src/api.py:1871`). **This is not optional** — see §7. |
| **Network error on load** | `err.status === 0 && err.network` (`frontend/api.js:41-47`) | `.cln-state` + error copy + retry |
| **Network error on an action** | same | `.cln-card-err` saying **nothing was saved**. `queue_pending_op` is server-side Python (`src/database.py:1085`); if the fetch to 127.0.0.1 failed, the handler never ran and nothing was queued. The interaction track's « Votre action est enregistrée » is false in every case in which it can fire — the same class of lie as the string it opens by deleting. `err.timeout` gets a separate string that does not claim to know. |
| **Partial unsubscribe failure** | `job.failed > 0`, or `skipped` non-empty from `/bulk` (`src/api.py:2029`) | Names the senders that failed and the ones never attempted, and offers a retry scoped to them. Failed senders are not stamped, so they return next mount — say so rather than let the user discover it. |
| **Stale set** | `affected === 0` on a card that promised N | `cleanup.err.gone`, card removes itself |
| **Hidden** | `.cln-card-hide` | One rule: hides that card id for 30 days, stored in `kv` under `cleanup.hidden` as `{card_id: iso}` (`db.set_kv`/`get_kv`, `src/database.py:2259`/`:2268`). No growth test, no 90-day arm, no per-card exemption — four invisible rules on a page whose premise is zero configuration. `.cln-unhide` in the footer clears the key. |

---

## 6. COPY

FR and EN, both dictionaries in `frontend/i18n.js`. Plain language: no "backfill", "one-click", "score", "en-têtes", "règle", "hydratation".

**Prerequisite — plural handling.** `window.t` does `{var}` substitution only, and the shipped dictionary works around it with "message(s)" (`frontend/i18n.js:639`). `unsub_bulk` fires at n=1, so add ~5 lines to `window.t`: when `vars.n === 1` and `key + '_one'` exists, use it. Only the keys marked ⑴ below need the variant.

**Delete first:** `cleanup.confirm.delete_body_html` (`frontend/i18n.js:641` FR / `:1676` EN) says "Cette action est irréversible." / "This action cannot be undone." about a move to `folder='deleted'`. It is false in both languages and it is the single most damaging string on the page.

**Rename before any key sweep:** `cleanup.cancel` (`frontend/i18n.js:576`/`:1613`), `cleanup.confirm.default_title` (`:577`/`:1614`), `cleanup.confirm.default_ok` (`:578`/`:1615`) → `confirm.*`. They are read by `frontend/confirm.js:17,18,32`, which the **mailbox** imports too. A bulk `cleanup.*` deletion silently degrades every confirm dialog in the product to raw key strings.

| key | FR | EN |
|---|---|---|
| `cleanup.title` | Nettoyage | Cleanup |
| `cleanup.sub` ⑴ | {n} choses à faire pour alléger votre boîte. | {n} things you can do to lighten your mailbox. |
| `cleanup.sub_one` | Une chose à faire pour alléger votre boîte. | One thing you can do to lighten your mailbox. |
| `cleanup.stamp` | Vérifié à {time} | Checked at {time} |
| `cleanup.guard` | Les messages favoris et ceux marqués « à répondre » ne sont jamais touchés. | Starred messages and those marked "needs a reply" are never touched. |
| `cleanup.more` ⑴ | Voir {n} suggestions de plus | See {n} more suggestions |
| `cleanup.more_one` | Voir 1 suggestion de plus | See 1 more suggestion |
| `cleanup.hide` | Masquer | Hide |
| `cleanup.hide_aria` | Masquer cette suggestion pendant 30 jours | Hide this suggestion for 30 days |
| `cleanup.unhide` ⑴ | Réafficher {n} suggestions masquées | Show {n} hidden suggestions |
| `cleanup.unhide_one` | Réafficher 1 suggestion masquée | Show 1 hidden suggestion |
| `cleanup.peek` | Voir ces messages | See these messages |
| `cleanup.peek_aria` | Voir ces messages dans la boîte de réception | See these messages in the inbox |
| **states** | | |
| `cleanup.state.loading` | Nous regardons votre boîte… | Looking through your mailbox… |
| `cleanup.state.clean.title` | Rien à nettoyer. | Nothing to clean up. |
| `cleanup.state.clean.body` | {n} messages dans votre boîte, {unread} non lus. Repassez dans quelques jours. | {n} messages in your mailbox, {unread} unread. Come back in a few days. |
| `cleanup.state.clean.unsub` ⑴ | Vous êtes désabonné de {n} expéditeurs. | You've unsubscribed from {n} senders. |
| `cleanup.state.clean.unsub_one` | Vous êtes désabonné d'un expéditeur. | You've unsubscribed from one sender. |
| `cleanup.state.firstrun.title` | Nous n'avons pas fini de lire votre courrier. | We haven't finished reading your mail yet. |
| `cleanup.state.firstrun.body` | Encore {n} messages à examiner. Les suggestions apparaîtront ici au fur et à mesure. | {n} messages left to look at. Suggestions will appear here as we go. |
| `cleanup.banner.analysing` | Analyse en cours : encore {n} messages. D'autres suggestions vont apparaître. | Still reading: {n} messages to go. More suggestions will appear. |
| `cleanup.banner.noai` | Le tri automatique est désactivé. Sans lui, nous ne pouvons proposer que la désinscription et vos vieux messages non lus. | Automatic sorting is off. Without it we can only offer unsubscribing and your old unread mail. |
| `cleanup.banner.syncing` ⑴ | Mise à jour de votre compte en cours ({n} messages restants). Vous pouvez continuer. | Still updating your mail account ({n} messages left). You can carry on. |
| `cleanup.banner.scan.title` | {n} messages n'ont jamais été inspectés. | {n} messages have never been checked. |
| `cleanup.banner.scan.body` | Nous ne savons pas encore de quoi vous pouvez vous désabonner dans ces messages. | We don't yet know what you can unsubscribe from in those. |
| `cleanup.banner.scan.btn` | Rechercher les liens | Look for the links |
| `cleanup.banner.scan.running` | Recherche en cours, {done} sur {total}. | Looking, {done} of {total}. |
| `cleanup.state.error.title` | Impossible de charger les suggestions. | Couldn't load the suggestions. |
| `cleanup.state.error.body` | Vérifiez que l'application tourne toujours, puis réessayez. | Check that the app is still running, then try again. |
| `cleanup.state.retry` | Réessayer | Try again |
| **cards** | | |
| `cleanup.card.unsub_bulk.title` ⑴ | Se désabonner de {n} listes que vous ne lisez pas | Unsubscribe from {n} lists you don't read |
| `cleanup.card.unsub_bulk.title_one` | Se désabonner de {name} | Unsubscribe from {name} |
| `cleanup.card.unsub_bulk.gain` | {total} mails reçus, {read} ouverts. Vous devriez en recevoir environ {rate} de moins par an. | {total} emails received, {read} opened. You should get about {rate} fewer a year. |
| `cleanup.card.unsub_bulk.btn` ⑴ | Se désabonner des {n} | Unsubscribe from all {n} |
| `cleanup.card.unsub_bulk.btn_one` | Se désabonner | Unsubscribe |
| `cleanup.card.unsub_one.title` | Se désabonner de {name} | Unsubscribe from {name} |
| `cleanup.card.unsub_one.gain` | {total} mails, {unread} non lus. Le lien ouvre leur site : nous ne pouvons pas le faire à votre place. | {total} emails, {unread} unread. The link opens their website — we can't do it for you. |
| `cleanup.card.unsub_one.btn` | Ouvrir la page de désabonnement | Open their unsubscribe page |
| `cleanup.card.unsub_one.ask` | Vous êtes désabonné de {name} ? | Did you unsubscribe from {name}? |
| `cleanup.card.unsub_one.yes` | Oui, c'est fait | Yes, it's done |
| `cleanup.card.unsub_one.no` | Pas encore | Not yet |
| `cleanup.card.spam.title` | Envoyer {n} spams à la corbeille | Move {n} spam emails to the Trash |
| `cleanup.card.spam.gain` | Détectés comme indésirables. Récupérables depuis la Corbeille. | Flagged as junk. You can get them back from the Trash. |
| `cleanup.card.spam.btn` | Mettre les {n} à la corbeille | Move all {n} to the Trash |
| `cleanup.card.old_news.title` | Vider {n} vieilles newsletters déjà lues | Clear {n} old newsletters you already read |
| `cleanup.card.old_news.gain` | Reçues il y a plus de {days} jours et déjà ouvertes. Elles partent à la corbeille, récupérables. | Received over {days} days ago and already opened. They go to the Trash and can be restored. |
| `cleanup.card.old_news.btn` | Mettre les {n} à la corbeille | Move all {n} to the Trash |
| `cleanup.card.old_unread.title` | Marquer {n} vieux messages non lus comme lus | Mark {n} old unread messages as read |
| `cleanup.card.old_unread.gain` | Jamais ouverts depuis plus de {days} jours. Rien n'est supprimé : le compteur passe de {before} à {after}. | Never opened in over {days} days. Nothing is deleted — your unread count drops from {before} to {after}. |
| `cleanup.card.old_unread.btn` | Marquer les {n} comme lus | Mark all {n} as read |
| `cleanup.card.after_unsub.title` | {n} messages d'expéditeurs que vous avez quittés | {n} messages from senders you left |
| `cleanup.card.after_unsub.gain` | Vous vous êtes désabonné, ils écrivent toujours. Ces messages partent à la corbeille, récupérables. | You unsubscribed and they kept writing. These go to the Trash and can be restored. |
| `cleanup.card.after_unsub.btn` | Mettre les {n} à la corbeille | Move all {n} to the Trash |
| `cleanup.card.capped` | {matched} au total, {n} à la fois. | {matched} in total, {n} at a time. |
| **action results** | | |
| `cleanup.card.working` | En cours… | Working… |
| `cleanup.card.done.trashed` | {n} messages déplacés vers la corbeille. | {n} messages moved to the Trash. |
| `cleanup.card.done.read` | {n} messages marqués comme lus. | {n} messages marked as read. |
| `cleanup.card.undo` | Annuler ({s} s) | Undo ({s}s) |
| `cleanup.card.undone` | C'est annulé. Rien n'a bougé. | Undone. Nothing moved. |
| `cleanup.card.undo_failed` | L'annulation n'a pas marché. Vos messages sont dans la corbeille. | The undo didn't work. Your messages are in the Trash. |
| `cleanup.card.after_trash` | Ils sont dans la corbeille. | They're in the Trash. |
| `cleanup.card.after_read` | Vous pouvez les remettre en non lus depuis la boîte de réception. | You can mark them unread again from the inbox. |
| `cleanup.card.open_trash` | Ouvrir la corbeille | Open the Trash |
| **unsubscribe sheet & results** | | |
| `cleanup.unsub.sheet.title` ⑴ | Se désabonner de {n} listes ? | Unsubscribe from {n} lists? |
| `cleanup.unsub.sheet.body` | Nous enverrons une demande à chacune. Vous ne recevrez plus leurs messages, et l'application ne pourra pas revenir en arrière. | We'll send a request to each one. You'll stop getting their messages, and the app cannot undo it. |
| `cleanup.unsub.sheet.confirm` ⑴ | Se désabonner des {n} | Unsubscribe from {n} |
| `cleanup.unsub.running` | Désinscription, {done} sur {total}… | Unsubscribing, {done} of {total}… |
| `cleanup.unsub.done` ⑴ | Désinscription faite pour {n} listes. | Unsubscribed from {n} lists. |
| `cleanup.unsub.partial.title` | {done} désinscriptions faites, {failed} refusées. | {done} unsubscribes went through, {failed} were refused. |
| `cleanup.unsub.partial.body` | {names} n'ont pas répondu. Elles réapparaîtront ici. | {names} didn't answer. They'll show up here again. |
| `cleanup.unsub.partial.retry` ⑴ | Réessayer les {n} | Retry the {n} |
| `cleanup.unsub.skipped` | {names} n'acceptent pas la désinscription automatique. Ouvrez leur page une par une. | {names} don't accept automatic unsubscribing. Open their page one at a time. |
| `cleanup.unsub.marked` | C'est noté. {name} n'apparaîtra plus ici. | Noted. {name} won't show up here again. |
| **errors** | | |
| `cleanup.err.offline` | L'application ne répond pas. Rien n'a été modifié. | The app isn't responding. Nothing was changed. |
| `cleanup.err.timeout` | Ça a mis trop de temps. Rechargez la page pour voir où ça en est. | That took too long. Reload the page to see where it got to. |
| `cleanup.err.generic` | Ça n'a pas marché. Rien n'a été modifié. | That didn't work. Nothing was changed. |
| `cleanup.err.gone` | Ces messages ont déjà été traités. | Those messages have already been dealt with. |
| **screen reader** | | |
| `cleanup.sr.loaded` ⑴ | {n} suggestions. | {n} suggestions. |
| `cleanup.sr.done` | {msg} Un bouton Annuler est disponible pendant {s} secondes. | {msg} An Undo button is available for {s} seconds. |
| **migration** | | |
| `cleanup.migrated` ⑴ | Vos {n} règles personnalisées ont été retirées : elles ne se déclenchaient jamais toutes seules. | Your {n} custom rules were removed — they never ran on their own. |

---

## 7. WHAT IS DELETED

### 7.1 Keep / fold / hide / delete

`fold` = the capability survives as a computed card with no UI of its own.

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 1 | 3-tab bar | delete | `frontend/cleanup.js:17-21` |
| 2 | Preset *Spams* | fold → `spam` | `cleanup.js:28-35` |
| 3 | Preset *Newsletters > 30 j* | fold → `old_news`, **stricter**: 90 days + `is_read=1` + unsubscribe header. The shipped preset deletes newsletters the user has not opened yet | `cleanup.js:36-44` |
| 4 | Preset *Score faible non lus* | delete | `cleanup.js:45-53`; §2 |
| 5 | Preset *Non lus > 180 j* | fold → `old_unread`, **action changed** from `delete` first to `mark_read` only | `cleanup.js:54-62` |
| 6 | Preset *Autres non lus* | delete | `cleanup.js:63-71` — "Autres" is a residual bucket that states no gain |
| 7 | Rules rail + per-item live count | delete | `renderRulesRail` |
| 8 | Rule detail header + action buttons | fold → the card's one button | |
| 9 | Rule detail body (summary strip, top-6 senders, 100-row sample, date span, account chips) | fold → `.cln-card-peek` | server cap 500 at `src/api.py:1645` |
| 10-17 | Custom rules rail, 48-control creation drawer (20 icons, 10 colours, keyword/score/age filters), 5 templates, "Action par défaut", Activée/Désactivée toggle, Modifier/Supprimer, `position` | delete | §7.5. `position` has never had a reorder control: written once (`src/database.py:2442`), read only by an `ORDER BY` (`:2434`), and `CustomRulePatch.position` (`src/api.py:2682`) is unreachable |
| 18 | Bespoke delete modal `confirmDelete` (4th dialog design) | delete | superseded by `confirmAsync` + undo |
| 19 | Per-rule progress bar, `pollRuleJob`, `pollCustomJob` | delete — already orphaned | `_apply_bulk_action` returns `job_id: None` (`src/api.py:1634`), so `runRule` already takes the "nothing to poll" branch |
| 20 | Expéditeurs tab, 200 rows × 3 buttons | delete | `src/api.py:1516` caps at 200 |
| 21 | Account-filter dropdown | delete | cards compute across all accounts; every endpoint keeps its optional `account=` for later |
| 22 | 5 sort modes | delete | sorting a list that no longer exists |
| 23-25 | Per-sender Voir / Marquer lu / Supprimer | delete | the inbox does all three better, with selection and undo |
| 26 | Per-row progress bar | delete | |
| 27 | Category breakdown bar | delete — **already dead**: `segs` is computed and then `const breakdownBar = ''` | |
| 28 | Unsubscribe status banner | delete | reports a background job's health to a user who never asked |
| 29 | « Rechercher les liens » button | **hide, do not delete** | §7.4 |
| 30-33 | Sender rail, detail header, mode chips, 4 KPI tiles, last-50 mail list | delete | the KPI tiles are what the brief bans outright; the mail list also fires an extra `getEmails({limit:50})` per selection and calls an i18n key that does not exist (`cleanup.unsub.no_mails`, `frontend/cleanup.js:2325`, absent from both dictionaries) |
| 34-36 | One-click / HTTP-page / mailto unsubscribe | **keep**, as `unsub_bulk` and `unsub_one`. Not three modes on a card face — one card each, chosen by the data | `src/api.py:1904-1932` |
| 37 | Purge checkbox | **delete the checkbox**; the capability returns as `after_unsub` | §7.4 |
| 38 | Unsub confirm modal (3rd dialog design) | delete → `confirmAsync` | |
| 39 | `runBulkUnsubscribe` | **keep and promote.** It is *not* dead code: the button is rendered at `frontend/cleanup.js:1995` and wired at `:2010`. The problem is discoverability — it lives inside a status row on the third tab, visible only after the backfill has populated the list. The card's job is to surface it, not to enable it. (The catalogue track's "first caller" claim is false; its critique wins.) |
| 40 | `?tab=` / `?sender=` deep links | delete — already orphaned | no producer exists; `frontend/dashboard.js` does not exist and `ROUTES` is `['inbox','cleanup','ai','settings']` |
| 41 | Header subtitle `#cln-sub` | delete | written only by `loadSenders()`, which is why the page lands on *Règles* with a subtitle describing *Expéditeurs* |
| 42 | Job registry | **keep** | still the mechanism for the backfill and both unsubscribe flows |

### 7.2 Dead endpoints and DB objects

See §4.9 for the full list. The only table that becomes unreferenced is **`custom_rules`** (`src/database.py:255-266`) — nothing in `scheduler.py`, `idle_watcher.py`, `ai_processor.py`, `lifecycle.py` or `email_fetcher.py` mentions it.

### 7.3 i18n and CSS

410 `cleanup.*` lines across both dictionaries. Roughly 130 keys die (`cleanup.form.*`, `cleanup.tpl.*`, `cleanup.custom.*`, `cleanup.tab.*`, `cleanup.sort.*`, `cleanup.sender(s).*`, `cleanup.confirm.delete_*`, `cleanup.progress.*`, `cleanup.detail.*`, `cleanup.backfill.*`, and ~38 of the 53 `cleanup.unsub.*`), 7 are already dead today (`cleanup.rel.week`, `cleanup.rules.empty`, `cleanup.rules.empty_desc`, `cleanup.tpl.newsletters.*`, `cleanup.tpl.promo.*`), and **3 must be renamed, not deleted** (§6). `unsub.cancel` / `unsub.confirm` are consumed only by the modal markup in `index.html` and die with it.

CSS: 317 `cln-` lines plus 26 `unsub-modal-` blocks in `frontend/style.css` — about 1 950 of 7 224 lines, in exactly two files (`cleanup.js` and `style.css`), borrowed by nothing else. A card list needs ~250-350 new lines. Net ≈ −1 600.

### 7.4 Two things that must NOT be deleted with the tab they live on

**The « Rechercher les liens » button.** `_backfill_unsubscribe_headers` stamps the terminal `unsubscribe_backfill_done_at` and **never runs again** whenever a pass moves nothing — `elif done == 0:` at `src/scheduler.py:722-729`, with the log line "reprise manuelle depuis Nettoyage". That branch fires when every account is offline or in backoff (`:684-688`), and the backfill runs *after* `_drain_pending_ops` and body hydration inside the analysis pass (`:948-965`), so a busy first pass on a 20 000-row mailbox can disable it before it inspects a single UID. `POST /api/cleanup/unsubscribe/backfill` (`src/api.py:1871`) does not consult the flag, so it is the only recovery — and after the redesign the flagship card is the only thing that would be empty. Three tracks proposed deleting it; all three lose. It moves from a header button on a tab to the `.cln-banner` escape hatch in §5.9.

**The unsubscribe purge, as `after_unsub` rather than a checkbox.** `req.purge` calls the non-transactional `db.bulk_set_folder` (`src/api.py:1950`, `:2016`) and hand-builds `imap_trash` plan steps — no delay, nothing to cancel, no undo payload. It is the last non-undoable destructive path on this page and it violates the brief outright. It is also a no-op for most senders: `mailto_only`, `http_only` and every non-one-click `auto` sender **return early at `src/api.py:1915-1932`, before the purge block at `:1946`** — the user ticks "aussi supprimer les mails", a tab opens, and nothing is deleted. And `runBulkUnsubscribe` hardcodes `purge: false` (`frontend/cleanup.js:2035`) so the bulk path never honoured it at all. So: the checkbox goes, `purge` stays `false` everywhere, and "delete their backlog" becomes `after_unsub` — a separate card, on the undoable `_apply_bulk_action` path, offered *after* the unsubscribe succeeded rather than bundled into the same confirm.

### 7.5 Custom rules: delete outright

**Recommendation: Option A, delete. Do not schedule an applier.** Three reasons in order of weight. (a) "One ranked list of computed suggestions, zero configuration" and "a user-authored automation engine" are different products; shipping both means the page still opens onto a choice, and choice is what users bounced on. (b) The demand signal does not exist: the feedback is *"trop de fonctionnalités inutiles affichées"*, not "mes règles ne se déclenchent pas". Nobody complained the automation was missing because almost nobody reached the drawer — five clicks and a 48-control form deep. (c) The 5 shipped templates (`job-search`, `security-codes`, `social-networks`, `app-notifications`, `promotions`) are each *a category of clutter the app can detect on its own*: they are evidence of what people want cleaned, not evidence that people want a rule builder.

The alternative — a `rules_pass` in the scheduler — is 5-8 days, and the expensive half is not the engine but the trust surface (dry-run, per-rule action log, bulk reversal, kill switch, new-mail watermarking, an interaction contract with `analysis_pass` so a rule cannot fire on `category='pending'`). A wrong rule running unattended at 3 a.m. against a 20 000-row mailbox is a materially worse failure than any current bug on this page. Cut it, including the priorart track's "et à l'avenir" checkbox — which is the same system with the schema, the rule list and the removal UI left unbudgeted, i.e. the Règles tab returning in disguise.

**Migration.** `custom_rules` has no FK to `emails` and nothing was ever applied, so no mail state derives from a rule. Ship the removal as `ALTER TABLE custom_rules RENAME TO custom_rules_removed_v2` in the `init_db` migration block, not a `DROP` — one dead table in a single-user SQLite file buys a reversible release. The real `DROP` lands two versions later. **No first-visit dismiss-once banner**: on this evidence almost every install has zero rows, and a modal explaining a removed feature is orientation furniture on a page whose brief is "useful in two seconds". Instead: when the renamed table has rows, render `cleanup.migrated` as one grey line in the footer, permanently, with no dismiss state. Two i18n keys, no kv round-trip.

Do not offer to convert rules into cards. Suggestions are computed, not configured; a converter rebuilds the surface the redesign exists to remove. If a power user later wants a saved filter, the honest answer is a saved *inbox search* — the inbox already has query parsing, selection, bulk actions and undo.

---

## 8. RISKS

| # | What silently breaks | The check that catches it |
|---|---|---|
| R1 | A `cleanup.*` key sweep kills `confirm.js` app-wide, degrading every confirm dialog in the product to raw key strings (`frontend/confirm.js:17,18,32`; mailbox imports it too). There is a documented precedent for exactly this class of mistake at `frontend/api.js:388-390`. | Rename the three keys to `confirm.*` in **commit 1**, before anything else. Test: `test_i18n_parity` asserting every key referenced by `frontend/*.js` exists in both dictionaries, and every FR key has an EN twin. |
| R2 | A partial index is silently dropped because the predicate was re-spelled — no error, ~100× regression, invisible to code review. | `tests/test_cleanup_perf.py`: for each of Q1-Q7, assert `EXPLAIN QUERY PLAN` contains `idx_cleanup_`. Also assert the source contains exactly one literal occurrence of the predicate string. |
| R3 | The `sender_addr` ALTER re-runs on the second launch and crashes `init_db()`, because `PRAGMA table_info` does not list generated columns. | Test: run `init_db()` three times against a populated fixture and assert it succeeds each time. |
| R4 | The SQL canonicalisation diverges from `_canonical_sender`, so a sender groups two ways and the card count is wrong. | Test: fuzz the SQL expression against `_canonical_sender(raw)[1]` over the adversarial set (`'"a>b" <x@y.z>'`, `'nested <<a@b>>'`, `'name <  >'`, `'no closing <angle'`, `''`, `'   '`, `'\tTab <t@t.t>\n'`) plus 10 000 random strings. Known and accepted divergence: SQLite's `lower()` is ASCII-only. |
| R5 | A card trashes a favourite, a needs-reply, a sent message or mail the user filed into a custom folder. `find_by_filter`/`find_by_sender`/`top_senders` all scope only `folder != 'deleted'` today (`src/database.py:1927`, `:1888`, `:1792`) and `_BUILTIN_FOLDERS` (`src/api.py:95`) plus every custom folder are in scope. | Test (this is the replacement for the empty-filter guard): a fixture with one favourite, one needs-reply, one `folder='sent'`, one `folder='draft'` and one in a custom folder, all otherwise matching every card; assert every card's count is 0 and `POST /api/cleanup/apply` touches nothing. |
| R6 | `POST /api/cleanup/apply` acts on a different set than the card counted — after a sync, or between render and click. | The endpoint re-runs the card's own SQL; it never accepts an id list from the client. Test: mutate rows between `GET /suggestions` and `POST /apply`, assert `affected` equals the freshly-recomputed count and the response's `suggestions` block reflects the new state. |
| R7 | A 1 000-row trash press queues 1 000 IMAP logins at 50/minute — 20 minutes of stalled queue behind which every ordinary read-a-mail op waits (`ORDER BY p.id ASC`, `src/database.py:1176`). | The batched drain (§4.8), plus a test asserting `_drain_pending_ops` calls `batch_move_to_trash` once per account for a 300-op trash backlog, not 300 times. |
| R8 | The undo is destroyed by the app itself: `_refreshBusyToast` fires a `loading` toast on a 3 s poll (`frontend/rail-toast.js:406`, `:465`) and `show()` destroys the live one (`:174`). | The undo lives in the card. E2E: start a fake sync, fire a card action, assert `.cln-card-undo` is still present and clickable 5 s later. |
| R9 | `mark_sender_unsubscribed` raises on a sender with >900 rows and `_run_unsubscribe_job` still bumps the job `ok` (`src/api.py:1822-1826`) — the user is told they unsubscribed, the stamp never lands, the card returns forever. **Already half-fixed**: the function chunks at `src/database.py:2245`. The swallowed exception is not. | Make the stamp failure bump the job `failed`. Test: monkeypatch the stamp to raise, assert the job reports the sender as failed. |
| R10 | `has_one_click` is sticky-true: set from *any* row that ever carried `List-Unsubscribe-Post` (`src/database.py:2178`) while `unsubscribe_sender_target` reads it from the **freshest row only** (`:2216`). The card shows the badge, the bulk route drops the sender into `skipped` (`src/api.py:2029`), and the user is told nothing. | Q5+Q6 take both from the same freshest row, which fixes it by construction. Test: a sender whose latest campaign dropped the header must not appear in `unsub_bulk`. |
| R11 | `agent_tools.unsubscribe_candidates` reports `one_click: false` for every sender — it reads `r.get("one_click")` (`src/agent_tools.py:144`) while `db.unsubscribe_senders` emits `has_one_click` (`src/database.py:2178`). Pre-existing; the redesign makes one-click eligibility the thing that matters. | Fix while rewriting the helper. `tests/test_agent.py:31-32` already asserts spec/impl parity, so deleting a tool without its spec fails today — the agent side is the safe part of this change. |
| R12 | The unsubscribe list is permanently empty on a mailbox that was offline during the one backfill pass. | §7.4's banner. Test already exists in spirit: `tests/test_cleanup_safety.py:314` (`test_backfill_skips_accounts_in_backoff`) and `:275` (connection failure does not mark rows checked). Add one asserting the banner condition (`count_emails_missing_headers() > 0` with the done-flag set) is reachable and the manual route clears it. |
| R13 | Deleting symbols breaks `tests/test_cleanup_safety.py` (305 lines, 15 tests) and `tests/test_agent.py`. This file is the regression net for exactly what §7 removes — the breakage track asserted it does not exist; it does. | Run it green before and after every commit. Tests keyed to deleted routes (`test_empty_filter_is_refused_everywhere`, `test_patching_a_rule_to_an_empty_filter_is_refused`, `test_rule_delete_is_undoable`) are **replaced** by R5's guard test and a card-apply undo test, not simply deleted. `bulk_mark_read`/`bulk_set_folder` stay until commit 7 because `:225`/`:226` call them. |
| R14 | The peek link lands on a different set than the button acts on. | Same cutoff string feeds both (§4.3). Accepted over-inclusion: `from:` is a substring LIKE (`src/database.py:811`) and the peek omits the favourite/needs-reply half of the guard. Test: for each card, assert the peek query parses to filters that are a superset of the card's, never a disjoint set. |
| R15 | `unsub_bulk` runs 9 sequential 5 s POSTs and the page looks frozen or, worse, silently reports success for senders never attempted (`skipped`, `src/api.py:2029`). | The in-card progress bar plus the partial/skipped states in §5.9. Test: a bulk call with one ineligible sender must surface it by name. |

---

## 9. BUILD ORDER

Each commit ships on its own and leaves the app working.

**1 — `fix(i18n): move the shared confirm strings out of the cleanup namespace`**
Rename `cleanup.cancel` / `cleanup.confirm.default_title` / `cleanup.confirm.default_ok` → `confirm.*` in both dictionaries and in `frontend/confirm.js:17,18,32`. Delete the false `cleanup.confirm.delete_body_html` "irréversible" strings (`frontend/i18n.js:641`, `:1676`) and reword the surviving delete-confirm copy to name the Corbeille. Add the `_one` plural fallback to `window.t`.
*Proves it:* new `test_i18n_parity` (every referenced key exists in FR and EN; every FR key has an EN twin); manual check that a mailbox bulk-delete dialog still renders its buttons.

**2 — `perf(db): group senders in SQL instead of Python`**
Add the `sender_addr` VIRTUAL column with the `table_xinfo` guard and `idx_emails_sender_addr`. Rewrite `find_by_sender`, `unsubscribe_sender_target`, `mark_sender_unsubscribed`, `unsubscribe_senders` and `top_senders` onto it, keeping every returned key (`first_seen`, `accounts`, the category buckets). Fix `agent_tools.unsubscribe_candidates`'s `one_click` read. Make `count_emails_missing_headers` a `COUNT(*)`.
*Proves it:* R3 (triple `init_db`) and R4 (SQL ≡ Python fuzz) tests; `tests/test_agent.py` and `tests/test_cleanup_safety.py` green; a timing assertion that `find_by_sender` on a 20 000-row fixture is under 50 ms.

**3 — `perf(db): cover the cleanup aggregates with partial indexes`**
`_CLEANUP_LIVE`, the four partial indexes, the kv-guarded `ANALYZE`, and the drops of `idx_emails_date` / `idx_emails_unsub`. No behaviour change yet.
*Proves it:* `tests/test_cleanup_perf.py` — `EXPLAIN QUERY PLAN` names an `idx_cleanup_` index for each of Q1-Q7, and the predicate literal appears exactly once in the source.

**4 — `perf(sync): trash queued messages in one connection per account`**
`operation` filter on `claim_pending_ops`; trash ops claimed at 250 and grouped through `batch_move_to_trash`; `seen`/`flagged` unchanged. Benefits the inbox immediately.
*Proves it:* R7's test; `tests/test_pending_ops.py` green.

**5 — `feat(cleanup): one endpoint computes every suggestion`**
`GET /api/cleanup/suggestions` with the six card types, ranking, floors and the 1 000 cap. `POST /api/cleanup/apply` taking a card id, delegating to `_apply_bulk_action`, returning the recomputed payload. Same on `/api/cleanup/undo`. Raise `_CLEANUP_UNDO_DELAY_SECONDS` to 20. No frontend yet.
*Proves it:* R5's guard test (favourite / needs-reply / sent / draft / custom folder are untouchable by every card), R6's recompute test, floor tests per card, a ranking test reproducing §3's worked example, and a `COALESCE(SUM(...),0)` test on an empty mailbox (`SUM()` over zero rows is NULL, not 0).

**6 — `feat(cleanup): replace the three tabs with a ranked suggestion list`**
Rewrite `frontend/cleanup.js` around the DOM of §5.1: cards, in-card undo with countdown, `confirmAsync` for `unsub_bulk` and trash ≥ 200, peek links, the `.cln-banner` states, hide/unhide via `kv`. Add the focus trap, container focus and focus restore to `confirm.js`. Add `'q'` to the mailbox strip loop (`frontend/mailbox.js:5775`). Remove the `160ms` delay from `.cln-pane`. Delete the CSS the old page owned.
*Proves it:* a Playwright spec under `frontend/tests/e2e/` against `scripts/ui_test_server.py` — mount with zero console errors; three cards render in rank order; a trash press flips the count and leaves a working Undo alive through a simulated sync; the all-clean and first-run states render; the peek link navigates to a non-empty inbox result.

**7 — `chore(cleanup): remove the rules engine that never ran`**
Delete the endpoints, DB helpers, Pydantic models and i18n keys in §4.9 and §7.3. Rename `custom_rules`. Move the unsubscribe purge off `db.bulk_set_folder` (delete the hand-built `imap_trash` plan steps — `bulk_set_folder_tx` queues its own, or you double-trash — and re-derive the job `total`), then delete `bulk_set_folder` and `bulk_mark_read` and the two test lines that call them. Make the failed unsubscribe stamp bump the job `failed` (R9).
*Proves it:* full suite green; a grep gate in CI asserting no reference remains to `find_by_filter`, `custom_rules`, `rules/preview`, `rules/run`; `tests/test_cleanup_safety.py` rewritten so its safety coverage moves from "an empty filter is refused" to "no card can select a protected message".

---

## WHERE PRIOR ART CONTRADICTS THIS BRIEF

Three places, stated rather than silently bent.

**Every competitor gives each suggestion a dismiss; the brief specified one primary button.** Clean Email pairs its primary with a dismiss whose semantics are exact ("will not suggest the action again"), and Gmail, Mailstrom, Leave Me Alone and SaneBox all offer a non-destructive escape per row. Without one, the only way to reject a card is to ignore it, which trains the user to ignore the page. **The brief bends:** `.cln-card-hide` is added, as one rule (30 days, one `kv` key, one unhide link), not as the four-rule state machine the catalogue track proposed.

**Every competitor makes inspection the card's primary affordance; the brief called it "a discreet link".** Gmail makes clicking the sender the way to see their mail; Clean Email opens a preview pane on the group. For a destructive action over hundreds of messages, the preview *is* the trust mechanism. **The brief holds anyway.** Making the whole card clickable creates three hit targets competing with the primary button and invites rebuilding a preview pane inside `cleanup.js` — which is the 200-row list under a new name. The inbox already has the list, the selection, the search and its own undo; a deep link is one `location.hash`. The link stays discreet, but its accessible name is explicit ("Voir ces messages dans la boîte de réception") and it is a real `<a>`, so it is discoverable by keyboard and middle-clickable.

**Every product that makes cleanup *stick* has a forward commitment — Clean Email's Auto Clean, Mailstrom's Block/Expire, SaneBox's SaneBlackHole, Gmail's "Block instead" — and the brief deletes persistence entirely.** The concern is real: without one, the same card returns next month with the same pile. **The brief holds, with one substitution.** The failure here was a 48-control rule *builder*, not persistence, but every cheap version of "and in future" (a checkbox on the confirm) still needs an applier, a schema for the rule, a place the user can see what they accumulated and a way to remove one — the Règles tab arriving through the side door. Instead, persistence in v1 is exactly one thing: `unsubscribed_at`, which the flagship card already writes, and `after_unsub`, which tells the user when a third party broke the promise. That is a forward commitment the app can actually honour, and it is the only one on the list that removes mail before it arrives.

Two further pieces of prior art are rejected outright and do not bend anything. Crowd-sourced suggestion ranking (Clean Email ranks partly on "messages other users have frequently cleaned") needs telemetry and a fleet, and is flatly incompatible with a local zero-account app — local engagement data is the substitute and is strictly better because it is about you. And the Rollup/digest (Unroll.me, Leave Me Alone, SaneBox) introduces a third destination for mail plus a scheduled compose-and-deliver mechanism, competes with the product's own triage, and shows up in both products as a coequal third button on every row — which is precisely the three-buttons-per-row density that got the Expéditeurs tab condemned in the first place.
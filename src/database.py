# SPDX-License-Identifier: GPL-3.0-or-later
import re
import sqlite3
import logging
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional, List, Dict, Any, Tuple, Union

from src import paths

logger = logging.getLogger(__name__)

DB_PATH = paths.DB_PATH


def _conn() -> sqlite3.Connection:
    paths.ensure_dirs()
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    # Enable FK enforcement so ON DELETE CASCADE on email_labels.label_id
    # actually triggers when a label is removed. SQLite ships with FK
    # checks OFF by default for backwards compatibility.
    con.execute("PRAGMA foreign_keys=ON")
    return con


def init_db():
    with _conn() as con:
        con.executescript("""
            CREATE TABLE IF NOT EXISTS emails (
                int_id      INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id  TEXT    UNIQUE NOT NULL,
                account_email TEXT  NOT NULL,
                uid         TEXT,
                subject     TEXT    DEFAULT '',
                sender      TEXT    DEFAULT '',
                recipient   TEXT    DEFAULT '',
                date_received TEXT  DEFAULT '',
                body_text   TEXT    DEFAULT '',
                body_html   TEXT    DEFAULT '',
                category    TEXT    DEFAULT 'pending',
                importance_score INTEGER DEFAULT 0,
                importance_reason TEXT DEFAULT '',
                summary     TEXT    DEFAULT '',
                needs_reply INTEGER DEFAULT 0,
                draft_response TEXT,
                is_read     INTEGER DEFAULT 0,
                is_notified INTEGER DEFAULT 0,
                folder      TEXT    DEFAULT 'inbox',
                fetched_at  TEXT    DEFAULT (datetime('now')),
                processed_at TEXT,
                tokens_in   INTEGER DEFAULT 0,
                tokens_out  INTEGER DEFAULT 0,
                local_classified INTEGER DEFAULT 0,
                date_received_iso TEXT
            );

            CREATE TABLE IF NOT EXISTS sync_state (
                account_email TEXT PRIMARY KEY,
                last_uid      TEXT,
                last_sync     TEXT,
                last_error    TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_emails_account    ON emails(account_email);
            CREATE INDEX IF NOT EXISTS idx_emails_category   ON emails(category);
            CREATE INDEX IF NOT EXISTS idx_emails_importance ON emails(importance_score DESC);
            CREATE INDEX IF NOT EXISTS idx_emails_date       ON emails(date_received DESC);
            CREATE INDEX IF NOT EXISTS idx_emails_read       ON emails(is_read);
        """)

        # Migrations idempotentes pour bases antérieures.
        cols = {row["name"] for row in con.execute("PRAGMA table_info(emails)")}
        if "folder" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN folder TEXT DEFAULT 'inbox'")
        if "is_favourite" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN is_favourite INTEGER DEFAULT 0")
        if "tokens_in" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN tokens_in INTEGER DEFAULT 0")
        if "tokens_out" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN tokens_out INTEGER DEFAULT 0")
        # sync_state migrations
        sync_cols = {row["name"] for row in con.execute("PRAGMA table_info(sync_state)")}
        if "last_error" not in sync_cols:
            con.execute("ALTER TABLE sync_state ADD COLUMN last_error TEXT")
        # Auto-test on save (Settings / onboarding) records its result here so
        # the UI can render a status badge per account without re-running the
        # IMAP login on every Settings page load. Distinct from `last_sync`/
        # `last_error` which track the actual mail-fetch lifecycle — a failed
        # test does not corrupt last_sync, and a fresh test does not reset
        # the last_uid cursor.
        if "last_test_at" not in sync_cols:
            con.execute("ALTER TABLE sync_state ADD COLUMN last_test_at TEXT")
        if "last_test_error" not in sync_cols:
            con.execute("ALTER TABLE sync_state ADD COLUMN last_test_error TEXT")

        if "local_classified" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN local_classified INTEGER DEFAULT 0")
            # Earlier prototype stored favourites as folder='favourite'. Promote
            # them to the new flag and put them back in the inbox so they show
            # up alongside non-starred mail.
            con.execute("UPDATE emails SET is_favourite = 1, folder = 'inbox' WHERE folder = 'favourite'")
        # NOTE: tokens_in / tokens_out are migrated once above (line ~80). A
        # duplicate block here re-ADDed them against the stale `cols` snapshot,
        # crashing legacy DBs that lacked the columns.
        # Step-3 cleanup feature: capture RFC 2369 + RFC 8058 unsubscribe info.
        if "list_unsubscribe" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN list_unsubscribe TEXT")
        if "list_unsubscribe_post" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN list_unsubscribe_post TEXT")
        if "unsubscribe_url" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN unsubscribe_url TEXT")
        if "unsubscribe_mailto" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN unsubscribe_mailto TEXT")
        if "unsubscribed_at" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN unsubscribed_at TEXT")
        # Attachment scan marker — NULL means "never scanned" (legacy rows
        # ingested before we extracted PJ at fetch time). The backfill job
        # consumes this column to know which messages still need a re-fetch.
        if "attachments_scanned_at" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN attachments_scanned_at TEXT")
        # Authentication-Results snapshot (SPF/DKIM/DMARC verdicts)
        # captured at ingest. Stored as compact JSON so the frontend
        # can decide one badge colour without re-parsing the headers.
        # NULL means "header was absent" → grey "non vérifié" badge.
        # See src/auth_results.py for the parsing logic.
        if "auth_results" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN auth_results TEXT")
        if "ai_attempts" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN ai_attempts INTEGER DEFAULT 0")
        # Phase 1 refactor LLM : trace quel provider a classifié chaque ligne.
        # Pour les lignes pré-refactor, on remplit rétrospectivement par
        # "openai" (le seul backend qui existait) afin que la colonne soit
        # exploitable côté UI/analytics sans une migration onéreuse.
        # Valeurs futures : "local-phi-3.5-mini-q4", "local-classifier"
        # (règles), "local-classifier-fallback" (rules après crash LLM).
        if "analyzed_by" not in cols:
            con.execute(
                "ALTER TABLE emails ADD COLUMN analyzed_by TEXT DEFAULT 'openai'"
            )
        # Sortable ISO 8601 timestamp derived from the RFC 2822 Date header.
        # Pure-string ORDER BY on date_received sorts on the weekday name
        # ("Wed" > "Sun" lexicographically), which silently hides recent mail.
        # NULL = legacy row not yet backfilled; backfill runs once on migration.
        if "date_received_iso" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN date_received_iso TEXT")
            _backfill_date_received_iso(con)
        # Prompt-injection guard (src/injection_guard.py): flag + reason set
        # when a body trips the scanner; the body is then NOT sent to the LLM.
        if "injection_flag" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN injection_flag INTEGER DEFAULT 0")
        if "injection_reason" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN injection_reason TEXT")
        # Auto-draft marker (P1.3): 1 = draft_response was pre-generated by the
        # per-account auto-draft (drives the ✎ badge).
        if "draft_auto" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN draft_auto INTEGER DEFAULT 0")
        # Conversation threading (src/threader.py). `email_references` (not
        # `references`, a reserved word). Ordered AFTER date_received_iso so the
        # thread backfill — which reads that column — sees it populated.
        _thread_cols_added = False
        if "in_reply_to" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN in_reply_to TEXT")
        if "email_references" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN email_references TEXT")
        if "thread_id" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN thread_id TEXT")
            _thread_cols_added = True
        if "normalized_subject" not in cols:
            con.execute("ALTER TABLE emails ADD COLUMN normalized_subject TEXT")
        con.execute("CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_emails_normsubj ON emails(normalized_subject)")
        if _thread_cols_added:
            _backfill_threads(con)
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_emails_date_iso "
            "ON emails(date_received_iso DESC)"
        )
        con.execute("CREATE INDEX IF NOT EXISTS idx_emails_folder ON emails(folder)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_emails_favourite ON emails(is_favourite)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_emails_unsub ON emails(unsubscribe_url, unsubscribe_mailto)")

        # Tiny KV bucket for app-level flags (unsubscribe backfill timestamp, etc.).
        con.execute("""
            CREATE TABLE IF NOT EXISTS kv (
                key   TEXT PRIMARY KEY,
                value TEXT
            )
        """)

        # Sender domain memoisation cache. Holds two pieces of state
        # per domain:
        #   • category — last AI/local classification, used to skip
        #     re-classifying every newsletter from the same sender.
        #   • images_trusted — opt-in bypass of the remote-image
        #     blocker. 0 = images stay blocked, 1 = render as normal.
        #     Toggled by the user via the per-email banner.
        con.execute("""
            CREATE TABLE IF NOT EXISTS sender_cache (
                domain          TEXT PRIMARY KEY,
                category        TEXT NOT NULL,
                updated_at      TEXT DEFAULT (datetime('now')),
                images_trusted  INTEGER DEFAULT 0
            )
        """)
        sc_cols = {row["name"] for row in con.execute("PRAGMA table_info(sender_cache)")}
        if "images_trusted" not in sc_cols:
            con.execute("ALTER TABLE sender_cache ADD COLUMN images_trusted INTEGER DEFAULT 0")

        # User-defined cleanup rules ("plugins").
        con.execute("""
            CREATE TABLE IF NOT EXISTS custom_rules (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                name         TEXT    NOT NULL,
                description  TEXT    DEFAULT '',
                icon         TEXT    DEFAULT 'filter',
                accent       TEXT    DEFAULT 'var(--accent)',
                filter_json  TEXT    NOT NULL DEFAULT '{}',
                actions_json TEXT    NOT NULL DEFAULT '["mark_read"]',
                enabled      INTEGER DEFAULT 1,
                position     INTEGER DEFAULT 0
            )
        """)

        # Attachments (security-aware: every row carries the threat
        # classification the fetcher computed at ingest, so the API can
        # enforce policy without re-scanning. `storage_path` is RELATIVE to
        # the configured attachments directory — the API resolves it via
        # is_path_within() to refuse traversal even if a malicious row got
        # injected somehow. `sha256` enables dedup + tamper detection.
        con.execute("""
            CREATE TABLE IF NOT EXISTS attachments (
                id                    INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id            TEXT    NOT NULL,
                account_email         TEXT    NOT NULL,
                filename              TEXT    NOT NULL,
                content_type_declared TEXT,
                content_type_sniffed  TEXT,
                size                  INTEGER NOT NULL,
                sha256                TEXT    NOT NULL,
                storage_path          TEXT,
                is_inline             INTEGER DEFAULT 0,
                threat_level          TEXT    NOT NULL DEFAULT 'safe',
                threat_reasons        TEXT    DEFAULT '[]',
                created_at            TEXT    DEFAULT (datetime('now'))
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_attachments_sha    ON attachments(sha256)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_attachments_threat ON attachments(threat_level)")

        # Outbound message log. Every send attempt — successful or not —
        # leaves a row here. The UI never reads `outbox` directly; the
        # table exists for diagnostics (why did this send fail?) and so a
        # future retry job can re-pick up `status='failed'` rows. Sent
        # messages also get a copy in the `emails` table at Phase 2 so
        # they show up in the Sent virtual folder.
        con.execute("""
            CREATE TABLE IF NOT EXISTS outbox (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                account_email TEXT    NOT NULL,
                message_id    TEXT,
                to_addr       TEXT    NOT NULL DEFAULT '',
                cc_addr       TEXT    DEFAULT '',
                bcc_addr      TEXT    DEFAULT '',
                subject       TEXT    DEFAULT '',
                body_text     TEXT    DEFAULT '',
                in_reply_to   TEXT,
                refs          TEXT,
                status        TEXT    NOT NULL DEFAULT 'pending',
                stage         TEXT,
                error         TEXT,
                created_at    TEXT    DEFAULT (datetime('now')),
                sent_at       TEXT
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_outbox_status  ON outbox(status)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_outbox_account ON outbox(account_email)")

        # User-typed drafts (composer auto-save + the Brouillons folder).
        # Distinct from `emails.draft_response` which holds AI-generated
        # reply suggestions tied to an inbound message — those stay
        # where they are. This table only tracks compose-from-scratch
        # work so it can survive across app restarts and show up under
        # folder='draft' in the sidebar.
        con.execute("""
            CREATE TABLE IF NOT EXISTS drafts (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                account_email   TEXT    NOT NULL,
                to_addr         TEXT    DEFAULT '',
                cc_addr         TEXT    DEFAULT '',
                bcc_addr        TEXT    DEFAULT '',
                subject         TEXT    DEFAULT '',
                body_text       TEXT    DEFAULT '',
                in_reply_to_int INTEGER,
                created_at      TEXT    DEFAULT (datetime('now')),
                updated_at      TEXT    DEFAULT (datetime('now'))
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_drafts_account ON drafts(account_email)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated_at DESC)")

        # Phase 3 — user-defined labels. Each row is a colour + name
        # the user creates in the sidebar; emails can carry multiple
        # labels via the join table below. Distinct from `category`
        # (a fixed enum from AI classification): labels are personal,
        # multi-valued, and never modified by the AI loop.
        con.execute("""
            CREATE TABLE IF NOT EXISTS labels (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT    NOT NULL UNIQUE,
                color      TEXT    NOT NULL DEFAULT '#94A3B8',
                position   INTEGER DEFAULT 0,
                created_at TEXT    DEFAULT (datetime('now'))
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_labels_position ON labels(position)")

        # Join table. Composite PK prevents duplicates; ON DELETE
        # CASCADE on label_id keeps the join clean when a label is
        # removed. We rely on PRAGMA foreign_keys=ON at connection
        # time (see _conn) for cascades to actually fire.
        con.execute("""
            CREATE TABLE IF NOT EXISTS email_labels (
                email_int_id INTEGER NOT NULL,
                label_id     INTEGER NOT NULL,
                created_at   TEXT    DEFAULT (datetime('now')),
                PRIMARY KEY (email_int_id, label_id),
                FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_email_labels_label ON email_labels(label_id)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_email_labels_email ON email_labels(email_int_id)")

        # Phase 4 — user-defined folders. Distinct from the four
        # built-ins (inbox / deleted / sent / draft) which stay
        # hardcoded in api._VALID_FOLDERS. Custom folders are
        # app-only (never pushed to IMAP) — moving an email
        # `folder = 'Factures'` just sets the column value; nothing
        # else has to know about it.
        con.execute("""
            CREATE TABLE IF NOT EXISTS folders (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                name          TEXT    NOT NULL UNIQUE,
                position      INTEGER DEFAULT 0,
                created_at    TEXT    DEFAULT (datetime('now'))
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_folders_position ON folders(position)")


def email_exists(message_id: str) -> bool:
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM emails WHERE message_id = ?", (message_id,)
        ).fetchone()
        return row is not None


def insert_email(data: Dict[str, Any]) -> bool:
    try:
        from src import threader
        raw_date = data.get("date_str", "")
        dt_iso: Optional[str] = None
        if raw_date:
            dt = _parse_email_date(raw_date)
            if dt is not None:
                dt_iso = dt.isoformat()
        in_reply_to = data.get("in_reply_to")
        references = data.get("references")
        norm_subject = threader.normalize_subject(data.get("subject", "") or "")
        with _conn() as con:
            # Resolve the conversation thread inside the same connection so the
            # parent lookup sees committed siblings from earlier in this sync.
            thread_id = threader.resolve_thread_id(
                con,
                message_id=data["message_id"],
                in_reply_to=in_reply_to,
                references=references,
                norm_subject=norm_subject,
                account=data["account"],
                date_iso=dt_iso,
            )
            con.execute("""
                INSERT OR IGNORE INTO emails
                    (message_id, account_email, uid, subject, sender, recipient,
                     date_received, date_received_iso, body_text, body_html,
                     list_unsubscribe, list_unsubscribe_post,
                     unsubscribe_url, unsubscribe_mailto, auth_results,
                     in_reply_to, email_references, thread_id, normalized_subject)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                data["message_id"],
                data["account"],
                data.get("uid"),
                data.get("subject", ""),
                data.get("sender", ""),
                data.get("recipient", ""),
                raw_date,
                dt_iso,
                data.get("body_text", ""),
                data.get("body_html", ""),
                # Empty-string sentinel = "inspected at ingest, no header found"
                # — keeps the row out of find_uids_missing_headers (which keys
                # off NULL = "never inspected") so missN doesn't bloat as
                # headerless mails arrive via the regular sync.
                data.get("list_unsubscribe") or "",
                data.get("list_unsubscribe_post"),
                data.get("unsubscribe_url"),
                data.get("unsubscribe_mailto"),
                data.get("auth_results"),
                in_reply_to,
                references,
                thread_id,
                norm_subject,
            ))
        return True
    except Exception as e:
        logger.error(f"insert_email error: {e}")
        return False


def update_email_ai(message_id: str, ai: Dict[str, Any]):
    with _conn() as con:
        con.execute("""
            UPDATE emails SET
                category         = ?,
                importance_score = ?,
                importance_reason= ?,
                summary          = ?,
                needs_reply      = ?,
                draft_response    = ?,
                tokens_in         = ?,
                tokens_out        = ?,
                local_classified  = ?,
                analyzed_by       = ?,
                processed_at      = datetime('now')
            WHERE message_id = ?
        """, (
            ai.get("category", "other"),
            max(1, min(10, int(ai.get("importance_score", 1)))),
            ai.get("importance_reason", ""),
            ai.get("summary", ""),
            1 if ai.get("needs_reply") else 0,
            ai.get("draft_response"),
            int(ai.get("tokens_in", 0)),
            int(ai.get("tokens_out", 0)),
            1 if ai.get("local_classified") else 0,
            # `analyzed_by` est posé par chaque provider (cf. OpenAIProvider).
            # Le fallback no-AI dans scheduler.py utilise "local-classifier".
            # Les règles `src/local_classifier.py` posent "local-classifier"
            # à terme (Phase 5) ; Phase 1 garde la rétro-compat avec
            # `local_classified=1` qui informe l'UI séparément.
            ai.get("analyzed_by") or ("openai" if not ai.get("local_classified") else "local-classifier"),
            message_id,
        ))


def set_draft_response(message_id: str, draft: str) -> None:
    with _conn() as con:
        con.execute(
            "UPDATE emails SET draft_response = ? WHERE message_id = ?",
            (draft, message_id),
        )


def set_needs_reply(message_id: str, on: bool) -> None:
    """Flip the `needs_reply` flag. Called after a manual draft generation
    so the list card surfaces the reply icon and the dashboard counters
    stay accurate."""
    with _conn() as con:
        con.execute(
            "UPDATE emails SET needs_reply = ? WHERE message_id = ?",
            (1 if on else 0, message_id),
        )


def flag_injection(message_id: str, reason: str = "") -> None:
    """Mark an email whose body tripped the prompt-injection scanner. The
    body is NOT sent to the LLM; this flag drives the ⚠ badge in the UI."""
    with _conn() as con:
        con.execute(
            "UPDATE emails SET injection_flag = 1, injection_reason = ? "
            "WHERE message_id = ?",
            (reason or "", message_id),
        )


def mark_auto_draft(message_id: str) -> None:
    """Flag an email as carrying a pre-generated auto-draft (P1.3). The draft
    body + tokens are persisted by update_email_ai in the same pass; this only
    sets the badge flag + needs_reply. Never sends anything."""
    with _conn() as con:
        con.execute(
            "UPDATE emails SET draft_auto = 1, needs_reply = 1 WHERE message_id = ?",
            (message_id,),
        )


def skip_old_email(message_id: str):
    with _conn() as con:
        con.execute(
            "UPDATE emails SET category = 'other', importance_score = 1, "
            "importance_reason = 'Email trop ancien, non traité par IA', "
            "processed_at = datetime('now') WHERE message_id = ?",
            (message_id,)
        )


def increment_ai_attempts(message_id: str) -> int:
    """Increment the AI processing attempt counter and return the new value."""
    with _conn() as con:
        con.execute(
            "UPDATE emails SET ai_attempts = ai_attempts + 1 WHERE message_id = ?",
            (message_id,),
        )
        row = con.execute(
            "SELECT ai_attempts FROM emails WHERE message_id = ?", (message_id,)
        ).fetchone()
        return row[0] if row else 0


def mark_ai_failed(message_id: str):
    """Mark an email as unclassifiable after repeated AI failures."""
    with _conn() as con:
        con.execute(
            "UPDATE emails SET category = 'other', importance_score = 1, "
            "importance_reason = 'Classification IA impossible après 3 tentatives', "
            "processed_at = datetime('now') WHERE message_id = ?",
            (message_id,),
        )


def skip_pending_emails() -> int:
    """Mark every pending email as other (manual drain). Returns count skipped."""
    with _conn() as con:
        cur = con.execute(
            "UPDATE emails SET category = 'other', importance_score = 1, "
            "importance_reason = 'File vidée manuellement', "
            "processed_at = datetime('now') WHERE category = 'pending'"
        )
        return cur.rowcount


def wipe_ai_analyses() -> int:
    """Efface toutes les données d'analyse IA et remet les emails en
    file d'attente. Garde le contenu brut (subject, body, sender, …) et
    l'état utilisateur (is_read, is_favourite, folder, label) — seuls
    les champs alimentés par l'analyseur ou le drafter sont réinitialisés.

    Utilisé par le bouton "Supprimer les analyses IA" dans Settings →
    Stockage. Au prochain sync, le scheduler retraitera chaque email
    via le provider actif (OpenAI ou local).

    Retourne le nombre d'emails impactés."""
    with _conn() as con:
        cur = con.execute(
            "UPDATE emails SET "
            "  category = 'pending', "
            "  importance_score = 0, "
            "  importance_reason = '', "
            "  summary = '', "
            "  needs_reply = 0, "
            "  draft_response = NULL, "
            "  processed_at = NULL, "
            "  tokens_in = 0, "
            "  tokens_out = 0, "
            "  local_classified = 0, "
            "  ai_attempts = 0, "
            "  is_notified = 0"
        )
        return cur.rowcount


def requeue_emails_by_reason(reason: str) -> int:
    """Reset emails matching `reason` back to the pending queue so the next
    sync re-processes them. Used when AI gets re-enabled and we want to
    re-analyze emails that previously got the no-AI fallback.

    `processed_at` is cleared so the throughput counters don't double-count
    once the real AI pass runs. The filter is intentionally narrow (exact
    string match) so unrelated classifications — age-skip, AI-failed,
    manual drain, local-rule hits — are left untouched."""
    with _conn() as con:
        cur = con.execute(
            "UPDATE emails SET "
            "  category = 'pending', "
            "  processed_at = NULL, "
            "  local_classified = 0, "
            "  importance_score = 1, "
            "  importance_reason = '', "
            "  summary = '', "
            "  draft_response = NULL, "
            "  ai_attempts = 0 "
            "WHERE importance_reason = ?",
            (reason,),
        )
        return cur.rowcount


def mark_read(message_id: str):
    with _conn() as con:
        con.execute("UPDATE emails SET is_read = 1 WHERE message_id = ?", (message_id,))


def mark_unread(message_id: str):
    with _conn() as con:
        con.execute("UPDATE emails SET is_read = 0 WHERE message_id = ?", (message_id,))


def update_email_category(message_id: str, category: str):
    with _conn() as con:
        con.execute("UPDATE emails SET category = ? WHERE message_id = ?", (category, message_id))


def update_email_folder(message_id: str, folder: str):
    with _conn() as con:
        con.execute("UPDATE emails SET folder = ? WHERE message_id = ?", (folder, message_id))


def set_favourite(message_id: str, on: bool):
    with _conn() as con:
        con.execute(
            "UPDATE emails SET is_favourite = ? WHERE message_id = ?",
            (1 if on else 0, message_id),
        )


def mark_notified(message_id: str):
    with _conn() as con:
        con.execute("UPDATE emails SET is_notified = 1 WHERE message_id = ?", (message_id,))


def get_emails(
    account: Optional[Union[str, List[str]]] = None,
    category: Optional[str] = None,
    is_read: Optional[bool] = None,
    needs_reply: Optional[bool] = None,
    folder: Optional[str] = None,
    sender: Optional[str] = None,
    label: Optional[int] = None,
    limit: int = 100,
    offset: int = 0,
) -> List[Dict]:
    # `label` joins on email_labels so a sidebar click on a personal
    # label filters the inbox to just that subset. Joined as INNER so
    # rows without an assignment are excluded — matches user intent
    # ("show me what I tagged Travail").
    if label is not None:
        q = (
            "SELECT e.* FROM emails e "
            "JOIN email_labels el ON el.email_int_id = e.int_id "
            "WHERE el.label_id = ?"
        )
        params: list = [int(label)]
    else:
        q = "SELECT * FROM emails WHERE 1=1"
        params = []

    # Single account → equality; list of accounts → IN(). Filtering
    # multi-account selections server-side keeps the LIMIT cap honest
    # (otherwise lighter accounts get evicted by busy ones once the
    # global top-N has been picked, then re-filtered client-side to
    # zero rows for those accounts).
    if isinstance(account, (list, tuple, set)):
        accs = [a for a in account if a]
        if len(accs) == 1:
            q += " AND account_email = ?"
            params.append(accs[0])
        elif accs:
            placeholders = ",".join("?" * len(accs))
            q += f" AND account_email IN ({placeholders})"
            params.extend(accs)
    elif account:
        q += " AND account_email = ?"
        params.append(account)
    if category and category != "all":
        q += " AND category = ?"
        params.append(category)
    if is_read is not None:
        q += " AND is_read = ?"
        params.append(1 if is_read else 0)
    if needs_reply is not None:
        q += " AND needs_reply = ?"
        params.append(1 if needs_reply else 0)
    if folder == "favourite":
        # 'favourite' is a virtual view: starred mail that has not been trashed.
        q += " AND is_favourite = 1 AND folder != 'deleted'"
    elif folder:
        q += " AND folder = ?"
        params.append(folder)
    if sender:
        q += " AND lower(sender) LIKE ?"
        params.append(f"%{sender.strip().lower()}%")

    q += (" ORDER BY COALESCE(date_received_iso, '0000') DESC, "
          "importance_score DESC LIMIT ? OFFSET ?")
    params += [limit, offset]

    with _conn() as con:
        return [dict(r) for r in con.execute(q, params).fetchall()]


def search_emails(parsed: Dict, account: Optional[str] = None,
                  limit: int = 100, offset: int = 0) -> List[Dict]:
    """Server-side search driven by a parsed Gmail-style query
    (src/search_query.parse_search_query). Parameterised LIKE conditions; the
    free-text `query` matches subject/body/sender/recipient. Date filters
    compare on the DATE portion only (substr 1..10) so they're timezone-offset
    independent."""
    q = "SELECT * FROM emails WHERE folder != 'deleted'"
    p: list = []
    if account:
        q += " AND account_email = ?"
        p.append(account)
    if parsed.get("query"):
        like = f"%{parsed['query'].strip().lower()}%"
        q += (" AND (lower(subject) LIKE ? OR lower(body_text) LIKE ? "
              "OR lower(sender) LIKE ? OR lower(recipient) LIKE ?)")
        p += [like, like, like, like]
    if parsed.get("from"):
        q += " AND lower(sender) LIKE ?"
        p.append(f"%{parsed['from'].strip().lower()}%")
    if parsed.get("to"):
        q += " AND lower(recipient) LIKE ?"
        p.append(f"%{parsed['to'].strip().lower()}%")
    if parsed.get("subject"):
        q += " AND lower(subject) LIKE ?"
        p.append(f"%{parsed['subject'].strip().lower()}%")
    if parsed.get("folder") == "favourite":
        q += " AND is_favourite = 1"
    elif parsed.get("folder"):
        q += " AND folder = ?"
        p.append(parsed["folder"])
    if parsed.get("is_read") is not None:
        q += " AND is_read = ?"
        p.append(1 if parsed["is_read"] else 0)
    if parsed.get("is_starred") is not None:
        q += " AND is_favourite = ?"
        p.append(1 if parsed["is_starred"] else 0)
    if parsed.get("has_attachment"):
        q += " AND message_id IN (SELECT message_id FROM attachments)"
    if parsed.get("date_start"):
        q += " AND substr(date_received_iso, 1, 10) >= ?"
        p.append(parsed["date_start"])
    if parsed.get("date_end"):
        q += " AND substr(date_received_iso, 1, 10) <= ?"
        p.append(parsed["date_end"])
    q += (" ORDER BY COALESCE(date_received_iso, '0000') DESC, "
          "importance_score DESC LIMIT ? OFFSET ?")
    p += [limit, offset]
    with _conn() as con:
        return [dict(r) for r in con.execute(q, p).fetchall()]


def get_thread(thread_id: str) -> List[Dict]:
    """All emails of a conversation, oldest first."""
    if not thread_id:
        return []
    with _conn() as con:
        return [dict(r) for r in con.execute(
            "SELECT * FROM emails WHERE thread_id = ? "
            "ORDER BY COALESCE(date_received_iso, '0000') ASC",
            (thread_id,),
        ).fetchall()]


def get_threads(account: Optional[str] = None, folder: Optional[str] = None,
                category: Optional[str] = None, limit: int = 100,
                offset: int = 0) -> List[Dict]:
    """Collapsed conversation view: the latest email per thread_id, plus
    `thread_count` and `thread_unread`. SQLite window functions (3.25+)."""
    where = "WHERE folder != 'deleted'"
    params: list = []
    if account:
        where += " AND account_email = ?"
        params.append(account)
    if folder == "favourite":
        where += " AND is_favourite = 1"
    elif folder:
        where += " AND folder = ?"
        params.append(folder)
    if category and category != "all":
        where += " AND category = ?"
        params.append(category)
    q = f"""
        SELECT * FROM (
            SELECT *,
                ROW_NUMBER() OVER (PARTITION BY COALESCE(thread_id, message_id)
                    ORDER BY COALESCE(date_received_iso, '0000') DESC) AS _rn,
                COUNT(*)         OVER (PARTITION BY COALESCE(thread_id, message_id)) AS thread_count,
                SUM(1 - is_read) OVER (PARTITION BY COALESCE(thread_id, message_id)) AS thread_unread
            FROM emails
            {where}
        ) WHERE _rn = 1
        ORDER BY COALESCE(date_received_iso, '0000') DESC, importance_score DESC
        LIMIT ? OFFSET ?
    """
    params += [limit, offset]
    with _conn() as con:
        rows = [dict(r) for r in con.execute(q, params).fetchall()]
    for r in rows:
        r.pop("_rn", None)
    return rows


def get_email_by_id(int_id: int) -> Optional[Dict]:
    with _conn() as con:
        row = con.execute("SELECT * FROM emails WHERE int_id = ?", (int_id,)).fetchone()
        return dict(row) if row else None


def get_pending_emails(limit: int = 30) -> List[Dict]:
    with _conn() as con:
        rows = con.execute("""
            SELECT * FROM emails
            WHERE category = 'pending'
            ORDER BY fetched_at DESC
            LIMIT ?
        """, (limit,)).fetchall()
        return [dict(r) for r in rows]


def get_unnotified_important(min_score: int = 7) -> List[Dict]:
    with _conn() as con:
        rows = con.execute("""
            SELECT * FROM emails
            WHERE importance_score >= ? AND is_notified = 0 AND category != 'pending'
            ORDER BY importance_score DESC
        """, (min_score,)).fetchall()
        return [dict(r) for r in rows]


def get_stats() -> Dict:
    with _conn() as con:
        by_cat = {
            r["category"]: r["count"]
            for r in con.execute(
                "SELECT category, COUNT(*) as count FROM emails GROUP BY category"
            ).fetchall()
        }
        unread = con.execute(
            "SELECT COUNT(*) FROM emails WHERE is_read = 0 AND category != 'pending'"
        ).fetchone()[0]
        needs_reply = con.execute(
            "SELECT COUNT(*) FROM emails WHERE needs_reply = 1 AND is_read = 0"
        ).fetchone()[0]
        total = con.execute("SELECT COUNT(*) FROM emails").fetchone()[0]

        return {
            "by_category": by_cat,
            "unread": unread,
            "needs_reply": needs_reply,
            "total": total,
        }


def get_sync_state(account_email: str) -> Optional[Dict]:
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM sync_state WHERE account_email = ?", (account_email,)
        ).fetchone()
        return dict(row) if row else None


def update_sync_state(account_email: str, last_uid: Optional[str] = None):
    """Record a successful sync tick — clears any stored error."""
    with _conn() as con:
        con.execute("""
            INSERT INTO sync_state (account_email, last_uid, last_sync, last_error)
            VALUES (?, ?, datetime('now'), NULL)
            ON CONFLICT(account_email) DO UPDATE SET
                last_uid   = COALESCE(excluded.last_uid, last_uid),
                last_sync  = datetime('now'),
                last_error = NULL
        """, (account_email, last_uid))


def set_sync_error(account_email: str, error: str):
    """Persist a per-account IMAP/fetch error without touching last_uid or last_sync."""
    with _conn() as con:
        con.execute("""
            INSERT INTO sync_state (account_email, last_uid, last_sync, last_error)
            VALUES (?, NULL, NULL, ?)
            ON CONFLICT(account_email) DO UPDATE SET
                last_error = excluded.last_error
        """, (account_email, str(error)[:500]))


def record_test_result(account_email: str, ok: bool, error: Optional[str] = None):
    """Persist the outcome of an explicit IMAP login test (auto-test on
    save in Settings/onboarding, or manual click on the per-row icon).

    Stamps `last_test_at` with `datetime('now')` regardless of outcome —
    a row whose `last_test_at IS NOT NULL` has been tested at least once.
    `last_test_error` carries the human-readable failure detail on
    failure and is set to NULL on success.

    Stays separate from `last_sync` / `last_error` (the actual mail-fetch
    lifecycle) so a failing test cannot corrupt the fetch cursor and a
    fresh test does not reset the last_uid.
    """
    with _conn() as con:
        con.execute("""
            INSERT INTO sync_state (account_email, last_test_at, last_test_error)
            VALUES (?, datetime('now'), ?)
            ON CONFLICT(account_email) DO UPDATE SET
                last_test_at    = datetime('now'),
                last_test_error = excluded.last_test_error
        """, (account_email, None if ok else (str(error or "")[:500])))


def remove_account_state(account_email: str):
    """Drop every sync_state row tied to `account_email` so the row is
    not left behind when the account is removed via Settings (otherwise
    a re-add would inherit stale `last_test_*` markers)."""
    with _conn() as con:
        con.execute(
            "DELETE FROM sync_state WHERE account_email = ?", (account_email,)
        )


# ── Dashboard helpers ─────────────────────────────────────────────────────────

def count_pending() -> int:
    with _conn() as con:
        return con.execute(
            "SELECT COUNT(*) FROM emails WHERE category = 'pending'"
        ).fetchone()[0]


def per_account_stats() -> List[Dict]:
    with _conn() as con:
        rows = con.execute("""
            SELECT
                account_email,
                SUM(CASE WHEN is_read = 0 AND folder = 'inbox' THEN 1 ELSE 0 END) AS unread,
                SUM(CASE WHEN needs_reply = 1 AND is_read = 0 AND folder = 'inbox' THEN 1 ELSE 0 END) AS needs_reply,
                SUM(CASE WHEN category = 'pending' AND folder = 'inbox' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN is_favourite = 1 AND folder != 'deleted' THEN 1 ELSE 0 END) AS favourite,
                COUNT(*) AS total
            FROM emails
            GROUP BY account_email
        """).fetchall()
        result: Dict[str, Dict] = {}
        for r in rows:
            d = dict(r)
            d.setdefault("draft", 0)
            result[d["account_email"]] = d
        # Drafts live in a separate table.
        draft_rows = con.execute("""
            SELECT account_email, COUNT(*) AS draft_count
            FROM drafts
            GROUP BY account_email
        """).fetchall()
        for dr in draft_rows:
            d = dict(dr)
            email = d["account_email"]
            entry = result.get(email)
            if entry is None:
                result[email] = {
                    "account_email": email,
                    "unread": 0, "needs_reply": 0, "pending": 0,
                    "favourite": 0, "total": 0,
                    "draft": int(d["draft_count"]),
                }
            else:
                entry["draft"] = int(d["draft_count"])
        return list(result.values())


def score_histogram() -> List[int]:
    buckets = [0] * 10
    with _conn() as con:
        rows = con.execute("""
            SELECT importance_score AS s, COUNT(*) AS c
            FROM emails
            WHERE category != 'pending' AND importance_score BETWEEN 1 AND 10
            GROUP BY importance_score
        """).fetchall()
        for r in rows:
            buckets[int(r["s"]) - 1] = int(r["c"])
    return buckets


def actionable_emails(limit: int = 10) -> List[Dict]:
    with _conn() as con:
        rows = con.execute("""
            SELECT int_id, sender, subject, importance_score, summary,
                   needs_reply, date_received, account_email, category
            FROM emails
            WHERE category != 'pending'
              AND is_read = 0
              AND (needs_reply = 1 OR importance_score >= 7)
            ORDER BY importance_score DESC, date_received_iso DESC
            LIMIT ?
        """, (limit,)).fetchall()
        return [dict(r) for r in rows]


def throughput_since(seconds: int) -> int:
    with _conn() as con:
        return con.execute(
            f"SELECT COUNT(*) FROM emails WHERE processed_at >= datetime('now', '-{int(seconds)} seconds')"
        ).fetchone()[0]


# ── Cleanup helpers (Top senders, bulk actions) ───────────────────────────────

_SENDER_ANGLE_RE = re.compile(r"<([^>]+)>")


def _canonical_sender(raw: str) -> Tuple[str, str]:
    """Return (display_name, canonical_email_lowercased) from a raw From header."""
    if not raw:
        return ("", "")
    m = _SENDER_ANGLE_RE.search(raw)
    if m:
        addr = m.group(1).strip().lower()
        name = raw.split("<", 1)[0].strip().strip('"').strip()
        return (name or addr, addr)
    s = raw.strip()
    return (s, s.lower())


def _parse_email_date(raw: str):
    """Parse a Date header into a tz-aware datetime, or None.

    Accepts both ISO 8601 (rows already migrated) and RFC 2822 (raw header).
    Lexicographic ordering on the raw RFC 2822 string is wrong (it sorts on
    the weekday name) so we always normalise before comparing dates.
    Always returns a timezone-aware datetime (assumes UTC if naive).
    """
    if not raw:
        return None
    # Fast-path ISO 8601 — already-migrated rows
    try:
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        pass
    # Fallback RFC 2822 — raw Date header
    try:
        dt = parsedate_to_datetime(raw)
        if dt and dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (TypeError, ValueError):
        return None


def _backfill_date_received_iso(con) -> int:
    """Compute date_received_iso for every NULL row.

    Idempotent — safe to re-run. Sub-second on small bases, ~10s on 100k rows.
    """
    rows = con.execute(
        "SELECT int_id, date_received FROM emails "
        "WHERE date_received_iso IS NULL AND date_received != ''"
    ).fetchall()
    updated = 0
    for r in rows:
        dt = _parse_email_date(r["date_received"])
        if dt is None:
            continue
        con.execute(
            "UPDATE emails SET date_received_iso = ? WHERE int_id = ?",
            (dt.isoformat(), r["int_id"]),
        )
        updated += 1
    logger.info(f"date_received_iso backfill : {updated} ligne(s) mises a jour")
    return updated


def _backfill_threads(con) -> int:
    """Assign thread_id + normalized_subject to every row that lacks one.

    Processed chronologically so a parent is resolved before its replies.
    Idempotent — only touches rows where thread_id IS NULL. Runs after the
    date_received_iso backfill so the subject-fallback window has dates."""
    from src import threader
    rows = con.execute(
        "SELECT int_id, message_id, account_email, subject, in_reply_to, "
        "email_references, date_received_iso FROM emails WHERE thread_id IS NULL "
        "ORDER BY COALESCE(date_received_iso, '0000') ASC"
    ).fetchall()
    updated = 0
    for r in rows:
        norm = threader.normalize_subject(r["subject"] or "")
        tid = threader.resolve_thread_id(
            con,
            message_id=r["message_id"],
            in_reply_to=r["in_reply_to"],
            references=r["email_references"],
            norm_subject=norm,
            account=r["account_email"],
            date_iso=r["date_received_iso"],
        )
        con.execute(
            "UPDATE emails SET thread_id = ?, normalized_subject = ? WHERE int_id = ?",
            (tid, norm, r["int_id"]),
        )
        updated += 1
    logger.info(f"thread backfill : {updated} ligne(s) regroupees")
    return updated


def top_senders(limit: int = 50, account: Optional[str] = None) -> List[Dict]:
    """Aggregate emails by canonical sender for the cleanup view.

    Excludes the trash so users only see what is still cluttering their inboxes.
    Display name kept is the most recent one seen for that address.
    """
    q = """
        SELECT message_id, account_email, sender, category,
               importance_score, is_read, date_received
        FROM emails
        WHERE folder != 'deleted'
    """
    params: list = []
    if account:
        q += " AND account_email = ?"
        params.append(account)

    groups: Dict[str, Dict] = {}
    with _conn() as con:
        rows = con.execute(q, params).fetchall()

    for r in rows:
        display, addr = _canonical_sender(r["sender"] or "")
        if not addr:
            continue
        g = groups.get(addr)
        if g is None:
            g = {
                "email": addr,
                "name": display,
                "total": 0,
                "unread": 0,
                "newsletter": 0,
                "important": 0,
                "transactional": 0,
                "other": 0,
                "spam": 0,
                "pending": 0,
                "_score_sum": 0,
                "_score_n": 0,
                "_last_dt": None,
                "_first_dt": None,
                "last_seen": "",
                "first_seen": "",
                "accounts": set(),
            }
            groups[addr] = g
        g["total"] += 1
        if not r["is_read"]:
            g["unread"] += 1
        cat = (r["category"] or "other")
        if cat in g:
            g[cat] += 1
        score = int(r["importance_score"] or 0)
        if cat != "pending" and score > 0:
            g["_score_sum"] += score
            g["_score_n"] += 1
        raw_d = r["date_received"] or ""
        dt = _parse_email_date(raw_d)
        if dt is not None:
            if g["_last_dt"] is None or dt > g["_last_dt"]:
                g["_last_dt"] = dt
                g["last_seen"] = dt.isoformat()
                # Refresh the display label with the most-recent name seen.
                if display:
                    g["name"] = display
            if g["_first_dt"] is None or dt < g["_first_dt"]:
                g["_first_dt"] = dt
                g["first_seen"] = dt.isoformat()
        g["accounts"].add(r["account_email"])

    out = []
    for g in groups.values():
        avg = (g["_score_sum"] / g["_score_n"]) if g["_score_n"] else 0
        out.append({
            "email": g["email"],
            "name": g["name"],
            "total": g["total"],
            "unread": g["unread"],
            "newsletter": g["newsletter"],
            "important": g["important"],
            "transactional": g["transactional"],
            "other": g["other"],
            "spam": g["spam"],
            "pending": g["pending"],
            "avg_score": round(avg, 1),
            "last_seen": g["last_seen"],
            "first_seen": g["first_seen"],
            "accounts": sorted(g["accounts"]),
        })

    out.sort(key=lambda s: (s["total"], s["unread"]), reverse=True)
    return out[: max(1, limit)]


def find_by_sender(sender_email: str, account: Optional[str] = None) -> List[Dict]:
    """Return live (non-trashed) messages whose canonical sender matches.

    Used by bulk cleanup actions to know which messages to update both in
    SQLite and on IMAP.
    """
    target = (sender_email or "").strip().lower()
    if not target:
        return []
    q = """
        SELECT message_id, account_email, uid, sender, is_read, folder
        FROM emails
        WHERE folder != 'deleted'
    """
    params: list = []
    if account:
        q += " AND account_email = ?"
        params.append(account)
    with _conn() as con:
        rows = con.execute(q, params).fetchall()
    out = []
    for r in rows:
        _, addr = _canonical_sender(r["sender"] or "")
        if addr == target:
            out.append(dict(r))
    return out


def find_by_filter(
    *,
    categories: Optional[List[str]] = None,
    max_score: Optional[int] = None,
    is_read: Optional[bool] = None,
    older_than_days: Optional[int] = None,
    account: Optional[str] = None,
    subject_keywords: Optional[List[str]] = None,
    sender_keywords: Optional[List[str]] = None,
    limit: Optional[int] = None,
) -> List[Dict]:
    """Return live (non-trashed) messages matching a filter spec.

    All fields combine with AND. Within subject_keywords / sender_keywords,
    values are OR'd (any match is sufficient). Date filtering happens in
    Python because `date_received` is stored as the raw RFC 2822 header
    string (strings don't sort by date). Everything else is pushed to SQL.
    """
    q = """
        SELECT int_id, message_id, account_email, uid, sender, subject,
               date_received, category, importance_score, is_read, folder
        FROM emails
        WHERE folder != 'deleted'
    """
    params: list = []
    if categories:
        placeholders = ",".join("?" for _ in categories)
        q += f" AND category IN ({placeholders})"
        params.extend(categories)
    if is_read is not None:
        q += " AND is_read = ?"
        params.append(1 if is_read else 0)
    if max_score is not None:
        q += " AND importance_score <= ? AND category != 'pending'"
        params.append(int(max_score))
    if account:
        q += " AND account_email = ?"
        params.append(account)
    # subject_keywords and sender_keywords are combined with OR between them
    # (an email matches if ANY subject keyword OR ANY sender keyword matches).
    # This is more intuitive for plugin-style rules where both fields identify
    # the same category of emails via different signals.
    if subject_keywords or sender_keywords:
        parts = []
        if subject_keywords:
            sub_clauses = " OR ".join("LOWER(subject) LIKE ?" for _ in subject_keywords)
            parts.append(f"({sub_clauses})")
            params.extend(f"%{kw.lower()}%" for kw in subject_keywords)
        if sender_keywords:
            snd_clauses = " OR ".join("LOWER(sender) LIKE ?" for _ in sender_keywords)
            parts.append(f"({snd_clauses})")
            params.extend(f"%{kw.lower()}%" for kw in sender_keywords)
        q += f" AND ({' OR '.join(parts)})"

    with _conn() as con:
        rows = con.execute(q, params).fetchall()

    if older_than_days is not None and older_than_days > 0:
        from datetime import datetime, timedelta, timezone
        cutoff = datetime.now(timezone.utc) - timedelta(days=int(older_than_days))
        filtered = []
        for r in rows:
            dt = _parse_email_date(r["date_received"])
            # If the date is unparseable we err on the safe side and skip
            # (don't auto-delete unknown-age messages).
            if dt is not None and dt < cutoff:
                filtered.append(r)
        rows = filtered

    out = [dict(r) for r in rows]
    if limit is not None and limit > 0:
        out = out[: int(limit)]
    return out


def bulk_set_folder(message_ids: List[str], folder: str):
    if not message_ids:
        return 0
    with _conn() as con:
        placeholders = ",".join("?" for _ in message_ids)
        cur = con.execute(
            f"UPDATE emails SET folder = ? WHERE message_id IN ({placeholders})",
            (folder, *message_ids),
        )
        return cur.rowcount


def bulk_mark_read(message_ids: List[str], is_read: bool):
    if not message_ids:
        return 0
    with _conn() as con:
        placeholders = ",".join("?" for _ in message_ids)
        cur = con.execute(
            f"UPDATE emails SET is_read = ? WHERE message_id IN ({placeholders})",
            (1 if is_read else 0, *message_ids),
        )
        return cur.rowcount


# ── Unsubscribe (RFC 2369 + RFC 8058) ─────────────────────────────────────────

# `List-Unsubscribe` is a comma-separated list of `<…>` entries; we want the
# first https URL and the first mailto address. The RFC 8058 header
# `List-Unsubscribe-Post: List-Unsubscribe=One-Click` opts the URL into
# fully-automated unsubscription.
_LU_TOKEN_RE = re.compile(r"<\s*([^>]+?)\s*>")


def parse_list_unsubscribe(raw_lu: Optional[str], raw_post: Optional[str]) -> Dict[str, Any]:
    url: Optional[str] = None
    mailto: Optional[str] = None
    tokens = _LU_TOKEN_RE.findall(raw_lu or "")
    # Some senders ship the list without angle brackets; fall back to splitting.
    if not tokens and raw_lu:
        tokens = [t.strip() for t in raw_lu.split(",") if t.strip()]
    for tok in tokens:
        t = tok.strip()
        if not t:
            continue
        low = t.lower()
        if low.startswith("https://") or low.startswith("http://"):
            if url is None:
                url = t
        elif low.startswith("mailto:"):
            if mailto is None:
                mailto = t[len("mailto:"):]
    one_click = bool(raw_post and "one-click" in raw_post.lower())
    return {
        "list_unsubscribe": (raw_lu or None),
        "list_unsubscribe_post": (raw_post or None),
        "unsubscribe_url": url,
        "unsubscribe_mailto": mailto,
        "one_click": one_click,
    }


def update_unsubscribe_headers(message_id: str, parsed: Dict[str, Any]):
    """Persist headers fetched via the backfill IMAP pass.

    Stamps `list_unsubscribe` with an empty string when the header was
    absent so the row is distinguishable from "never inspected" (NULL) on
    the next backfill — otherwise we'd re-fetch headerless mails forever.
    """
    raw_lu = parsed.get("list_unsubscribe")
    # Empty string sentinel = "checked, no header found". NULL = "not yet
    # inspected" and remains the trigger for find_uids_missing_headers.
    lu_value = raw_lu if raw_lu else ""
    with _conn() as con:
        con.execute("""
            UPDATE emails SET
                list_unsubscribe       = ?,
                list_unsubscribe_post  = ?,
                unsubscribe_url        = ?,
                unsubscribe_mailto     = ?
            WHERE message_id = ?
        """, (
            lu_value,
            parsed.get("list_unsubscribe_post"),
            parsed.get("unsubscribe_url"),
            parsed.get("unsubscribe_mailto"),
            message_id,
        ))


def find_uids_missing_headers(account: Optional[str] = None) -> List[Dict]:
    """Rows whose List-Unsubscribe header has never been captured. Used by
    the backfill job — we only re-fetch headers for those, never refetch
    rows that already have a known result (NULL = "not yet inspected"; the
    backfill writes EVERY value, even empty strings, so a non-NULL value
    means "checked once and either had something or didn't")."""
    q = """
        SELECT message_id, account_email, uid
        FROM emails
        WHERE folder != 'deleted'
          AND uid IS NOT NULL AND uid != ''
          AND list_unsubscribe IS NULL
    """
    params: list = []
    if account:
        q += " AND account_email = ?"
        params.append(account)
    with _conn() as con:
        return [dict(r) for r in con.execute(q, params).fetchall()]


def count_emails_missing_headers(account: Optional[str] = None) -> int:
    rows = find_uids_missing_headers(account)
    return len(rows)


def unsubscribe_senders(account: Optional[str] = None) -> List[Dict]:
    """Aggregate by canonical sender, keeping only senders with at least one
    captured unsubscribe URL or mailto. Returns the freshest URL/mailto for
    that sender (so the action targets a recent endpoint) and a flag for
    one-click eligibility."""
    q = """
        SELECT message_id, account_email, sender, subject, date_received,
               is_read, list_unsubscribe_post,
               unsubscribe_url, unsubscribe_mailto, unsubscribed_at
        FROM emails
        WHERE folder != 'deleted'
          AND (unsubscribe_url IS NOT NULL OR unsubscribe_mailto IS NOT NULL)
    """
    params: list = []
    if account:
        q += " AND account_email = ?"
        params.append(account)
    with _conn() as con:
        rows = con.execute(q, params).fetchall()

    groups: Dict[str, Dict] = {}
    for r in rows:
        display, addr = _canonical_sender(r["sender"] or "")
        if not addr:
            continue
        g = groups.get(addr)
        if g is None:
            g = {
                "email": addr,
                "name": display,
                "total": 0,
                "unread": 0,
                "_last_dt": None,
                "last_seen": "",
                "http_url": None,
                "mailto": None,
                "has_one_click": False,
                "unsubscribed_at": None,
                "accounts": set(),
                "sample_uids": [],  # one (account, uid, message_id) per row, recent-first
            }
            groups[addr] = g
        g["total"] += 1
        if not r["is_read"]:
            g["unread"] += 1
        g["accounts"].add(r["account_email"])
        # Track unsubscribed state — set if ANY message has it (we mark every
        # row when the user successfully unsubscribes from a sender).
        if r["unsubscribed_at"]:
            g["unsubscribed_at"] = r["unsubscribed_at"]

        dt = _parse_email_date(r["date_received"] or "")
        is_newer = dt is not None and (g["_last_dt"] is None or dt > g["_last_dt"])
        if is_newer:
            g["_last_dt"] = dt
            g["last_seen"] = dt.isoformat()
            if display:
                g["name"] = display
        # Pick the URL/mailto from the most recent row that has them.
        if is_newer or (g["http_url"] is None and r["unsubscribe_url"]):
            if r["unsubscribe_url"]:
                g["http_url"] = r["unsubscribe_url"]
            if r["unsubscribe_mailto"]:
                g["mailto"] = r["unsubscribe_mailto"]
            if r["list_unsubscribe_post"] and "one-click" in r["list_unsubscribe_post"].lower():
                g["has_one_click"] = True

    out = []
    for g in groups.values():
        out.append({
            "email": g["email"],
            "name": g["name"],
            "total": g["total"],
            "unread": g["unread"],
            "last_seen": g["last_seen"],
            "http_url": g["http_url"],
            "mailto": g["mailto"],
            "has_one_click": g["has_one_click"],
            "unsubscribed_at": g["unsubscribed_at"],
            "accounts": sorted(g["accounts"]),
        })
    out.sort(key=lambda s: (s["unsubscribed_at"] is not None, -s["total"], s["email"]))
    return out


def unsubscribe_sender_target(sender_email: str, account: Optional[str] = None) -> Optional[Dict]:
    """Pick the freshest captured unsubscribe target (URL/mailto/one-click)
    for a sender. Returns None when no row has any. Used by the action
    endpoint when the user clicks "Se désabonner" — we want the most recent
    URL because senders rotate them per-campaign."""
    q = """
        SELECT date_received, list_unsubscribe_post,
               unsubscribe_url, unsubscribe_mailto, sender
        FROM emails
        WHERE folder != 'deleted'
          AND (unsubscribe_url IS NOT NULL OR unsubscribe_mailto IS NOT NULL)
    """
    params: list = []
    if account:
        q += " AND account_email = ?"
        params.append(account)
    target = (sender_email or "").strip().lower()
    if not target:
        return None
    with _conn() as con:
        rows = con.execute(q, params).fetchall()
    best: Optional[Dict] = None
    best_dt = None
    for r in rows:
        _, addr = _canonical_sender(r["sender"] or "")
        if addr != target:
            continue
        dt = _parse_email_date(r["date_received"] or "")
        if best is None or (dt is not None and (best_dt is None or dt > best_dt)):
            best = dict(r)
            best_dt = dt
    if best is None:
        return None
    one_click = bool(best.get("list_unsubscribe_post") and "one-click" in best["list_unsubscribe_post"].lower())
    return {
        "url": best.get("unsubscribe_url"),
        "mailto": best.get("unsubscribe_mailto"),
        "one_click": one_click,
    }


def mark_sender_unsubscribed(sender_email: str, account: Optional[str] = None) -> int:
    """Stamp every row of `sender_email` (optionally filtered by account)
    with `unsubscribed_at = now`, so the rail shows a "désabonné" state for
    every existing message and future messages from the same sender."""
    target = (sender_email or "").strip().lower()
    if not target:
        return 0
    q = "SELECT message_id, sender FROM emails WHERE 1=1"
    params: list = []
    if account:
        q += " AND account_email = ?"
        params.append(account)
    with _conn() as con:
        rows = con.execute(q, params).fetchall()
        ids = []
        for r in rows:
            _, addr = _canonical_sender(r["sender"] or "")
            if addr == target:
                ids.append(r["message_id"])
        if not ids:
            return 0
        placeholders = ",".join("?" for _ in ids)
        cur = con.execute(
            f"UPDATE emails SET unsubscribed_at = datetime('now') WHERE message_id IN ({placeholders})",
            ids,
        )
        return cur.rowcount


# ── Tiny KV (app-level flags) ─────────────────────────────────────────────────

def set_kv(key: str, value: str) -> None:
    with _conn() as con:
        con.execute(
            "INSERT INTO kv (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def get_kv(key: str) -> Optional[str]:
    with _conn() as con:
        row = con.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None


def throughput_buckets(minutes: int = 30) -> List[int]:
    """Return one count per minute over the last `minutes` minutes (oldest first)."""
    buckets = [0] * minutes
    with _conn() as con:
        rows = con.execute(f"""
            SELECT
                CAST((julianday('now') - julianday(processed_at)) * 24 * 60 AS INTEGER) AS mins_ago,
                COUNT(*) AS c
            FROM emails
            WHERE processed_at IS NOT NULL
              AND processed_at >= datetime('now', '-{int(minutes)} minutes')
            GROUP BY mins_ago
        """).fetchall()
        for r in rows:
            m = int(r["mins_ago"])
            if 0 <= m < minutes:
                buckets[minutes - 1 - m] = int(r["c"])
    return buckets


def throughput_buckets_daily(days: int = 30) -> List[int]:
    """Return one count per day over the last `days` days (oldest first)."""
    buckets = [0] * days
    with _conn() as con:
        rows = con.execute(f"""
            SELECT
                CAST(julianday('now') - julianday(date(processed_at)) AS INTEGER) AS days_ago,
                COUNT(*) AS c
            FROM emails
            WHERE processed_at IS NOT NULL
              AND processed_at >= datetime('now', '-{int(days)} days')
            GROUP BY days_ago
        """).fetchall()
        for r in rows:
            d = int(r["days_ago"])
            if 0 <= d < days:
                buckets[days - 1 - d] = int(r["c"])
    return buckets


_hours_dist_cache: Tuple[float, List[int]] = (0.0, [0] * 24)
_HOURS_DIST_TTL_S = 30.0


def hours_distribution() -> List[int]:
    """Return email counts by hour of day (0..23) based on date_received_iso.

    Reads the ISO column (not the raw RFC 2822 one) so we can extract the
    hour with a string slice instead of parsing N dates per dashboard tick.
    Cached for 30s — the dashboard polls every 5s but a heatmap that's at
    most 30s stale is invisible to the eye.
    """
    global _hours_dist_cache
    now = time.time()
    cached_at, cached = _hours_dist_cache
    if now - cached_at < _HOURS_DIST_TTL_S:
        return cached
    buckets = [0] * 24
    with _conn() as con:
        rows = con.execute(
            "SELECT date_received_iso FROM emails "
            "WHERE date_received_iso IS NOT NULL AND folder != 'deleted'"
        ).fetchall()
    for r in rows:
        # ISO 8601 hour is at offset 11..13 (after "YYYY-MM-DDT"). Cheaper
        # than fromisoformat() × N because we don't need anything else.
        try:
            buckets[int(r["date_received_iso"][11:13])] += 1
        except (TypeError, ValueError, IndexError):
            continue
    _hours_dist_cache = (now, buckets)
    return buckets


def count_processed() -> int:
    """Total emails that have been AI-analysed (processed_at is set)."""
    with _conn() as con:
        return con.execute(
            "SELECT COUNT(*) FROM emails WHERE processed_at IS NOT NULL"
        ).fetchone()[0]


def token_totals_30d() -> Dict[str, int]:
    """Sum of actual input/output tokens for emails processed in the last 30 days."""
    with _conn() as con:
        row = con.execute("""
            SELECT
                COALESCE(SUM(tokens_in),  0) AS total_in,
                COALESCE(SUM(tokens_out), 0) AS total_out
            FROM emails
            WHERE processed_at >= datetime('now', '-30 days')
              AND tokens_in > 0
        """).fetchone()
        return {"tokens_in": int(row["total_in"]), "tokens_out": int(row["total_out"])}


# ── Sender domain memoisation ─────────────────────────────────────────────────

def get_sender_category(domain: str) -> Optional[str]:
    """Return a previously learned category for *domain*, or None if unknown."""
    if not domain:
        return None
    with _conn() as con:
        row = con.execute(
            "SELECT category FROM sender_cache WHERE domain = ?", (domain.lower(),)
        ).fetchone()
        return row["category"] if row else None


def set_sender_category(domain: str, category: str) -> None:
    """Persist / update the category associated with *domain*."""
    if not domain or not category:
        return
    with _conn() as con:
        con.execute("""
            INSERT INTO sender_cache (domain, category, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(domain) DO UPDATE SET
                category   = excluded.category,
                updated_at = excluded.updated_at
        """, (domain.lower(), category))


def is_sender_trusted_for_images(domain: str) -> bool:
    """True iff the user has explicitly opted-in to load remote images
    from `domain`. Default (no row, or row with images_trusted=0) is
    blocked — that's the whole point of the remote-image blocker."""
    if not domain:
        return False
    with _conn() as con:
        row = con.execute(
            "SELECT images_trusted FROM sender_cache WHERE domain = ?",
            (domain.lower(),),
        ).fetchone()
        return bool(row and row["images_trusted"])


def set_sender_trusted_for_images(domain: str, trusted: bool) -> None:
    """Toggle the per-domain image-trust flag. Inserts a row with an
    empty category when the domain isn't yet known to sender_cache —
    `get_sender_category` returns "" then None for that case, which is
    fine (it just means the AI fast-path won't kick in)."""
    if not domain:
        return
    flag = 1 if trusted else 0
    with _conn() as con:
        con.execute("""
            INSERT INTO sender_cache (domain, category, images_trusted, updated_at)
            VALUES (?, '', ?, datetime('now'))
            ON CONFLICT(domain) DO UPDATE SET
                images_trusted = excluded.images_trusted,
                updated_at     = excluded.updated_at
        """, (domain.lower(), flag))


# ── Custom rules ("plugins") ──────────────────────────────────────────────────

def get_custom_rules() -> List[Dict]:
    with _conn() as con:
        rows = con.execute(
            "SELECT * FROM custom_rules ORDER BY position ASC, id ASC"
        ).fetchall()
    return [dict(r) for r in rows]


def create_custom_rule(name: str, description: str, icon: str, accent: str,
                       filter_json: str, actions_json: str) -> int:
    with _conn() as con:
        pos = con.execute("SELECT COALESCE(MAX(position)+1, 0) FROM custom_rules").fetchone()[0]
        cur = con.execute(
            """INSERT INTO custom_rules (name, description, icon, accent, filter_json, actions_json, position)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (name, description, icon, accent, filter_json, actions_json, pos),
        )
        return cur.lastrowid


def update_custom_rule(rule_id: int, **fields) -> bool:
    allowed = {"name", "description", "icon", "accent", "filter_json", "actions_json", "enabled", "position"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return False
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    params = list(updates.values()) + [rule_id]
    with _conn() as con:
        con.execute(f"UPDATE custom_rules SET {set_clause} WHERE id = ?", params)
    return True


def delete_custom_rule(rule_id: int) -> bool:
    with _conn() as con:
        con.execute("DELETE FROM custom_rules WHERE id = ?", (rule_id,))
    return True


# ── Attachments ───────────────────────────────────────────────────────────────

def insert_attachment(
    *,
    message_id: str,
    account_email: str,
    filename: str,
    content_type_declared: Optional[str],
    content_type_sniffed: Optional[str],
    size: int,
    sha256: str,
    storage_path: Optional[str],
    is_inline: bool,
    threat_level: str,
    threat_reasons_json: str,
) -> int:
    """Persist one attachment row, idempotently.

    Dedupe key is `(message_id, sha256)` — same content in the same message
    is the same attachment, regardless of MIME structure. This protects
    against three real-world cases:
      • the same PJ appearing in both branches of `multipart/alternative`
      • a race between the lazy scan (triggered on email open) and the
        global backfill running in parallel
      • a manual re-run of the backfill after a crash

    Returns the existing row id when a duplicate is detected (the disk
    file written by the second pass is left orphaned but never served —
    the existing row keeps the canonical storage_path).

    `storage_path` may be None when the file was blocked before reaching
    disk (`block_dangerous` mode) — the metadata is still recorded so the
    UI can surface "1 fichier dangereux refusé".
    """
    with _conn() as con:
        existing = con.execute(
            "SELECT id FROM attachments WHERE message_id = ? AND sha256 = ? LIMIT 1",
            (message_id, sha256),
        ).fetchone()
        if existing:
            return int(existing["id"])
        cur = con.execute(
            """INSERT INTO attachments
               (message_id, account_email, filename, content_type_declared,
                content_type_sniffed, size, sha256, storage_path, is_inline,
                threat_level, threat_reasons)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                message_id, account_email, filename, content_type_declared,
                content_type_sniffed, int(size), sha256, storage_path,
                1 if is_inline else 0, threat_level, threat_reasons_json,
            ),
        )
        return cur.lastrowid


def deduplicate_attachments() -> Dict[str, int]:
    """One-shot cleanup of pre-existing duplicates created before the
    insert dedupe was added. Keeps the lowest id per (message_id, sha256)
    group; deletes the rest. Orphaned files on disk are left alone — they
    cost ~kB each and the API never serves them.

    Returns counters for logging.
    """
    with _conn() as con:
        # Find groups with duplicates first so we know what we're deleting.
        groups = con.execute(
            """
            SELECT message_id, sha256, COUNT(*) AS c, MIN(id) AS keep_id
            FROM attachments
            GROUP BY message_id, sha256
            HAVING c > 1
            """
        ).fetchall()
        n_groups = len(groups)
        n_removed = 0
        for g in groups:
            cur = con.execute(
                "DELETE FROM attachments "
                "WHERE message_id = ? AND sha256 = ? AND id != ?",
                (g["message_id"], g["sha256"], g["keep_id"]),
            )
            n_removed += cur.rowcount or 0
        return {"groups": n_groups, "removed": n_removed}


def get_attachments_for_message(message_id: str) -> List[Dict]:
    """All attachments for one email, ordered by id (insertion order). Used
    by the read pane and as a sanity check in tests."""
    with _conn() as con:
        rows = con.execute(
            "SELECT * FROM attachments WHERE message_id = ? ORDER BY id ASC",
            (message_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_attachment(att_id: int) -> Optional[Dict]:
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM attachments WHERE id = ?", (att_id,)
        ).fetchone()
        return dict(row) if row else None


def message_has_attachments(message_id: str) -> bool:
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM attachments WHERE message_id = ? LIMIT 1",
            (message_id,),
        ).fetchone()
        return row is not None


def find_messages_to_scan_attachments(
    account: Optional[str] = None, limit: Optional[int] = None
) -> List[Dict]:
    """Rows that still need their attachments inspected via IMAP.

    Excludes deleted mail (no point re-fetching what the user trashed) and
    rows without a UID (we can't refetch those — they were ingested via a
    fallback path that lost the UID).
    """
    q = """
        SELECT message_id, account_email, uid
        FROM emails
        WHERE attachments_scanned_at IS NULL
          AND uid IS NOT NULL AND uid != ''
          AND folder != 'deleted'
    """
    params: list = []
    if account:
        q += " AND account_email = ?"
        params.append(account)
    q += " ORDER BY date_received_iso DESC"
    if limit and limit > 0:
        q += " LIMIT ?"
        params.append(int(limit))
    with _conn() as con:
        return [dict(r) for r in con.execute(q, params).fetchall()]


def count_messages_to_scan_attachments(account: Optional[str] = None) -> int:
    return len(find_messages_to_scan_attachments(account=account))


def mark_attachments_scanned(message_id: str) -> None:
    with _conn() as con:
        con.execute(
            "UPDATE emails SET attachments_scanned_at = datetime('now') WHERE message_id = ?",
            (message_id,),
        )


def attachment_counts_for_messages(message_ids: List[str]) -> Dict[str, Dict[str, int]]:
    """Bulk count for the list view: returns {message_id: {total, dangerous,
    suspicious}}. Empty input returns empty dict."""
    if not message_ids:
        return {}
    placeholders = ",".join("?" for _ in message_ids)
    with _conn() as con:
        rows = con.execute(
            f"""
            SELECT message_id,
                   COUNT(*) AS total,
                   SUM(CASE WHEN threat_level = 'dangerous' THEN 1 ELSE 0 END) AS dangerous,
                   SUM(CASE WHEN threat_level = 'suspicious' THEN 1 ELSE 0 END) AS suspicious
            FROM attachments
            WHERE message_id IN ({placeholders})
              AND is_inline = 0
            GROUP BY message_id
            """,
            message_ids,
        ).fetchall()
    return {
        r["message_id"]: {
            "total": int(r["total"] or 0),
            "dangerous": int(r["dangerous"] or 0),
            "suspicious": int(r["suspicious"] or 0),
        }
        for r in rows
    }


# ── Outbox (Phase 1) ─────────────────────────────────────────────────────────


def insert_outbox_pending(
    *,
    account_email: str,
    to_addr: str,
    cc_addr: str,
    bcc_addr: str,
    subject: str,
    body_text: str,
    in_reply_to: Optional[str],
    refs: Optional[str],
) -> int:
    """Open a pending outbox row before attempting SMTP delivery. The
    returned id is updated by `mark_outbox_sent`/`mark_outbox_failed`
    once the smtplib call returns."""
    with _conn() as con:
        cur = con.execute(
            """
            INSERT INTO outbox
                (account_email, to_addr, cc_addr, bcc_addr, subject,
                 body_text, in_reply_to, refs, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
            """,
            (account_email, to_addr, cc_addr, bcc_addr, subject,
             body_text, in_reply_to, refs),
        )
        return int(cur.lastrowid or 0)


def mark_outbox_sent(outbox_id: int, message_id: str) -> None:
    with _conn() as con:
        con.execute(
            """
            UPDATE outbox
               SET status = 'sent',
                   message_id = ?,
                   sent_at = datetime('now'),
                   error = NULL,
                   stage = NULL
             WHERE id = ?
            """,
            (message_id, outbox_id),
        )


def mark_outbox_failed(outbox_id: int, stage: str, error: str) -> None:
    with _conn() as con:
        con.execute(
            """
            UPDATE outbox
               SET status = 'failed',
                   stage = ?,
                   error = ?
             WHERE id = ?
            """,
            (stage, str(error)[:1000], outbox_id),
        )


# ── Drafts (Phase 2) ─────────────────────────────────────────────────────────


def list_drafts(
    account: Optional[str] = None,
    in_reply_to_int: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Return drafts ordered by most-recently-edited first. Filterable
    by account (Brouillons folder) and by `in_reply_to_int` (the reply
    composer's lookup of "do I have a saved draft for this email?")."""
    q = "SELECT * FROM drafts WHERE 1=1"
    params: list = []
    if account:
        q += " AND account_email = ?"
        params.append(account)
    if in_reply_to_int is not None:
        q += " AND in_reply_to_int = ?"
        params.append(int(in_reply_to_int))
    q += " ORDER BY updated_at DESC, id DESC"
    with _conn() as con:
        return [dict(r) for r in con.execute(q, params).fetchall()]


def get_draft(draft_id: int) -> Optional[Dict[str, Any]]:
    with _conn() as con:
        row = con.execute("SELECT * FROM drafts WHERE id = ?", (draft_id,)).fetchone()
        return dict(row) if row else None


def insert_draft(
    *,
    account_email: str,
    to_addr: str = "",
    cc_addr: str = "",
    bcc_addr: str = "",
    subject: str = "",
    body_text: str = "",
    in_reply_to_int: Optional[int] = None,
) -> int:
    with _conn() as con:
        cur = con.execute(
            """
            INSERT INTO drafts
                (account_email, to_addr, cc_addr, bcc_addr, subject,
                 body_text, in_reply_to_int)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (account_email, to_addr, cc_addr, bcc_addr, subject,
             body_text, in_reply_to_int),
        )
        return int(cur.lastrowid or 0)


def update_draft(
    draft_id: int,
    *,
    account_email: Optional[str] = None,
    to_addr: Optional[str] = None,
    cc_addr: Optional[str] = None,
    bcc_addr: Optional[str] = None,
    subject: Optional[str] = None,
    body_text: Optional[str] = None,
    in_reply_to_int: Optional[int] = None,
) -> bool:
    """Partial update — only the columns the caller passes are touched.
    Returns True iff a row was updated."""
    sets: List[str] = []
    params: list = []
    for col, val in (
        ("account_email", account_email),
        ("to_addr", to_addr),
        ("cc_addr", cc_addr),
        ("bcc_addr", bcc_addr),
        ("subject", subject),
        ("body_text", body_text),
        ("in_reply_to_int", in_reply_to_int),
    ):
        if val is not None:
            sets.append(f"{col} = ?")
            params.append(val)
    if not sets:
        return False
    sets.append("updated_at = datetime('now')")
    params.append(draft_id)
    with _conn() as con:
        cur = con.execute(
            f"UPDATE drafts SET {', '.join(sets)} WHERE id = ?",
            params,
        )
        return cur.rowcount > 0


def delete_draft(draft_id: int) -> bool:
    with _conn() as con:
        cur = con.execute("DELETE FROM drafts WHERE id = ?", (draft_id,))
        return cur.rowcount > 0


# ── Labels (Phase 3) ─────────────────────────────────────────────────────────


def list_labels() -> List[Dict[str, Any]]:
    """Return all user-defined labels ordered by position then id.
    Position is editable so the sidebar can show a deliberate order;
    new labels land at the end (max position + 1)."""
    with _conn() as con:
        rows = con.execute(
            "SELECT * FROM labels ORDER BY position ASC, id ASC"
        ).fetchall()
        return [dict(r) for r in rows]


def get_label(label_id: int) -> Optional[Dict[str, Any]]:
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM labels WHERE id = ?", (label_id,)
        ).fetchone()
        return dict(row) if row else None


def create_label(name: str, color: str) -> int:
    """Insert a new label at the end of the list. Raises sqlite3
    IntegrityError on duplicate name (caught by the API layer)."""
    name = (name or "").strip()
    if not name:
        raise ValueError("nom d'étiquette vide")
    with _conn() as con:
        max_pos = con.execute(
            "SELECT COALESCE(MAX(position), 0) AS p FROM labels"
        ).fetchone()["p"]
        cur = con.execute(
            "INSERT INTO labels (name, color, position) VALUES (?, ?, ?)",
            (name, color or "#94A3B8", int(max_pos) + 1),
        )
        return int(cur.lastrowid or 0)


def update_label(
    label_id: int,
    *,
    name: Optional[str] = None,
    color: Optional[str] = None,
    position: Optional[int] = None,
) -> bool:
    sets: List[str] = []
    params: list = []
    if name is not None:
        n = name.strip()
        if not n:
            raise ValueError("nom d'étiquette vide")
        sets.append("name = ?")
        params.append(n)
    if color is not None:
        sets.append("color = ?")
        params.append(color)
    if position is not None:
        sets.append("position = ?")
        params.append(int(position))
    if not sets:
        return False
    params.append(label_id)
    with _conn() as con:
        cur = con.execute(
            f"UPDATE labels SET {', '.join(sets)} WHERE id = ?",
            params,
        )
        return cur.rowcount > 0


def delete_label(label_id: int) -> bool:
    """Drop a label. ON DELETE CASCADE on `email_labels.label_id`
    cleans up every assignment in the same transaction."""
    with _conn() as con:
        cur = con.execute("DELETE FROM labels WHERE id = ?", (label_id,))
        return cur.rowcount > 0


def get_labels_for_email(email_int_id: int) -> List[Dict[str, Any]]:
    """All labels currently assigned to one email."""
    with _conn() as con:
        rows = con.execute(
            """
            SELECT l.* FROM labels l
            JOIN email_labels el ON el.label_id = l.id
            WHERE el.email_int_id = ?
            ORDER BY l.position ASC, l.id ASC
            """,
            (email_int_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_labels_for_emails(email_int_ids: List[int]) -> Dict[int, List[Dict[str, Any]]]:
    """Bulk lookup for the list view: returns {email_int_id: [labels]}.
    Empty input returns {}. Used to attach a labels[] field to every
    row of the inbox /api/emails response without N+1."""
    if not email_int_ids:
        return {}
    placeholders = ",".join("?" for _ in email_int_ids)
    out: Dict[int, List[Dict[str, Any]]] = {i: [] for i in email_int_ids}
    with _conn() as con:
        rows = con.execute(
            f"""
            SELECT el.email_int_id, l.id, l.name, l.color, l.position
              FROM email_labels el
              JOIN labels l ON l.id = el.label_id
             WHERE el.email_int_id IN ({placeholders})
             ORDER BY l.position ASC, l.id ASC
            """,
            email_int_ids,
        ).fetchall()
    for r in rows:
        out.setdefault(r["email_int_id"], []).append({
            "id": r["id"],
            "name": r["name"],
            "color": r["color"],
            "position": r["position"],
        })
    return out


def set_email_labels(email_int_id: int, label_ids: List[int]) -> None:
    """Replace the full set of labels on an email. Empty list = clear
    every assignment for this email. Single-transaction so the row's
    state is consistent at every point."""
    unique = list({int(i) for i in label_ids}) if label_ids else []
    with _conn() as con:
        con.execute(
            "DELETE FROM email_labels WHERE email_int_id = ?",
            (email_int_id,),
        )
        if unique:
            con.executemany(
                "INSERT OR IGNORE INTO email_labels (email_int_id, label_id) VALUES (?, ?)",
                [(email_int_id, lid) for lid in unique],
            )


# ── Folders (Phase 4) ────────────────────────────────────────────────────────


def list_folders() -> List[Dict[str, Any]]:
    """All custom folders ordered by position then id. Built-ins
    (inbox/sent/draft/deleted) are NOT in this table — the API layer
    exposes them separately."""
    with _conn() as con:
        rows = con.execute(
            "SELECT * FROM folders ORDER BY position ASC, id ASC"
        ).fetchall()
        return [dict(r) for r in rows]


def get_folder(folder_id: int) -> Optional[Dict[str, Any]]:
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM folders WHERE id = ?", (folder_id,)
        ).fetchone()
        return dict(row) if row else None


def get_folder_by_name(name: str) -> Optional[Dict[str, Any]]:
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM folders WHERE name = ?", (name,)
        ).fetchone()
        return dict(row) if row else None


def create_folder(name: str) -> int:
    name = (name or "").strip()
    if not name:
        raise ValueError("nom de dossier vide")
    with _conn() as con:
        max_pos = con.execute(
            "SELECT COALESCE(MAX(position), 0) AS p FROM folders"
        ).fetchone()["p"]
        cur = con.execute(
            "INSERT INTO folders (name, position) VALUES (?, ?)",
            (name, int(max_pos) + 1),
        )
        return int(cur.lastrowid or 0)


def update_folder(
    folder_id: int,
    *,
    name: Optional[str] = None,
    position: Optional[int] = None,
) -> bool:
    sets: List[str] = []
    params: list = []
    if name is not None:
        n = name.strip()
        if not n:
            raise ValueError("nom de dossier vide")
        sets.append("name = ?")
        params.append(n)
    if position is not None:
        sets.append("position = ?")
        params.append(int(position))
    if not sets:
        return False
    params.append(folder_id)
    with _conn() as con:
        cur = con.execute(
            f"UPDATE folders SET {', '.join(sets)} WHERE id = ?",
            params,
        )
        return cur.rowcount > 0


def delete_folder(folder_id: int, fallback_name: str = "inbox") -> bool:
    """Drop a custom folder. Any emails currently sitting in it are
    moved back to `fallback_name` (default: inbox) so they don't
    disappear from every view."""
    folder = get_folder(folder_id)
    if not folder:
        return False
    name = folder["name"]
    with _conn() as con:
        con.execute(
            "UPDATE emails SET folder = ? WHERE folder = ?",
            (fallback_name, name),
        )
        con.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
    return True


def custom_folder_names() -> set:
    """Convenience: just the names. Used by api._VALID_FOLDERS to
    accept custom folders when patching emails."""
    return {row["name"] for row in list_folders()}

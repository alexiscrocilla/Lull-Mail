"""Schema migration ordering (regression for the threading/date_received_iso
ordering bug).

A DB created before BOTH `date_received_iso` and `thread_id` existed must
migrate cleanly: the thread backfill (which reads date_received_iso) has to
run AFTER that column is added and populated, or init_db crashes on boot.
"""

from __future__ import annotations

import importlib
import sqlite3
import sys


def _drop_src_modules():
    for m in list(sys.modules):
        if m == "src" or m.startswith("src."):
            del sys.modules[m]


# A minimal pre-date_received_iso / pre-threading emails table.
_LEGACY_SCHEMA = """
CREATE TABLE emails (
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
    fetched_at  TEXT,
    processed_at TEXT
);
"""


def test_init_db_migrates_legacy_db_without_date_iso(tmp_data_dir, tmp_keyring):
    _drop_src_modules()
    paths = importlib.import_module("src.paths")
    paths.ensure_dirs()

    con = sqlite3.connect(paths.DB_PATH)
    con.executescript(_LEGACY_SCHEMA)
    con.execute(
        "INSERT INTO emails (message_id, account_email, subject, date_received) "
        "VALUES ('<legacy@t>', 'u@x.fr', 'Re: Sujet', 'Mon, 05 May 2025 10:00:00 +0000')"
    )
    con.commit()
    con.close()

    db = importlib.import_module("src.database")
    db.init_db()  # must NOT raise — thread backfill reads date_received_iso

    rows = db.get_emails(limit=10)
    assert len(rows) == 1
    row = rows[0]
    assert row["message_id"] == "<legacy@t>"
    assert row["date_received_iso"]          # backfilled from date_received
    assert row["thread_id"] == "<legacy@t>"  # threaded (own root)
    assert row["normalized_subject"] == "sujet"

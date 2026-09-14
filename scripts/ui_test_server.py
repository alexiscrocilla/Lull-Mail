# SPDX-License-Identifier: GPL-3.0-or-later
"""Hermetic FastAPI server used by Playwright.

It creates a temporary mailbox and never starts IMAP, the scheduler, the
updater, a keyring migration, or an LLM provider.
"""

from __future__ import annotations

import os
import sys
import tempfile
import textwrap
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Playwright starts this server with its own cwd (`frontend/`), so the repo
# root is not on sys.path and `from src import ...` resolved to whatever
# unrelated `src` package happened to be installed. Anchor on this file.
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


# The suite is single-account by default so its screenshots stay pinned to
# the chrome a first install actually shows. LULLMAIL_TEST_ACCOUNTS switches
# the same server to several mailboxes, which is what the multi-account specs
# run against -- on their own port, with their own baselines.
PRIMARY = "demo@lullmail.test"


def _accounts() -> list[tuple[str, str]]:
    """(name, email) for every configured mailbox, primary first."""
    raw = os.environ.get("LULLMAIL_TEST_ACCOUNTS", "").strip()
    if not raw:
        return [("Demo", PRIMARY)]
    out = []
    for entry in raw.split(","):
        email = entry.strip()
        if not email:
            continue
        local = email.split("@")[0]
        out.append((local.capitalize(), email))
    return out or [("Demo", PRIMARY)]


def _prepare_environment() -> tuple[str, int]:
    os.environ["LULLMAIL_TEST_MODE"] = "1"
    data_dir = os.environ.get("LULLMAIL_DATA") or tempfile.mkdtemp(prefix="lullmail-ui-")
    os.environ["LULLMAIL_DATA"] = data_dir
    port = int(os.environ.get("LULLMAIL_PORT", "8765"))
    return data_dir, port


def _write_config(data_dir: str, port: int) -> None:
    """An AI-on config so the suite needs nothing outside itself.

    Without it `/api/accounts` raises FileNotFoundError and the sidebar's
    COMPTES section never renders, so the screenshots would not show the
    chrome the tests exist to pin.
    """
    path = os.path.join(data_dir, "config.yaml")
    if os.path.exists(path):
        return
    accounts_yaml = "".join(
        textwrap.dedent(
            """            - name: {name}
              type: imap
              email: {email}
              imap_host: 127.0.0.1
              imap_port: 1
              username: {email}
              password: not-a-real-password
              ssl: false
              enabled: true
            """
        ).format(name=name, email=email)
        for name, email in _accounts()
    )
    yaml_text = textwrap.dedent(
        """\
        openai:
          api_key: 'sk-playwright-not-a-real-key'
          model: gpt-4o-mini
        llm:
          provider: openai
        polling:
          interval_minutes: 2
          initial_fetch_count: 500
          max_age_days: 0
          ai_batch_size: 200
          interval_migrated: true
        server:
          host: 127.0.0.1
          port: {port}
        accounts:
        """
    ).format(port=port) + accounts_yaml
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(yaml_text)


def _seed_mailbox() -> None:
    from src import database as db

    if db.get_emails(limit=1):
        return

    now = datetime(2026, 8, 25, 9, 30, tzinfo=timezone.utc)
    senders = [
        ("Camille Martin <camille@atelier-martin.fr>", "Point sur la maquette de septembre"),
        ("Nora Benali <nora@rivage-studio.fr>", "Compte rendu de notre échange"),
        ("Louis Bernard <louis@maison-bernard.fr>", "Facture 2026-084 disponible"),
        ("Élodie Petit <elodie@bureau-petit.fr>", "Validation du planning éditorial"),
        ("Samir Diallo <samir@diallo-conseil.fr>", "Documents pour vendredi"),
        ("Ana Ferreira <ana@ferreira-design.pt>", "Relecture finale du dossier"),
    ]
    # `insert_email` writes the envelope only — it ignores category, score and
    # summary, which is why every seeded mail used to render as "En attente"
    # with a bare card. The verdict is a second write, the same one the
    # scheduler makes, so the screenshots pin the AI-on card.
    for index in range(18):
        sender, subject = senders[index % len(senders)]
        received = now - timedelta(minutes=index * 37)
        message_id = f"<playwright-{index}@lullmail.test>"
        db.insert_email({
            "message_id": message_id,
            "account": "demo@lullmail.test",
            "uid": str(1000 + index),
            "subject": subject,
            "sender": sender,
            "recipient": "demo@lullmail.test",
            "date_str": received.strftime("%a, %d %b %Y %H:%M:%S +0000"),
            "body_text": "Bonjour,\n\nVoici un message de démonstration déterministe pour les tests LullMail.",
            "body_html": "<p>Bonjour,</p><p>Voici un message de démonstration déterministe pour les tests LullMail.</p>",
            "is_read": index % 3 != 0,
            # One message fails its origin checks, so the read pane's warning
            # has something to render. Every other message carries a normal
            # verdict, which is now deliberately silent.
            "auth_results": ('{"spf": "fail", "dkim": "fail", "dmarc": "fail"}'
                             if index == 1 else
                             '{"spf": "pass", "dkim": "pass", "dmarc": "pass"}'),
        })
        important = index % 4 == 0
        db.update_email_ai(message_id, {
            "category": "important" if important else "other",
            "importance_score": 8 if important else 5,
            "importance_reason": "Expéditeur connu, échéance proche."
            if important else "Information, pas d'action attendue.",
            "summary": "Message de démonstration pour la validation visuelle.",
            "needs_reply": important,
            "analyzed_by": "playwright-seed",
        })


def _seed_other_accounts() -> None:
    """Mail for every mailbox after the first.

    The primary account keeps exactly the 18 messages the single-account
    baselines were shot against, so turning this on cannot move them. What
    it adds is what a single account cannot express: the same newsletter,
    from the same sender, landing in two different mailboxes -- the case
    where a row that does not name its account is unreadable, and where a
    cleanup suggestion that ignores the account unsubscribes the wrong one.
    """
    from src import database as db

    extra = _accounts()[1:]
    if not extra:
        return

    now = datetime(2026, 8, 25, 9, 30, tzinfo=timezone.utc)
    for a_idx, (name, email) in enumerate(extra):
        for index in range(6):
            shared = index % 3 == 0
            sender = ("Lettre Rivage <news@rivage-studio.fr>" if shared
                      else f"Contact {name} <contact{index}@{email.split('@')[1]}>")
            subject = ("Votre sélection de la semaine" if shared
                       else f"Dossier {name} {index + 1}")
            received = now - timedelta(minutes=13 + index * 41 + a_idx * 7)
            message_id = f"<pw-{a_idx}-{index}@lullmail.test>"
            db.insert_email({
                "message_id": message_id,
                "account": email,
                "uid": str(3000 + a_idx * 100 + index),
                "subject": subject,
                "sender": sender,
                "recipient": email,
                "date_str": received.strftime("%a, %d %b %Y %H:%M:%S +0000"),
                "body_text": "Bonjour,\n\nMessage de démonstration multi-comptes.",
                "body_html": ('<p>Bonjour,</p><p>Message de démonstration multi-comptes.</p>'
                              '<p><a href="https://rivage-studio.fr/unsub">Se désabonner</a></p>'
                              if shared else
                              '<p>Bonjour,</p><p>Message de démonstration multi-comptes.</p>'),
                "is_read": index % 2 == 1,
                "auth_results": '{"spf": "pass", "dkim": "pass", "dmarc": "pass"}',
                "list_unsubscribe": ("<https://rivage-studio.fr/unsub>" if shared else None),
            })
            db.update_email_ai(message_id, {
                "category": "newsletter" if shared else "other",
                "importance_score": 3 if shared else 5,
                "importance_reason": "Information, pas d'action attendue.",
                "summary": "Message de démonstration multi-comptes.",
                "needs_reply": False,
                "analyzed_by": "playwright-seed",
            })


def main() -> None:
    data_dir, port = _prepare_environment()
    from src import paths
    from src import database as db

    paths.ensure_dirs()
    _write_config(data_dir, port)
    db.init_db()
    _seed_mailbox()
    _seed_other_accounts()

    import uvicorn
    from src.api import app

    from src import events

    @app.post("/__test__/emit")
    def _emit(kind: str, int_id: int = 0, account: str = PRIMARY):
        """Make the server announce something, the way the real code does.

        This server never starts the scheduler or the IDLE watchers, so
        nothing can publish on its own. Test-harness only.
        """
        from datetime import datetime as _dt, timedelta as _td, timezone as _tz

        if kind == "mail":
            now = _dt.now(_tz.utc)
            mid = f"<streamed-{now.timestamp()}@lullmail.test>"
            db.insert_email({
                "message_id": mid, "account": account,
                "uid": "9999", "subject": "Message arrivé pendant le test",
                "sender": "Flux <flux@lullmail.test>",
                "recipient": account,
                "date_str": now.strftime("%a, %d %b %Y %H:%M:%S +0000"),
                "body_text": "corps", "body_html": "<p>corps</p>",
            })
            events.hub.publish("mail", {"account": account, "count": 1})
            return {"ok": True, "message_id": mid}

        if kind == "envelope":
            with db._conn() as con:
                con.execute(
                    "UPDATE emails SET body_state='envelope', body_text='', body_html='' "
                    "WHERE int_id = ?", (int_id,))
            return {"ok": True}

        if kind == "body":
            with db._conn() as con:
                con.execute(
                    "UPDATE emails SET body_state='full', body_text='Corps arrivé par le flux.' "
                    "WHERE int_id = ?", (int_id,))
            events.hub.publish("body", {"int_id": int_id, "body_state": "full"})
            return {"ok": True}

        if kind == "failed":
            with db._conn() as con:
                con.execute(
                    "UPDATE emails SET body_state='failed', body_error='IMAP fetch empty response' "
                    "WHERE int_id = ?", (int_id,))
            events.hub.publish("body", {"int_id": int_id, "body_state": "failed"})
            return {"ok": True}

        return {"ok": False, "error": "unknown kind"}

    @app.post("/__test__/cleanup")
    def _seed_cleanup(kind: str = "spam", n: int = 260, senders: int = 5,
                      account: str = PRIMARY):
        """Seed a pile big enough for a card to reach its confirm gate.

        The default mailbox is 18 well-behaved messages, which is by design:
        the cards the preview exists for only appear past a few hundred.
        Test-harness only.
        """
        from datetime import datetime as _dt, timedelta as _td, timezone as _tz

        now = _dt.now(_tz.utc)
        for i in range(n):
            mid = f"<cln-{kind}-{i}@lullmail.test>"
            db.insert_email({
                "message_id": mid, "account": account, "uid": str(5000 + i),
                "subject": f"Offre {i}",
                "sender": f"Expediteur {i % senders} <s{i % senders}@bulk.example>",
                "recipient": account,
                "date_str": (now - _td(days=40, minutes=i)).strftime(
                    "%a, %d %b %Y %H:%M:%S +0000"),
                "body_text": "corps", "body_html": "<p>corps</p>",
                "is_read": i % 2 == 0,
            })
        with db._conn() as con:
            con.execute(
                "UPDATE emails SET category = ?, local_classified = 0 "
                "WHERE message_id LIKE ?", (kind, f"<cln-{kind}-%"))
        return {"ok": True, "seeded": n}

    @app.post("/__test__/reset")
    def _reset():
        """Put the mailbox back to its seeded state.

        One server serves every spec file, and the mailbox is mutable: a test
        that opens a message marks it read, and one that trashes a message
        changes the counts the screenshot tests assert. Each spec resets
        first, so its starting point does not depend on which files ran
        before it. Test-harness only -- this route does not exist in the app.
        """
        with db._conn() as con:
            con.execute("DELETE FROM emails")
            con.execute("DELETE FROM drafts")
            con.execute("DELETE FROM pending_ops")
            con.execute("DELETE FROM kv WHERE key LIKE 'cleanup%'")
        _seed_mailbox()
        _seed_other_accounts()
        return {"ok": True}

    app.state.bound_port = port
    # Same reason as main.py: a parked stream must not keep the test
    # server alive past the run that started it.
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning",
                timeout_graceful_shutdown=2)


if __name__ == "__main__":
    main()

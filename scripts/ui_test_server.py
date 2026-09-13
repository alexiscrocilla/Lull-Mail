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


def _prepare_environment() -> tuple[str, int]:
    os.environ["LULLMAIL_TEST_MODE"] = "1"
    data_dir = os.environ.get("LULLMAIL_DATA") or tempfile.mkdtemp(prefix="lullmail-ui-")
    os.environ["LULLMAIL_DATA"] = data_dir
    port = int(os.environ.get("LULLMAIL_PORT", "8765"))
    return data_dir, port


def _write_config(data_dir: str, port: int) -> None:
    """A single-account, AI-on config so the suite needs nothing outside itself.

    Without it `/api/accounts` raises FileNotFoundError and the sidebar's
    COMPTES section never renders, so the screenshots would not show the
    chrome the tests exist to pin.
    """
    path = os.path.join(data_dir, "config.yaml")
    if os.path.exists(path):
        return
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
        - name: Demo
          type: imap
          email: demo@lullmail.test
          imap_host: 127.0.0.1
          imap_port: 1
          username: demo@lullmail.test
          password: not-a-real-password
          ssl: false
          enabled: true
        """
    ).format(port=port)
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


def main() -> None:
    data_dir, port = _prepare_environment()
    from src import paths
    from src import database as db

    paths.ensure_dirs()
    _write_config(data_dir, port)
    db.init_db()
    _seed_mailbox()

    import uvicorn
    from src.api import app

    app.state.bound_port = port
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()

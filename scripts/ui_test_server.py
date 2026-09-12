# SPDX-License-Identifier: GPL-3.0-or-later
"""Hermetic FastAPI server used by Playwright.

It creates a temporary mailbox and never starts IMAP, the scheduler, the
updater, a keyring migration, or an LLM provider.
"""

from __future__ import annotations

import os
import tempfile
from datetime import datetime, timedelta, timezone


def _prepare_environment() -> tuple[str, int]:
    os.environ["LULLMAIL_TEST_MODE"] = "1"
    data_dir = os.environ.get("LULLMAIL_DATA") or tempfile.mkdtemp(prefix="lullmail-ui-")
    os.environ["LULLMAIL_DATA"] = data_dir
    port = int(os.environ.get("LULLMAIL_PORT", "8765"))
    return data_dir, port


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
    for index in range(18):
        sender, subject = senders[index % len(senders)]
        received = now - timedelta(minutes=index * 37)
        db.insert_email({
            "message_id": f"<playwright-{index}@lullmail.test>",
            "account": "demo@lullmail.test",
            "uid": str(1000 + index),
            "subject": subject,
            "sender": sender,
            "recipient": "demo@lullmail.test",
            "date_str": received.strftime("%a, %d %b %Y %H:%M:%S +0000"),
            "body_text": "Bonjour,\n\nVoici un message de démonstration déterministe pour les tests LullMail.",
            "body_html": "<p>Bonjour,</p><p>Voici un message de démonstration déterministe pour les tests LullMail.</p>",
            "category": "important" if index % 4 == 0 else "other",
            "importance_score": 8 if index % 4 == 0 else 5,
            "summary": "Message de démonstration pour la validation visuelle.",
            "is_read": index % 3 != 0,
        })


def main() -> None:
    _, port = _prepare_environment()
    from src import paths
    from src import database as db

    paths.ensure_dirs()
    db.init_db()
    _seed_mailbox()

    import uvicorn
    from src.api import app

    app.state.bound_port = port
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()

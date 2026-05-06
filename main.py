import asyncio
import logging
import os
import sys

# On Windows, Python 3.8+ defaults to ProactorEventLoop which raises spurious
# ConnectionResetError ([WinError 10054]) when clients disconnect mid-request.
# SelectorEventLoop avoids this entirely and is fully compatible with uvicorn.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from src import paths

paths.migrate_legacy_install()
paths.ensure_dirs()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(paths.LOG_PATH, encoding="utf-8"),
    ],
)

logger = logging.getLogger(__name__)

import uvicorn

from src import config as cfg
from src import database as db
from src import lifecycle
from src import secrets_migration
from src.api import app


def main():
    logger.info("═══════════════════════════════")
    logger.info("       Lull Mail démarrage      ")
    logger.info("═══════════════════════════════")
    logger.info("Données : %s", paths.APP_DATA_DIR)

    db.init_db()

    # One-shot migration of any clear-text passwords / OpenAI key found
    # in config.yaml into the OS keyring (Windows Credential Manager /
    # macOS Keychain / Linux Secret Service). Idempotent — accounts
    # already migrated are skipped instantly. Falls back silently when
    # the keyring is unavailable on this machine.
    try:
        moved = secrets_migration.run()
        if moved:
            logger.info("Migration keyring : %d secret(s) déplacé(s)", moved)
    except Exception:
        logger.exception("Migration keyring a échoué (on continue)")

    if lifecycle.start_email_services():
        logger.info("Configuration OK — services email démarrés")
    else:
        logger.warning("Aucune config valide — assistant disponible sur /onboarding")

    # Dev mode keeps a fixed port (so devs can keep their bookmark on
    # localhost:8000 working). Override with LULLMAIL_PORT.
    host = "127.0.0.1"
    port = int(os.environ.get("LULLMAIL_PORT", "8000"))

    # Publish the bound port so the origin-check middleware can build
    # its allowlist (see src/security/origin.py).
    app.state.bound_port = port

    logger.info(f"Dashboard : http://localhost:{port}")
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()

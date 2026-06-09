# SPDX-License-Identifier: GPL-3.0-or-later
"""
Lull Mail — entry point for the native desktop app (Windows, macOS, Linux).

Runs the FastAPI server in a background thread and presents the dashboard
in a real OS window via pywebview (Edge WebView2 on Windows, WebKit on
macOS, WebKit2GTK on Linux). A system tray icon keeps the email polling
alive when the window is closed.

This file is the entry point bundled by PyInstaller into the platform
executable (LullMail.exe on Windows, LullMail on macOS/Linux).
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import sys
import threading
import time
from pathlib import Path
from typing import Optional


# ── LLM subprocess hand-off ──────────────────────────────────────────────────
# When LullMail.exe is invoked with `--serve-llm`, we route the process to
# llama_cpp.server's CLI instead of bootstrapping the GUI. This is the
# PyInstaller workaround : a frozen exe cannot do `python -m llama_cpp.server`
# (PyInstaller's bootloader has no `-m` support and sys.executable points at
# the LullMail.exe wrapper, not python). The same binary therefore acts as
# both the desktop app and its own python launcher for the LLM subprocess.
#
# Detected as early as possible — BEFORE heavy imports / data-dir migration
# / logging setup — so the subprocess starts clean and doesn't conflict
# with the parent's state. Works in dev too (the dev path also routes here
# if `--serve-llm` is passed), which makes the new branch testable without
# a frozen build.
if "--serve-llm" in sys.argv:
    sys.argv.remove("--serve-llm")
    # Cosmetic : llama_cpp.server's argparse uses argv[0] in help / errors.
    sys.argv[0] = "llama_cpp.server"
    from llama_cpp.server.__main__ import main as _llama_serve_main
    sys.exit(_llama_serve_main())


# ── Working directory ────────────────────────────────────────────────────────
# When launched from a Start-menu shortcut or double-clicked from anywhere,
# the cwd may not be the project root. Anchor everything (config.yaml,
# data/, mail.db, the log file) to the directory containing the exe / script.
if getattr(sys, "frozen", False):
    APP_DIR = Path(sys.executable).resolve().parent
else:
    APP_DIR = Path(__file__).resolve().parent
os.chdir(APP_DIR)


# Under PyInstaller --windowed, sys.stdout / sys.stderr are None. Any
# library that does sys.stdout.isatty() (uvicorn's log formatter, click,
# rich, …) blows up with AttributeError. Replace them with a minimal
# silent stream that satisfies the file-like protocol.
class _SilentStream:
    def write(self, _data): return 0
    def flush(self): pass
    def isatty(self): return False
    def fileno(self): raise OSError("no fileno on silent stream")
    def readable(self): return False
    def writable(self): return True
    def seekable(self): return False
    encoding = "utf-8"
    errors = "replace"


if sys.stdout is None:
    sys.stdout = _SilentStream()  # type: ignore[assignment]
if sys.stderr is None:
    sys.stderr = _SilentStream()  # type: ignore[assignment]

# Same Windows event-loop fix as main.py — must run before uvicorn imports.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

# Resolve the canonical data directory + migrate any legacy install before
# anything reads config.yaml or opens the DB.
from src import paths  # noqa: E402

paths.migrate_legacy_install()
paths.ensure_dirs()

# Logging always goes to the file. We only add a stdout handler in dev
# (frozen builds run --windowed; their stdout was None and is now the
# silent stub from above — writing to it would burn cycles for nothing).
_log_handlers: list[logging.Handler] = [
    logging.FileHandler(paths.LOG_PATH, encoding="utf-8")
]
if not getattr(sys, "frozen", False):
    _log_handlers.append(logging.StreamHandler(sys.stdout))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=_log_handlers,
)
logger = logging.getLogger("lull_mail.gui")


# ── Heavy imports (after logging + cwd are ready) ────────────────────────────
import uvicorn  # noqa: E402

from src import config as cfg  # noqa: E402
from src import database as db  # noqa: E402
from src import lifecycle  # noqa: E402
from src import secrets_migration  # noqa: E402
from src.api import app as fastapi_app  # noqa: E402


# ── Server lifecycle ─────────────────────────────────────────────────────────


class _ServerThread(threading.Thread):
    """uvicorn.Server wrapped in a thread we can shut down cleanly."""

    def __init__(self, host: str, port: int):
        super().__init__(name="uvicorn", daemon=True)
        config = uvicorn.Config(
            fastapi_app,
            host=host,
            port=port,
            log_level="warning",
            access_log=False,
            # Skip uvicorn's dictConfig — its custom formatters call
            # sys.stdout.isatty() and similar, which is fragile under
            # PyInstaller --windowed. Our basicConfig already routes
            # everything we care about to data/lull_mail.log.
            log_config=None,
        )
        self.server = uvicorn.Server(config)

    def run(self) -> None:
        try:
            self.server.run()
        except Exception:
            logger.exception("uvicorn crashed")

    def stop(self) -> None:
        self.server.should_exit = True


def _wait_for_port(host: str, port: int, timeout: float = 30.0) -> bool:
    """Block until the server accepts TCP connections, or timeout expires."""
    probe_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            try:
                s.connect((probe_host, port))
                return True
            except OSError:
                time.sleep(0.15)
    return False


def _pick_ephemeral_port() -> int:
    """Ask the OS for a free TCP port on the loopback interface.

    Tiny race window between close() and uvicorn re-bind, but on a desktop
    that's negligible — and uvicorn would just fail loudly if it lost.
    Used so the app never advertises a fixed :8000 to the user; a real
    Windows app shouldn't have a "port".
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _pick_stable_port() -> int:
    """Reuse the port from the previous session when possible.

    localStorage in WebView2 is partitioned by origin (`scheme://host:port`),
    so a fresh ephemeral port every launch makes sidebar collapse state,
    sort prefs, section order, etc. effectively *non-persistent* — even
    though `webview.start(storage_path=…)` keeps the underlying profile.
    We therefore remember the last-used port in `data/.last_port` and try
    to bind it again on the next launch. If it's taken (a second instance
    is up, or another app grabbed it in the meantime), fall back to a
    fresh ephemeral allocation — losing the saved UI prefs that one time.
    """
    port_file = paths.APP_DATA_DIR / ".last_port"
    last: Optional[int] = None
    try:
        raw = port_file.read_text(encoding="utf-8").strip()
        n = int(raw)
        if 1024 <= n <= 65535:
            last = n
    except (OSError, ValueError):
        last = None

    if last is not None:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            # SO_REUSEADDR is intentionally NOT set — we want to fail fast
            # if the port is already bound, not race uvicorn to it.
            s.bind(("127.0.0.1", last))
            s.close()
            return last
        except OSError:
            try:
                s.close()
            except OSError:
                pass

    port = _pick_ephemeral_port()
    try:
        port_file.write_text(str(port), encoding="utf-8")
    except OSError:
        # Storage is read-only or full — not fatal, we just lose
        # persistence this launch.
        pass
    return port


# ── App mutex (Windows) ──────────────────────────────────────────────────────
# The installer (Inno Setup) uses this mutex to detect a running instance and
# close it before overwriting files.  Must match `AppMutex` in installer.iss.
_APP_MUTEX_NAME = "Local\LullMail-{5933D412-CD2C-42ED-BCB4-9809CF1683F2}"
_APP_MUTEX_HANDLE = None  # keep alive for the lifetime of the process


def _create_app_mutex():
    global _APP_MUTEX_HANDLE
    if sys.platform != "win32":
        return
    try:
        import ctypes
        _APP_MUTEX_HANDLE = ctypes.windll.kernel32.CreateMutexW(
            None, 0, _APP_MUTEX_NAME
        )
    except Exception:
        pass  # non-fatal — installer fallback kills the process anyway


# ── Main ─────────────────────────────────────────────────────────────────────


def main() -> int:
    _create_app_mutex()
    logger.info("═══════════════════════════════")
    logger.info("       Lull Mail (desktop)      ")
    logger.info("═══════════════════════════════")
    logger.info("Données : %s", paths.APP_DATA_DIR)

    # The DB is needed by every API route, even in setup mode (the wizard's
    # /api/setup/* endpoints don't touch it, but plain GET / does).
    db.init_db()

    # One-shot migration of any clear-text passwords / OpenAI key found
    # in config.yaml into the OS keyring (Windows Credential Manager).
    # Idempotent — accounts already migrated are skipped instantly.
    try:
        moved = secrets_migration.run()
        if moved:
            logger.info("Migration keyring : %d secret(s) déplacé(s)", moved)
    except Exception:
        logger.exception("Migration keyring a échoué (on continue)")

    # Try to start email services. Failure is fine — the wizard takes over.
    if lifecycle.start_email_services():
        logger.info("Configuration OK — services email démarrés")
    else:
        logger.info("Aucune configuration valide — démarrage en mode setup")

    # The desktop app never exposes a port to the user — it's an internal
    # implementation detail. We bind to loopback on the port from the
    # previous launch when it's still free (so WebView2's origin-keyed
    # localStorage keeps sidebar prefs, section order, etc. across
    # restarts) and fall back to a fresh ephemeral port otherwise.
    # Power users can override via LULLMAIL_PORT.
    host = "127.0.0.1"
    forced = os.environ.get("LULLMAIL_PORT")
    port = int(forced) if forced and forced.isdigit() else _pick_stable_port()
    url = f"http://127.0.0.1:{port}"

    # Publish the bound port so the origin-check middleware can build
    # its allowlist (see src/security/origin.py).
    fastapi_app.state.bound_port = port

    server = _ServerThread(host=host, port=port)
    server.start()

    if not _wait_for_port(host, port, timeout=30.0):
        _fatal_dialog(
            "Démarrage impossible",
            "L'application n'a pas réussi à démarrer dans le délai imparti.\n"
            f"Consultez le journal pour plus de détails :\n{paths.LOG_PATH}",
        )
        server.stop()
        lifecycle.stop_email_services()
        return 1

    logger.info("Application prête")

    import webview  # imported late so the splash isn't blocked by it

    # Pywebview defaults `ALLOW_DOWNLOADS` to False — WebView2 then cancels
    # every download (`args.Cancel = True` in `on_download_starting`). Without
    # this flag the attachment "Télécharger" buttons silently no-op in the
    # packaged app, even though the FastAPI route responds correctly with
    # `Content-Disposition: attachment`. Enabling it surfaces the native
    # Windows save dialog rooted at the user's Downloads folder.
    webview.settings['ALLOW_DOWNLOADS'] = True

    window = webview.create_window(
        title="Lull Mail",
        url=url,
        width=1400,
        height=900,
        min_size=(900, 600),
        confirm_close=False,
    )

    # Strip the web-page-isms that betray "this is a browser inside an
    # app": F5/Ctrl+R reload, F12 dev tools, Ctrl+P print, the right-click
    # context menu. Apps we sit next to (Slack, Notion, VS Code…) all
    # behave this way. Right-click on a real INPUT / TEXTAREA still works
    # so users can paste / undo, only the page-wide menu is gone.
    _NATIVE_FEEL_JS = r"""
    (function(){
      const allowMenuOn = el => {
        if (!el) return false;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
        if (el.isContentEditable) return true;
        return false;
      };
      window.addEventListener('contextmenu', e => {
        if (!allowMenuOn(e.target)) e.preventDefault();
      }, true);
      window.addEventListener('keydown', e => {
        const k = e.key;
        const ctrl = e.ctrlKey || e.metaKey;
        if (k === 'F5' || k === 'F12') { e.preventDefault(); return; }
        if (ctrl && (k === 'r' || k === 'R')) { e.preventDefault(); return; }
        if (ctrl && (k === 'p' || k === 'P')) { e.preventDefault(); return; }
        if (ctrl && (k === 'u' || k === 'U')) { e.preventDefault(); return; }
        if (ctrl && e.shiftKey && (k === 'i' || k === 'I' || k === 'j' || k === 'J')) {
          e.preventDefault(); return;
        }
      }, true);
      // Disable text selection on chrome-y elements only (the rail, etc.)
      // — leave the inbox / dashboard content selectable so users can
      // copy email contents.
    })();
    """

    def _inject_native_feel(*_args, **_kw):
        # pywebview's `loaded` event fires the callback with no args; we
        # accept *args anyway in case the signature changes between
        # pywebview versions.
        try:
            window.evaluate_js(_NATIVE_FEEL_JS)
        except Exception:
            logger.exception("Injection script natif a échoué")

    window.events.loaded += _inject_native_feel

    # Closing the window quits the whole app — like every other normal
    # Windows app. webview.start() returns when the last window dies, the
    # finally block tears the server + scheduler down cleanly.
    #
    # private_mode=False + an explicit storage_path = persistent localStorage
    # (sidebar collapsed sections, sort prefs, …) across restarts. pywebview
    # defaults to private_mode=True which uses an ephemeral WebView2 profile,
    # so anything written to localStorage is wiped at app close.
    from src.paths import APP_DATA_DIR
    webview_storage = APP_DATA_DIR / "webview"
    webview_storage.mkdir(parents=True, exist_ok=True)
    try:
        webview.start(private_mode=False, storage_path=str(webview_storage))
    finally:
        logger.info("Fermeture en cours")
        server.stop()
        lifecycle.stop_email_services()
        server.join(timeout=3.0)

    return 0


def _fatal_dialog(title: str, message: str) -> None:
    """Best-effort native message box. Falls back to logging if unavailable."""
    logger.error("%s — %s", title, message)
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, message, f"Lull Mail — {title}", 0x10)
            return
        except Exception:
            pass
    print(f"[{title}] {message}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())

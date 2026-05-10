# Developing Lull Mail

Guide to clone, run in dev mode, build the app, and produce release packages.

---

## Prerequisites

- **Python 3.11+** with `python` or `py` on `PATH`.
- **Windows 10/11** — to produce the Inno Setup installer (`.exe`).
  *(Optional)* [Inno Setup 6](https://jrsoftware.org/isdl.php) for local installer builds.
- **macOS 12+** — to produce the `.app` / `.dmg`. No extra tools needed
  (icon generation uses `sips` + `iconutil`, which ship with macOS).
- **Linux** — to produce the `.tar.gz`. Requires `libwebkit2gtk-4.1-dev`
  (or `4.0` on older distros): `sudo apt install libwebkit2gtk-4.1-dev`.

## Dev commands

**Windows** — all commands go through `dev.bat`:

```cmd
.\dev.bat install        :: create .venv and install deps (run once)
.\dev.bat start          :: run the app in dev mode (console + browser)
.\dev.bat build          :: produces dist\LullMail\LullMail.exe (PyInstaller)
.\dev.bat installer      :: produces dist\LullMail-Setup-X.Y.Z.exe (Inno Setup)
.\dev.bat shortcut       :: desktop shortcut (handy in dev without the installer)
```

`dev.bat` is a thin dispatcher that routes to the real scripts in
`scripts/`. It's the single entry point at the root — same role as
a `Makefile` or `npm run` in other ecosystems.

**macOS / Linux** — use the shell script directly:

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
bash scripts/build.sh    # produces dist/LullMail/ (and dist/LullMail.app on macOS)
```

## Running the test suite

```cmd
.venv\Scripts\pip install -r requirements-dev.txt
.venv\Scripts\python -m pytest -q
```

The test suite (~56 tests, ~3.5 s on a recent laptop) covers the
security guards (origin-check middleware, SSRF block, TLS lock,
sandbox iframe), the anti-phishing analyser (`src/safe_link.py`),
the OS-keyring round-trip, the attachment-security helpers, the
SPF/DKIM/DMARC parser, and the Pydantic config schema. Tests use a
per-test tempdir + an in-memory keyring backend so they never touch
your real OS data directory or your OS keyring.

CI runs the same `pytest -q` on every push to `develop` / `main`
and on every PR via [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
A red CI doesn't block the release workflow today, but the assertion
is loud enough to catch in review.

## First run

```cmd
.\dev.bat install
.\dev.bat start
```

`dev.bat start` opens the browser at http://localhost:8000 once the
server is responding. The dashboard is identical to the native app's.

In dev mode, `config.yaml` and `data/` live **at the project root**
(not in the OS data directory). Handy to test with a throwaway config
without polluting your installed Lull Mail.

## Building on Windows

```cmd
.\dev.bat build          :: produces dist\LullMail\LullMail.exe (PyInstaller)
.\dev.bat installer      :: produces dist\LullMail-Setup-X.Y.Z.exe (Inno Setup)
```

`dev.bat build` runs PyInstaller through `lull_mail.spec` and produces a
**onedir** bundle (`dist\LullMail\` — exe + DLLs + `frontend/`).

`dev.bat installer` chains the build (silent via `LULLMAIL_NOINTERACT=1`)
and then compiles `scripts\installer.iss` to produce the setup exe. The
installer installs to `%LOCALAPPDATA%\Programs\LullMail` (no admin needed),
adds a Start Menu entry, optional desktop shortcut, and registers in
Add/Remove Programs. It does **not** touch `%APPDATA%\LullMail` (user data
survives uninstall).

**Bumping the version**: edit `MyAppVersion` at the top of
`scripts\installer.iss`.

## Building on macOS

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
bash scripts/build.sh
```

Produces `dist/LullMail/LullMail` (onedir) and `dist/LullMail.app`.
To wrap it in a `.dmg` for distribution:

```bash
VERSION=0.4.0
hdiutil create -volname "Lull Mail $VERSION" \
  -srcfolder dist/LullMail.app -ov -format UDZO \
  dist/LullMail-$VERSION.dmg
```

> **Note**: Without an Apple Developer certificate, macOS Gatekeeper will
> warn on first launch. Users can right-click → Open to bypass it.

## Building on Linux

```bash
sudo apt install libwebkit2gtk-4.1-dev   # Ubuntu 22.04+ (use 4.0 on older)
python -m venv .venv && .venv/bin/pip install -r requirements.txt
bash scripts/build.sh
```

Produces `dist/LullMail/LullMail`. To create a portable archive:

```bash
tar -czf dist/LullMail-0.4.0.tar.gz -C dist LullMail
```

## Release cycle (CI)

The [`.github/workflows/release.yml`](../.github/workflows/release.yml)
workflow builds on **Windows, macOS, and Linux** in parallel on tag
`vX.Y.Z` and publishes all three artefacts as a draft release:

| Platform | Artefact |
|---|---|
| Windows | `LullMail-Setup-X.Y.Z.exe` |
| macOS   | `LullMail-X.Y.Z.dmg` |
| Linux   | `LullMail-X.Y.Z.tar.gz` |

Release procedure:

```bash
# 1. Bump the version in scripts/installer.iss (#define MyAppVersion).
# 2. Merge develop → main and push.
git checkout main && git merge develop && git push origin main
# 3. Tag and push — this triggers all three build jobs.
git tag v0.5.0 && git push origin v0.5.0
# 4. The workflow runs ~10-15 min. A draft release appears in the
#    Releases tab with the three artefacts attached. Review and publish.
# 5. Edit the release body in English: keep Highlights + Install short
#    (see docs/RELEASE-NOTES.md). Drop or trim GitHub's auto-generated
#    wall of text unless you want to paste back only the Full Changelog link.
# 6. Back to develop.
git checkout develop
```

## Repo structure

```
dev.bat               ← single dispatcher for install / start / build / installer
lull_mail.spec        ← PyInstaller spec
app_gui.py            ← native app entry point (PyInstaller)
main.py               ← console / dev entry point
requirements.txt
requirements-dev.txt  ← test-only deps (pytest, httpx, keyrings.alt)
pytest.ini
README.md

assets/
  lull_mail.ico       ← multi-resolution Windows icon (16…256)
  lull_mail.icns      ← macOS icon (generated by CI from lullmail-icon.png)

frontend/             ← UI served by FastAPI
  index.html / app.js / dashboard.js / mailbox.js / cleanup.js
  settings.js         ← Settings page (mountSettings)
  onboarding.html / onboarding.js
  i18n.js             ← FR/EN translation module
  api.js / style.css
  image-blocker.js    ← strips remote <img>/<source>/CSS url(…) before
                        the email body lands in the iframe
  assets/             ← logos / icons used in the UI

src/                  ← Python code
  api.py              ← FastAPI: dashboard routes + middlewares
  setup_api.py        ← FastAPI: onboarding & settings routes
  paths.py            ← path resolution (dev vs frozen) + migrations
  config.py           ← config.yaml I/O + Pydantic validation
                        + keyring sentinel resolution
  database.py         ← SQLite (emails, sync_state, attachments,
                        sender_cache, custom_rules, kv)
  email_fetcher.py    ← IMAP polling + auth-results extraction
  ai_processor.py     ← OpenAI call + structured parsing
  local_classifier.py ← fast heuristics (before LLM)
  attachment_security.py
  auth_results.py     ← SPF/DKIM/DMARC verdict parser
  safe_link.py        ← anti-phishing interstitial (`/safe-link?url=…`)
  brands.py           ← curated brand list for typosquat / subdomain-spoof
  secrets_store.py    ← OS-keyring wrapper (Credential Manager / Keychain
                        / Secret Service) — IMAP passwords + OpenAI key
  secrets_migration.py← one-shot move of clear-text secrets into the keyring
  scheduler.py        ← apscheduler — periodic jobs
  notifier.py         ← ntfy push
  lifecycle.py        ← start/stop services
  updater.py          ← GitHub Releases poller + one-click install
  security/           ← cross-cutting hardening helpers
    tls.py            ← refuse verify_ssl=False on non-loopback hosts
    url_safety.py     ← SSRF block on outbound HTTP (private IPs etc.)
    origin.py         ← FastAPI middleware: cross-origin POST → 403
    rate_limit.py     ← shared slowapi `Limiter` instance

tests/                ← pytest suite (run via `python -m pytest -q`)
  conftest.py         ← per-test tempdir + in-memory keyring fixtures
  test_security.py
  test_safe_link.py
  test_secrets_store.py
  test_attachment_security.py
  test_auth_results.py
  test_config_validation.py

scripts/              ← dev scripts (never run directly, go through dev.bat / bash)
  install.bat         ← venv + dependencies (Windows)
  start.bat           ← console mode (Windows)
  build.bat           ← PyInstaller (Windows)
  build.sh            ← PyInstaller (macOS / Linux)
  build_installer.bat ← chains build.bat + ISCC (Windows)
  installer.iss       ← Inno Setup script (Windows installer)
  create_shortcut.bat ← desktop shortcut (dev, Windows)
  open_when_ready.ps1 ← waits for the port before opening the browser

docs/
  MARKETING.md         ← positioning, pitch, manifesto
  DEVELOPING.md        ← this file
  RELEASE-NOTES.md     ← English release notes + PR-facing copy conventions
  SECURITY-ROADMAP.md  ← long-term security work that's still on the table

.github/workflows/
  ci.yml               ← pytest on every push / PR
  release.yml          ← .exe + installer build on tag, draft release
```

## Environment variables

| Variable | Effect |
|---|---|
| `LULLMAIL_DATA` | Force the data directory (handy to test onboarding on a clean copy). |
| `LULLMAIL_NO_MIGRATE=1` | Disable auto-migration of a `config.yaml` sitting next to the exe. |
| `LULLMAIL_PORT` | Force a fixed port instead of an ephemeral one. |
| `LULLMAIL_NOINTERACT=1` | Skip the `pause` and `start explorer` at the end of `build.bat` — used by CI and `build_installer.bat`. |

## Architecture in 30 seconds

```
        ┌───────────────────────────────────┐
        │   LullMail.exe (pywebview)        │
        │   ┌─────────────────────┐         │
        │   │ Edge WebView2       │ ←── frontend/* (HTML/JS)
        │   └────────┬────────────┘         │
        │            │ HTTP loopback        │
        │            │ + Origin-check       │
        │            │ + rate-limit         │
        │   ┌────────▼────────────┐         │
        │   │ FastAPI (uvicorn)   │         │
        │   └──────┬──────────────┘         │
        │          │                        │
        │   ┌──────▼──────┐  ┌────────────┐ │
        │   │ APScheduler │  │ SQLite     │ │
        │   └──────┬──────┘  └────────────┘ │
        │          │         ┌────────────┐ │
        │          │         │ OS keyring │ ←── IMAP pwd + OpenAI key
        │          │         └────────────┘ │
        │   ┌──────▼──────┐                 │
        │   │ IMAP poll   │ ───── OpenAI (summaries)
        │   │  + ntfy push│ ───── ntfy.sh  (notifications)
        │   └─────────────┘ ───── GitHub   (updater check)
        └───────────────────────────────────┘
```

Everything is local except outbound calls to OpenAI (summaries +
score), ntfy.sh (push), and the GitHub Releases API (auto-update
poll, every 6 h). IMAP credentials stay in the OS keyring on the
machine. The optional one-click List-Unsubscribe POST goes through
the SSRF guard in `src/security/url_safety.py` so an attacker-
controlled URL can't probe the local network.

## Internationalisation (i18n)

Lull Mail ships bilingual **French / English** since v0.3.0.

**Detection**, in priority order:
1. `?lang=en` or `?lang=fr` URL parameter
2. `localStorage.lullmail.lang` (`'en'` or `'fr'`)
3. `navigator.language` — starts with `fr` → French, anything else → English

**Architecture**: a single file [`frontend/i18n.js`](../frontend/i18n.js)
holds both dictionaries (FR + EN), exposes `window.t(key, vars)` and
`window.applyI18n(root)`, and applies `data-i18n*` attributes on load.

**Supported HTML attributes**:
- `data-i18n="key"` → `textContent`
- `data-i18n-html="key"` → `innerHTML` (only for trusted strings)
- `data-i18n-placeholder="key"` → `placeholder`
- `data-i18n-aria-label="key"` → `aria-label`
- `data-i18n-title="key"` → `title`

For dynamically-built strings in JS, call `window.t('key', { var: 'value' })`
directly. Interpolation uses `{var}`.

**v0.3.0 coverage**:

| Surface | Status |
|---|---|
| Onboarding wizard | ✅ Complete |
| Rail / sidebar + keyboard shortcuts | ✅ Complete |
| Unsubscribe modal, finalize | ✅ Complete |
| Settings page (`settings.js`) | ❌ French only |
| Inbox (`mailbox.js`) | ❌ French only |
| Dashboard (`dashboard.js`) | ❌ French only |
| Cleanup (`cleanup.js`) | ❌ French only |
| Backend errors (`src/setup_api.py`) | ❌ French only |

The v0.4.0 goal is to finish coverage on the Settings and Inbox pages
(the two most visible surfaces after onboarding).

**Adding a string**: open `frontend/i18n.js`, add the key in both
`STRINGS.fr` and `STRINGS.en`. Reference it via `data-i18n="key"` in
HTML or `window.t('key')` in JS.

**Force a language for testing**:
```
http://localhost:8000/?lang=en
http://localhost:8000/?lang=fr
```
Or in the console: `localStorage.setItem('lullmail.lang', 'en')` then reload.

## Migrations & paths

`src/paths.py` is the **only** module that knows where data lives.
It handles three modes:

- **Frozen (.exe)** — `%APPDATA%\LullMail\`
- **Dev** — project root (where `main.py` lives)
- **Override** — `LULLMAIL_DATA` env var

And two boot-time migrations:

1. **Rename** `%APPDATA%\AgenticMail` → `%APPDATA%\LullMail` when an
   install under the old name is detected (atomic rename, never
   clobbers the new dir).
2. **Copy** any `config.yaml` sitting next to the exe into
   `%APPDATA%\LullMail\` on first launch (legacy distribution
   without an installer). Skipped if the candidate looks like a dev
   source tree — otherwise builds run from `dist\LullMail\` would
   inherit the developer's `config.yaml` and onboarding would never
   trigger.

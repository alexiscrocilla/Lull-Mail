# Developing Lull Mail

Guide to clone, run in dev mode, build the exe and the installer.

---

## Prerequisites

- **Windows 10 or 11.** The Python code is cross-platform but the
  onedir packaging + WebView2 + tray icon are tested on Windows
  only.
- **Python 3.11+** with `python` or `py` on `PATH`.
- *(Optional — to build the installer)* [Inno Setup 6](https://jrsoftware.org/isdl.php).

## All commands go through `dev.bat`

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

## First run

```cmd
.\dev.bat install
.\dev.bat start
```

`dev.bat start` opens the browser at http://localhost:8000 once the
server is responding. The dashboard is identical to the native app's.

In dev mode, `config.yaml` and `data/` live **at the project root**
(not in `%APPDATA%`). Handy to test with a throwaway config without
polluting your installed Lull Mail.

## Building a Windows exe

```cmd
.\dev.bat build
```

Runs PyInstaller through `lull_mail.spec` and produces a **onedir**
bundle (the `dist\LullMail\` folder contains the exe + DLLs +
`frontend/`). No onefile: faster startup, easier debugging.

## Building an installer (Inno Setup)

```cmd
.\dev.bat installer
```

Chains `dev.bat build` (silent mode via `LULLMAIL_NOINTERACT=1`) and
then compiles `scripts\installer.iss` to produce
`dist\LullMail-Setup-X.Y.Z.exe`. The installer:

- installs to `%LOCALAPPDATA%\Programs\LullMail` (no admin),
- adds a Start Menu entry + an optional desktop shortcut,
- offers Windows autostart (checkbox, off by default),
- registers in Add/Remove Programs (clean uninstall),
- **does not touch** `%APPDATA%\LullMail` (user data stays intact
  after uninstall — use `Settings → Storage → Delete my data`
  beforehand if you want to wipe everything).

**Bumping the version**: edit `MyAppVersion` at the top of
`scripts\installer.iss`. The value flows into the output filename
and the Add/Remove Programs entry.

## Release cycle (CI)

The [`.github/workflows/release.yml`](../.github/workflows/release.yml)
workflow builds the app + installer on tag `vX.Y.Z` and publishes the
result as a draft release. Procedure:

```cmd
:: 1. Bump the version in scripts\installer.iss (#define MyAppVersion).
:: 2. Commit, push.
:: 3. Tag.
git tag v0.4.0
git push --tags
:: 4. The workflow runs ~10 min on a Windows runner. A draft release
::    appears in the Releases tab with the exe attached. Verify, publish.
```

## Repo structure

```
dev.bat               ← single dispatcher for install / start / build / installer
lull_mail.spec        ← PyInstaller spec
app_gui.py            ← native app entry point (PyInstaller)
main.py               ← console / dev entry point
requirements.txt
README.md

assets/
  lull_mail.ico       ← multi-resolution Windows icon (16…256)

frontend/             ← UI served by FastAPI
  index.html / app.js / dashboard.js / mailbox.js / cleanup.js
  settings.js         ← Settings page (mountSettings)
  onboarding.html / onboarding.js
  i18n.js             ← FR/EN translation module
  api.js / style.css
  assets/             ← logos / icons used in the UI

src/                  ← Python code
  api.py              ← FastAPI: dashboard routes
  setup_api.py        ← FastAPI: onboarding & settings routes
  paths.py            ← path resolution (dev vs frozen) + migrations
  config.py           ← config.yaml I/O + validation
  database.py         ← SQLite (emails, sync_state)
  email_fetcher.py    ← IMAP polling
  ai_processor.py     ← OpenAI call + structured parsing
  local_classifier.py ← fast heuristics (before LLM)
  attachment_security.py
  scheduler.py        ← apscheduler — periodic jobs
  notifier.py         ← ntfy push
  lifecycle.py        ← start/stop services

scripts/              ← dev scripts (never run directly, go through dev.bat)
  install.bat         ← venv + dependencies
  start.bat           ← console mode
  build.bat           ← PyInstaller
  build_installer.bat ← chains build.bat + ISCC
  installer.iss       ← Inno Setup script
  create_shortcut.bat ← desktop shortcut (dev)
  open_when_ready.ps1 ← waits for the port before opening the browser

docs/
  MARKETING.md        ← positioning, pitch, manifesto
  DEVELOPING.md       ← this file
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
        ┌───────────────────────────────┐
        │   LullMail.exe (pywebview)    │
        │   ┌─────────────────────┐     │
        │   │ Edge WebView2       │ ←── frontend/* (HTML/JS)
        │   └────────┬────────────┘     │
        │            │ HTTP loopback    │
        │   ┌────────▼────────────┐     │
        │   │ FastAPI (uvicorn)   │     │
        │   └──────┬──────────────┘     │
        │          │                    │
        │   ┌──────▼──────┐  ┌────────┐ │
        │   │ APScheduler │  │ SQLite │ │
        │   └──────┬──────┘  └────────┘ │
        │          │                    │
        │   ┌──────▼──────┐             │
        │   │ IMAP poll   │ ───── OpenAI (summaries)
        │   │  + ntfy push│ ───── ntfy.sh (notifications)
        │   └─────────────┘             │
        └───────────────────────────────┘
```

Everything is local except outbound calls to OpenAI (summaries +
score) and ntfy.sh (push). IMAP credentials never leave the machine.

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

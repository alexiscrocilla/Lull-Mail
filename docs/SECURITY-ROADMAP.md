# Security roadmap (long-term)

This file tracks security improvements that go **beyond** the work
already shipped (sandboxed iframe + anti-phishing interstitial,
TLS / SSRF / origin-check network guards, OS-keyring credential
storage, remote-image blocker + SPF/DKIM/DMARC verdict badges,
per-endpoint rate-limit, automated test suite). Each entry below is
a deliberate scope cut. The underlying problem is real but the
remediation is heavier (new deps, significant code, or business-
grade infrastructure) and warrants its own focused work.

Order is rough priority. Top entries land first when capacity allows.

---

## 1. End-to-end encryption: OpenPGP / S/MIME

**Problem.** Lull Mail can decrypt and display whatever the IMAP
server hands over. Anything end-to-end encrypted between sender and
recipient (PGP-armoured body, S/MIME multipart) currently shows as
gibberish or as a `.asc` attachment the user has to handle by hand.
Sending encrypted mail isn't possible at all (we don't even speak
SMTP yet).

**Scope.**
- Decoding: detect `multipart/encrypted` / `multipart/signed`,
  decrypt with the user's private key, render the inner part
  through the same sandbox + image-blocker pipeline as plain HTML.
- Sending: requires SMTP support first (separate roadmap entry).
- Key management: import `.asc` keys, store private keys in the OS
  keyring under a separate service (`lull-mail-pgp`), display key
  fingerprints in Settings.

**Library options.**
- `python-gnupg`: wraps the GnuPG CLI. Mature, but adds an
  external runtime dep (`gpg` / `gpg.exe`) and ships a fairly
  large binary distribution.
- `PGPy`: pure Python implementation. No external deps, smaller
  PyInstaller bundle, slower decryption on large mails.

**Decision deferred.** Tie-breaker is whether we end up needing
GnuPG for keyring access on Linux too.

---

## 2. Antivirus integration on attachment download

**Problem.** Today's attachment pipeline (`src/attachment_security.py`)
catches the obvious: extensions, magic bytes, EICAR, double
extensions, suspicious MIME mismatches. It does NOT scan with a real
AV engine, so a freshly-crafted dropper hidden in a PDF with valid
PDF magic bytes would be marked `safe` and saved.

**Scope.**
- **Windows:** call into AMSI (`AMSIScanBuffer`) via `ctypes` before
  writing the attachment to disk. AMSI is the API Defender (and
  third-party AVs) hook into, which gets us free coverage from
  whatever the user already runs.
- **macOS:** XProtect runs system-wide whenever a file lands in
  user space, no API needed; document it.
- **Linux:** invoke `clamdscan` over the local socket if the daemon
  is running; skip silently otherwise.

**New surface.** A new `THREAT_AV_DETECTED` tier in
`attachment_security`, an `av_engine` field on the DB row, and a
clear UI banner when an AV verdict overrides our heuristic.

---

## 3. Local LLM backend (no more uploads to OpenAI)

**Problem.** Every email body (subject + first 8 KB) is sent to
OpenAI for classification + summary. The user accepts this when
configuring the OpenAI key, but it's the strongest argument against
Lull Mail vs. ProtonMail for privacy-first users.

**Scope.**
- Add a `ai.backend = "openai" | "local"` switch in `config.yaml`.
- Local backend runs a quantised Llama 3 8B (or a more recent
  small model) via `llama-cpp-python` (CPU/GPU agnostic).
- First-run downloads the model (~5 GB) with explicit user consent
  + progress bar.
- Provide a quality-vs-speed switch (Llama 3 8B q4 ≈ 2 s/email on
  recent CPUs, q8 ≈ 4 s/email but better summaries).
- Document the trade-off: local = private but slower + bigger
  install; OpenAI = fast + free for the user (low cost) but
  contents leave the machine.

**Risk.** Adds 5+ GB to the install footprint. A separate
"download model" optional installer is probably the right shape.

---

## 4. Code-signing the Windows installer

**Problem.** Today's installer is unsigned. Windows SmartScreen
shows the "this app may be dangerous" dialog on every fresh
download, training users to click "Run anyway" on unsigned
binaries, exactly the muscle reflex phishing distributors want.

**Scope.**
- Acquire an EV Code Signing certificate (DigiCert / Sectigo,
  ~€350/year, requires HSM hardware).
- Hook `signtool sign /tr <ts> /td sha256 /fd sha256 ...` into
  `release.yml` between `Verify installer output` and
  `Create draft GitHub release`.
- Optionally also sign `LullMail.exe` itself (not just the
  installer) so the smartscreen verdict carries to subsequent
  launches.

**Cost.** Hard money + admin overhead. Worth doing once the user
base is large enough that the SmartScreen friction visibly hurts
conversion.

---

## 5. Optional master password (alternative to OS keyring)

**Problem.** The OS keyring solves the disk-secret problem on
single-user machines, but on a shared Linux box (or any setup
where multiple humans share the same OS account) every user has
read access to every other user's keyring entry. Same for Windows
profiles bypassed via offline disk access.

**Scope.**
- Opt-in flag in Settings: "Protect with master password".
- When enabled, secrets are encrypted with AES-GCM keyed by
  PBKDF2(passphrase, salt, 600k iterations). The encrypted blob
  lives in `config.yaml` instead of the keyring.
- App startup pops a native password dialog (pywebview-native)
  before the wizard / dashboard load.
- Coexists with the keyring path: if the master password mode is
  off, behaviour stays exactly as today.

**Risk.** Lost master password = lost secrets. The wipe flow stays
the recovery path: re-setup from scratch.

---

## 6. DMARC / DKIM aggregate reports for power users

**Problem.** Lull Mail already surfaces SPF/DKIM/DMARC verdicts
per email, but doesn't aggregate them across the whole inbox. A user
running their own domain might want to see "98% of mail purporting
to be from `mydomain.com` failed DMARC last month", a signal of
active spoofing campaigns.

**Scope.**
- New page under Cleanup: "Authentification expéditeurs".
- Per-domain rollup of pass/fail counts over the last 30 / 90 days.
- Export to CSV / JSON for forwarding to a real DMARC aggregator
  (DMARCian, Postmark, …).

**Cost.** Pure UI work on top of the existing `auth_results`
column. Cheap, but niche audience.

---

## 7. Audit log of destructive actions

**Problem.** Lull Mail can bulk-delete thousands of emails via a
rule, mass-unsubscribe, or wipe the entire local store. Today
those actions are logged to `lull_mail.log` in plain text (rotated
by us, no integrity guarantee). A rogue script with API access
could trigger a destructive action AND scrub the log line.

**Scope.**
- Append-only DB table `audit_log(timestamp, action, target,
  count, user_origin)`.
- `pragma journal_mode=wal` already gives us per-row durability.
- Settings page surfaces the last 30 days of destructive actions
  with a "this is read-only" disclaimer.
- Future: HMAC-chain each row to detect post-hoc tampering
  (Merkle log style, overkill for now, noted as a stretch).

---

## Out-of-scope, but worth noting

- **Sender-based block-list.** Anti-spam is well covered by IMAP
  servers themselves (Gmail, Outlook, etc.). Implementing our own
  Bayesian filter would compete with mail providers for no real
  win.
- **Per-account VPN / proxy routing.** Niche, lots of code, low
  threat-model gain. Better solved by the user's OS-wide VPN.
- **Hardware-token (YubiKey) protection of the master password.**
  Worth revisiting once #5 ships and we measure actual demand.

---

_Last review: 2026-05-07. Re-review every 6 months or whenever
significant new security work ships._

# Release process: dev -> public

This is the explicit checklist for publishing a Lull Mail release. It
exists because the dev repo (`Lull-Mail-dev`, private) and the public
mirror (`alexiscrocilla/Lull-Mail`) have diverged histories on purpose,
and several past releases hit avoidable bugs (stale badges, missing
files, slug typos). Follow it in order.

For the *contents* of release notes (voice, structure, what to drop),
see [`RELEASE-NOTES.md`](RELEASE-NOTES.md).

## Prerequisites (one-time)

- [ ] `gh` CLI authenticated against both repos (`gh auth status`).
- [ ] `git filter-repo` installed (`pip install git-filter-repo`).
- [ ] Inno Setup installed locally if you want to test the Windows
      installer build before pushing (CI also builds it).
- [ ] **Update signing configured on the PUBLIC repo** — see below. Until
      it is, a release build fails on purpose rather than shipping an app
      that can never update itself.

### Update signing (one-time, public repo)

The app verifies an Ed25519 signature over the release manifest before it
offers an update, and the trusted public keys are **sealed into the binary
at build time**. That ordering is the whole reason this is a prerequisite:
a build made without keys produces an installer that refuses every update
for ever, and no later fix to CI can repair the copies already downloaded.

1. Generate the pair, once, on a machine you trust:

   ```bash
   python scripts/new_update_key.py --key-id 2026-09
   ```

2. On **`alexiscrocilla/Lull-Mail`** (the repo releases are published
   from — not the dev repo), add:

   | Kind | Name | Value |
   |------|------|-------|
   | Variable | `LULLMAIL_UPDATE_PUBLIC_KEYS` | the JSON the script printed |
   | Variable | `LULLMAIL_UPDATE_KEY_ID` | the `--key-id` you chose |
   | Secret | `UPDATE_SIGNING_PRIVATE_KEY` | the contents of the key file |

   `gh secret set` reads the value from standard input, so the key never
   has to appear in a command line — and therefore never in a shell
   history file.

   ```bash
   # bash / zsh
   gh secret set UPDATE_SIGNING_PRIVATE_KEY --repo alexiscrocilla/Lull-Mail      < update-signing-key.private
   ```

   ```powershell
   # PowerShell: `<` is a reserved operator and errors out, so let cmd do
   # the redirection. Do NOT use --body "$(Get-Content ...)": that writes
   # the key into ConsoleHost_history.txt.
   cmd /c "gh secret set UPDATE_SIGNING_PRIVATE_KEY --repo alexiscrocilla/Lull-Mail < update-signing-key.private"
   ```

   Or, on any shell, run it with no `--body` and no redirection at all and
   paste the value into the prompt `gh` opens.

3. Delete the private key file, or move it to a password manager. Losing
   it means you can never sign another update for the installs that trust
   that key; leaking it means someone else can.

**Releases must be tagged on the public repo.** `src/updater.py` only
accepts download URLs under `alexiscrocilla/Lull-Mail`, so a release cut
from the dev repo produces a correctly signed manifest pointing at URLs
every install rejects — and the only symptom is "no update available".
The release job reads that constant rather than `$GITHUB_REPOSITORY`, and
verifies the finished manifest against the published public keys before
the draft is created, so this fails in CI rather than in the field.

**Rotating a key:** keep the old public key in the JSON alongside the new
one until nobody is still running a build that predates the new one. A
build trusts every key in that object. Removing one strands anybody who
has not updated since.

## Per-release checklist

### 1. Pick the version

There is nothing to edit. The version comes from the tag: the workflow
derives it from `GITHUB_REF_NAME`, `scripts/build.*` writes
`src/_version.py` from it (a generated, gitignored file), and ISCC gets it
as `/DMyAppVersion`.

- [ ] Decide `vX.Y.Z` and check it sorts after the last tag.
- [ ] Do **not** add a bare `#define MyAppVersion` to
      `scripts/installer.iss`. Inno Setup takes the last `#define`, so it
      silently overrides the workflow's `/D` — that is how a `v0.7.1` tag
      once shipped `LullMail-Setup-0.7.0.exe`. The `#ifndef` fallback in
      that file exists only for ad-hoc local builds.

### 2. Update release notes

- [ ] Open `docs/RELEASE-NOTES.md` for the voice + template.
- [ ] Draft the highlights section against the user-visible changes
      since the last tag. Keep it under one screen.
- [ ] Write it to `docs/releases/vX.Y.Z.md` so the text is reviewed with
      the code rather than typed into the GitHub form at publish time.
- [ ] PR titles since last tag: `git log v<previous>..HEAD --oneline`.

### 3. Run preflight checks

- [ ] `pwsh scripts/preflight-public-push.ps1 -All`
  - All FAIL items must be resolved.
  - `INFO` items (e.g. screenshot paths not on disk yet) are
    expected until visuals land.
- [ ] Optional but recommended before a public push:
      `pwsh scripts/preflight-public-push.ps1 -All -Online` (also
      verifies shields.io badge URLs return 200).

### 4. Sync to public mirror

The public mirror lives at `alexiscrocilla/Lull-Mail`. We run a
sanitised `git filter-repo` pass before push so dev-only commits never
appear in public history.

The public repo is a **sanitised mirror** of dev `main`, not a shared
history: filter-repo rewrites every hash, so the two histories run in
parallel and the push replaces public `main` wholesale. Old commits stay
reachable through the existing release tags, which the push leaves alone.

**Never run filter-repo inside `Lull-Mail-dev`.** It rewrites the repo in
place and would destroy the dev history. Always work in a throwaway
clone, as below.

#### Dev-only paths (the sanitisation list)

These never go public. Keep this list in sync with reality — an earlier
release leaked `BACKLOG.md` precisely because the rules lived in nobody's
notes:

| Path | Why it stays private |
|---|---|
| `BACKLOG.md` | Unshipped feature list; sets expectations we haven't committed to. |
| `docs/AUDIT-UX-BOITE-MAIL.md` | Catalogue of 81 internal UX/a11y defects with line numbers. |
| `docs/PLAN-CORRECTIFS-BOITE-MAIL.md` | Remediation plan naming what is still deliberately unfixed. |
| `docs/AUDIT-MULTI-COMPTES.md` | Same shape as the UX audit: regressions and pre-existing defects with file:line, several still open on purpose. |

Everything else ships. In particular `MARKETING.md` (voice guide),
`SECURITY-ROADMAP.md` (deliberate scope cuts, no exploitable detail) and
this file are public on purpose — a privacy-first app benefits from
showing its reasoning.

#### The pipeline

```bash
# 1. Throwaway clone of dev main (never filter-repo the dev repo itself)
git clone --no-local --branch main /path/to/Lull-Mail-dev /tmp/public-sync
cd /tmp/public-sync

# 2. Strip the dev-only paths from ALL history
git filter-repo --force --invert-paths \
  --path BACKLOG.md \
  --path docs/AUDIT-UX-BOITE-MAIL.md \
  --path docs/PLAN-CORRECTIFS-BOITE-MAIL.md \
  --path docs/AUDIT-MULTI-COMPTES.md

# 3. Verify before pushing anything
#    - every dev-only path returns 0 commits:
for f in BACKLOG.md docs/AUDIT-UX-BOITE-MAIL.md \
         docs/PLAN-CORRECTIFS-BOITE-MAIL.md docs/AUDIT-MULTI-COMPTES.md; do
  git log --all --oneline -- "$f" | wc -l
done
#    - every remaining file is byte-identical to dev main (empty diff):
diff <(git -C /path/to/Lull-Mail-dev ls-tree -r main \
        | grep -vE 'BACKLOG|AUDIT-UX-BOITE-MAIL|PLAN-CORRECTIFS-BOITE-MAIL|AUDIT-MULTI-COMPTES' \
        | awk '{print $3, $4}' | sort) \
     <(git ls-tree -r HEAD | awk '{print $3, $4}' | sort)
#    - preflight passes on the sanitised tree:
pwsh scripts/preflight-public-push.ps1 -All

# 4. Push (commits that only touched excluded paths vanish — expected)
git remote add public https://github.com/alexiscrocilla/Lull-Mail.git
git fetch public
git push public main --force-with-lease
```

`--force-with-lease` (never plain `--force`) so a push that landed on
public since the last fetch aborts instead of being silently erased.

### 5. Tag and trigger the build

- [ ] On the public mirror: `git tag vX.Y.Z && git push public vX.Y.Z`.
- [ ] The `Release` workflow (`.github/workflows/release.yml`) fires:
      builds Windows / macOS / Linux artefacts, attaches them to a
      *draft* GitHub release.
- [ ] Watch `gh run watch` until all three jobs are green.

### 6. Review and publish

- [ ] Open the draft release in the browser (or `gh release view
      vX.Y.Z --web`).
- [ ] Replace GitHub's auto-generated body with the release notes
      drafted in step 2 (template in `RELEASE-NOTES.md`).
- [ ] Download all three artefacts and smoke-test each:
  - Windows: install via the `.exe`, launch the app, run setup.
  - macOS: open the `.dmg`, drag to Applications, right-click ->
    Open (Gatekeeper), run setup.
  - Linux: extract the `.tar.gz`, run `LullMail/LullMail`.
- [ ] If any smoke test fails, fix forward: delete the draft, push a
      new tag.
- [ ] Click **Publish release** when all three pass.

### 7. Post-publish

- [ ] Hit one of the shields.io badge URLs in your browser to force
      its CDN to re-fetch (the cache TTL is 5 min; this skips the
      wait).
- [ ] Confirm `https://alexiscrocilla.github.io/Lull-Mail/` is live and
      shows the latest version in the hero.
- [ ] If the auto-update feature is enabled, the in-app update check
      will pick up the new release within ~6 hours.

## One-time public-repo configuration

These commands set repo-level metadata (description, homepage, topics,
Pages source). Run once after the public mirror has all the files from
this overhaul. Re-run only when topics or description change.

```bash
gh repo edit alexiscrocilla/Lull-Mail \
  --description "Your inbox, on mute. A local desktop app that filters noise and only notifies you when something actually matters." \
  --homepage "https://alexiscrocilla.github.io/Lull-Mail/" \
  --add-topic email --add-topic email-client --add-topic imap \
  --add-topic desktop-app --add-topic python --add-topic pywebview \
  --add-topic privacy --add-topic local-first --add-topic productivity \
  --add-topic gmail --add-topic outlook --add-topic cross-platform \
  --add-topic windows --add-topic macos --add-topic linux \
  --add-topic email-triage --add-topic gpl-v3 --add-topic open-source

# Enable Pages from main:/docs (one-time)
gh api -X POST repos/alexiscrocilla/Lull-Mail/pages \
  -f "source[branch]=main" -f "source[path]=/docs"
```

Topics deliberately omit `ai` / `gpt` / `llm`; see voice rule #1 in
[`MARKETING.md`](MARKETING.md) ("never lead with AI").

## What the preflight script checks (and why)

| Check | Why it exists |
|---|---|
| Forbidden `Lull-Mail-dev` references | Caught a release where a doc link still pointed at the private repo. |
| LICENSE present + GPL v3 | Without it GitHub doesn't tag the repo as open-source; the license badge would also break. |
| No "To be defined" placeholders | Old README footer used to ship "To be defined" as the licence section. |
| Internal markdown links resolve | Renamed files broke 4 links across docs in past releases. |
| Required community-health files | GitHub's community profile checks expect these; missing files lower the project score. |
| No private absolute paths | Stops `d:\Données Utilisateur\...` from leaking via stack traces, configs, or accidental copy-paste. |
| Workflow + issue-template slug sanity | Prevents a `Lull-Mail-dev` slug landing in a workflow on the public repo. |
| README asset existence | Stops broken images on the GitHub README. |
| shields.io URLs (online) | Catches typos in badge URLs before the README renders broken in front of visitors. |

The script does not replace common sense. It catches the regressions
we have already seen in production. Add new checks here when you find a
new failure mode.

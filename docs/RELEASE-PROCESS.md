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

## Per-release checklist

### 1. Bump version

- [ ] `scripts/installer.iss`: update `MyAppVersion`.
- [ ] Confirm the version matches what you'll tag (`vX.Y.Z`). The
      release workflow extracts the version from the tag and fails the
      build if the installer's `MyAppVersion` doesn't match.

### 2. Update release notes

- [ ] Open `docs/RELEASE-NOTES.md` for the voice + template.
- [ ] Draft the highlights section against the user-visible changes
      since the last tag. Keep it under one screen.
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

- [ ] `git fetch public && git reset --hard public/main`. Make sure
      the local clone reflects the latest public state before
      rewriting history (sync local to remote BEFORE filter-repo,
      otherwise a stale local clone overwrites newer remote state).
- [ ] Run the existing `git filter-repo` sanitisation pipeline
      (project-specific; document in your own notes if not yet
      automated).
- [ ] `git push public main --force-with-lease`. Never plain
      `--force` on `main`.

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

# Contributing to Lull Mail

Thanks for considering a contribution. Lull Mail is a small, opinionated
project. The bar for "is this aligned with what we're building" matters
as much as the bar for "does this code work". Before opening a PR, skim
[`docs/DEVELOPING.md`](docs/DEVELOPING.md) for local setup and
[`docs/MARKETING.md`](docs/MARKETING.md) for the product voice and
positioning.

## Code of conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
By participating you agree to its terms. Reports go to
`contact.Lullmail@pm.me`.

## What we're looking for

- **Bug reports** with clear reproduction steps. Use the
  [bug-report template](.github/ISSUE_TEMPLATE/bug_report.yml).
- **Bug fixes**, especially around mail-server quirks (Gmail OAuth,
  Outlook IMAP edge cases, ProtonMail Bridge, etc.).
- **Privacy and security improvements**: see
  [`docs/SECURITY-ROADMAP.md`](docs/SECURITY-ROADMAP.md) for items
  already on our list.
- **Provider tweaks** to better detect newsletters, transactional
  mail, or scoring edge cases.
- **Translations**: the UI is currently FR/EN; adding a new locale
  is welcome.

## What we're slow on

- **Pure-refactor PRs** with no user-visible benefit.
- **New top-level features** without a prior discussion in an issue.
- **Cloud-first or telemetry-adjacent features.** Lull Mail is
  local-first by construction; this is non-negotiable.
- **AI-generated PRs.** Disclose it in the PR description if you used
  an LLM substantially. We don't auto-reject, but we read more
  carefully.

## Before opening a PR

1. **Search existing issues** so you don't duplicate something.
2. **Run the test suite** locally: `pytest`.
3. **Match the existing code style.** No formatter is enforced; just
   read the surrounding code.
4. **English for GitHub-facing copy.** PR titles, descriptions, and
   release-note bullets are English. UI strings can stay bilingual
   (mirrors [`docs/RELEASE-NOTES.md`](docs/RELEASE-NOTES.md)).
5. **For UI changes**, attach a screenshot or short clip in the PR
   description.

## Branching & commits

- Branch off `main` with a short descriptive name (`fix/imap-attach-utf8`,
  `feat/protonmail-detection`).
- Conventional-commit-ish prefix in the title: `fix:`, `feat:`,
  `docs:`, `refactor:`, `test:`. Not strict; just helpful for the
  release-notes draft.
- Keep commits focused. Prefer multiple small commits over one giant
  one.

## PR checklist

- [ ] Tests pass (`pytest`).
- [ ] User-visible change: a one-line entry suitable for the next
      release notes is in the PR description.
- [ ] UI change: screenshot attached.
- [ ] No secrets, no `.env` files, no API keys committed.
- [ ] Touched code carries the existing
      `# SPDX-License-Identifier: GPL-3.0-or-later` header (new files
      need it on line 1).

## Licence of contributions

Lull Mail is licensed under [GPL v3](LICENSE). Contributions are
inbound under the same terms. By opening a pull request you agree
that your contribution will be licensed under GPL v3 or later. There
is no CLA. You retain copyright on your work.

## Reporting security issues

**Do not open public issues for vulnerabilities.** Email
`contact.Lullmail@pm.me` directly. Include reproduction steps and an
estimate of impact. We aim to respond within five working days.

## Recognition

Material contributors are credited by name in the release notes.
We do not run a "all-contributors" bot. Credit goes to people who
shipped, not people who showed up.

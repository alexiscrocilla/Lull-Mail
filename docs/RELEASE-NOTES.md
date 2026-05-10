# GitHub release notes

## Language (mandatory)

**Pull requests** (title and description) and **GitHub Releases** text
must be written in **English**. The app UI may stay bilingual
(FR/EN); this policy applies only to GitHub-facing copy.

---

This document defines tone and layout for text on the
[Releases](https://github.com/alexiscrocilla/Lull-Mail/releases) page.
CI opens a **draft** with binaries and, by default, GitHub's generated
"What's Changed" block. Before publishing, replace that block with a
short note following this guide, or keep only the **Full Changelog**
link at the bottom if you prefer.

## Goals

- Readable in about one minute: no essays, no implementation dumps
  (file names, internal routes, test details).
- Style similar to
  [home-assistant/core](https://github.com/home-assistant/core/releases):
  one bullet = one idea, active voice, one or two lines per bullet max.
- **Highlights** and **Install** are the sections we keep; everything
  else is optional and short.
- Open with one line that fits *this* release (bugfix, feature drop,
  packaging). Reuse a short product line below if you want, but avoid
  pasting the same long tagline every time with no lead-in.

## Avoid (AI-ish or marketing tone)

- Empty hype: "landscape", "testament to", "pivotal", "commitment to".
- Rule-of-three adjectives and stacked "-ing" phrases.
- Long "What's new" sections that repeat Git history or architecture.
- Emojis in headings (optional warning once per OS is fine).
- Bold at the start of every highlight (reads like a slide deck).

## Recommended structure

1. **Title**: `Lull Mail X.Y.Z` (filled by the workflow).
2. **One line** (optional): what this release does, no superlatives.
3. **`## Highlights`**: 3-6 bullets, user-first.
4. **`## Install`**: small table (file + action) plus one-line
   SmartScreen / Gatekeeper warnings where relevant.
5. **`## Notes`** (optional): migration, breaking changes, new config -
   one or two sentences, or 2-3 bullets.
6. **Full Changelog**: `https://github.com/OWNER/REPO/compare/vA.B.C...vX.Y.Z`
   (copy from GitHub's generated note before replacing it, or rebuild).

Technical detail (SQL, YAML keys, touched modules) belongs in commits /
PRs; the release blurb summarizes user-visible impact.

## Copy-paste template

```markdown
One line: what this release changes (user-visible).

Lull Mail: local-first IMAP desktop client (triage, reply, compose, labels, filing).

## Highlights

-

## Install

| Platform | File | Install |
|----------|------|---------|
| Windows 10/11 | `LullMail-Setup-X.Y.Z.exe` | Double-click |
| macOS 12+ | `LullMail-X.Y.Z.dmg` | Open, drag to Applications |
| Linux | `LullMail-X.Y.Z.tar.gz` | Extract and run `LullMail/LullMail` |

- **Windows**: SmartScreen (unsigned installer). *More info* → *Run anyway*.
- **macOS**: Gatekeeper (app not notarized). Right-click the app → *Open*.

## Notes

(optional: migration, new `config.yaml` keys, etc.)

**Full Changelog:** https://github.com/alexiscrocilla/Lull-Mail/compare/vPREVIOUS...vX.Y.Z
```

To publish: **Releases** → open the draft for the tag → **Edit** → replace the generated body using the template above (set `vPREVIOUS...vX.Y.Z` to the real compare range).

## Pre-publish checklist

- [ ] Highlights: user-visible changes only.
- [ ] No pasted commit lists or implementation essays.
- [ ] Install table matches tagged artefact names.
- [ ] Full Changelog URL uses the correct tag range.
- [ ] Entire note is in **English**.
- [ ] Straight ASCII quotes in UI strings (`"` not `""`).

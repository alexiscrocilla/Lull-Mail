# Screenshot & demo asset contract

The README and the GitHub Pages landing both reference fixed filenames
in this folder. Drop the assets here using the names below and both
surfaces update at once — no markdown or HTML edits needed.

## Required files

| Filename | Format | Dimensions | Max size | Used in |
|---|---|---|---|---|
| `01-triage.png` | PNG | 1280×800 | 500 KB | README grid (left) |
| `02-summary.png` | PNG | 1280×800 | 500 KB | README grid (centre) |
| `03-dashboard.png` | PNG | 1280×800 | 500 KB | README grid (right) |

The landing page (`docs/index.html`) renders both the inbox and the
dashboard as CSS-only mockups inside a swipe carousel, so it does
not reference any file in this folder.

## Optional (dark variants)

The README logo block already swaps light/dark via `<picture>`. We can
extend the same pattern to screenshots later — drop a `*-dark.png` next
to each light variant and we'll wire the swap.

| Filename | When to add |
|---|---|
| `01-triage-dark.png`, `02-summary-dark.png`, `03-dashboard-dark.png` | If the app's dark theme reads materially different |

## Compression tips

- PNGs: run through [pngquant](https://pngquant.org/) (`pngquant --quality=70-90 input.png`).

## What to capture

The three PNGs should land on the moments that *make the case* for
the product, in order of impact:

1. **`01-triage.png`** — the smart inbox view: importance score,
   two-line summary, classification badge. This is the "is the AI
   any good?" answer.
2. **`02-summary.png`** — close-up on a single email card with the
   summary, score, and unsubscribe CTA. Shows that the value
   compresses 80 lines to 2.
3. **`03-dashboard.png`** — the AI triage dashboard: category
   distribution donut, queue status, real OpenAI cost over 30 days,
   top senders. Shows the bird's-eye view of what's been processed
   and how cheap it ran.

## Privacy note

Use a sanitised mailbox. No real names, real subjects, real client
correspondence. Either build a fixture with synthetic emails or blur
sensitive fields (subjects, sender names) in post.

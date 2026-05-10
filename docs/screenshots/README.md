# Screenshot & demo asset contract

The README and the GitHub Pages landing both reference fixed filenames
in this folder. Drop the assets here using the names below and both
surfaces update at once — no markdown or HTML edits needed.

## Required files

| Filename | Format | Dimensions | Max size | Used in |
|---|---|---|---|---|
| `01-triage.png` | PNG | 1280×800 | 500 KB | README grid (top-left), landing demo |
| `02-summary.png` | PNG | 1280×800 | 500 KB | README grid (top-right), landing demo |
| `03-dashboard.png` | PNG | 1280×800 | 500 KB | README grid (bottom-left), landing demo |
| `04-notification.png` | PNG | 1280×800 | 500 KB | README grid (bottom-right), landing demo |
| `demo.gif` | GIF (loop) | 720×450 | 8 MB | README hero clip, landing hero clip |

## Optional (dark variants)

The README logo block already swaps light/dark via `<picture>`. We can
extend the same pattern to screenshots later — drop a `*-dark.png` next
to each light variant and we'll wire the swap.

| Filename | When to add |
|---|---|
| `01-triage-dark.png` … `04-notification-dark.png` (incl. `03-dashboard-dark.png`) | If the app's dark theme reads materially different |
| `demo-dark.gif` | Optional; usually not worth it |

## Compression tips

- PNGs: run through [pngquant](https://pngquant.org/) (`pngquant --quality=70-90 input.png`).
- GIFs: keep the loop tight (≤ 15 s), drop the framerate to 15 fps,
  use [gifsicle](https://www.lcdf.org/gifsicle/) (`gifsicle -O3 --colors 128`)
  or [Gifski](https://gif.ski/) for higher quality at smaller sizes.
- Aim for the README hero GIF to load in under 2 s on a 10 Mbps connection.

## What to capture

The four PNGs and the GIF should land on the moments that *make the
case* for the product, in order of impact:

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
4. **`04-notification.png`** — the OS notification banner. Shows the
   single-buzz-per-day promise.
5. **`demo.gif`** — 10 seconds: open inbox → scroll list → click an
   important email → notification fires for a new urgent one.
   Don't try to show everything; show the rhythm.

## Privacy note

Use a sanitised mailbox. No real names, real subjects, real client
correspondence. Either build a fixture with synthetic emails or blur
sensitive fields (subjects, sender names) in post.

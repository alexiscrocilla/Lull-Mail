"""Cross-cutting security helpers.

Each module here is small and focussed:

- `tls`    — guard against accidental MITM exposure
- `origin` — FastAPI middleware that rejects cross-origin mutating
             requests (Lot B / step 5)

Adjacent in spirit to `src/attachment_security.py` and
`src/safe_link.py`, which are bigger and self-contained enough to live
at module top-level.
"""

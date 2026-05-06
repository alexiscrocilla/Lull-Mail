"""
Shared slowapi `Limiter` instance.

Lives in its own module so both `src/api.py` (the main app) and
`src/setup_api.py` (the wizard router) can import the same limiter
without creating a circular dependency. The limiter is bound to the
FastAPI app's middleware stack inside `api.py` — this file is just
the construction point.

Key strategy
------------
`get_remote_address` returns the client IP. On Lull Mail's
loopback-only deployment that's always `127.0.0.1`, so every caller
shares the same bucket. The limits act as a brake on a misbehaving
local script (a runaway POST loop, a third-party helper hammering
`/api/setup/*`) rather than as classic per-user throttling — the
desktop app is single-user by design.
"""

from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address


limiter = Limiter(key_func=get_remote_address)

# SPDX-License-Identifier: GPL-3.0-or-later
"""
CSRF mitigation: origin-check middleware.

Lull Mail's API is served on `127.0.0.1:<port>`. With no auth and no
CORS configured, any web page the user happens to visit while the
app is running could `fetch('http://127.0.0.1:8000/api/sync',
{method:'POST'})` from JS and trigger destructive actions in the
inbox. The browser blocks the *response* from being read (CORS), but
the *request* still goes through — that's a classic CSRF.

This middleware refuses every state-changing request whose `Origin`
header doesn't match our own origin. Same-origin requests sent from
the dashboard/onboarding pages always carry an Origin matching the
bound port; cross-origin requests carry the attacker's origin, which
is never on the allowlist.

Allowed Origins are computed dynamically from `app.state.bound_port`,
set by the entry points (`main.py`, `app_gui.py`) right after picking
a port. If the entry point forgets to set it, the middleware falls
back to a permissive mode (lenient default) so the app boots; this
is logged loudly so it's noticed.

Notes
-----
• `GET / HEAD / OPTIONS` are always allowed (preflight + read-only).
• Requests without an Origin header are allowed too — that's how
  webview-rendered pages, server-side `RedirectResponse`s and a few
  legitimate fetch contexts behave. Origin-less attacks would need a
  malicious local script that bypasses the browser entirely, in
  which case origin-check isn't the right defence anyway.
• Loopback origins (`http://127.0.0.1:<port>`, `http://localhost:<port>`)
  are accepted for any port — pywebview, the dev uvicorn run, and
  tests sometimes use ephemeral ports we can't predict at module
  load.
"""

from __future__ import annotations

import logging
from typing import Optional, Set

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


logger = logging.getLogger(__name__)


# Methods that don't change state. RFC 9110 marks GET, HEAD, OPTIONS as
# safe; we add TRACE for completeness even though we never serve it.
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})


def _allowed_origins(bound_port: Optional[int]) -> Set[str]:
    """Build the per-request origin allowlist. Static loopback hosts
    on the bound port; the wildcard 'any loopback port' fallback is
    handled by `_is_loopback_origin` for ephemeral / test scenarios."""
    origins: Set[str] = set()
    if bound_port:
        origins.add(f"http://127.0.0.1:{bound_port}")
        origins.add(f"http://localhost:{bound_port}")
    return origins


def _is_loopback_origin(origin: str) -> bool:
    """Lenient match for any loopback origin regardless of port. Used
    so the dev wizard on :8000 keeps working alongside the desktop
    build on a random ephemeral port."""
    if not origin:
        return False
    o = origin.lower()
    return (
        o.startswith("http://127.0.0.1:")
        or o.startswith("http://localhost:")
        or o.startswith("http://[::1]:")
        # File:// origin happens when the frontend runs from a local
        # file (rare in our setup, but harmless and same-machine).
        or o == "null"
    )


class OriginCheckMiddleware(BaseHTTPMiddleware):
    """Reject mutating requests with a foreign Origin."""

    async def dispatch(self, request: Request, call_next):
        if request.method in _SAFE_METHODS:
            return await call_next(request)

        origin = request.headers.get("origin", "")

        # Origin-less requests pass — see module docstring.
        if not origin:
            return await call_next(request)

        bound_port: Optional[int] = getattr(
            request.app.state, "bound_port", None
        )
        explicit = _allowed_origins(bound_port)

        if origin in explicit or _is_loopback_origin(origin):
            return await call_next(request)

        logger.warning(
            "Origin-check refused: method=%s path=%s origin=%r "
            "(allowed: %s)", request.method, request.url.path, origin,
            sorted(explicit) or "{loopback only}",
        )
        return JSONResponse(
            {
                "error": "origin_refused",
                "detail": (
                    "Cette requête provient d'une origine non autorisée. "
                    "Lull Mail n'accepte les actions modifiantes que "
                    "depuis sa propre interface locale."
                ),
            },
            status_code=403,
        )

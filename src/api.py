# SPDX-License-Identifier: GPL-3.0-or-later
import hashlib
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Literal, Optional, Tuple

from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from src import config as cfg
from src import database as db
from src import attachment_security as att_sec
from src import brand_logos as _brand_logos
from src import paths as _paths
from src.i18n import tr, get_locale
from src.search_query import parse_search_query
from src.safe_link import router as _safe_link_router

logger = logging.getLogger(__name__)

app = FastAPI(title="Lull Mail", docs_url=None, redoc_url=None)
# Anti-phishing interstitial — `/safe-link?url=...` is the click-target the
# frontend rewrites to when an email link is detected as a homograph spoof.
app.include_router(_safe_link_router)

# Origin-check CSRF guard. Mutating requests (POST/PATCH/DELETE/PUT) must
# carry an Origin header pointing at our own loopback host. The bound port
# is published by the entry points (main.py / app_gui.py) via
# app.state.bound_port — when absent, the middleware accepts any loopback
# origin (lenient fallback so dev tools on ephemeral ports keep working).
from src.security.origin import OriginCheckMiddleware  # noqa: E402
app.add_middleware(OriginCheckMiddleware)

# Rate limiter. Shared instance lives in src/security/rate_limit so
# the wizard router (src/setup_api.py) can decorate its own endpoints
# with the same `@limiter.limit(...)` without creating a circular
# import. Per-endpoint limits are intentionally loose: well above
# realistic human use, but tight enough to stop runaway local loops
# within a few seconds.
from slowapi.errors import RateLimitExceeded  # noqa: E402
from slowapi.middleware import SlowAPIMiddleware  # noqa: E402
from starlette.responses import JSONResponse  # noqa: E402

from src.security.rate_limit import limiter  # noqa: E402

app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)


def _rate_limit_handler(request: Request, exc: RateLimitExceeded):
    """Friendly 429 response — the default slowapi handler returns a
    text/plain body which the frontend can't surface usefully."""
    locale = get_locale(request)
    return JSONResponse(
        {
            "error": "rate_limited",
            "detail": tr("rate_limited", locale),
            "retry_after": str(exc.detail),
        },
        status_code=429,
        headers={"Retry-After": "10"},
    )


app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)


def _frontend_dir() -> Path:
    # When frozen by PyInstaller, static assets live in the temp _MEIPASS dir.
    # In dev / source runs, they sit next to the project root.
    base = Path(getattr(__import__("sys"), "_MEIPASS", Path.cwd()))
    bundled = base / "frontend"
    if bundled.exists():
        return bundled
    return Path("frontend")


FRONTEND = _frontend_dir()


# ── Models ────────────────────────────────────────────────────────────────────

_VALID_CATEGORIES = {"important", "newsletter", "transactional", "spam", "other", "pending"}
# Built-in folder names. Custom folders (Phase 4) are stored in the
# `folders` table and joined into the validation set at request time
# via `_valid_folders()` below.
_BUILTIN_FOLDERS = {"inbox", "deleted", "sent", "draft"}


def _valid_folders() -> set:
    """Built-ins + every custom folder defined in the DB."""
    return _BUILTIN_FOLDERS | db.custom_folder_names()


class EmailPatch(BaseModel):
    is_read: Optional[bool] = None
    category: Optional[str] = None
    folder: Optional[str] = None
    is_favourite: Optional[bool] = None
    # Lets the frontend persist edits the user makes to an AI-generated
    # draft (Modifier → composer → close). When provided, replaces the
    # stored body verbatim. None = unchanged.
    draft_response: Optional[str] = None


class CleanupSenderReq(BaseModel):
    sender: str
    action: Literal["delete", "mark_read"]
    account: Optional[str] = None


class RuleFilter(BaseModel):
    """Generic filter spec used by the rules cleanup tab. Every field is
    optional and they combine with AND. Within subject_keywords /
    sender_keywords, values are OR'd (any keyword match is sufficient)."""

    categories: Optional[List[str]] = None
    max_score: Optional[int] = None
    is_read: Optional[bool] = None
    older_than_days: Optional[int] = None
    account: Optional[str] = None
    subject_keywords: Optional[List[str]] = None
    sender_keywords: Optional[List[str]] = None


class RuleRunReq(BaseModel):
    filter: RuleFilter
    action: Literal["delete", "mark_read"]


class UnsubscribeReq(BaseModel):
    sender: str
    account: Optional[str] = None
    # 'auto' = use one-click HTTPS POST when available, otherwise return
    # `action_required: open_url|open_mailto` so the UI opens a tab.
    # 'http_only' / 'mailto_only' force a specific mode for retry / fallback.
    mode: Literal["auto", "http_only", "mailto_only"] = "auto"
    purge: bool = False  # also trash existing messages from this sender
    force: bool = False  # bypass `unsubscribed_at IS NULL` idempotency gate


class UnsubscribeBulkReq(BaseModel):
    senders: List[str]
    account: Optional[str] = None
    purge: bool = False


class FolderCreate(BaseModel):
    name: str


class FolderPatch(BaseModel):
    name: Optional[str] = None
    position: Optional[int] = None


class LabelCreate(BaseModel):
    name: str
    color: str = "#94A3B8"


class LabelPatch(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    position: Optional[int] = None


class EmailLabelsSet(BaseModel):
    """Replace-all assignment for a single email. Empty list clears
    every label currently assigned."""

    label_ids: List[int] = []


class DraftCreate(BaseModel):
    """Compose-from-scratch draft. Every field is optional so the
    frontend can call POST early (with just `from_account`) and PATCH
    incrementally as the user types — same wire shape both ways."""

    from_account: str
    to: Optional[str] = ""
    cc: Optional[str] = ""
    bcc: Optional[str] = ""
    subject: Optional[str] = ""
    body_text: Optional[str] = ""
    in_reply_to_int: Optional[int] = None


class DraftPatch(BaseModel):
    """Partial update — same fields as DraftCreate but each one
    optional with `None` meaning "leave it alone". Empty strings ARE
    a meaningful value (user cleared the field)."""

    from_account: Optional[str] = None
    to: Optional[str] = None
    cc: Optional[str] = None
    bcc: Optional[str] = None
    subject: Optional[str] = None
    body_text: Optional[str] = None
    in_reply_to_int: Optional[int] = None


class SendRequest(BaseModel):
    """Outbound message payload. `to`/`cc`/`bcc` accept either a single
    string ("a@b.com, c@d.com") or a list. `reply_to_int_id` is a
    server-side shortcut: when set, the API loads the original
    message-id + References from the `emails` table and threads the
    reply automatically — the frontend doesn't have to know those
    headers exist."""

    from_account: str
    to: List[str] = []
    cc: List[str] = []
    bcc: List[str] = []
    subject: str = ""
    body_text: str = ""
    body_html: Optional[str] = None
    reply_to_int_id: Optional[int] = None
    in_reply_to: Optional[str] = None
    references: Optional[str] = None
    # Phase 4 — staged outbound files. Each id points at an upload
    # previously created via POST /api/uploads. `attachments` lands
    # as proper file attachments; `inline_images` are referenced via
    # `cid:<id>` from `body_html` and stay tied to the HTML part.
    attachments: List[str] = []
    inline_images: List[str] = []


# ── Email routes ──────────────────────────────────────────────────────────────

@app.get("/api/emails")
def list_emails(
    account: Optional[str] = None,
    accounts: Optional[str] = None,
    category: Optional[str] = None,
    is_read: Optional[bool] = None,
    needs_reply: Optional[bool] = None,
    folder: Optional[str] = None,
    sender: Optional[str] = None,
    label: Optional[int] = None,
    view: str = "flat",
    limit: int = 100,
    offset: int = 0,
):
    # `accounts` (comma-separated) is the multi-account variant. Without
    # it, a multi-selection in the sidebar would have to fall back to
    # "no account filter + client-side prune", which silently drops
    # mail from light accounts once the 2000-row cap is reached.
    acct_filter: Optional[object] = account
    if accounts:
        parsed = [a.strip() for a in accounts.split(",") if a.strip()]
        if parsed:
            acct_filter = parsed if len(parsed) > 1 else parsed[0]

    if view == "threads":
        # Collapsed conversation view: one row per thread. get_threads takes a
        # single account, so a multi-selection falls back to all accounts.
        # is_read/needs_reply/label are honoured at the thread level so the
        # sidebar/chip filters work the same as in flat view.
        rows = db.get_threads(
            account=acct_filter if isinstance(acct_filter, str) else None,
            folder=folder, category=category,
            is_read=is_read, needs_reply=needs_reply, label=label,
            limit=min(limit, 2000), offset=offset,
        )
    else:
        rows = db.get_emails(
            account=acct_filter,
            category=category,
            is_read=is_read,
            needs_reply=needs_reply,
            folder=folder,
            sender=sender,
            label=label,
            limit=min(limit, 2000),
            offset=offset,
        )
    _attach_counts_and_labels(rows)
    return rows


def _attach_counts_and_labels(rows: list) -> list:
    """Bulk-attach an `attachments` summary + `labels[]` to a list of email
    rows so the list/search views render the paperclip icon, risk badge and
    coloured chips without N+1 queries. Mutates rows in place and returns it."""
    if rows:
        counts = db.attachment_counts_for_messages([r["message_id"] for r in rows])
        for r in rows:
            c = counts.get(r["message_id"])
            r["attachments"] = c or {"total": 0, "dangerous": 0, "suspicious": 0}
        labels_by_id = db.get_labels_for_emails([int(r["int_id"]) for r in rows])
        for r in rows:
            r["labels"] = labels_by_id.get(int(r["int_id"]), [])
    return rows


@app.get("/api/brand-logo/{domain}")
def brand_logo(domain: str):
    """Sender-domain favicon, fetched and cached **locally** by
    src/brand_logos.py — the client never contacts a third-party favicon
    service. Returns the image bytes, or 404 when the domain has no usable
    logo (the UI then falls back to the coloured initials bubble).

    Sync `def` on purpose: the fetch is blocking I/O, so FastAPI runs it in
    the threadpool instead of stalling the event loop.
    """
    got = _brand_logos.get_logo(domain)
    if not got:
        # Cache the negative in the browser too so an inbox repaint doesn't
        # re-ask; real network fetches are already throttled by the on-disk
        # `.miss` markers.
        return Response(status_code=404, headers={"Cache-Control": "public, max-age=86400"})
    data, content_type = got
    return Response(
        content=data,
        media_type=content_type,
        headers={
            "Cache-Control": "public, max-age=604800, immutable",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )


@app.get("/api/emails/search")
def search_emails_ep(q: str, account: Optional[str] = None,
                     folder: Optional[str] = None,
                     limit: int = 100, offset: int = 0):
    """Server-side search with Gmail-style operators (from:/to:/subject:/in:/
    is:/has:/before:/after:). `folder` scopes results to the current view's
    folder unless the query already carries an explicit `in:` operator.
    Returns parsed filters + results."""
    parsed = parse_search_query(q)
    if folder and not parsed.get("folder"):
        parsed["folder"] = folder
    rows = db.search_emails(parsed, account=account,
                            limit=min(limit, 2000), offset=offset)
    _attach_counts_and_labels(rows)
    return {"parsed": parsed, "results": rows}


@app.get("/api/emails/{int_id}")
def get_email(int_id: int, bg: BackgroundTasks, locale: str = Depends(get_locale)):
    em = db.get_email_by_id(int_id)
    if not em:
        raise HTTPException(404, tr("email.not_found", locale))
    # Lazy attachment scan: if this row was ingested before the PJ
    # extraction was added, kick off a single-message IMAP fetch in the
    # background. The first read returns no attachments; on a refresh a
    # few seconds later they'll be there. This avoids forcing the user to
    # run a full backfill before they can ever see PJ on legacy mail.
    if (
        not em.get("attachments_scanned_at")
        and em.get("uid")
        and em.get("folder") != "deleted"
    ):
        bg.add_task(_lazy_scan_one, em["int_id"], em["account_email"], em["uid"], em["message_id"])
    rows = db.get_attachments_for_message(em["message_id"])
    em["attachments"] = [_attachment_summary(r) for r in rows]
    em["attachments_pending_scan"] = not bool(em.get("attachments_scanned_at"))
    # Remote-image blocker: tell the frontend whether to render remote
    # images directly or behind a placeholder. Defaults to False — only
    # senders the user has explicitly trusted via the in-mail banner.
    sender_domain = ""
    raw_sender = em.get("sender") or ""
    m = re.search(r"@([\w.\-]+)", raw_sender)
    if m:
        sender_domain = m.group(1).lower()
    em["sender_domain"] = sender_domain
    em["sender_images_trusted"] = (
        db.is_sender_trusted_for_images(sender_domain) if sender_domain else False
    )
    # Phase 3 — attach the user-defined labels assigned to this email
    # so the read pane can render chips without an extra round-trip.
    em["labels"] = [
        {"id": l["id"], "name": l["name"], "color": l["color"], "position": l.get("position", 0)}
        for l in db.get_labels_for_email(int_id)
    ]
    return em


@app.get("/api/emails/{int_id}/thread")
def get_email_thread(int_id: int, locale: str = Depends(get_locale)):
    """All messages in the conversation an email belongs to, oldest first."""
    em = db.get_email_by_id(int_id)
    if not em:
        raise HTTPException(404, tr("email.not_found", locale))
    # Conversation identity = COALESCE(thread_id, message_id), matching the
    # collapsed list view (get_threads). Passing message_id when thread_id is
    # NULL keeps the pivot in its own thread.
    thread_key = em.get("thread_id") or em.get("message_id")
    rows = db.get_thread(thread_key)
    _attach_counts_and_labels(rows)
    return {"thread_id": thread_key, "messages": rows}


def _lazy_scan_one(int_id: int, account_email: str, uid: str, message_id: str):
    """Single-message IMAP fetch + attachment persist. Used for the
    on-demand scan path triggered by the read pane."""
    from src.email_fetcher import batch_scan_attachments
    acc = _account_for(account_email)
    if not acc:
        return
    policy = att_sec.policy_from_config(cfg.get())
    try:
        batch_scan_attachments(
            acc,
            [{"uid": uid, "message_id": message_id}],
            policy,
        )
    except Exception as e:
        logger.warning(f"lazy attachment scan failed for {message_id}: {e}")


@app.patch("/api/emails/{int_id}")
def patch_email(int_id: int, patch: EmailPatch, bg: BackgroundTasks, locale: str = Depends(get_locale)):
    em = db.get_email_by_id(int_id)
    if not em:
        raise HTTPException(404, tr("email.not_found", locale))

    if patch.is_read is True and not em.get("is_read"):
        db.mark_read(em["message_id"])
        bg.add_task(_imap_mark_seen, em["account_email"], em["uid"])
    elif patch.is_read is False and em.get("is_read"):
        db.mark_unread(em["message_id"])
        bg.add_task(_imap_mark_unseen, em["account_email"], em["uid"])

    if patch.category is not None:
        if patch.category not in _VALID_CATEGORIES:
            raise HTTPException(400, tr("email.category_invalid", locale, category=patch.category))
        if patch.category != em.get("category"):
            db.update_email_category(em["message_id"], patch.category)

    if patch.folder is not None:
        if patch.folder not in _valid_folders():
            raise HTTPException(400, tr("email.folder_invalid", locale, folder=patch.folder))
        if patch.folder != em.get("folder"):
            db.update_email_folder(em["message_id"], patch.folder)
            bg.add_task(_imap_apply_folder, em["account_email"], em["uid"], patch.folder)

    if patch.is_favourite is not None:
        if bool(em.get("is_favourite")) != patch.is_favourite:
            db.set_favourite(em["message_id"], patch.is_favourite)
            bg.add_task(_imap_set_favourite, em["account_email"], em["uid"], patch.is_favourite)

    if patch.draft_response is not None:
        # Allow clearing (empty string) or replacing the AI draft. The
        # body is trusted as-is — the field is plain text rendered via
        # escapeHtml on the way out.
        if patch.draft_response != (em.get("draft_response") or ""):
            db.set_draft_response(em["message_id"], patch.draft_response)
            # Setting an empty draft means the user discarded it; flip
            # needs_reply off so the list-card icon stops nagging.
            if not patch.draft_response.strip():
                db.set_needs_reply(em["message_id"], False)

    return {"ok": True}


@app.post("/api/emails/{int_id}/draft")
def generate_draft(int_id: int, locale: str = Depends(get_locale)):
    """Generate an AI draft reply on demand for a specific email.

    When a draft already exists we return it verbatim (idempotent). On
    fresh generation we also flip `needs_reply = 1`: the user explicitly
    asked for a reply, so the email semantically "awaits a reply" and the
    list-card reply icon should reflect that. Returns the persisted state
    flags too so the frontend can update its local cache without a
    follow-up GET.
    """
    from src.ai_processor import enrich_draft, init_client
    em = db.get_email_by_id(int_id)
    if not em:
        raise HTTPException(404, tr("email.not_found", locale))
    if em.get("draft_response"):
        # Idempotent path. We still ensure needs_reply is set to 1 in case
        # an older row had a draft without the flag (legacy state).
        if not em.get("needs_reply"):
            db.set_needs_reply(em["message_id"], True)
        return {
            "draft_response": em["draft_response"],
            "needs_reply": True,
        }
    if not cfg.ai_enabled():
        raise HTTPException(409, tr("email.ai_disabled.draft", locale))
    conf = cfg.get()
    # Lazy init: covers the path where the user just toggled AI on via
    # Settings. The startup-time init in lifecycle.py was skipped (key
    # was empty back then) and the next sync hasn't run yet.
    init_client(conf["openai"]["api_key"])
    model = conf.get("openai", {}).get("model", "gpt-4o-mini")
    result = enrich_draft(em, dict(em), model=model)
    draft = result.get("draft_response") or ""
    if draft:
        db.set_draft_response(em["message_id"], draft)
        db.set_needs_reply(em["message_id"], True)
    return {
        "draft_response": draft,
        "needs_reply": bool(draft),
    }


class AssistantAsk(BaseModel):
    message: str
    # Previous turns of the SAME conversation, oldest first:
    # [{"role": "user"|"assistant", "content": "..."}]. Optional — a fresh
    # question sends none. The frontend owns the thread; the backend stays
    # stateless and just replays what it is given (bounded below).
    history: Optional[List[Dict[str, str]]] = None


def _sanitize_history(raw: Optional[List[Dict[str, str]]]) -> List[Dict[str, str]]:
    """Whitelist roles, force str content, and bound the replay: the last 12
    turns, 4 000 chars each. Keeps a runaway client from stuffing the model
    context (and the local backend's 4-8k window) with arbitrary payloads."""
    out: List[Dict[str, str]] = []
    for entry in (raw or []):
        role = str(entry.get("role", ""))
        content = entry.get("content", "")
        if role not in ("user", "assistant") or not isinstance(content, str):
            continue
        content = content.strip()
        if not content:
            continue
        out.append({"role": role, "content": content[:4000]})
    return out[-12:]


@app.post("/api/assistant/ask")
@limiter.limit("20/minute")
def assistant_ask(request: Request, body: AssistantAsk,
                  locale: str = Depends(get_locale)):
    """Bounded AI agent over the local mailbox. Returns the assistant's text
    plus a `trace` of the tool calls (transparency). Read + draft only — no
    send. Runs on the active LLM backend: cloud OpenAI, or the local model
    (tool-calling best-effort on small local models)."""
    if not cfg.ai_enabled():
        raise HTTPException(409, tr("assistant.ai_disabled", locale))
    from src.ai_processor import init_client
    from src import agent
    conf = cfg.get()
    # OpenAI needs a lazy client init (the local analyzer is already started by
    # lifecycle at boot). run_agent(model=None) then picks the active backend's
    # model via chat_client().
    if (conf.get("llm") or {}).get("provider", "openai") == "openai":
        init_client(conf.get("openai", {}).get("api_key", ""))
    try:
        return agent.run_agent(body.message, history=_sanitize_history(body.history))
    except RuntimeError:
        # No LLM backend ready (e.g. local analyzer not started) → unavailable.
        raise HTTPException(409, tr("assistant.ai_disabled", locale))
    except Exception as e:  # noqa: BLE001
        logging.getLogger(__name__).error(f"assistant error: {e}")
        raise HTTPException(502, tr("assistant.failed", locale))


@app.post("/api/emails/{int_id}/draft/stream")
def generate_draft_stream(int_id: int, locale: str = Depends(get_locale)):
    """Variante streaming de `generate_draft`. Réservée au provider local
    parce que c'est là où la latence brute (10-15 s) tue l'UX. Renvoie
    un flux SSE où chaque event est `{"delta": "...mot..."}` puis un
    event final `{"done": true, "full_text": "..."}`.

    Le frontend (mailbox.js btn-ai-draft) consomme le flux et append
    les deltas au textarea du composer au fur et à mesure. À la fin,
    le backend persiste `draft_response` dans la DB et flippe
    `needs_reply=1`, exactement comme la version non-streaming.

    Si le provider actif n'est PAS local, on renvoie 409 — le frontend
    fait alors un fallback sur l'endpoint non-streaming /draft.
    """
    em = db.get_email_by_id(int_id)
    if not em:
        raise HTTPException(404, tr("email.not_found", locale))
    if em.get("draft_response"):
        # Idempotent : on renvoie un mini-flux qui annonce direct le
        # texte déjà persisté. Permet au frontend de garder le même
        # code (toujours stream) sans cas particulier.
        cached = em["draft_response"]
        if not em.get("needs_reply"):
            db.set_needs_reply(em["message_id"], True)
        def cached_stream():
            yield f"data: {json.dumps({'delta': cached})}\n\n"
            yield f"data: {json.dumps({'done': True, 'full_text': cached, 'needs_reply': True})}\n\n"
        return StreamingResponse(
            cached_stream(), media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    if not cfg.ai_enabled():
        raise HTTPException(409, tr("email.ai_disabled.draft", locale))

    from src.llm.registry import get_provider
    provider = get_provider()
    if provider.name != "local":
        raise HTTPException(
            409,
            tr("email.streaming_not_supported", locale,
               default="Streaming non disponible avec le provider actif. Utilisez /draft."),
        )

    from src.llm import prompts_local as plocal

    def event_stream():
        accumulated = []
        try:
            for chunk in provider.stream_draft(dict(em)):
                accumulated.append(chunk)
                # Wrap each chunk in an SSE event. We don't trim the
                # accumulated prefix mid-stream — strip_draft_prefix is
                # applied ONCE at the end on the full text so a partial
                # match doesn't gobble valid content.
                payload = json.dumps({"delta": chunk})
                yield f"data: {payload}\n\n"
        except Exception as e:
            logger.exception("draft stream error")
            err = json.dumps({"error": str(e)})
            yield f"data: {err}\n\n"
            return

        full_text = plocal.strip_draft_prefix("".join(accumulated)).rstrip()
        if full_text:
            try:
                db.set_draft_response(em["message_id"], full_text)
                db.set_needs_reply(em["message_id"], True)
            except Exception:
                logger.exception("persist streamed draft failed")
        final = json.dumps({
            "done": True,
            "full_text": full_text,
            "needs_reply": bool(full_text),
        })
        yield f"data: {final}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/emails/{int_id}/reanalyze")
def reanalyze_email(int_id: int, locale: str = Depends(get_locale)):
    from src.ai_processor import process_email, init_client
    em = db.get_email_by_id(int_id)
    if not em:
        raise HTTPException(404, tr("email.not_found", locale))
    if not cfg.ai_enabled():
        raise HTTPException(409, tr("email.ai_disabled.reanalyze", locale))
    conf = cfg.get()
    init_client(conf["openai"]["api_key"])
    model = conf.get("openai", {}).get("model", "gpt-4o-mini")
    result = process_email(em, model=model)
    if not result:
        raise HTTPException(502, tr("email.reanalyze_failed", locale))
    db.update_email_ai(em["message_id"], result)
    return db.get_email_by_id(int_id)


@app.post("/api/emails/send")
@limiter.limit("30/minute")
def send_email(request: Request, payload: SendRequest, locale: str = Depends(get_locale)):
    """Deliver a message via the SMTP server tied to `from_account`.

    The request body is intentionally lean: when `reply_to_int_id` is
    set, this endpoint loads the original Message-ID/References from
    `emails` so the new mail threads correctly without the frontend
    having to fish those headers itself. Synchronous: the HTTP response
    only returns once smtplib accepted the message (or raised).
    """
    from src import email_sender as sender

    if not payload.from_account.strip():
        raise HTTPException(400, tr("email.send.from_required", locale))
    if not payload.to:
        raise HTTPException(400, tr("email.send.to_required", locale))

    in_reply_to = (payload.in_reply_to or "").strip() or None
    references = (payload.references or "").strip() or None
    if payload.reply_to_int_id is not None:
        original = db.get_email_by_id(payload.reply_to_int_id)
        if original:
            orig_mid = (original.get("message_id") or "").strip()
            if orig_mid:
                if not in_reply_to:
                    in_reply_to = orig_mid
                if not references:
                    # No `References` header is captured at ingest yet, so
                    # we fall back to a single-element chain pointing at the
                    # original — good enough for most clients to thread.
                    references = orig_mid

    outbox_id = db.insert_outbox_pending(
        account_email=payload.from_account,
        to_addr=", ".join(payload.to),
        cc_addr=", ".join(payload.cc or []),
        bcc_addr=", ".join(payload.bcc or []),
        subject=payload.subject or "",
        body_text=payload.body_text or "",
        in_reply_to=in_reply_to,
        refs=references,
    )

    try:
        result = sender.send_message(
            account_email=payload.from_account,
            to=payload.to,
            cc=payload.cc or [],
            bcc=payload.bcc or [],
            subject=payload.subject or "",
            body_text=payload.body_text or "",
            body_html=payload.body_html,
            in_reply_to=in_reply_to,
            references=references,
            attachments=payload.attachments or [],
            inline_images=payload.inline_images or [],
        )
    except sender.SendError as e:
        db.mark_outbox_failed(outbox_id, e.stage, str(e))
        # Authentication failures and missing config are user errors → 400.
        # Everything else (connect/ssl/data/recipients) is upstream → 502.
        status = 400 if e.stage in {
            "auth", "smtp_unconfigured", "missing_password",
            "account_disabled", "account_missing", "address_validation",
            "empty_to", "upload_missing", "upload_invalid",
        } else 502
        raise HTTPException(
            status_code=status,
            detail={
                "error": "send_failed",
                "stage": e.stage,
                "message": str(e),
            },
        )
    except Exception as e:
        logger.exception("send_email: unexpected exception")
        db.mark_outbox_failed(outbox_id, "unknown", str(e))
        raise HTTPException(500, tr("email.send.unexpected", locale, msg=str(e)))

    db.mark_outbox_sent(outbox_id, result["message_id"])
    return {
        "ok": True,
        "message_id": result["message_id"],
        "smtp_host": result["smtp_host"],
    }


# ── Drafts (Phase 2) ──────────────────────────────────────────────────────────


def _draft_to_api(row: Dict) -> Dict:
    """Shape a `drafts` row for the wire. Mirrors the keys the frontend
    uses (camelCase free — keep snake_case to stay consistent with the
    rest of the email payload)."""
    return {
        "id": row.get("id"),
        "account_email": row.get("account_email", ""),
        "to": row.get("to_addr", "") or "",
        "cc": row.get("cc_addr", "") or "",
        "bcc": row.get("bcc_addr", "") or "",
        "subject": row.get("subject", "") or "",
        "body_text": row.get("body_text", "") or "",
        "in_reply_to_int": row.get("in_reply_to_int"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


@app.get("/api/drafts")
def list_drafts(
    account: Optional[str] = None,
    in_reply_to_int: Optional[int] = None,
):
    rows = db.list_drafts(account=account, in_reply_to_int=in_reply_to_int)
    return [_draft_to_api(r) for r in rows]


@app.post("/api/drafts")
def create_draft(payload: DraftCreate, locale: str = Depends(get_locale)):
    if not payload.from_account.strip():
        raise HTTPException(400, tr("draft.from_required", locale))
    draft_id = db.insert_draft(
        account_email=payload.from_account.strip(),
        to_addr=payload.to or "",
        cc_addr=payload.cc or "",
        bcc_addr=payload.bcc or "",
        subject=payload.subject or "",
        body_text=payload.body_text or "",
        in_reply_to_int=payload.in_reply_to_int,
    )
    row = db.get_draft(draft_id)
    if not row:
        raise HTTPException(500, tr("draft.insert_failed", locale))
    return _draft_to_api(row)


@app.patch("/api/drafts/{draft_id}")
def patch_draft(draft_id: int, payload: DraftPatch, locale: str = Depends(get_locale)):
    existing = db.get_draft(draft_id)
    if not existing:
        raise HTTPException(404, tr("draft.not_found", locale))
    db.update_draft(
        draft_id,
        account_email=(payload.from_account.strip() if payload.from_account is not None else None),
        to_addr=payload.to,
        cc_addr=payload.cc,
        bcc_addr=payload.bcc,
        subject=payload.subject,
        body_text=payload.body_text,
        in_reply_to_int=payload.in_reply_to_int,
    )
    row = db.get_draft(draft_id)
    return _draft_to_api(row) if row else {"ok": True}


@app.delete("/api/drafts/{draft_id}")
def remove_draft(draft_id: int, locale: str = Depends(get_locale)):
    existing = db.get_draft(draft_id)
    if not existing:
        raise HTTPException(404, tr("draft.not_found", locale))
    db.delete_draft(draft_id)
    return {"ok": True}


# ── Labels (Phase 3) ──────────────────────────────────────────────────────────


import sqlite3 as _sqlite3  # local alias for IntegrityError


def _label_to_api(row: Dict) -> Dict:
    return {
        "id": row.get("id"),
        "name": row.get("name", ""),
        "color": row.get("color") or "#94A3B8",
        "position": row.get("position", 0),
    }


@app.get("/api/labels")
def list_labels():
    return [_label_to_api(r) for r in db.list_labels()]


@app.post("/api/labels")
def create_label(payload: LabelCreate, locale: str = Depends(get_locale)):
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(400, tr("label.name_required", locale))
    if len(name) > 60:
        raise HTTPException(400, tr("label.name_too_long", locale))
    try:
        new_id = db.create_label(name, payload.color or "#94A3B8")
    except _sqlite3.IntegrityError:
        raise HTTPException(409, tr("label.named_exists", locale, name=name))
    row = db.get_label(new_id)
    return _label_to_api(row) if row else {"id": new_id}


@app.patch("/api/labels/{label_id}")
def patch_label(label_id: int, payload: LabelPatch, locale: str = Depends(get_locale)):
    existing = db.get_label(label_id)
    if not existing:
        raise HTTPException(404, tr("label.not_found", locale))
    if payload.name is not None and len(payload.name.strip()) > 60:
        raise HTTPException(400, tr("label.name_too_long", locale))
    try:
        db.update_label(
            label_id,
            name=payload.name,
            color=payload.color,
            position=payload.position,
        )
    except _sqlite3.IntegrityError:
        raise HTTPException(409, tr("label.exists", locale))
    except ValueError as e:
        raise HTTPException(400, str(e))
    row = db.get_label(label_id)
    return _label_to_api(row) if row else {"ok": True}


@app.delete("/api/labels/{label_id}")
def remove_label(label_id: int, locale: str = Depends(get_locale)):
    existing = db.get_label(label_id)
    if not existing:
        raise HTTPException(404, tr("label.not_found", locale))
    db.delete_label(label_id)
    return {"ok": True}


@app.put("/api/emails/{int_id}/labels")
def set_email_labels(int_id: int, payload: EmailLabelsSet, locale: str = Depends(get_locale)):
    em = db.get_email_by_id(int_id)
    if not em:
        raise HTTPException(404, tr("email.not_found", locale))
    # Validate every requested label exists — partial assignment with
    # phantom ids would silently drop those. The frontend already
    # restricts the picker to known labels, but keep this defensive.
    if payload.label_ids:
        for lid in payload.label_ids:
            if not db.get_label(int(lid)):
                raise HTTPException(400, tr("label.id_not_found", locale, id=lid))
    db.set_email_labels(int_id, payload.label_ids or [])
    labels = db.get_labels_for_email(int_id)
    return {"ok": True, "labels": [_label_to_api(l) for l in labels]}


# ── Custom folders (Phase 4) ─────────────────────────────────────────────────


_FOLDER_NAME_RE = re.compile(r"^[\w\- ]{1,40}$", re.UNICODE)


def _folder_to_api(row: Dict) -> Dict:
    return {
        "id": row.get("id"),
        "name": row.get("name", ""),
        "position": row.get("position", 0),
    }


def _validate_folder_name(name: str, locale: str = "fr") -> str:
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, tr("folder.name_required", locale))
    if name.lower() in _BUILTIN_FOLDERS:
        raise HTTPException(409, tr("folder.name_reserved", locale, name=name))
    if not _FOLDER_NAME_RE.match(name):
        raise HTTPException(400, tr("folder.name_invalid", locale))
    return name


@app.get("/api/folders")
def list_folders():
    return [_folder_to_api(r) for r in db.list_folders()]


@app.post("/api/folders")
def create_folder(payload: FolderCreate, locale: str = Depends(get_locale)):
    name = _validate_folder_name(payload.name, locale)
    if db.get_folder_by_name(name):
        raise HTTPException(409, tr("folder.named_exists", locale, name=name))
    try:
        new_id = db.create_folder(name)
    except _sqlite3.IntegrityError:
        raise HTTPException(409, tr("folder.named_exists", locale, name=name))
    row = db.get_folder(new_id)
    return _folder_to_api(row) if row else {"id": new_id}


@app.patch("/api/folders/{folder_id}")
def patch_folder(folder_id: int, payload: FolderPatch, locale: str = Depends(get_locale)):
    existing = db.get_folder(folder_id)
    if not existing:
        raise HTTPException(404, tr("folder.not_found", locale))
    new_name: Optional[str] = None
    if payload.name is not None:
        new_name = _validate_folder_name(payload.name, locale)
        # Renaming: also update every email currently filed under the
        # old name so they stay in the renamed folder.
        if new_name != existing["name"]:
            other = db.get_folder_by_name(new_name)
            if other and other["id"] != folder_id:
                raise HTTPException(409, tr("folder.named_exists", locale, name=new_name))
            with db._conn() as con:
                con.execute(
                    "UPDATE emails SET folder = ? WHERE folder = ?",
                    (new_name, existing["name"]),
                )
    try:
        db.update_folder(folder_id, name=new_name, position=payload.position)
    except _sqlite3.IntegrityError:
        raise HTTPException(409, tr("folder.exists", locale))
    except ValueError as e:
        raise HTTPException(400, str(e))
    row = db.get_folder(folder_id)
    return _folder_to_api(row) if row else {"ok": True}


@app.delete("/api/folders/{folder_id}")
def remove_folder(folder_id: int, locale: str = Depends(get_locale)):
    existing = db.get_folder(folder_id)
    if not existing:
        raise HTTPException(404, tr("folder.not_found", locale))
    db.delete_folder(folder_id, fallback_name="inbox")
    return {"ok": True}


# ── Outbound attachment uploads (Phase 4) ────────────────────────────────────


# Hardcoded ceiling for outbound attachment files. Sized to fit
# inside the SMTP soft-limit of most providers (Gmail 25 MB, OVH
# 50 MB) without doing per-account discovery. The frontend picker
# enforces the same number so users get an immediate error rather
# than waiting on the server to read the whole file.
_OUTBOX_MAX_SIZE = 25 * 1024 * 1024  # 25 MB

# Reject obvious executable types client-side AND server-side. The
# user is sending FROM their machine (so they're trusted), but
# bouncing a .exe or shell script through their own SMTP server
# would still get the message flagged as spam by most filters and
# may run afoul of provider acceptable-use policies.
_OUTBOX_BLOCKED_EXTS = {
    ".exe", ".com", ".bat", ".cmd", ".scr", ".msi", ".dll",
    ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh",
    ".ps1", ".ps2", ".psc1", ".psc2",
    ".jar", ".app", ".lnk", ".reg",
}

# Filename safety — collapse to a safe ASCII subset so a malicious
# filename can't craft a path-traversal in the upload directory.
_SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._\- ]")


def _safe_upload_filename(name: str) -> str:
    name = (name or "").strip()
    # Strip any directory components — UploadFile.filename normally
    # carries the basename already, but defence-in-depth.
    name = os.path.basename(name)
    if not name or name in (".", ".."):
        name = "fichier"
    name = _SAFE_FILENAME_RE.sub("_", name)
    # Cap length so an absurdly long filename can't trip path-length
    # limits on Windows (260 chars by default).
    if len(name) > 120:
        stem, dot, ext = name.rpartition(".")
        if dot:
            stem = stem[: 120 - len(ext) - 1]
            name = f"{stem}.{ext}"
        else:
            name = name[:120]
    return name


def _outbox_upload_path(upload_id: str) -> Optional[Path]:
    """Resolve the storage directory for an upload id, with traversal
    protection. Returns the directory path if it sits inside the
    configured outbox dir; None otherwise."""
    base = _paths.OUTBOX_ATTACHMENTS_DIR.resolve()
    candidate = (base / upload_id).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        return None
    return candidate


def _read_upload_metadata(upload_id: str) -> Optional[Dict[str, Any]]:
    folder = _outbox_upload_path(upload_id)
    if not folder or not folder.is_dir():
        return None
    files = [p for p in folder.iterdir() if p.is_file()]
    if not files:
        return None
    f = files[0]
    return {
        "upload_id": upload_id,
        "filename": f.name,
        "size": f.stat().st_size,
        "content_type": _guess_content_type(f.name),
    }


def _guess_content_type(filename: str) -> str:
    import mimetypes
    ct, _ = mimetypes.guess_type(filename)
    return ct or "application/octet-stream"


@app.post("/api/uploads")
@limiter.limit("60/minute")
async def upload_attachment(
    request: Request,
    file: UploadFile = File(...),
    locale: str = Depends(get_locale),
):
    """Stage a file for inclusion in an outbound message. Stores the
    upload under `OUTBOX_ATTACHMENTS_DIR/<uuid>/<safe_filename>` and
    returns its handle. The frontend posts this BEFORE the user hits
    Send, then references the returned `upload_id` in the SendRequest
    payload. Files that are never sent leak — call DELETE manually
    or wait for a future cleanup pass."""
    if not file.filename:
        raise HTTPException(400, tr("upload.filename_missing", locale))

    safe_name = _safe_upload_filename(file.filename)
    ext = os.path.splitext(safe_name)[1].lower()
    if ext in _OUTBOX_BLOCKED_EXTS:
        raise HTTPException(400, tr("upload.type_blocked", locale, ext=ext))

    # Read the file in chunks so a 25 MB upload doesn't blow up the
    # event loop. Stop and 413 as soon as the running tally crosses
    # the cap — we don't want to write 100 MB to disk before deciding
    # to reject it.
    upload_id = uuid.uuid4().hex
    folder = _paths.OUTBOX_ATTACHMENTS_DIR / upload_id
    _paths.ensure_dirs()
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / safe_name
    total = 0
    chunk_size = 64 * 1024
    max_mb = _OUTBOX_MAX_SIZE // (1024 * 1024)
    try:
        with open(target, "wb") as out:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                total += len(chunk)
                if total > _OUTBOX_MAX_SIZE:
                    out.close()
                    target.unlink(missing_ok=True)
                    folder.rmdir()
                    raise HTTPException(413, tr("upload.too_large", locale, max_mb=max_mb))
                out.write(chunk)
    except HTTPException:
        raise
    except Exception as e:
        # Clean up partial state so the staging dir doesn't accumulate
        # zombie folders on disk-full / permission errors.
        try:
            if target.exists():
                target.unlink()
            if folder.exists():
                folder.rmdir()
        except Exception:
            pass
        raise HTTPException(500, tr("upload.failed", locale, msg=str(e)))

    return {
        "upload_id": upload_id,
        "filename": safe_name,
        "size": total,
        "content_type": _guess_content_type(safe_name),
    }


@app.get("/api/uploads/{upload_id}")
def get_upload(upload_id: str, locale: str = Depends(get_locale)):
    meta = _read_upload_metadata(upload_id)
    if not meta:
        raise HTTPException(404, tr("upload.not_found", locale))
    return meta


@app.delete("/api/uploads/{upload_id}")
def delete_upload(upload_id: str, locale: str = Depends(get_locale)):
    folder = _outbox_upload_path(upload_id)
    if not folder or not folder.is_dir():
        raise HTTPException(404, tr("upload.not_found", locale))
    import shutil
    try:
        shutil.rmtree(folder)
    except Exception as e:
        raise HTTPException(500, tr("upload.delete_failed", locale, msg=str(e)))
    return {"ok": True}


# ── Attachments ───────────────────────────────────────────────────────────────

# Resolve once: the absolute path of the attachment store. Every download
# must remain inside this root after symlink resolution. Re-resolved per
# request would be wasteful AND would let an attacker race a symlink swap
# between resolution and read.
_ATTACHMENTS_ROOT_ABS = _paths.ATTACHMENTS_DIR.resolve()


def _decode_threat_reasons(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    try:
        v = json.loads(raw)
        return [str(x) for x in v] if isinstance(v, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _attachment_summary(row: dict) -> dict:
    """Public-safe view of an attachment row — never exposes storage_path."""
    return {
        "id": row["id"],
        "filename": row["filename"],
        "size": int(row["size"] or 0),
        "content_type": row.get("content_type_sniffed") or row.get("content_type_declared") or "",
        "is_inline": bool(row.get("is_inline")),
        "threat_level": row.get("threat_level") or att_sec.THREAT_SAFE,
        "threat_reasons": _decode_threat_reasons(row.get("threat_reasons")),
        "available": bool(row.get("storage_path")),  # False = blocked, metadata only
        "sha256": row.get("sha256"),
    }


@app.get("/api/emails/{int_id}/attachments")
def list_attachments(int_id: int, locale: str = Depends(get_locale)):
    em = db.get_email_by_id(int_id)
    if not em:
        raise HTTPException(404, tr("email.not_found", locale))
    rows = db.get_attachments_for_message(em["message_id"])
    return [_attachment_summary(r) for r in rows]


@app.get("/api/attachments/{att_id}/download")
@limiter.limit("60/minute")
def download_attachment(
    request: Request,
    att_id: int,
    confirm: int = Query(0, description="Set to 1 to override the dangerous-file gate"),
    locale: str = Depends(get_locale),
):
    """Serve one attachment with hardened response headers.

    Security checks applied (in order):
      1. Row exists and was successfully written to disk.
      2. Resolved absolute path stays inside `data/attachments` — protects
         against any malicious storage_path that may have slipped in.
      3. Recompute SHA-256 and compare with the stored fingerprint. If the
         file on disk has been tampered with we refuse to serve it.
      4. `dangerous` files require explicit `?confirm=1` (the UI surfaces
         a modal first); `blocked` files are never served.
      5. Content-Type is forced to `application/octet-stream` for anything
         not classified as `safe`, and to `application/octet-stream` for
         text/html even when safe — never let the browser render attacker
         markup in-frame.
      6. `Content-Disposition: attachment` (RFC 5987) makes browsers save
         instead of preview.
      7. Defensive headers neutralise sniffing and isolate any in-tab
         rendering: `X-Content-Type-Options: nosniff`, a `default-src
         'none'; sandbox` CSP, and `Cross-Origin-Resource-Policy: same-
         origin`.
    """
    row = db.get_attachment(att_id)
    if not row:
        raise HTTPException(404, tr("attachment.not_found", locale))

    threat_level = row.get("threat_level") or att_sec.THREAT_SAFE

    # `blocked` files were never written to disk by policy. We expose the
    # metadata via /list_attachments but refuse to serve bytes — there are
    # none to serve.
    if threat_level == att_sec.THREAT_BLOCKED or not row.get("storage_path"):
        raise HTTPException(410, tr("attachment.blocked_policy", locale))

    # The dangerous-file gate. Without `?confirm=1` the UI shows a warning
    # modal first; with it, the request is allowed but still served as
    # octet-stream.
    policy = att_sec.policy_from_config(cfg.get())
    if (
        threat_level == att_sec.THREAT_DANGEROUS
        and policy.download_requires_confirm
        and confirm != 1
    ):
        raise HTTPException(
            status_code=403,
            detail={
                "error": "confirmation_required",
                "threat_level": threat_level,
                "reasons": _decode_threat_reasons(row.get("threat_reasons")),
                "filename": row["filename"],
            },
        )

    # Resolve + traversal guard. realpath() collapses `..` and follows any
    # symlink, then we compare against the (also realpath'd) attachments
    # root. If the file is outside, log + 404 — never leak the real path.
    rel = row["storage_path"]
    candidate = (_ATTACHMENTS_ROOT_ABS / rel).resolve()
    if not att_sec.is_path_within(str(candidate), str(_ATTACHMENTS_ROOT_ABS)):
        logger.error(
            f"attachment {att_id}: storage_path '{rel}' resolved outside root"
        )
        raise HTTPException(404, tr("attachment.not_found", locale))
    if not candidate.is_file():
        raise HTTPException(404, tr("attachment.file_missing", locale))

    # Tamper detection. The stored SHA-256 was computed at ingest; if disk
    # contents have changed, refuse to serve and flag the row.
    try:
        h = hashlib.sha256()
        with open(candidate, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        actual = h.hexdigest()
    except OSError as e:
        logger.error(f"attachment {att_id}: read failed: {e}")
        raise HTTPException(500, tr("attachment.read_error", locale))
    if actual != (row.get("sha256") or ""):
        logger.error(
            f"attachment {att_id}: SHA-256 mismatch "
            f"(stored={row.get('sha256')!r}, disk={actual!r}); refusing serve"
        )
        raise HTTPException(409, tr("attachment.fingerprint_mismatch", locale))

    headers = att_sec.hardened_response_headers(threat_level)
    headers["Content-Disposition"] = att_sec.safe_disposition_header(row["filename"])
    headers["Content-Length"] = str(row["size"])
    media_type = att_sec.served_content_type(
        threat_level,
        row.get("content_type_sniffed"),
        row.get("content_type_declared"),
    )
    logger.info(
        f"attachment {att_id} served ({threat_level}, {media_type}, "
        f"{row['size']} bytes) → {row['filename']}"
    )
    return FileResponse(
        path=str(candidate),
        media_type=media_type,
        filename=None,        # we set Content-Disposition ourselves above
        headers=headers,
    )


def _run_attachment_backfill(job_id: str, account: Optional[str]):
    """Walk every legacy email (no `attachments_scanned_at`) account-by-
    account, re-fetching RFC822 via IMAP and persisting attachments. Bumps
    the shared `_jobs` registry so the UI can poll progress."""
    from src.email_fetcher import batch_scan_attachments

    rows = db.find_messages_to_scan_attachments(account=account)
    if not rows:
        with _jobs_lock:
            j = _jobs.get(job_id)
            if j and not j["finished"]:
                j["finished"] = True
                j["finished_at"] = _now_iso()
        return

    by_acc: Dict[str, List[Dict]] = {}
    for r in rows:
        by_acc.setdefault(r["account_email"], []).append(r)

    policy = att_sec.policy_from_config(cfg.get())

    for account_email, targets in by_acc.items():
        acc = _account_for(account_email)
        if not acc:
            for _ in targets:
                _bump_job(job_id, False)
            continue

        cb = lambda _uid, ok, _n: _bump_job(job_id, ok)
        try:
            batch_scan_attachments(acc, targets, policy, on_each=cb)
        except Exception as e:
            logger.error(f"[{account_email}] attachment backfill crashed: {e}")
            with _jobs_lock:
                j = _jobs.get(job_id)
                if j:
                    remaining = j["total"] - j["done"] - j["failed"]
                    if remaining > 0:
                        j["failed"] += remaining
                        j["finished"] = True
                        j["finished_at"] = _now_iso()


@app.get("/api/attachments/backfill/stats")
def attachment_backfill_stats(account: Optional[str] = None):
    """Per-account counts so the UI can show '243 mails à scanner'."""
    pending = db.count_messages_to_scan_attachments(account=account)
    return {"pending": pending}


@app.post("/api/attachments/backfill")
def attachment_backfill(
    bg: BackgroundTasks,
    account: Optional[str] = None,
    limit: Optional[int] = None,
):
    """Kick off a backfill job. `?limit=` lets the UI test on a small
    batch before committing (useful with 1k+ legacy mails). `?account=`
    restricts to one mailbox."""
    rows = db.find_messages_to_scan_attachments(account=account, limit=limit)
    total = len(rows)
    if total == 0:
        return {"ok": True, "job_id": None, "total": 0}
    job_id = _make_job(
        "attachment_backfill",
        f"attachments:backfill{':' + account if account else ''}",
        total,
    )
    bg.add_task(_run_attachment_backfill, job_id, account)
    return {"ok": True, "job_id": job_id, "total": total}


def _account_for(account_email: str) -> Optional[dict]:
    conf = cfg.get()
    return next(
        (a for a in conf.get("accounts", []) if a["email"] == account_email),
        None,
    )


def _imap_mark_seen(account_email: str, uid: str):
    from src.email_fetcher import mark_seen_on_server
    account = _account_for(account_email)
    if account:
        mark_seen_on_server(account, uid)


def _imap_mark_unseen(account_email: str, uid: str):
    from src.email_fetcher import mark_unseen_on_server
    account = _account_for(account_email)
    if account:
        mark_unseen_on_server(account, uid)


def _imap_apply_folder(account_email: str, uid: str, folder: str):
    from src.email_fetcher import move_to_trash_on_server
    account = _account_for(account_email)
    if not account:
        return
    if folder == "deleted":
        move_to_trash_on_server(account, uid)
    # 'inbox' has no IMAP-side action — we cannot un-trash from the server.


def _imap_set_favourite(account_email: str, uid: str, on: bool):
    from src.email_fetcher import set_flagged_on_server
    account = _account_for(account_email)
    if account:
        set_flagged_on_server(account, uid, on)


# ── Cleanup (Top senders, bulk actions) ───────────────────────────────────────

# In-memory job registry. Holds running and recently-finished cleanup jobs so
# the UI can poll progress until completion. Capped at _JOBS_MAX entries; old
# finished jobs are evicted FIFO. Process restart resets the registry, which
# is fine: the DB state is already correct, only IMAP propagation may be
# partial — but the user sees the inbox already cleaned.
_jobs: Dict[str, Dict] = {}
_jobs_order: List[str] = []
_jobs_lock = Lock()
_JOBS_MAX = 100


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _make_job(action: str, sender: str, total: int) -> str:
    job_id = uuid.uuid4().hex[:12]
    job = {
        "id": job_id,
        "action": action,
        "sender": sender,
        "total": int(total),
        "done": 0,
        "failed": 0,
        "finished": False,
        "started_at": _now_iso(),
        "finished_at": None,
    }
    with _jobs_lock:
        _jobs[job_id] = job
        _jobs_order.append(job_id)
        # Evict the oldest finished jobs once the registry overflows.
        while len(_jobs_order) > _JOBS_MAX:
            old_id = _jobs_order.pop(0)
            old = _jobs.get(old_id)
            if old and not old["finished"]:
                # Don't evict an in-flight job; push it back to the front
                # of the queue and stop trimming for now.
                _jobs_order.insert(0, old_id)
                break
            _jobs.pop(old_id, None)
    return job_id


def _bump_job(job_id: str, ok: bool):
    """Increment the done/failed counters and mark finished when complete."""
    with _jobs_lock:
        j = _jobs.get(job_id)
        if not j:
            return
        if ok:
            j["done"] += 1
        else:
            j["failed"] += 1
        if j["done"] + j["failed"] >= j["total"]:
            j["finished"] = True
            j["finished_at"] = _now_iso()


def _run_imap_batch(job_id: str, targets: List[Dict], action: str):
    """Stream IMAP ops for a cleanup job, grouping by account so each
    Bridge/IMAP server only sees one connection per account.
    """
    from src.email_fetcher import batch_mark_seen, batch_move_to_trash

    by_acc: Dict[str, List[str]] = {}
    for m in targets:
        uid = m.get("uid")
        if not uid:
            continue
        by_acc.setdefault(m["account_email"], []).append(uid)

    for account_email, uids in by_acc.items():
        acc = _account_for(account_email)
        if not acc:
            for _ in uids:
                _bump_job(job_id, False)
            continue
        cb = lambda _uid, ok: _bump_job(job_id, ok)
        try:
            if action == "delete":
                batch_move_to_trash(acc, uids, on_each=cb)
            else:
                batch_mark_seen(acc, uids, on_each=cb)
        except Exception as e:
            logger.error(f"[{account_email}] cleanup job {job_id} crashed: {e}")
            # Make sure the counters still complete so the UI stops polling.
            with _jobs_lock:
                j = _jobs.get(job_id)
                if j:
                    remaining = j["total"] - j["done"] - j["failed"]
                    if remaining > 0:
                        j["failed"] += remaining
                        j["finished"] = True
                        j["finished_at"] = _now_iso()


@app.get("/api/cleanup/senders")
def cleanup_senders(limit: int = 50, account: Optional[str] = None):
    return db.top_senders(limit=min(max(1, limit), 200), account=account)


@app.post("/api/cleanup/sender")
@limiter.limit("10/minute")
def cleanup_sender(request: Request, req: CleanupSenderReq, bg: BackgroundTasks):
    """Apply a bulk action ('delete' or 'mark_read') to every live message
    coming from `req.sender`. DB writes happen synchronously so the UI can
    refresh the counts immediately; IMAP propagation runs as one tracked
    job whose progress the UI polls via /api/cleanup/jobs/{id}.
    """
    matches = db.find_by_sender(req.sender, account=req.account)
    if not matches:
        return {"ok": True, "affected": 0, "job_id": None, "total": 0}

    if req.action == "delete":
        ids = [m["message_id"] for m in matches if m["folder"] != "deleted"]
        db.bulk_set_folder(ids, "deleted")
        targets = [m for m in matches if m["folder"] != "deleted" and m.get("uid")]
    else:  # mark_read
        ids = [m["message_id"] for m in matches if not m["is_read"]]
        db.bulk_mark_read(ids, True)
        targets = [m for m in matches if not m["is_read"] and m.get("uid")]

    affected = len(ids)
    if not targets:
        return {"ok": True, "affected": affected, "job_id": None, "total": 0}

    job_id = _make_job(req.action, req.sender, len(targets))
    bg.add_task(_run_imap_batch, job_id, targets, req.action)
    return {"ok": True, "affected": affected, "job_id": job_id, "total": len(targets)}


@app.get("/api/cleanup/jobs/{job_id}")
def get_cleanup_job(job_id: str, locale: str = Depends(get_locale)):
    with _jobs_lock:
        j = _jobs.get(job_id)
    if not j:
        raise HTTPException(404, tr("cleanup.job_not_found", locale))
    return j


def _filter_kwargs(f: RuleFilter) -> dict:
    return {
        "categories": f.categories,
        "max_score": f.max_score,
        "is_read": f.is_read,
        "older_than_days": f.older_than_days,
        "account": f.account,
        "subject_keywords": f.subject_keywords,
        "sender_keywords": f.sender_keywords,
    }


@app.post("/api/cleanup/rules/preview")
def cleanup_rule_preview(filter: RuleFilter, limit: int = 100):
    """Return rich aggregates + a sample of messages that match a filter
    spec. The Rules tab uses this to surface every signal a user might want
    before committing to a destructive action: the total, the most recent
    matches (highest false-positive risk), the top senders inside the
    selection, the date span, and a per-account breakdown.
    """
    matches = db.find_by_filter(**_filter_kwargs(filter))

    # Sort by date descending so the preview shows the most recent matches
    # first — that's where "wait, I actually want to keep this" hits.
    def _sort_key(m):
        dt = db._parse_email_date(m.get("date_received") or "")
        return dt.timestamp() if dt is not None else 0
    matches_sorted = sorted(matches, key=_sort_key, reverse=True)

    cap = max(1, min(int(limit), 500))
    sample = []
    for m in matches_sorted[:cap]:
        sample.append({
            "int_id": m.get("int_id"),
            "message_id": m["message_id"],
            "sender": m["sender"],
            "subject": m["subject"],
            "date_received": m["date_received"],
            "account_email": m["account_email"],
            "category": m["category"],
            "importance_score": m["importance_score"],
            "is_read": bool(m["is_read"]),
        })

    unread = sum(1 for m in matches if not m["is_read"])
    accounts: Dict[str, int] = {}
    for m in matches:
        accounts[m["account_email"]] = accounts.get(m["account_email"], 0) + 1

    # Top senders inside this rule's selection.
    senders_count: Dict[str, Dict] = {}
    for m in matches:
        display, addr = db._canonical_sender(m["sender"] or "")
        if not addr:
            continue
        bucket = senders_count.setdefault(addr, {"email": addr, "count": 0, "name": ""})
        bucket["count"] += 1
        if display and not bucket["name"]:
            bucket["name"] = display
    top_senders = sorted(senders_count.values(), key=lambda x: x["count"], reverse=True)[:6]

    # Date span: oldest and newest match.
    date_oldest = None
    date_newest = None
    for m in matches:
        dt = db._parse_email_date(m.get("date_received") or "")
        if dt is None:
            continue
        if date_oldest is None or dt < date_oldest:
            date_oldest = dt
        if date_newest is None or dt > date_newest:
            date_newest = dt

    return {
        "total": len(matches),
        "unread": unread,
        "by_account": accounts,
        "sample": sample,
        "top_senders": top_senders,
        "date_oldest": date_oldest.isoformat() if date_oldest else None,
        "date_newest": date_newest.isoformat() if date_newest else None,
    }


@app.post("/api/cleanup/rules/run")
@limiter.limit("10/minute")
def cleanup_rule_run(request: Request, req: RuleRunReq, bg: BackgroundTasks):
    """Apply a rule's action (delete | mark_read) to every match. DB writes
    happen synchronously (counts shrink immediately on the UI) and IMAP
    propagation runs as one tracked job, exactly like the senders flow.
    """
    matches = db.find_by_filter(**_filter_kwargs(req.filter))
    if not matches:
        return {"ok": True, "affected": 0, "job_id": None, "total": 0}

    if req.action == "delete":
        ids = [m["message_id"] for m in matches if m["folder"] != "deleted"]
        db.bulk_set_folder(ids, "deleted")
        targets = [m for m in matches if m["folder"] != "deleted" and m.get("uid")]
    else:  # mark_read
        ids = [m["message_id"] for m in matches if not m["is_read"]]
        db.bulk_mark_read(ids, True)
        targets = [m for m in matches if not m["is_read"] and m.get("uid")]

    affected = len(ids)
    if not targets:
        return {"ok": True, "affected": affected, "job_id": None, "total": 0}

    # Synthesise a label so the job registry can identify rule jobs (they
    # share the storage with sender jobs but have no canonical "sender").
    label_bits = []
    if req.filter.categories: label_bits.append("/".join(req.filter.categories))
    if req.filter.max_score is not None: label_bits.append(f"≤{req.filter.max_score}")
    if req.filter.older_than_days: label_bits.append(f">{req.filter.older_than_days}j")
    if req.filter.is_read is False: label_bits.append("non lus")
    label = "rule:" + " ".join(label_bits) if label_bits else "rule"

    job_id = _make_job(req.action, label, len(targets))
    bg.add_task(_run_imap_batch, job_id, targets, req.action)
    return {"ok": True, "affected": affected, "job_id": job_id, "total": len(targets)}


# ── Unsubscribe (RFC 2369 + RFC 8058) ─────────────────────────────────────────

def _run_header_backfill(job_id: str, account: Optional[str]):
    """Re-fetch List-Unsubscribe + List-Unsubscribe-Post for every row that
    has never been inspected. Bumps the job per UID and writes results to
    SQLite. Persists `unsubscribe_backfill_done_at` once finished."""
    from src.email_fetcher import batch_fetch_headers

    rows = db.find_uids_missing_headers(account)
    if not rows:
        # Make sure the job finishes even when nothing to do.
        with _jobs_lock:
            j = _jobs.get(job_id)
            if j and not j["finished"]:
                j["finished"] = True
                j["finished_at"] = _now_iso()
        db.set_kv("unsubscribe_backfill_done_at", _now_iso())
        return

    # Index rows by (account_email, uid) so we can recover the message_id
    # in the on_each callback (the IMAP layer only has UIDs to play with).
    index: Dict[Tuple[str, str], str] = {
        (r["account_email"], r["uid"]): r["message_id"] for r in rows
    }

    by_acc: Dict[str, List[str]] = {}
    for r in rows:
        by_acc.setdefault(r["account_email"], []).append(r["uid"])

    for account_email, uids in by_acc.items():
        acc = _account_for(account_email)
        if not acc:
            for _ in uids:
                _bump_job(job_id, False)
            continue

        def make_cb(ae: str):
            def _cb(uid, ok, parsed):
                msg_id = index.get((ae, uid))
                if msg_id:
                    try:
                        db.update_unsubscribe_headers(msg_id, parsed)
                    except Exception as e:
                        logger.warning(f"[{ae}] backfill DB write UID {uid} failed: {e}")
                _bump_job(job_id, ok)
            return _cb

        try:
            batch_fetch_headers(acc, uids, on_each=make_cb(account_email))
        except Exception as e:
            logger.error(f"[{account_email}] backfill batch crashed: {e}")
            with _jobs_lock:
                j = _jobs.get(job_id)
                if j:
                    remaining = j["total"] - j["done"] - j["failed"]
                    if remaining > 0:
                        j["failed"] += remaining
                        j["finished"] = True
                        j["finished_at"] = _now_iso()

    db.set_kv("unsubscribe_backfill_done_at", _now_iso())


def _run_unsubscribe_job(job_id: str, plan: List[Dict]):
    """Execute a sequence of steps for one or more sender unsubscriptions.
    Each step is one of:
      - {"kind": "http_post", "sender": str, "url": str, "account": Optional[str]}
      - {"kind": "imap_trash", "account_email": str, "uid": str, "message_id": str}
    The HTTP step bumps the job and stamps `unsubscribed_at` on success.
    The IMAP trash step is a per-UID move using the existing batch helper.
    """
    from src.email_fetcher import unsubscribe_http, batch_move_to_trash

    # Group trash steps by account so we still benefit from one connection.
    trash_groups: Dict[str, List[str]] = {}
    trash_msg_ids: Dict[Tuple[str, str], str] = {}

    for step in plan:
        kind = step.get("kind")
        if kind == "http_post":
            url = step.get("url") or ""
            sender = step.get("sender")
            account = step.get("account")
            ok, status, err = unsubscribe_http(url, timeout_s=5.0)
            if ok and sender:
                try:
                    db.mark_sender_unsubscribed(sender, account=account)
                except Exception as e:
                    logger.warning(f"unsubscribe DB stamp for {sender} failed: {e}")
            else:
                logger.info(f"unsubscribe POST {sender}: status={status} err={err}")
            _bump_job(job_id, ok)
        elif kind == "imap_trash":
            ae = step["account_email"]
            uid = step["uid"]
            trash_groups.setdefault(ae, []).append(uid)
            trash_msg_ids[(ae, uid)] = step.get("message_id", "")

    # Execute trash batches now (one connection per account).
    for account_email, uids in trash_groups.items():
        acc = _account_for(account_email)
        if not acc:
            for _ in uids:
                _bump_job(job_id, False)
            continue
        try:
            batch_move_to_trash(acc, uids, on_each=lambda _u, ok: _bump_job(job_id, ok))
        except Exception as e:
            logger.error(f"[{account_email}] unsubscribe trash batch crashed: {e}")


@app.get("/api/cleanup/unsubscribe/senders")
def cleanup_unsubscribe_senders(account: Optional[str] = None):
    return db.unsubscribe_senders(account=account)


@app.get("/api/cleanup/unsubscribe/stats")
def cleanup_unsubscribe_stats(account: Optional[str] = None):
    """Numbers for the status banner: how many rows still need a header
    backfill, how many already have an unsubscribe link, and when the last
    backfill ran."""
    missing = db.count_emails_missing_headers(account=account)
    senders = db.unsubscribe_senders(account=account)
    with_header_rows = sum(s["total"] for s in senders)
    last_backfill = db.get_kv("unsubscribe_backfill_done_at")
    return {
        "with_header": with_header_rows,
        "without_header": missing,
        "senders_with_link": len(senders),
        "last_backfill_at": last_backfill,
    }


@app.post("/api/cleanup/unsubscribe/backfill")
def cleanup_unsubscribe_backfill(account: Optional[str] = None, bg: BackgroundTasks = None):
    rows = db.find_uids_missing_headers(account)
    total = len(rows)
    if total == 0:
        # Still stamp the timestamp so the UI banner clears.
        db.set_kv("unsubscribe_backfill_done_at", _now_iso())
        return {"ok": True, "job_id": None, "total": 0}
    job_id = _make_job("backfill", "unsubscribe:backfill", total)
    bg.add_task(_run_header_backfill, job_id, account)
    return {"ok": True, "job_id": job_id, "total": total}


@app.post("/api/cleanup/unsubscribe")
@limiter.limit("10/minute")
def cleanup_unsubscribe(request: Request, req: UnsubscribeReq, bg: BackgroundTasks, locale: str = Depends(get_locale)):
    """Single-sender unsubscribe with optional purge of existing messages."""
    target = db.unsubscribe_sender_target(req.sender, account=req.account)
    if not target:
        raise HTTPException(404, tr("unsub.no_link", locale))

    # Idempotency gate (overridable). If the user already unsubscribed from
    # this sender we don't re-POST unless `force=True`.
    if not req.force:
        existing = next(
            (s for s in db.unsubscribe_senders(account=req.account)
             if s["email"] == req.sender.strip().lower()),
            None,
        )
        if existing and existing.get("unsubscribed_at"):
            return {
                "ok": True,
                "already": True,
                "unsubscribed_at": existing["unsubscribed_at"],
                "job_id": None,
                "total": 0,
            }

    # Decide what to do based on mode + capabilities.
    can_one_click = bool(target.get("one_click") and target.get("url"))
    plan: List[Dict] = []

    if req.mode == "mailto_only" or (req.mode == "auto" and not can_one_click and not target.get("url") and target.get("mailto")):
        # Frontend handles `mailto:` via window.open — return the address.
        return {
            "ok": True,
            "action_required": "open_mailto",
            "target": target["mailto"],
            "job_id": None,
            "total": 0,
        }
    if req.mode == "http_only" or (req.mode == "auto" and not can_one_click and target.get("url")):
        # No one-click flag but a URL is present — let the user open it.
        return {
            "ok": True,
            "action_required": "open_url",
            "target": target["url"],
            "job_id": None,
            "total": 0,
        }

    # Auto mode with one-click: queue a job.
    plan.append({
        "kind": "http_post",
        "sender": req.sender.strip().lower(),
        "url": target["url"],
        "account": req.account,
    })

    # Optional purge: gather all UIDs of this sender (live mails only) and
    # add IMAP trash steps to the same job. DB-side folder is updated
    # synchronously so the UI flips immediately.
    purge_total = 0
    if req.purge:
        matches = db.find_by_sender(req.sender, account=req.account)
        live = [m for m in matches if m["folder"] != "deleted" and m.get("uid")]
        if live:
            db.bulk_set_folder([m["message_id"] for m in live], "deleted")
            for m in live:
                plan.append({
                    "kind": "imap_trash",
                    "account_email": m["account_email"],
                    "uid": m["uid"],
                    "message_id": m["message_id"],
                })
            purge_total = len(live)

    total = len(plan)
    job_id = _make_job("unsubscribe", f"unsubscribe:{req.sender}", total)
    bg.add_task(_run_unsubscribe_job, job_id, plan)
    return {
        "ok": True,
        "action_required": None,
        "job_id": job_id,
        "total": total,
        "purge_total": purge_total,
    }


@app.post("/api/cleanup/unsubscribe/bulk")
@limiter.limit("10/minute")
def cleanup_unsubscribe_bulk(request: Request, req: UnsubscribeBulkReq, bg: BackgroundTasks):
    """Run one-click POSTs for every sender in the list. Senders without a
    one-click target are skipped (the UI restricts the bulk button to
    one-click senders, but we double-check server-side)."""
    plan: List[Dict] = []
    skipped: List[str] = []
    for raw_sender in req.senders:
        sender = (raw_sender or "").strip().lower()
        target = db.unsubscribe_sender_target(sender, account=req.account)
        if not target or not target.get("one_click") or not target.get("url"):
            skipped.append(sender)
            continue
        plan.append({
            "kind": "http_post",
            "sender": sender,
            "url": target["url"],
            "account": req.account,
        })
        if req.purge:
            matches = db.find_by_sender(sender, account=req.account)
            live = [m for m in matches if m["folder"] != "deleted" and m.get("uid")]
            if live:
                db.bulk_set_folder([m["message_id"] for m in live], "deleted")
                for m in live:
                    plan.append({
                        "kind": "imap_trash",
                        "account_email": m["account_email"],
                        "uid": m["uid"],
                        "message_id": m["message_id"],
                    })

    if not plan:
        return {"ok": True, "job_id": None, "total": 0, "skipped": skipped}
    job_id = _make_job("unsubscribe", "unsubscribe:bulk", len(plan))
    bg.add_task(_run_unsubscribe_job, job_id, plan)
    return {"ok": True, "job_id": job_id, "total": len(plan), "skipped": skipped}


# ── Sender trust (remote-image blocking) ─────────────────────────────────────


class TrustImagesReq(BaseModel):
    trusted: bool = True


@app.get("/api/senders/{domain}/images-trusted")
def sender_images_trusted(domain: str):
    """Return whether the user has opted-in to load remote images for
    `domain`. The frontend hits this when rendering an email body so
    it knows whether to swap <img src=https://…> for the placeholder."""
    return {"domain": domain.lower(), "trusted": db.is_sender_trusted_for_images(domain)}


@app.post("/api/senders/{domain}/images-trusted")
def set_sender_images_trusted(domain: str, body: TrustImagesReq):
    """Toggle the per-domain image-trust flag. Triggered by the
    "Toujours pour cet expéditeur" button on the in-mail banner."""
    db.set_sender_trusted_for_images(domain, body.trusted)
    return {"ok": True, "domain": domain.lower(), "trusted": body.trusted}


# ── Update ────────────────────────────────────────────────────────────────────

@app.get("/api/update/check")
def update_check():
    from src.updater import check_for_update
    return check_for_update()


@app.post("/api/update/install")
def update_install(bg: BackgroundTasks, locale: str = Depends(get_locale)):
    from src.updater import download_and_install
    bg.add_task(download_and_install)
    return {"ok": True, "message": tr("update.downloading", locale)}


# ── Stats & accounts ──────────────────────────────────────────────────────────

@app.get("/api/stats")
def get_stats():
    return db.get_stats()


@app.get("/api/accounts")
def get_accounts():
    conf = cfg.get()
    result = []
    for acc in conf.get("accounts", []):
        if not acc.get("enabled", True):
            continue
        state = db.get_sync_state(acc["email"])
        result.append({
            "email": acc["email"],
            "name": acc.get("name", acc["email"]),
            "type": acc.get("type", "other"),
            "last_sync": state["last_sync"] if state else None,
            "sync_error": state["last_error"] if state else None,
            # Auto-test status (separate from sync lifecycle). Drives the
            # green/red/grey badge in the Settings account list.
            "last_test_at": state["last_test_at"] if state else None,
            "last_test_error": state["last_test_error"] if state else None,
        })
    return result


# ── Sync ──────────────────────────────────────────────────────────────────────

@app.post("/api/sync")
@limiter.limit("6/minute")
def trigger_sync(request: Request, bg: BackgroundTasks, locale: str = Depends(get_locale)):
    from src.scheduler import is_running, run_sync
    if is_running():
        return {"ok": False, "message": tr("sync.already_running", locale)}
    bg.add_task(run_sync)
    return {"ok": True, "message": tr("sync.started", locale)}


@app.get("/api/app/ping")
def app_ping():
    """Identify this server as a running Lull Mail instance. The desktop
    entry point probes this on startup: if another instance already answers
    on the remembered port, the new process wakes its window (below) and
    exits instead of spawning a second app — the common path once closing
    the window backgrounds the app instead of quitting it."""
    from src.updater import get_current_version
    return {"app": "lullmail", "version": get_current_version()}


@app.post("/api/app/show-window")
def app_show_window():
    """Bring the (possibly hidden) desktop window back to front. The GUI
    entry point registers the callback on app.state; headless runs (dev
    server, tests) simply report not-shown. Loopback-only like everything
    else, and it exposes nothing but 'make my own window visible'."""
    fn = getattr(app.state, "show_window", None)
    if not fn:
        return {"shown": False}
    try:
        fn()
        return {"shown": True}
    except Exception as e:  # noqa: BLE001 — a wake failure must not 500
        logger.warning(f"show-window callback failed: {e}")
        return {"shown": False}


@app.get("/api/sync/status")
def sync_status():
    """Polled every 3 s by the rail (rail-toast.js). `queue_pending` feeds
    the rail's AI-queue indicator — one COUNT query, cheap at this rate."""
    from src.scheduler import get_last_sync, is_running
    return {
        "running": is_running(),
        "last_sync": get_last_sync(),
        "queue_pending": db.count_pending(),
    }


# ── Local LLM management ─────────────────────────────────────────────────────
# Endpoints qui pilotent le backend `provider=local` depuis l'UI Settings.
# Tout est lazy-importé pour éviter de tirer `psutil` ou de toucher au
# catalog quand l'utilisateur reste sur OpenAI.


@app.get("/api/llm/hardware")
def llm_hardware():
    """Snapshot du matériel local : RAM / GPU / tier recommandé.
    Affiché dans le bandeau "Détecté: 16 Go RAM → Medium" de Settings."""
    from src import hardware
    return hardware.detect()


@app.get("/api/llm/models")
def llm_models():
    """Catalogue des modèles supportés, enrichi de l'état "téléchargé".

    Réponse : [{id, name, role, tier, size_bytes, downloaded, license, …}]
    Le frontend filtre par role + tier recommandé pour pré-sélectionner.
    """
    from src.llm import catalog
    out = []
    for model_id, meta in catalog.CATALOG.items():
        path = _paths.MODELS_DIR / meta["filename"]
        on_disk = path.is_file()
        out.append({
            "id": model_id,
            "name": meta["name"],
            "vendor": meta.get("vendor", ""),
            "role": meta["role"],
            "tier": meta["tier"],
            "recommended_for_tier": meta.get("recommended_for_tier", meta["tier"]),
            "size_bytes": meta["size_bytes"],
            "license": meta.get("license", ""),
            "license_url": meta.get("license_url", ""),
            "languages": meta.get("languages", []),
            "context_length": meta.get("context_length", 4096),
            "downloaded": on_disk,
            "downloaded_bytes": path.stat().st_size if on_disk else 0,
        })
    return out


@app.get("/api/llm/ollama/models")
def llm_ollama_models(base_url: str = "http://localhost:11434"):
    """List the models installed on the user's Ollama server (GET /api/tags).
    Powers the model dropdown and doubles as a connection test: a non-empty
    `models` list means Ollama is reachable. `ok=false` + `error` otherwise."""
    import requests as _rq
    url = (base_url or "http://localhost:11434").rstrip("/") + "/api/tags"
    try:
        r = _rq.get(url, timeout=4)
        r.raise_for_status()
        models = sorted({m.get("name", "") for m in (r.json().get("models") or []) if m.get("name")})
        return {"ok": True, "models": models}
    except Exception as e:  # noqa: BLE001 — surface as a friendly UI message
        return {"ok": False, "models": [], "error": str(e)}


@app.get("/api/llm/status")
def llm_status():
    """État runtime des serveurs locaux. Utilisé par le bandeau
    "Chargement du modèle de rédaction…" et le futur dashboard."""
    from src.llm.registry import get_provider
    provider = get_provider()
    if provider.name != "local":
        return {"provider": provider.name, "analyzer": None, "drafter": None}

    analyzer = None
    drafter = None
    a = getattr(provider, "analyzer_server", None)
    if a is not None:
        analyzer = {
            "running": a.running,
            "model_id": getattr(provider, "analyzer_model_id", None),
            "port": a.port if a.running else None,
        }
    d = getattr(provider, "drafter_server", None)
    if d is not None:
        drafter = {
            "running": d.running,
            "model_id": getattr(provider, "drafter_model_id", None),
            "port": d.port if d.running else None,
            "last_used_at": getattr(d, "last_used_at", 0),
        }
    return {
        "provider": "local",
        "analyzer": analyzer,
        "drafter": drafter,
    }


class _LLMActivatePayload(BaseModel):
    analyzer_model_id: str
    drafter_model_id: str


@app.post("/api/llm/activate")
@limiter.limit("10/minute")
def llm_activate(request: Request, payload: _LLMActivatePayload,
                 locale: str = Depends(get_locale)):
    """Bascule la config sur `provider=local` avec les modèles choisis,
    persiste dans config.yaml, et redémarre les services pour spawn
    l'AnalyzerServer.

    Retourne 200 avec `{ok: True, warning: "..."}` si l'activation
    réussit mais avec une note (par ex. modèle plus gros que la RAM
    détectée). 400 si un modèle est inconnu du catalog ou pas téléchargé.
    """
    from src.llm import catalog
    from src import hardware

    a_meta = catalog.get_model(payload.analyzer_model_id)
    d_meta = catalog.get_model(payload.drafter_model_id)
    if a_meta is None or a_meta["role"] != "analyzer":
        raise HTTPException(400, tr("llm.unknown_analyzer", locale,
                                    default="Analyzer inconnu."))
    if d_meta is None or d_meta["role"] != "drafter":
        raise HTTPException(400, tr("llm.unknown_drafter", locale,
                                    default="Drafter inconnu."))
    a_path = _paths.MODELS_DIR / a_meta["filename"]
    if not a_path.is_file():
        raise HTTPException(400, tr("llm.analyzer_not_downloaded", locale,
                                    default="Analyzer non téléchargé."))

    # Warning soft si le modèle pèse plus que la RAM dispo. On laisse
    # passer parce que l'user peut consciemment forcer (case "Override"
    # dans l'UI).
    warning = None
    hw = hardware.detect()
    if a_meta["size_bytes"] > hw["ram_gb"] * 1024**3 * 0.5:
        warning = "ram_low_analyzer"

    # Persist via setup_api helpers (cohérent avec /api/setup/openai).
    from src.setup_api import _load_or_default, _persist
    data = _load_or_default()
    llm_sect = data.setdefault("llm", {})
    llm_sect["provider"] = "local"
    local_sect = llm_sect.setdefault("local", {})
    local_sect["analyzer_model_id"] = payload.analyzer_model_id
    local_sect["drafter_model_id"] = payload.drafter_model_id
    _persist(data)

    # Restart services pour booter l'AnalyzerServer. Import local pour éviter
    # un cycle d'import au boot (lifecycle → ai_processor → llm → api).
    from src.llm.registry import reset as _reset_llm
    from src import lifecycle as _lifecycle
    _reset_llm()
    try:
        _lifecycle.start_email_services(restart=True)
    except Exception:
        logger.exception("Restart après activation local LLM a échoué")
        raise HTTPException(500, tr("llm.activate_restart_failed", locale,
                                    default="Activation OK mais échec du redémarrage."))

    return {"ok": True, "warning": warning}


@app.delete("/api/llm/models/{model_id}")
@limiter.limit("10/minute")
def llm_delete_model(request: Request, model_id: str,
                     locale: str = Depends(get_locale)):
    """Supprime un GGUF du disque pour libérer de l'espace. Sans danger :
    le runtime ne touchera plus à ce fichier ; si c'était le modèle
    actif, le prochain start tombera sur LLMServerError et basculera
    en mode no-AI proprement."""
    from src.llm import catalog
    meta = catalog.get_model(model_id)
    if meta is None:
        raise HTTPException(404, tr("llm.unknown_model", locale,
                                    default="Modèle inconnu."))
    path = _paths.MODELS_DIR / meta["filename"]
    if path.is_file():
        try:
            path.unlink()
        except OSError as e:
            raise HTTPException(500, f"Impossible de supprimer : {e}")
    return {"ok": True}


@app.post("/api/llm/models/{model_id}/download")
@limiter.limit("4/minute")
def llm_download_model(request: Request, model_id: str,
                       locale: str = Depends(get_locale)):
    """Télécharge un GGUF en streaming, renvoie un Server-Sent Events
    flux que le frontend consomme pour mettre à jour une progress bar.

    Format des events :
        data: {"progress": 0.42, "speed_mbps": 8.3, "eta_sec": 35}
        data: {"done": true, "sha_ok": true}
    """
    from src.llm import catalog, downloader

    meta = catalog.get_model(model_id)
    if meta is None:
        raise HTTPException(404, tr("llm.unknown_model", locale,
                                    default="Modèle inconnu."))

    dst = _paths.MODELS_DIR / meta["filename"]
    if dst.is_file():
        # Déjà là — on renvoie un mini-flux qui annonce 100% direct.
        def already_done():
            payload = json.dumps({"done": True, "sha_ok": True,
                                  "already_present": True})
            yield f"data: {payload}\n\n"
        return StreamingResponse(already_done(), media_type="text/event-stream")

    def event_stream():
        for event in downloader.stream_download(
            url=meta["url"],
            dst=dst,
            expected_sha256=meta.get("sha256"),
            expected_size=meta.get("size_bytes"),
        ):
            payload = {
                "progress": event.progress,
                "downloaded_bytes": event.downloaded_bytes,
                "total_bytes": event.total_bytes,
                "speed_mbps": event.speed_mbps,
                "eta_sec": event.eta_sec,
                "done": event.done,
                "sha_ok": event.sha_ok,
                "error": event.error,
            }
            yield f"data: {json.dumps(payload)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Dashboard ─────────────────────────────────────────────────────────────────

_MODEL_PRICES: dict = {
    "gpt-4o-mini":  {"in": 0.15,  "out": 0.60},
    "gpt-4o":       {"in": 2.50,  "out": 10.00},
    "gpt-4.1-mini": {"in": 0.40,  "out": 1.60},
    "gpt-4.1":      {"in": 2.00,  "out": 8.00},
    "gpt-4-turbo":  {"in": 10.00, "out": 30.00},
}


@app.post("/api/queue/skip-all")
def queue_skip_all():
    """Drain the AI analysis queue by marking all pending emails as 'other'."""
    count = db.skip_pending_emails()
    return {"ok": True, "skipped": count}


@app.get("/api/dashboard/status")
def dashboard_status():
    from src.scheduler import get_last_sync, is_running

    conf = cfg.get()
    enabled = [a for a in conf.get("accounts", []) if a.get("enabled", True)]
    per_acc = {r["account_email"]: r for r in db.per_account_stats()}

    accounts = []
    for acc in enabled:
        state = db.get_sync_state(acc["email"])
        stat = per_acc.get(acc["email"], {})
        accounts.append({
            "email": acc["email"],
            "name": acc.get("name", acc["email"]),
            "type": acc.get("type", "other"),
            "last_sync": state["last_sync"] if state else None,
            "sync_error": state["last_error"] if state else None,
            "unread": int(stat.get("unread") or 0),
            "needs_reply": int(stat.get("needs_reply") or 0),
            "pending": int(stat.get("pending") or 0),
            "favourite": int(stat.get("favourite") or 0),
            "draft": int(stat.get("draft") or 0),
            "total": int(stat.get("total") or 0),
        })

    stats = db.get_stats()
    ai_model = conf.get("openai", {}).get("model", "gpt-4o-mini")
    tokens   = db.token_totals_30d()
    prices   = _MODEL_PRICES.get(ai_model, _MODEL_PRICES["gpt-4o-mini"])
    cost_usd = (tokens["tokens_in"] * prices["in"] + tokens["tokens_out"] * prices["out"]) / 1_000_000

    return {
        "running": is_running(),
        "last_sync": get_last_sync(),
        "queue_pending": db.count_pending(),
        "throughput_60s": db.throughput_since(60),
        "throughput_30m": db.throughput_buckets(30),
        "throughput_30d": db.throughput_buckets_daily(30),
        "processed_total": db.count_processed(),
        "ai_model": ai_model,
        "cost_30d_usd": round(cost_usd, 6),
        "tokens_30d": tokens,
        "by_category": stats["by_category"],
        "score_histogram": db.score_histogram(),
        "totals": {
            "total": stats["total"],
            "unread": stats["unread"],
            "needs_reply": stats["needs_reply"],
        },
        "accounts": accounts,
        "actionable": db.actionable_emails(limit=10),
        "hours_distribution": db.hours_distribution(),
    }


_LOG_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s+"
    r"\[(?P<level>[A-Z]+)\]\s+(?P<logger>[^:]+):\s+(?P<message>.*)$"
)


def _read_tail(path: Path, max_bytes: int = 65536) -> str:
    if not path.exists():
        return ""
    size = path.stat().st_size
    with path.open("rb") as f:
        if size > max_bytes:
            f.seek(size - max_bytes)
            f.read(1)  # discard partial line
        return f.read().decode("utf-8", errors="replace")


@app.get("/api/logs/tail")
def logs_tail(lines: int = 50, since: Optional[str] = None):
    log_path = _paths.LOG_PATH
    text = _read_tail(log_path)
    if not text:
        return {"lines": []}

    parsed = []
    current = None
    for raw in text.splitlines():
        m = _LOG_RE.match(raw)
        if m:
            if current:
                parsed.append(current)
            current = {
                "ts": m.group("ts"),
                "level": m.group("level"),
                "logger": m.group("logger"),
                "message": m.group("message"),
            }
        elif current:
            current["message"] += "\n" + raw
    if current:
        parsed.append(current)

    if since:
        parsed = [p for p in parsed if p["ts"] > since]

    cap = max(1, min(int(lines), 200))
    return {"lines": parsed[-cap:]}


# ── Diagnostics (used by the in-app "Report a bug" flow) ──────────────────────

# Patterns we redact before exposing the log tail to the GitHub issue
# pre-fill. Order matters: long-form secrets (sk-*, Bearer …) must run
# before the catch-all email pattern.
_SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"sk-[A-Za-z0-9_-]{16,}"),                 "sk-***"),
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._-]+"),        "Bearer ***"),
    (re.compile(r"(?i)(api[_-]?key|token|password)\s*[:=]\s*[^\s,'\"]+"),
                                                            r"\1=***"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
                                                            "***@***"),
    # Windows user-profile path: C:\Users\<name>\... → C:\Users\<USER>\...
    (re.compile(r"([A-Za-z]:\\Users\\)[^\\\s\"']+"),       r"\1<USER>"),
    # POSIX home: /home/<name>/ or /Users/<name>/
    (re.compile(r"(/(?:home|Users)/)[^/\s\"']+"),          r"\1<USER>"),
]


def _sanitize_log_text(text: str) -> str:
    for pat, repl in _SECRET_PATTERNS:
        text = pat.sub(repl, text)
    return text


@app.get("/api/diagnostics")
def diagnostics():
    """Sanitized snapshot of the runtime, used to pre-fill bug reports.

    Never exposes email addresses, API keys, or absolute user paths. The
    frontend shows the JSON to the user *before* opening the GitHub issue
    URL, so anything that lands here ends up visible in their browser.
    """
    import platform
    import sys as _sys
    from src.updater import get_current_version

    # The point of this endpoint is to help report bugs — including bugs
    # that come from a broken config. So we never let cfg.get() crash the
    # response: we degrade gracefully and the user still gets version/OS.
    accounts: list = []
    enabled_accounts: list = []
    openai_conf: dict = {}
    has_ntfy = False
    config_error: Optional[str] = None
    try:
        conf = cfg.get()
        accounts = conf.get("accounts") or []
        enabled_accounts = [a for a in accounts if a.get("enabled", True)]
        openai_conf = conf.get("openai") or {}
        has_ntfy = bool((conf.get("ntfy") or {}).get("topic"))
    except Exception as exc:
        config_error = type(exc).__name__
    has_openai = bool(openai_conf.get("api_key"))
    model = openai_conf.get("model") if has_openai else None
    # `ai_enabled` couvre les deux providers (OpenAI clé + local GGUF).
    # `has_openai` reste exposé séparément pour les diagnostics qui veulent
    # distinguer le provider.
    ai_enabled = cfg.ai_enabled()

    try:
        from src.scheduler import get_last_sync, is_running as sync_running
        last_sync = get_last_sync()
        sync_is_running = bool(sync_running())
    except Exception:
        last_sync = None
        sync_is_running = False

    log_tail_raw = _read_tail(_paths.LOG_PATH, max_bytes=16384)
    log_lines = log_tail_raw.splitlines()[-30:] if log_tail_raw else []
    log_tail = _sanitize_log_text("\n".join(log_lines)) if log_lines else ""

    return {
        "app": {
            "name": "Lull Mail",
            "version": get_current_version(),
            "frozen": bool(getattr(_sys, "frozen", False)),
        },
        "os": {
            "platform": platform.platform(),
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "python": platform.python_version(),
        "config": {
            "accounts_total": len(accounts),
            "accounts_enabled": len(enabled_accounts),
            "ai_enabled": ai_enabled,
            "has_openai": has_openai,
            "ai_model": model,
            "has_ntfy": has_ntfy,
            "error": config_error,
        },
        "sync": {
            "last_sync": last_sync,
            "running": sync_is_running,
        },
        "log_tail": log_tail,
    }


# ── Custom cleanup rules ──────────────────────────────────────────────────────

class CustomRuleBody(BaseModel):
    name: str
    description: str = ""
    icon: str = "filter"
    accent: str = "var(--accent)"
    filter: dict = {}
    actions: List[str] = ["mark_read"]
    enabled: bool = True


class CustomRulePatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    accent: Optional[str] = None
    filter: Optional[dict] = None
    actions: Optional[List[str]] = None
    enabled: Optional[bool] = None
    position: Optional[int] = None


@app.get("/api/cleanup/custom-rules")
def list_custom_rules():
    return db.get_custom_rules()


@app.post("/api/cleanup/custom-rules", status_code=201)
def create_custom_rule(body: CustomRuleBody):
    rule_id = db.create_custom_rule(
        name=body.name.strip() or "Sans titre",
        description=body.description,
        icon=body.icon or "filter",
        accent=body.accent or "var(--accent)",
        filter_json=json.dumps(body.filter),
        actions_json=json.dumps(body.actions),
    )
    rules = db.get_custom_rules()
    created = next((r for r in rules if r["id"] == rule_id), None)
    return created or {"id": rule_id}


@app.patch("/api/cleanup/custom-rules/{rule_id}")
def patch_custom_rule(rule_id: int, body: CustomRulePatch, locale: str = Depends(get_locale)):
    fields: dict = {}
    if body.name is not None:
        fields["name"] = body.name.strip() or "Sans titre"
    if body.description is not None:
        fields["description"] = body.description
    if body.icon is not None:
        fields["icon"] = body.icon
    if body.accent is not None:
        fields["accent"] = body.accent
    if body.filter is not None:
        fields["filter_json"] = json.dumps(body.filter)
    if body.actions is not None:
        fields["actions_json"] = json.dumps(body.actions)
    if body.enabled is not None:
        fields["enabled"] = 1 if body.enabled else 0
    if body.position is not None:
        fields["position"] = body.position
    if not fields:
        raise HTTPException(400, tr("cleanup.no_field_to_update", locale))
    db.update_custom_rule(rule_id, **fields)
    return {"ok": True}


@app.delete("/api/cleanup/custom-rules/{rule_id}")
def remove_custom_rule(rule_id: int):
    db.delete_custom_rule(rule_id)
    return {"ok": True}


# ── Setup wizard router ──────────────────────────────────────────────────────
# Mounted late so it inherits the same FastAPI instance. Imported here (not
# at module top) to avoid pulling lifecycle/yaml at api.py import time when
# the consumer just needs the model definitions.
from src.setup_api import router as _setup_router  # noqa: E402
app.include_router(_setup_router)


# ── Frontend ──────────────────────────────────────────────────────────────────

if FRONTEND.exists():
    # Custom StaticFiles that disables HTTP caching. Lull Mail runs on
    # 127.0.0.1 against a single user, so the perf cost of re-fetching a
    # 2 KB JS file on every reload is irrelevant — and it avoids the
    # week-long debugging sessions that come from a cached `api.js` after
    # a security/UI hotfix. ES modules in Firefox are particularly sticky
    # with the default `Cache-Control: max-age=...` returned by Starlette.
    class _NoCacheStatic(StaticFiles):
        async def get_response(self, path, scope):
            response = await super().get_response(path, scope)
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
            return response

    app.mount("/static", _NoCacheStatic(directory=str(FRONTEND)), name="static")

    from fastapi.responses import RedirectResponse  # local import keeps top tidy

    # The HTML shells need the same no-cache treatment as /static — and they
    # need it MORE. FileResponse sets etag + last-modified but no
    # Cache-Control, and RFC 9111 lets a cache invent a heuristic freshness
    # lifetime when none is given (commonly 10% of the file's age). WebView2
    # then serves index.html from disk WITHOUT asking the server.
    #
    # That is how a desktop upgrade could still paint the previous release's
    # UI: the packaged app keeps a persistent WebView2 profile
    # (private_mode=False) and deliberately reuses the same port across
    # launches (_pick_stable_port, so localStorage survives), so the origin
    # and the URL are identical from one version to the next — a perfect
    # cache hit. The rail markup lives in index.html, so users saw the old
    # navbar while the freshly-shipped JS/CSS underneath were already
    # no-cache and up to date.
    _HTML_NO_CACHE = {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    }

    _STATIC_REF = re.compile(r'(["\'])(/static/[^"\'?#]+)\1')

    def _shell(filename: str) -> HTMLResponse:
        """Serve an HTML shell with version-stamped asset URLs.

        no-store stops the embedded browser creating NEW stale entries, but
        it cannot evict what an older build already banked — and those
        entries can be served without ever asking us. Clearing the cache
        directory only helps where we know its layout (WebView2 on Windows);
        macOS/WKWebView and Linux/WebKitGTK keep theirs elsewhere.

        Stamping every /static reference with the app version changes the
        cache key on each upgrade, so no engine can hand back the previous
        release's JS or CSS regardless of what it stored. Cheap: these files
        are a few KB and this runs once per window load.
        """
        from src.updater import get_current_version
        html = (FRONTEND / filename).read_text(encoding="utf-8")
        ver = get_current_version()
        html = _STATIC_REF.sub(rf'\1\2?v={ver}\1', html)
        return HTMLResponse(html, headers=_HTML_NO_CACHE)

    @app.get("/")
    def root():
        # First-run UX: send users straight to the wizard instead of
        # showing them a broken dashboard (no accounts → empty everything).
        from src import config as _cfg
        if not _cfg.is_configured():
            return RedirectResponse(url="/onboarding", status_code=302)
        return _shell("index.html")

    @app.get("/onboarding", response_class=HTMLResponse)
    def onboarding():
        return _shell("onboarding.html")

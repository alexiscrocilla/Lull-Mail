import hashlib
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Dict, List, Literal, Optional, Tuple

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from src import config as cfg
from src import database as db
from src import attachment_security as att_sec

logger = logging.getLogger(__name__)

app = FastAPI(title="Lull Mail", docs_url=None, redoc_url=None)


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
# 'favourite' is no longer a folder — it became a separate boolean flag.
_VALID_FOLDERS = {"inbox", "deleted"}


class EmailPatch(BaseModel):
    is_read: Optional[bool] = None
    category: Optional[str] = None
    folder: Optional[str] = None
    is_favourite: Optional[bool] = None


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


# ── Email routes ──────────────────────────────────────────────────────────────

@app.get("/api/emails")
def list_emails(
    account: Optional[str] = None,
    category: Optional[str] = None,
    is_read: Optional[bool] = None,
    needs_reply: Optional[bool] = None,
    folder: Optional[str] = None,
    sender: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
):
    rows = db.get_emails(
        account=account,
        category=category,
        is_read=is_read,
        needs_reply=needs_reply,
        folder=folder,
        sender=sender,
        limit=min(limit, 500),
        offset=offset,
    )
    # Bulk-attach an `attachments` summary so the list view can render the
    # paperclip icon + a per-email risk badge without N+1 queries.
    if rows:
        counts = db.attachment_counts_for_messages([r["message_id"] for r in rows])
        for r in rows:
            c = counts.get(r["message_id"])
            r["attachments"] = c or {"total": 0, "dangerous": 0, "suspicious": 0}
    return rows


@app.get("/api/emails/{int_id}")
def get_email(int_id: int, bg: BackgroundTasks):
    em = db.get_email_by_id(int_id)
    if not em:
        raise HTTPException(404, "Email introuvable")
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
    return em


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
def patch_email(int_id: int, patch: EmailPatch, bg: BackgroundTasks):
    em = db.get_email_by_id(int_id)
    if not em:
        raise HTTPException(404, "Email introuvable")

    if patch.is_read is True and not em.get("is_read"):
        db.mark_read(em["message_id"])
        bg.add_task(_imap_mark_seen, em["account_email"], em["uid"])
    elif patch.is_read is False and em.get("is_read"):
        db.mark_unread(em["message_id"])
        bg.add_task(_imap_mark_unseen, em["account_email"], em["uid"])

    if patch.category is not None:
        if patch.category not in _VALID_CATEGORIES:
            raise HTTPException(400, f"Catégorie invalide : {patch.category}")
        if patch.category != em.get("category"):
            db.update_email_category(em["message_id"], patch.category)

    if patch.folder is not None:
        if patch.folder not in _VALID_FOLDERS:
            raise HTTPException(400, f"Dossier invalide : {patch.folder}")
        if patch.folder != em.get("folder"):
            db.update_email_folder(em["message_id"], patch.folder)
            bg.add_task(_imap_apply_folder, em["account_email"], em["uid"], patch.folder)

    if patch.is_favourite is not None:
        if bool(em.get("is_favourite")) != patch.is_favourite:
            db.set_favourite(em["message_id"], patch.is_favourite)
            bg.add_task(_imap_set_favourite, em["account_email"], em["uid"], patch.is_favourite)

    return {"ok": True}


@app.post("/api/emails/{int_id}/draft")
def generate_draft(int_id: int):
    """Generate an AI draft reply on demand for a specific email.

    When a draft already exists we return it verbatim (idempotent). On
    fresh generation we also flip `needs_reply = 1`: the user explicitly
    asked for a reply, so the email semantically "awaits a reply" and the
    list-card reply icon should reflect that. Returns the persisted state
    flags too so the frontend can update its local cache without a
    follow-up GET.
    """
    from src.ai_processor import enrich_draft
    em = db.get_email_by_id(int_id)
    if not em:
        raise HTTPException(404, "Email introuvable")
    if em.get("draft_response"):
        # Idempotent path. We still ensure needs_reply is set to 1 in case
        # an older row had a draft without the flag (legacy state).
        if not em.get("needs_reply"):
            db.set_needs_reply(em["message_id"], True)
        return {
            "draft_response": em["draft_response"],
            "needs_reply": True,
        }
    conf = cfg.get()
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


@app.post("/api/emails/{int_id}/reanalyze")
def reanalyze_email(int_id: int):
    from src.ai_processor import process_email
    em = db.get_email_by_id(int_id)
    if not em:
        raise HTTPException(404, "Email introuvable")
    conf = cfg.get()
    model = conf.get("openai", {}).get("model", "gpt-4o-mini")
    result = process_email(em, model=model)
    if not result:
        raise HTTPException(502, "Échec de la ré-analyse IA")
    db.update_email_ai(em["message_id"], result)
    return db.get_email_by_id(int_id)


# ── Attachments ───────────────────────────────────────────────────────────────

# Resolve once: the absolute path of the attachment store. Every download
# must remain inside this root after symlink resolution. Re-resolved per
# request would be wasteful AND would let an attacker race a symlink swap
# between resolution and read.
from src import paths as _paths
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
def list_attachments(int_id: int):
    em = db.get_email_by_id(int_id)
    if not em:
        raise HTTPException(404, "Email introuvable")
    rows = db.get_attachments_for_message(em["message_id"])
    return [_attachment_summary(r) for r in rows]


@app.get("/api/attachments/{att_id}/download")
def download_attachment(
    att_id: int,
    confirm: int = Query(0, description="Set to 1 to override the dangerous-file gate"),
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
        raise HTTPException(404, "Pièce jointe introuvable")

    threat_level = row.get("threat_level") or att_sec.THREAT_SAFE

    # `blocked` files were never written to disk by policy. We expose the
    # metadata via /list_attachments but refuse to serve bytes — there are
    # none to serve.
    if threat_level == att_sec.THREAT_BLOCKED or not row.get("storage_path"):
        raise HTTPException(
            410,
            "Pièce jointe bloquée par la politique de sécurité — "
            "aucune donnée stockée."
        )

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
        raise HTTPException(404, "Pièce jointe introuvable")
    if not candidate.is_file():
        raise HTTPException(404, "Fichier physiquement absent")

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
        raise HTTPException(500, "Lecture impossible")
    if actual != (row.get("sha256") or ""):
        logger.error(
            f"attachment {att_id}: SHA-256 mismatch "
            f"(stored={row.get('sha256')!r}, disk={actual!r}); refusing serve"
        )
        raise HTTPException(409, "Empreinte de fichier altérée — accès refusé")

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
def cleanup_sender(req: CleanupSenderReq, bg: BackgroundTasks):
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
def get_cleanup_job(job_id: str):
    with _jobs_lock:
        j = _jobs.get(job_id)
    if not j:
        raise HTTPException(404, "Job introuvable")
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
def cleanup_rule_run(req: RuleRunReq, bg: BackgroundTasks):
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
def cleanup_unsubscribe(req: UnsubscribeReq, bg: BackgroundTasks):
    """Single-sender unsubscribe with optional purge of existing messages."""
    target = db.unsubscribe_sender_target(req.sender, account=req.account)
    if not target:
        raise HTTPException(404, "Aucun lien de désabonnement connu pour cet expéditeur")

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
def cleanup_unsubscribe_bulk(req: UnsubscribeBulkReq, bg: BackgroundTasks):
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
        })
    return result


# ── Sync ──────────────────────────────────────────────────────────────────────

@app.post("/api/sync")
def trigger_sync(bg: BackgroundTasks):
    from src.scheduler import is_running, run_sync
    if is_running():
        return {"ok": False, "message": "Sync déjà en cours"}
    bg.add_task(run_sync)
    return {"ok": True, "message": "Synchronisation lancée"}


@app.get("/api/sync/status")
def sync_status():
    from src.scheduler import get_last_sync, is_running
    return {"running": is_running(), "last_sync": get_last_sync()}


# ── Dashboard ─────────────────────────────────────────────────────────────────

_MODEL_PRICES: dict = {
    "gpt-4o-mini":  {"in": 0.15,  "out": 0.60},
    "gpt-4o":       {"in": 2.50,  "out": 10.00},
    "gpt-4.1-mini": {"in": 0.40,  "out": 1.60},
    "gpt-4.1":      {"in": 2.00,  "out": 8.00},
    "gpt-4-turbo":  {"in": 10.00, "out": 30.00},
}


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
def patch_custom_rule(rule_id: int, body: CustomRulePatch):
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
        raise HTTPException(400, "Aucun champ à mettre à jour")
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
    app.mount("/static", StaticFiles(directory=str(FRONTEND)), name="static")

    from fastapi.responses import RedirectResponse  # local import keeps top tidy

    @app.get("/")
    def root():
        # First-run UX: send users straight to the wizard instead of
        # showing them a broken dashboard (no accounts → empty everything).
        from src import config as _cfg
        if not _cfg.is_configured():
            return RedirectResponse(url="/onboarding", status_code=302)
        return FileResponse(str(FRONTEND / "index.html"))

    @app.get("/onboarding", response_class=HTMLResponse)
    def onboarding():
        return FileResponse(str(FRONTEND / "onboarding.html"))

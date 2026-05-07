"""
SMTP outbound for Lull Mail.

The send pipeline is intentionally synchronous: cfg.get() returns a
freshly-loaded account dict, secrets_store resolves the keyring sentinel
to the real password, and smtplib delivers the message. Any failure
bubbles up as `SendError` with a human-readable French message — the
API layer turns that into a 502 the UI can toast.

The module never logs the password or the message body. Only the
envelope (From / To / Subject / message-id / SMTP host) reaches the
log so a verbose run is safe to share for debugging.

References:
  - RFC 5322 (message format) — handled via `email.message.EmailMessage`
  - RFC 2822 §3.6.4 (Message-ID generation) — UUID-based to avoid leaks
  - RFC 5321 §4.5.3.1.1 (250 4.x.x retryable / 5.x.x permanent) — we
    surface both as `SendError`; the outbox status records which.
"""

from __future__ import annotations

import logging
import smtplib
import socket
import ssl
import uuid
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr
from typing import Any, Dict, List, Optional, Tuple

from src import config as cfg
from src import secrets_store

logger = logging.getLogger(__name__)


class SendError(RuntimeError):
    """Raised when delivery fails. Carries a French message ready for
    the toast plus an internal `stage` tag for telemetry."""

    def __init__(self, message: str, stage: str = "unknown", detail: str = ""):
        super().__init__(message)
        self.stage = stage
        self.detail = detail


# ── Account / provider resolution ───────────────────────────────────────────


def _resolve_account(account_email: str) -> Dict[str, Any]:
    """Pull the account dict from the loaded config. Raises SendError
    if the account doesn't exist or is disabled — both are user-facing
    misconfigurations the UI must surface, not silent no-ops."""
    conf = cfg.get()
    needle = (account_email or "").lower()
    for acc in (conf.get("accounts") or []):
        if (acc.get("email", "") or "").lower() == needle:
            if not acc.get("enabled", True):
                raise SendError(
                    f"Compte {account_email} désactivé.",
                    stage="account_disabled",
                )
            return acc
    raise SendError(
        f"Compte {account_email} introuvable dans la configuration.",
        stage="account_missing",
    )


def _resolve_smtp_settings(acc: Dict[str, Any]) -> Tuple[str, int, bool, bool]:
    """Return `(host, port, ssl, starttls)` for an account.

    Order of precedence: explicit per-account override > provider preset
    keyed on `type` > generic STARTTLS-on-587 fallback. Empty host or
    port=0 in the account dict means "use the preset" — the Settings
    UI writes `smtp_host=""` when the user clears the override field.
    """
    # Late import to avoid a circular dep (setup_api imports cfg, which
    # is fine, but cfg pulled into setup_api at import time would cycle).
    from src.setup_api import SMTP_DEFAULTS

    override_host = (acc.get("smtp_host") or "").strip()
    override_port = int(acc.get("smtp_port") or 0)
    preset = SMTP_DEFAULTS.get(acc.get("type", "imap")) or {}

    # An explicit host override always wins — if the user typed it in the
    # Avancé form, their provider's preset is irrelevant (they may have
    # picked a custom relay). Port falls back to override_port, then the
    # preset's port, then 587 (the IANA submission port).
    if override_host:
        host = override_host
        port = override_port or int(preset.get("smtp_port") or 587)
        # Transport flags follow the override block too — the Settings
        # form posts both checkboxes, so trusting the account dict here
        # mirrors what the user picked alongside their host.
        use_ssl = bool(acc.get("smtp_ssl", False))
        use_starttls = bool(acc.get("smtp_starttls", True))
    else:
        host = preset.get("smtp_host") or ""
        port = int(preset.get("smtp_port") or override_port or 587)
        use_ssl = bool(preset.get("smtp_ssl", False))
        use_starttls = bool(preset.get("smtp_starttls", True))

    if not host:
        raise SendError(
            f"Aucun serveur SMTP configuré pour {acc.get('email', '')}. "
            "Ouvrez Settings → Avancé pour renseigner host/port.",
            stage="smtp_unconfigured",
        )
    return host, port, use_ssl, use_starttls


def _resolve_password(acc: Dict[str, Any]) -> str:
    """Return the cleartext password. Tries the keyring first (sentinel
    case — config.yaml only ever stores `keyring:user@host`); falls
    back to whatever the dict carries (legacy clear-text path)."""
    raw = acc.get("password", "") or ""
    if secrets_store.is_sentinel(raw):
        try:
            return secrets_store.resolve(raw, secrets_store.SERVICE_IMAP)
        except secrets_store.SecretsBackendError as e:
            raise SendError(
                f"Impossible de lire le mot de passe : {e}",
                stage="secrets",
                detail=str(e),
            ) from e
    return raw


# ── Message construction ────────────────────────────────────────────────────


def _split_addrs(value: Optional[str]) -> List[str]:
    """Split a comma-separated address line into clean entries. Empty
    items are dropped so an extra trailing comma doesn't yield ''."""
    if not value:
        return []
    out: List[str] = []
    for part in value.split(","):
        addr = part.strip()
        if addr:
            out.append(addr)
    return out


def _validate_addr(addr: str) -> str:
    """Light validation: parseaddr returns ('', '') for garbage. We
    don't want to ship the message to the SMTP server only to have it
    bounce with a syntax error."""
    name, email = parseaddr(addr)
    if not email or "@" not in email:
        raise SendError(
            f"Adresse invalide : {addr!r}",
            stage="address_validation",
        )
    return addr


def _resolve_upload(upload_id: str) -> Tuple[Optional[bytes], Optional[str], Optional[str]]:
    """Read an `OUTBOX_ATTACHMENTS_DIR/<upload_id>/<filename>` payload
    and return `(data, filename, content_type)`. Returns `(None,…)`
    when the upload is missing — caller decides whether to abort or
    skip silently."""
    from src import paths
    import mimetypes
    folder = paths.OUTBOX_ATTACHMENTS_DIR / upload_id
    try:
        folder = folder.resolve()
        folder.relative_to(paths.OUTBOX_ATTACHMENTS_DIR.resolve())
    except (OSError, ValueError):
        return (None, None, None)
    if not folder.is_dir():
        return (None, None, None)
    files = [p for p in folder.iterdir() if p.is_file()]
    if not files:
        return (None, None, None)
    f = files[0]
    try:
        data = f.read_bytes()
    except OSError:
        return (None, None, None)
    ct, _ = mimetypes.guess_type(f.name)
    return (data, f.name, ct or "application/octet-stream")


def _cleanup_uploads(upload_ids: List[str]) -> None:
    """Best-effort delete of staged uploads after a successful send.
    Silent on failure — leftover files are an annoyance, not a bug."""
    if not upload_ids:
        return
    from src import paths
    import shutil
    base = paths.OUTBOX_ATTACHMENTS_DIR.resolve()
    for uid in upload_ids:
        try:
            folder = (paths.OUTBOX_ATTACHMENTS_DIR / uid).resolve()
            folder.relative_to(base)
            if folder.is_dir():
                shutil.rmtree(folder, ignore_errors=True)
        except Exception:
            continue


def _build_message(
    *,
    account_email: str,
    account_name: str,
    to: List[str],
    cc: List[str],
    bcc: List[str],
    subject: str,
    body_text: str,
    body_html: Optional[str],
    in_reply_to: Optional[str],
    references: Optional[str],
    attachments: Optional[List[str]] = None,
    inline_images: Optional[List[str]] = None,
) -> Tuple[EmailMessage, str]:
    msg = EmailMessage()

    if account_name:
        msg["From"] = f"{account_name} <{account_email}>"
    else:
        msg["From"] = account_email

    if to:
        msg["To"] = ", ".join(_validate_addr(a) for a in to)
    if cc:
        msg["Cc"] = ", ".join(_validate_addr(a) for a in cc)
    # BCC is intentionally NOT set as a header — recipients still receive
    # the message via the SMTP envelope (RCPT TO) but the address is
    # absent from the wire copy. Setting it as a header would leak the
    # bcc list to every other recipient.

    msg["Subject"] = subject or ""
    msg["Date"] = formatdate(localtime=True)
    # make_msgid uses the host portion as the domain part of the
    # Message-ID. We use a Lull-Mail-specific stub so the ID is opaque
    # but still RFC-5322-compliant; the value is also returned to the
    # caller so it can be persisted in `outbox`/`emails`.
    msg["Message-ID"] = make_msgid(domain="lull-mail.local")

    # Threading headers — when replying we MUST repeat the original
    # Message-ID in `In-Reply-To` and append it to `References`.
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
    if references:
        msg["References"] = references
    elif in_reply_to:
        msg["References"] = in_reply_to

    # ── Inline images ──────────────────────────────────────────
    # Each inline image is attached to the alternative HTML part
    # with a Content-ID (cid:upload_id). The HTML body should
    # reference those via `<img src="cid:upload_id">` — that's the
    # frontend's job; we just resolve and stage the resources here.
    # If the caller passed inline_images but no body_html, promote
    # them by appending <img> tags so the message isn't malformed.
    inline_resources: List[Tuple[str, bytes, str, str]] = []
    inline_ids = list(inline_images or [])
    for uid in inline_ids:
        data, fname, ctype = _resolve_upload(uid)
        if data is None:
            raise SendError(
                f"Image inline introuvable (upload {uid}).",
                stage="upload_missing",
            )
        if not (ctype or "").startswith("image/"):
            raise SendError(
                f"Pièce inline « {fname} » n'est pas une image ({ctype}).",
                stage="upload_invalid",
            )
        inline_resources.append((uid, data, fname, ctype))

    if inline_resources and not body_html:
        # Auto-build a tiny HTML body referencing each cid in order.
        imgs = "".join(
            f'<img src="cid:{uid}" alt="{fname}" style="max-width:100%">'
            for (uid, _, fname, _) in inline_resources
        )
        body_html = f"<div>{(body_text or '').replace(chr(10), '<br>')}</div>{imgs}"

    msg.set_content(body_text or "")
    if body_html:
        msg.add_alternative(body_html, subtype="html")
        if inline_resources:
            html_part = msg.get_payload()[1]
            for (uid, data, fname, ctype) in inline_resources:
                maintype, _, subtype = ctype.partition("/")
                html_part.add_related(
                    data,
                    maintype=maintype or "image",
                    subtype=subtype or "octet-stream",
                    cid=f"<{uid}>",
                    filename=fname,
                )

    # ── Regular attachments ────────────────────────────────────
    # Anchored at the message root (NOT inside the html alternative)
    # so they appear as proper file attachments rather than
    # inline-rendered images.
    attached_ids = list(attachments or [])
    for uid in attached_ids:
        data, fname, ctype = _resolve_upload(uid)
        if data is None:
            raise SendError(
                f"Pièce jointe introuvable (upload {uid}).",
                stage="upload_missing",
            )
        maintype, _, subtype = (ctype or "application/octet-stream").partition("/")
        msg.add_attachment(
            data,
            maintype=maintype or "application",
            subtype=subtype or "octet-stream",
            filename=fname,
        )

    # Return the message AND the merged list of upload ids consumed,
    # so send_message can clean them up after a successful delivery.
    consumed = inline_ids + attached_ids
    return msg, ",".join(consumed) if consumed else ""


# ── Delivery ────────────────────────────────────────────────────────────────


def _open_smtp(
    host: str, port: int, use_ssl: bool, use_starttls: bool, verify_ssl: bool
) -> smtplib.SMTP:
    """Connect to the SMTP server. Returns an authenticated-ready
    handle (login is the caller's job). Times out at 30s — long enough
    for slow corporate networks, short enough to fail fast in the UI."""
    try:
        if use_ssl:
            ctx = ssl.create_default_context()
            if not verify_ssl:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            return smtplib.SMTP_SSL(host, port, timeout=30, context=ctx)
        client = smtplib.SMTP(host, port, timeout=30)
        if use_starttls:
            ctx = ssl.create_default_context()
            if not verify_ssl:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            client.starttls(context=ctx)
        return client
    except (socket.gaierror, socket.timeout, OSError) as e:
        raise SendError(
            f"Connexion au serveur SMTP impossible ({host}:{port}).",
            stage="connect",
            detail=str(e),
        ) from e
    except ssl.SSLError as e:
        raise SendError(
            "Erreur SSL/TLS pendant la négociation avec le serveur SMTP.",
            stage="ssl",
            detail=str(e),
        ) from e


def send_message(
    *,
    account_email: str,
    to: List[str],
    cc: Optional[List[str]] = None,
    bcc: Optional[List[str]] = None,
    subject: str = "",
    body_text: str = "",
    body_html: Optional[str] = None,
    in_reply_to: Optional[str] = None,
    references: Optional[str] = None,
    attachments: Optional[List[str]] = None,
    inline_images: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Send a message via the SMTP server tied to `account_email`.

    `attachments` and `inline_images` are lists of `upload_id` strings
    pointing at staged files in `OUTBOX_ATTACHMENTS_DIR/<id>/<file>`.
    On successful delivery the staged files are deleted automatically.

    Returns `{"message_id": str, "smtp_host": str}` on success.
    Raises `SendError` (subclass of RuntimeError) on any failure, with a
    French user-facing message and an internal `stage` tag.
    """
    if not to:
        raise SendError("Au moins un destinataire est requis.", stage="empty_to")

    acc = _resolve_account(account_email)
    host, port, use_ssl, use_starttls = _resolve_smtp_settings(acc)
    password = _resolve_password(acc)
    if not password:
        raise SendError(
            "Aucun mot de passe disponible pour ce compte.",
            stage="missing_password",
        )

    msg, _consumed_csv = _build_message(
        account_email=acc.get("email", account_email),
        account_name=acc.get("name", "") or "",
        to=to,
        cc=cc or [],
        bcc=bcc or [],
        subject=subject,
        body_text=body_text,
        body_html=body_html,
        in_reply_to=in_reply_to,
        references=references,
        attachments=attachments or [],
        inline_images=inline_images or [],
    )

    envelope_rcpts: List[str] = list(to) + list(cc or []) + list(bcc or [])
    username = acc.get("username") or acc.get("email") or account_email
    verify_ssl = bool(acc.get("verify_ssl", True))

    logger.info(
        "smtp send: %s → %d rcpts via %s:%d (ssl=%s starttls=%s)",
        account_email, len(envelope_rcpts), host, port, use_ssl, use_starttls,
    )

    client: Optional[smtplib.SMTP] = None
    try:
        client = _open_smtp(host, port, use_ssl, use_starttls, verify_ssl)
        try:
            client.login(username, password)
        except smtplib.SMTPAuthenticationError as e:
            raise SendError(
                "Identifiants SMTP refusés par le serveur.",
                stage="auth",
                detail=str(e),
            ) from e
        try:
            client.send_message(
                msg, from_addr=acc.get("email", account_email),
                to_addrs=envelope_rcpts,
            )
        except smtplib.SMTPRecipientsRefused as e:
            # All recipients refused — surface the first reason.
            first_addr = next(iter(e.recipients), "")
            raise SendError(
                f"Destinataire refusé par le serveur : {first_addr}",
                stage="recipients",
                detail=str(e.recipients),
            ) from e
        except smtplib.SMTPSenderRefused as e:
            raise SendError(
                "Expéditeur refusé par le serveur SMTP.",
                stage="sender",
                detail=str(e),
            ) from e
        except smtplib.SMTPDataError as e:
            raise SendError(
                "Le serveur SMTP a refusé le contenu du message.",
                stage="data",
                detail=str(e),
            ) from e
        except smtplib.SMTPException as e:
            raise SendError(
                "Échec d'envoi SMTP.",
                stage="smtp",
                detail=str(e),
            ) from e
    finally:
        if client is not None:
            try:
                client.quit()
            except Exception:
                pass

    message_id = msg["Message-ID"]

    # Persist a local copy so the "Envoyés" folder has something to
    # show. Failure here MUST NOT raise — the message has already been
    # delivered to the SMTP server, and flipping the call into a 500
    # would mislead the UI into thinking nothing happened. We log and
    # move on; the outbox row created by the API endpoint already
    # records the success for diagnostics either way.
    try:
        from src import database as _db
        _db.insert_email({
            "message_id": str(message_id),
            "account": acc.get("email", account_email),
            "uid": None,
            "subject": subject or "",
            "sender": (
                f"{acc.get('name')} <{acc.get('email', account_email)}>"
                if acc.get("name") else acc.get("email", account_email)
            ),
            "recipient": ", ".join(to),
            "date_str": msg["Date"] or "",
            "body_text": body_text or "",
            "body_html": body_html or "",
        })
        # The fresh row defaults to category='pending' / folder='inbox';
        # a sent message belongs in folder='sent' and shouldn't be
        # re-classified by the AI loop. Mark it terminal in one shot.
        _db.update_email_folder(str(message_id), "sent")
        _db.update_email_category(str(message_id), "other")
        _db.mark_read(str(message_id))
    except Exception:
        logger.exception("send_message: local Sent copy failed (delivery succeeded)")

    # Drop the staged uploads now that they're delivered. Keep this
    # AFTER the local Sent copy so a failure to record the sent row
    # doesn't lose the user the option of re-sending with the same
    # files (the SendError above already short-circuits on any earlier
    # failure, so reaching this point means SMTP accepted the bytes).
    _cleanup_uploads(list(attachments or []) + list(inline_images or []))

    return {
        "message_id": str(message_id),
        "smtp_host": host,
    }


def new_message_id() -> str:
    """Stable Message-ID generator usable outside of `send_message` (for
    eventual draft auto-save in Phase 2). Uses the same domain stub so
    a draft promoted to a sent message keeps its identifier."""
    return f"<{uuid.uuid4().hex}@lull-mail.local>"

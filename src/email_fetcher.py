# SPDX-License-Identifier: GPL-3.0-or-later
import base64
import email
import hashlib
import imaplib
import json
import logging
import os
import re
import ssl
import uuid
from email.header import decode_header
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from src.attachment_security import (
    AttachmentPolicy,
    THREAT_BLOCKED,
    THREAT_DANGEROUS,
    THREAT_SUSPICIOUS,
    detect_threats,
    sanitize_filename,
    storage_subpath,
)

logger = logging.getLogger(__name__)

# Where attachments live on disk. Resolved via src.paths so it follows the
# same logic as DB/config (project root in dev, %APPDATA%\LullMail when
# packaged). The API enforces is_path_within() on every read regardless.
from src import paths as _paths
ATTACHMENTS_ROOT = _paths.ATTACHMENTS_DIR


def _decode_header(value: str) -> str:
    if not value:
        return ""
    try:
        parts = decode_header(value)
        result = []
        for raw, charset in parts:
            if isinstance(raw, bytes):
                result.append(raw.decode(charset or "utf-8", errors="replace"))
            else:
                result.append(str(raw))
        return "".join(result)
    except Exception:
        return str(value)


def _safe_decode_payload(payload: Optional[bytes], declared_charset: Optional[str]) -> str:
    if payload is None or not payload:
        return ""
    if declared_charset:
        try:
            return payload.decode(declared_charset, errors="replace")
        except (LookupError, UnicodeDecodeError):
            pass
    try:
        return payload.decode("utf-8", errors="replace")
    except (LookupError, UnicodeDecodeError):
        pass
    try:
        return payload.decode("latin-1", errors="replace")
    except Exception:
        return ""


def _extract_body(msg) -> Tuple[str, str, List[Dict]]:
    """Walk a parsed `email.message.Message` and return:

      - body_text   (plain-text body, capped to 8 KB)
      - body_html   (HTML body with cid: refs already inlined as data: URIs)
      - attachments (list of metadata + payload dicts for the caller to
                    classify & persist)

    Inline images keep being inlined as data URIs (preserves email rendering
    in the iframe with no extra fetches). Everything else — including
    inline parts WITHOUT a content-id, since they are still user-facing
    files — is returned as an attachment record. The caller decides what
    to write, what to flag, and what to throw away.
    """
    text, html = "", ""
    cid_map: Dict[str, str] = {}
    attachments: List[Dict] = []

    def _collect(part) -> None:
        """Append one attachment record for *part*, with raw payload bytes."""
        ct = part.get_content_type()
        try:
            payload = part.get_payload(decode=True)
        except Exception as e:
            logger.warning(f"attachment payload decode failed: {e}")
            return
        if not payload:
            return
        raw_name = part.get_filename()
        # `part.get_filename()` can return RFC 2231-encoded headers as
        # `email.header.Header` objects; normalise to a plain string before
        # sanitization.
        if raw_name is not None and not isinstance(raw_name, str):
            raw_name = _decode_header(str(raw_name))
        elif isinstance(raw_name, str):
            raw_name = _decode_header(raw_name)
        filename = sanitize_filename(raw_name)
        content_id = (part.get("Content-ID", "") or "").strip("<>").strip()
        is_inline = "inline" in str(part.get("Content-Disposition", "")).lower()
        attachments.append({
            "filename": filename,
            "content_type_declared": ct,
            "payload": payload,
            "is_inline": bool(content_id) or is_inline,
            "content_id": content_id,
        })

    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            # Skip the outer multipart container itself.
            if ct.startswith("multipart/"):
                continue
            cd = str(part.get("Content-Disposition", "")).lower()
            content_id = (part.get("Content-ID", "") or "").strip("<>").strip()

            if "attachment" in cd:
                _collect(part)
                continue

            # Inline images with Content-ID → embed as data: URI for the
            # iframe AND keep the original as a downloadable attachment so
            # the user can save the picture.
            if content_id and ct.startswith("image/"):
                try:
                    payload = part.get_payload(decode=True)
                    if payload:
                        b64 = base64.b64encode(payload).decode("ascii")
                        cid_map[content_id] = f"data:{ct};base64,{b64}"
                except Exception:
                    pass
                _collect(part)
                continue

            # Body parts.
            if ct in ("text/plain", "text/html"):
                charset = part.get_content_charset()
                try:
                    payload = part.get_payload(decode=True)
                    decoded = _safe_decode_payload(payload, charset)
                except Exception:
                    decoded = ""
                if ct == "text/plain" and not text:
                    text = decoded
                elif ct == "text/html" and not html:
                    html = decoded
                continue

            # Anything else multipart-shipped is treated as a real
            # attachment — this catches PDFs/spreadsheets that don't carry
            # a Content-Disposition header (some ESPs forget it).
            _collect(part)
    else:
        charset = msg.get_content_charset()
        try:
            payload = msg.get_payload(decode=True)
            decoded = _safe_decode_payload(payload, charset)
            if msg.get_content_type() == "text/plain":
                text = decoded
            else:
                html = decoded
        except Exception:
            pass

    # Replace cid: references in HTML with embedded data URIs.
    if html and cid_map:
        def _replace_cid(m: re.Match) -> str:
            cid = m.group(1).strip()
            return f'src="{cid_map[cid]}"' if cid in cid_map else m.group(0)
        html = re.sub(r'src=["\']cid:([^"\']+)["\']', _replace_cid, html)

    # When inline images are embedded as data URIs the HTML can be large.
    # Cap at 4 MB to stay within SQLite's practical limits.
    html_limit = 4_000_000 if cid_map else 200_000
    return text[:8000], html[:html_limit], attachments


def persist_attachments(
    *,
    message_id: str,
    account_email: str,
    parts: List[Dict],
    policy: AttachmentPolicy,
) -> List[Dict]:
    """Classify, write to disk (where allowed), and DB-record each part.

    Security pipeline per attachment, in order:
      1. Enforce per-file and per-email size caps.
      2. Run `detect_threats` (extension + magic + EICAR + double-ext +
         declared/sniffed MIME mismatch).
      3. If `policy.block_dangerous` is on and the threat is dangerous,
         do NOT write to disk — only the metadata row lands in the DB so
         the UI can warn ("1 fichier dangereux refusé"). We still SHA-256
         the bytes so accidental dedup works across messages.
      4. Otherwise write to a non-guessable subpath under data/attachments
         using a UUID-derived `.bin` filename. The original (sanitised)
         filename is stored in the DB and used in Content-Disposition only.

    Returns a list of metadata dicts (one per row inserted).
    """
    if not policy.enabled or not parts:
        return []

    from src import database as db

    saved: List[Dict] = []
    total_bytes = 0
    count = 0
    max_per_file = policy.max_size_mb * 1024 * 1024
    max_total = policy.max_total_mb_per_email * 1024 * 1024

    for part in parts:
        if count >= policy.max_count_per_email:
            logger.warning(
                f"[{account_email}] {message_id}: limite de "
                f"{policy.max_count_per_email} pièces jointes atteinte, "
                "le reste est ignoré"
            )
            break

        payload: bytes = part["payload"]
        size = len(payload)
        filename = part["filename"]
        declared = part.get("content_type_declared")
        is_inline = bool(part.get("is_inline"))

        # 1. Per-file cap. Oversize files never touch disk.
        if size > max_per_file:
            logger.info(
                f"[{account_email}] PJ '{filename}' rejetée : "
                f"{size} octets > limite {max_per_file}"
            )
            db.insert_attachment(
                message_id=message_id,
                account_email=account_email,
                filename=filename,
                content_type_declared=declared,
                content_type_sniffed=None,
                size=size,
                sha256=hashlib.sha256(payload).hexdigest(),
                storage_path=None,
                is_inline=is_inline,
                threat_level=THREAT_BLOCKED,
                threat_reasons_json=json.dumps([
                    f"Taille {size//1024} ko > limite {policy.max_size_mb} Mo"
                ]),
            )
            count += 1
            continue

        # 2. Total-per-email cap.
        if total_bytes + size > max_total:
            logger.info(
                f"[{account_email}] {message_id}: limite cumulée "
                f"{policy.max_total_mb_per_email} Mo atteinte, '{filename}' ignorée"
            )
            db.insert_attachment(
                message_id=message_id,
                account_email=account_email,
                filename=filename,
                content_type_declared=declared,
                content_type_sniffed=None,
                size=size,
                sha256=hashlib.sha256(payload).hexdigest(),
                storage_path=None,
                is_inline=is_inline,
                threat_level=THREAT_BLOCKED,
                threat_reasons_json=json.dumps([
                    "Taille cumulée des PJ dépassée"
                ]),
            )
            count += 1
            continue

        # 3. Threat assessment.
        report = detect_threats(filename, declared, payload)
        sha = hashlib.sha256(payload).hexdigest()

        # 4. Decide whether to persist.
        write_to_disk = True
        threat_level = report.threat_level
        if policy.block_dangerous and threat_level == THREAT_DANGEROUS:
            write_to_disk = False
            threat_level = THREAT_BLOCKED
        elif policy.block_suspicious and threat_level in (THREAT_SUSPICIOUS, THREAT_DANGEROUS):
            write_to_disk = False
            threat_level = THREAT_BLOCKED

        storage_path: Optional[str] = None
        if write_to_disk:
            try:
                subpath = storage_subpath(account_email, message_id)
                target_dir = ATTACHMENTS_ROOT / subpath
                target_dir.mkdir(parents=True, exist_ok=True)
                # Always store with a `.bin` extension under an opaque UUID
                # so a curious user double-clicking inside data/attachments/
                # cannot trigger Windows file association on the original
                # extension. The OS-level downloads always go through the
                # API, which restores the sanitized filename.
                opaque = f"{uuid.uuid4().hex}.bin"
                full = target_dir / opaque
                with open(full, "wb") as f:
                    f.write(payload)
                # Lock down on POSIX (no-op on Windows). Owner-readable only.
                try:
                    os.chmod(full, 0o600)
                except OSError:
                    pass
                storage_path = f"{subpath}/{opaque}"
            except OSError as e:
                logger.error(
                    f"[{account_email}] échec écriture PJ '{filename}': {e}"
                )
                threat_level = THREAT_BLOCKED
                report.reasons.append(f"Écriture sur disque échouée: {e}")

        att_id = db.insert_attachment(
            message_id=message_id,
            account_email=account_email,
            filename=filename,
            content_type_declared=declared,
            content_type_sniffed=report.sniffed_mime,
            size=size,
            sha256=sha,
            storage_path=storage_path,
            is_inline=is_inline,
            threat_level=threat_level,
            threat_reasons_json=json.dumps(report.reasons, ensure_ascii=False),
        )

        if threat_level in (THREAT_DANGEROUS, THREAT_BLOCKED):
            logger.warning(
                f"[{account_email}] PJ '{filename}' "
                f"({threat_level}): {'; '.join(report.reasons) or 'sans détail'}"
            )

        saved.append({
            "id": att_id,
            "filename": filename,
            "size": size,
            "threat_level": threat_level,
            "reasons": report.reasons,
            "stored": storage_path is not None,
        })
        if write_to_disk:
            total_bytes += size
        count += 1

    return saved


# Socket timeout for every IMAP connection the app opens. Without one, a
# connection that silently dies (Wi-Fi switch, sleep/resume, server hang)
# blocks its thread forever — and with it the whole sync pass.
IMAP_TIMEOUT_SECONDS = 30.0


def _make_connection(account: Dict, timeout: Optional[float] = None) -> imaplib.IMAP4:
    host = account["imap_host"]
    port = int(account["imap_port"])
    use_ssl = account.get("ssl", True)
    starttls = account.get("starttls", False)
    verify = account.get("verify_ssl", True)

    # Defence-in-depth: refuse to open the socket if a stale or manually-
    # edited config.yaml combined verify_ssl=False with a remote host.
    # The wizard already rejects this at save-time but a config edited
    # by hand could slip past — fail closed here too.
    from src.security.tls import assert_verify_ssl_allowed
    assert_verify_ssl_allowed(host, verify)

    ctx = ssl.create_default_context()
    if not verify:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    if timeout is None:
        timeout = IMAP_TIMEOUT_SECONDS
    if use_ssl:
        conn = imaplib.IMAP4_SSL(host, port, ssl_context=ctx, timeout=timeout)
    else:
        conn = imaplib.IMAP4(host, port, timeout=timeout)
        if starttls:
            conn.starttls(ssl_context=ctx)

    conn.login(account["username"], account["password"])
    return conn


def _fallback_id(uid: str, account_email: str, subject: str) -> str:
    raw = f"{account_email}|{uid}|{subject}"
    return hashlib.md5(raw.encode()).hexdigest()


def mark_seen_on_server(account: Dict, uid: str) -> bool:
    """Set the \\Seen IMAP flag so the email appears as read in all mail clients."""
    if not uid:
        return False
    try:
        conn = _make_connection(account)
        conn.select("INBOX")
        conn.uid("store", uid.encode(), "+FLAGS", "\\Seen")
        conn.logout()
        logger.info(f"[{account['email']}] UID {uid} marqué lu sur le serveur")
        return True
    except Exception as e:
        logger.warning(f"[{account['email']}] Impossible de marquer lu UID {uid}: {e}")
        return False


def mark_unseen_on_server(account: Dict, uid: str) -> bool:
    """Remove the \\Seen IMAP flag so the email appears as unread again."""
    if not uid:
        return False
    try:
        conn = _make_connection(account)
        conn.select("INBOX")
        conn.uid("store", uid.encode(), "-FLAGS", "\\Seen")
        conn.logout()
        logger.info(f"[{account['email']}] UID {uid} marqué non lu sur le serveur")
        return True
    except Exception as e:
        logger.warning(f"[{account['email']}] Impossible de marquer non lu UID {uid}: {e}")
        return False


_TRASH_CANDIDATES = [
    "[Gmail]/Trash", "[Gmail]/Corbeille",
    "Trash", "Corbeille",
    "Deleted Items", "Deleted Messages",
    "INBOX.Trash",
]


def _resolve_trash_folder(conn: imaplib.IMAP4) -> Optional[str]:
    """Return the IMAP folder name to use as Trash, or None if none match."""
    typ, data = conn.list()
    if typ != "OK" or not data:
        return None
    available = []
    for raw in data:
        if raw is None:
            continue
        line = raw.decode("utf-8", errors="replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
        # IMAP LIST format: (\HasNoChildren) "/" "INBOX/Trash"
        # Take the last quoted segment, fall back to the last whitespace-separated token.
        if '"' in line:
            parts = line.split('"')
            name = parts[-2] if len(parts) >= 2 else line
        else:
            name = line.rsplit(" ", 1)[-1]
        available.append(name)
    for cand in _TRASH_CANDIDATES:
        if cand in available:
            return cand
    # Last-ditch case-insensitive substring match on common keywords.
    for name in available:
        low = name.lower()
        if "trash" in low or "corbeille" in low or "deleted" in low:
            return name
    return None


def move_to_trash_on_server(account: Dict, uid: str) -> bool:
    """Move the message to the account's Trash folder. Falls back to \\Deleted+EXPUNGE."""
    if not uid:
        return False
    try:
        conn = _make_connection(account)
        try:
            conn.select("INBOX")
            trash = _resolve_trash_folder(conn)
            moved = False
            if trash:
                try:
                    typ, _ = conn.uid("MOVE", uid.encode(), f'"{trash}"')
                    moved = typ == "OK"
                except imaplib.IMAP4.error:
                    moved = False
                if not moved:
                    # Some servers expose COPY+STORE+EXPUNGE rather than MOVE.
                    typ, _ = conn.uid("COPY", uid.encode(), f'"{trash}"')
                    if typ == "OK":
                        conn.uid("store", uid.encode(), "+FLAGS", "\\Deleted")
                        conn.expunge()
                        moved = True
            if not moved:
                conn.uid("store", uid.encode(), "+FLAGS", "\\Deleted")
                conn.expunge()
            logger.info(f"[{account['email']}] UID {uid} déplacé en corbeille")
            return True
        finally:
            try:
                conn.logout()
            except Exception:
                pass
    except Exception as e:
        logger.warning(f"[{account['email']}] Impossible de supprimer UID {uid}: {e}")
        return False


def set_flagged_on_server(account: Dict, uid: str, on: bool) -> bool:
    """Toggle the \\Flagged IMAP flag (used as the favourite/star marker)."""
    if not uid:
        return False
    op = "+FLAGS" if on else "-FLAGS"
    try:
        conn = _make_connection(account)
        conn.select("INBOX")
        conn.uid("store", uid.encode(), op, "\\Flagged")
        conn.logout()
        logger.info(f"[{account['email']}] UID {uid} {'favori' if on else 'non-favori'} sur le serveur")
        return True
    except Exception as e:
        logger.warning(f"[{account['email']}] Impossible de basculer le flag favori UID {uid}: {e}")
        return False


def batch_fetch_headers(account: Dict, uids: List[str], on_each=None) -> List[Dict]:
    """Re-fetch only the unsubscribe headers for a list of UIDs through a
    single IMAP connection. Uses BODY.PEEK so the \\Seen flag is preserved.

    `on_each(uid, ok, parsed)` streams per-UID progress (used to bump cleanup
    job counters). Returns a list of `{uid, list_unsubscribe,
    list_unsubscribe_post, unsubscribe_url, unsubscribe_mailto}` dicts —
    populated even when no header was present (NULL fields), so the caller
    can mark the row "checked" in the DB.
    """
    out: List[Dict] = []
    if not uids:
        return out
    from src.database import parse_list_unsubscribe

    try:
        conn = _make_connection(account)
        try:
            conn.select("INBOX", readonly=True)
            for uid in uids:
                ok = False
                lu_raw: Optional[str] = None
                lu_post: Optional[str] = None
                try:
                    status, data = conn.uid(
                        "fetch", uid.encode(),
                        "(BODY.PEEK[HEADER.FIELDS (LIST-UNSUBSCRIBE LIST-UNSUBSCRIBE-POST)])",
                    )
                    if status == "OK" and data and data[0]:
                        # data[0] is a tuple (response_meta, raw_headers_bytes)
                        if isinstance(data[0], tuple) and len(data[0]) >= 2:
                            raw = data[0][1]
                            if isinstance(raw, (bytes, bytearray)):
                                msg = email.message_from_bytes(bytes(raw))
                                lu_raw = msg.get("List-Unsubscribe")
                                lu_post = msg.get("List-Unsubscribe-Post")
                        ok = True
                except Exception as e:
                    logger.warning(f"[{account['email']}] header fetch UID {uid} failed: {e}")
                parsed = parse_list_unsubscribe(lu_raw, lu_post)
                row = {"uid": uid, **parsed}
                out.append(row)
                if on_each:
                    try:
                        on_each(uid, ok, row)
                    except Exception:
                        pass
        finally:
            try:
                conn.logout()
            except Exception:
                pass
    except Exception as e:
        logger.error(f"[{account['email']}] batch_fetch_headers connection failed: {e}")
        if on_each:
            for uid in uids:
                try:
                    on_each(uid, False, {"uid": uid})
                except Exception:
                    pass
    return out


def batch_scan_attachments(
    account: Dict,
    targets: List[Dict],
    policy: AttachmentPolicy,
    on_each=None,
) -> int:
    """Backfill attachments for legacy emails ingested before the PJ
    extraction was added.

    For each `target = {message_id, uid}`:
      • re-fetch the full RFC822 body via BODY.PEEK so the \\Seen flag stays
        untouched on the IMAP server (read-only select),
      • run `_extract_body` to get the attachment parts,
      • call `persist_attachments` to classify, store, and DB-record them,
      • stamp `attachments_scanned_at = now` so we never re-scan that row.

    `on_each(uid, ok, count)` streams progress to the caller (FastAPI job
    registry). Returns the number of UIDs processed (ok or not — counters
    add up to total either way).
    """
    if not targets:
        return 0
    from src import database as db

    processed = 0
    try:
        conn = _make_connection(account)
        try:
            conn.select("INBOX", readonly=True)
            for tgt in targets:
                uid = tgt.get("uid") or ""
                msg_id = tgt.get("message_id") or ""
                ok = False
                added = 0
                try:
                    status, data = conn.uid("fetch", uid.encode(), "(BODY.PEEK[])")
                    if status == "OK" and data and data[0]:
                        if isinstance(data[0], tuple) and len(data[0]) >= 2:
                            raw = data[0][1]
                            if isinstance(raw, (bytes, bytearray)):
                                msg = email.message_from_bytes(bytes(raw))
                                _, _, parts = _extract_body(msg)
                                if parts:
                                    saved = persist_attachments(
                                        message_id=msg_id,
                                        account_email=account["email"],
                                        parts=parts,
                                        policy=policy,
                                    )
                                    added = len(saved)
                                ok = True
                                # Always mark scanned, even when zero
                                # attachments — otherwise we'd re-scan
                                # plain-text mails forever.
                                db.mark_attachments_scanned(msg_id)
                except Exception as e:
                    logger.warning(
                        f"[{account['email']}] scan UID {uid} ({msg_id}): {e}"
                    )
                processed += 1
                if on_each:
                    try:
                        on_each(uid, ok, added)
                    except Exception:
                        pass
        finally:
            try:
                conn.logout()
            except Exception:
                pass
    except Exception as e:
        logger.error(
            f"[{account['email']}] batch_scan_attachments connection failed: {e}"
        )
        # Make sure progress completes even on connection failure.
        if on_each:
            for tgt in targets[processed:]:
                try:
                    on_each(tgt.get("uid", ""), False, 0)
                except Exception:
                    pass
    return processed


def unsubscribe_http(url: str, timeout_s: float = 5.0) -> Tuple[bool, int, str]:
    """Fire the RFC 8058 one-click POST. Returns (ok, status_code, error).

    The URL is attacker-controlled (it comes from the email headers),
    so we route through `safe_post` which:
      • refuses any non-http(s) scheme,
      • rejects hosts that resolve to private / loopback / link-local /
        multicast IPs (an attacker-controlled List-Unsubscribe URL
        targeting `192.168.1.1` or `127.0.0.1:<port>` would otherwise
        let us probe the user's home network or own private API),
      • follows up to 5 redirects manually, validating each Location
        the same way (auto-redirect would skip the check on hops),
      • treats 2xx/3xx final status as success — many providers
        redirect to a "you've unsubscribed" page after the POST.
    """
    if not url:
        return (False, 0, "empty url")
    from src.security.url_safety import safe_post
    return safe_post(
        url,
        data={"List-Unsubscribe": "One-Click"},
        headers={
            "User-Agent": "LullMail/1.0 (+https://github.com/alexiscrocilla/Lull-Mail)",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout=timeout_s,
    )


def batch_mark_seen(account: Dict, uids: List[str], on_each=None) -> List[bool]:
    """Mark a list of UIDs as \\Seen using a single IMAP connection.

    `on_each(uid, ok)` is invoked after each UID so callers can stream
    progress (job counters, UI updates…). Connection-level failures bubble
    up as a series of False results so the progress total stays accurate.
    """
    results = [False] * len(uids)
    if not uids:
        return results
    try:
        conn = _make_connection(account)
        try:
            conn.select("INBOX")
            for i, uid in enumerate(uids):
                try:
                    conn.uid("store", uid.encode(), "+FLAGS", "\\Seen")
                    results[i] = True
                except Exception as e:
                    logger.warning(f"[{account['email']}] mark_seen UID {uid} failed: {e}")
                if on_each:
                    try:
                        on_each(uid, results[i])
                    except Exception:
                        pass
        finally:
            try:
                conn.logout()
            except Exception:
                pass
    except Exception as e:
        logger.error(f"[{account['email']}] batch_mark_seen connection failed: {e}")
        if on_each:
            for uid in uids:
                try:
                    on_each(uid, False)
                except Exception:
                    pass
    return results


def batch_move_to_trash(account: Dict, uids: List[str], on_each=None) -> List[bool]:
    """Move a list of UIDs to the account's Trash using a single connection.

    Resolves the trash folder once per batch instead of once per message.
    Falls back to COPY+\\Deleted+EXPUNGE for servers without MOVE, then to
    \\Deleted+EXPUNGE in-place if neither is supported.
    """
    results = [False] * len(uids)
    if not uids:
        return results
    try:
        conn = _make_connection(account)
        try:
            conn.select("INBOX")
            trash = _resolve_trash_folder(conn)
            for i, uid in enumerate(uids):
                ok = False
                try:
                    if trash:
                        try:
                            typ, _ = conn.uid("MOVE", uid.encode(), f'"{trash}"')
                            ok = typ == "OK"
                        except imaplib.IMAP4.error:
                            ok = False
                        if not ok:
                            typ, _ = conn.uid("COPY", uid.encode(), f'"{trash}"')
                            if typ == "OK":
                                conn.uid("store", uid.encode(), "+FLAGS", "\\Deleted")
                                conn.expunge()
                                ok = True
                    if not ok:
                        conn.uid("store", uid.encode(), "+FLAGS", "\\Deleted")
                        conn.expunge()
                        ok = True
                except Exception as e:
                    logger.warning(f"[{account['email']}] move-to-trash UID {uid} failed: {e}")
                    ok = False
                results[i] = ok
                if on_each:
                    try:
                        on_each(uid, ok)
                    except Exception:
                        pass
        finally:
            try:
                conn.logout()
            except Exception:
                pass
    except Exception as e:
        logger.error(f"[{account['email']}] batch_move_to_trash connection failed: {e}")
        if on_each:
            for uid in uids:
                try:
                    on_each(uid, False)
                except Exception:
                    pass
    return results


def _extract_uidvalidity(conn: imaplib.IMAP4) -> Optional[str]:
    """Read RFC 3501 UIDVALIDITY from untagged SELECT response or STATUS command."""
    try:
        typ, data = conn.response("UIDVALIDITY")
        if typ == "OK" and data and data[0]:
            val = data[0]
            if isinstance(val, bytes):
                return val.decode().strip()
            return str(val).strip()
    except Exception:
        pass
    try:
        if hasattr(conn, "untagged_responses") and "UIDVALIDITY" in conn.untagged_responses:
            val = conn.untagged_responses["UIDVALIDITY"]
            if val and val[0]:
                item = val[0]
                if isinstance(item, bytes):
                    return item.decode().strip()
                return str(item).strip()
    except Exception:
        pass
    try:
        typ, data = conn.status("INBOX", "(UIDVALIDITY)")
        if typ == "OK" and data and data[0]:
            raw = data[0].decode() if isinstance(data[0], bytes) else str(data[0])
            m = re.search(r"UIDVALIDITY\s+(\d+)", raw, re.IGNORECASE)
            if m:
                return m.group(1)
    except Exception:
        pass
    return None


def _parse_flags(raw_resp: Any) -> Tuple[bool, bool]:
    """Parse (is_read, is_favourite) from IMAP FETCH response metadata."""
    txt = str(raw_resp)
    is_seen = "\\Seen" in txt or "\\seen" in txt.lower()
    is_flagged = "\\Flagged" in txt or "\\flagged" in txt.lower()
    return is_seen, is_flagged


_UID_RE = re.compile(rb"\bUID (\d+)")


def _parse_fetch_items(msg_data: Any, default_uid: Optional[bytes] = None) -> List[Tuple[bytes, bytes, str]]:
    """Flatten a FETCH response — one or many messages — into
    ``(uid, raw_bytes, metadata_text)`` triples.

    imaplib returns ``[(meta, literal), b')', (meta, literal), b')', …]``
    and sometimes splits attributes that follow the literal (typically
    ``FLAGS``) into a bare bytes item; those are glued back onto the
    message they belong to so flag parsing sees them.
    """
    items: List[List[Any]] = []
    for part in msg_data or ():
        if isinstance(part, tuple) and len(part) >= 2 and isinstance(part[1], (bytes, bytearray)):
            meta = part[0] if isinstance(part[0], (bytes, bytearray)) else str(part[0]).encode()
            m = _UID_RE.search(bytes(meta))
            uid = m.group(1) if m else (default_uid or b"")
            items.append([uid, bytes(part[1]), bytes(meta).decode("utf-8", "replace")])
        elif isinstance(part, (bytes, bytearray)) and items:
            items[-1][2] += bytes(part).decode("utf-8", "replace")
    return [(u, r, m) for u, r, m in items if u]


def hydrate_email_bodies(
    account: Dict,
    targets: List[Dict],
    policy: AttachmentPolicy,
    on_each=None,
) -> int:
    """Hydrate full body (text + html) and attachments for emails in envelope state."""
    if not targets:
        return 0
    from src import database as db
    from src import threader
    from src.auth_results import parse_email as _parse_auth
    from json import dumps as _json_dumps
    from src.database import parse_list_unsubscribe

    processed = 0
    try:
        conn = _make_connection(account)
        try:
            conn.select("INBOX", readonly=True)
            for tgt in targets:
                uid = tgt.get("uid") or ""
                msg_id = tgt.get("message_id") or ""
                if not uid or not msg_id:
                    continue
                try:
                    status, data = conn.uid("fetch", uid.encode(), "(BODY.PEEK[])")
                    if status != "OK" or not data or not data[0]:
                        db.mark_email_body_failed(msg_id, "IMAP fetch empty response")
                        continue
                    raw = data[0][1] if isinstance(data[0], tuple) else None
                    if not isinstance(raw, (bytes, bytearray)):
                        db.mark_email_body_failed(msg_id, "IMAP fetch invalid raw bytes")
                        continue

                    try:
                        msg = email.message_from_bytes(bytes(raw))
                    except Exception as e:
                        db.mark_email_body_failed(msg_id, f"MIME parse failed: {e}")
                        continue

                    body_text, body_html, parts = _extract_body(msg)

                    if parts and policy.enabled:
                        try:
                            persist_attachments(
                                message_id=msg_id,
                                account_email=account["email"],
                                parts=parts,
                                policy=policy,
                            )
                        except Exception as e:
                            logger.warning(f"[{account['email']}] persist_attachments crashed for {msg_id}: {e}")

                    lu_raw = msg.get("List-Unsubscribe")
                    lu_post = msg.get("List-Unsubscribe-Post")
                    parsed_lu = parse_list_unsubscribe(lu_raw, lu_post)

                    auth_dict = _parse_auth(msg)
                    auth_json = _json_dumps(auth_dict) if any(auth_dict.values()) else None

                    in_reply_to = "".join((msg.get("In-Reply-To") or "").split()) or None
                    references = (msg.get("References") or "").strip() or None
                    norm_subject = threader.normalize_subject(_decode_header(msg.get("Subject", "")))
                    thread_id = None
                    with db._conn() as con:
                        thread_id = threader.resolve_thread_id(
                            con,
                            message_id=msg_id,
                            in_reply_to=in_reply_to,
                            references=references,
                            norm_subject=norm_subject,
                            account=account["email"],
                            date_iso=tgt.get("date_received_iso"),
                        )

                    db.update_email_body_hydrated(
                        message_id=msg_id,
                        body_text=body_text,
                        body_html=body_html,
                        list_unsubscribe=parsed_lu.get("list_unsubscribe"),
                        list_unsubscribe_post=parsed_lu.get("list_unsubscribe_post"),
                        unsubscribe_url=parsed_lu.get("unsubscribe_url"),
                        unsubscribe_mailto=parsed_lu.get("unsubscribe_mailto"),
                        auth_results=auth_json,
                        in_reply_to=in_reply_to,
                        references=references,
                        normalized_subject=norm_subject,
                        thread_id=thread_id,
                    )
                    processed += 1
                    if on_each:
                        try:
                            on_each(uid, True, len(parts))
                        except Exception:
                            pass
                except Exception as e:
                    logger.warning(f"[{account['email']}] hydrate UID {uid} ({msg_id}): {e}")
                    db.mark_email_body_failed(msg_id, str(e))
        finally:
            try:
                conn.logout()
            except Exception:
                pass
    except Exception as e:
        logger.error(f"[{account['email']}] hydrate_email_bodies connection failed: {e}")
        # The claim flipped these rows to 'hydrating'; give them back so the
        # next pass (or the next account that answers) can pick them up
        # instead of leaving them invisible to the analysis forever.
        try:
            db.release_hydration_claims([t.get("message_id") for t in targets if t.get("message_id")])
        except Exception:  # noqa: BLE001
            pass
    return processed


def hydrate_single_email(
    account: Dict,
    email_row: Dict,
    policy: AttachmentPolicy,
) -> bool:
    """Synchronously hydrate a single email row when opened by the user."""
    return hydrate_email_bodies(account, [email_row], policy) > 0


def fetch_emails(
    account: Dict,
    last_uid: Optional[str] = None,
    known_uidvalidity: Optional[str] = None,
    limit: int = 50,
    attachment_policy: Optional[AttachmentPolicy] = None,
    envelope_only: bool = True,
    on_chunk=None,
    chunk_size: int = 20,
    fetch_batch: int = 50,
) -> Tuple[List[Dict], Optional[str], Optional[str], bool]:
    """Fetch emails for *account*.

    Returns ``(results, error, server_uidvalidity, uidvalidity_changed)`` where
    *error* is ``None`` on success and a short human-readable string when a
    connection-level failure occurred.

    *on_chunk*, when given, is called from this thread every *chunk_size*
    parsed messages (and once more with the remainder) with a dict
    ``{"emails": [...], "server_uidvalidity": …, "uidvalidity_changed": …}``
    so the caller can persist progressively. Headers are requested
    *fetch_batch* UIDs per round-trip; servers that refuse the grouped form
    fall back to one FETCH per message.
    """
    results: List[Dict] = []
    server_uidvalidity: Optional[str] = None
    uidvalidity_changed = False
    try:
        conn = _make_connection(account)
        conn.select("INBOX", readonly=True)

        server_uidvalidity = _extract_uidvalidity(conn)
        if known_uidvalidity and server_uidvalidity and known_uidvalidity != server_uidvalidity:
            logger.warning(
                f"[{account['email']}] UIDVALIDITY changé ({known_uidvalidity} -> {server_uidvalidity}), "
                "réinitialisation du curseur"
            )
            uidvalidity_changed = True
            last_uid = None

        if last_uid:
            try:
                next_uid = int(last_uid) + 1
                status, data = conn.uid("search", None, f"UID {next_uid}:*")
                if not (data and data[0] and data[0].strip()):
                    s2, d2 = conn.uid("search", None, f"UID {last_uid}:{last_uid}")
                    uid_still_exists = bool(d2 and d2[0] and d2[0].strip())
                    if not uid_still_exists:
                        logger.warning(
                            f"[{account['email']}] UID {last_uid} absent du serveur — "
                            "réinitialisation des UIDs détectée, fallback sur ALL"
                        )
                        status, data = conn.uid("search", None, "ALL")
            except ValueError:
                status, data = conn.uid("search", None, "ALL")
        else:
            status, data = conn.uid("search", None, "ALL")

        if status != "OK" or not data or not data[0]:
            conn.logout()
            return results, None, server_uidvalidity, uidvalidity_changed

        uids = [u for u in data[0].split() if u]
        if not uids:
            conn.logout()
            return results, None, server_uidvalidity, uidvalidity_changed

        if len(uids) > limit:
            uids = uids[-limit:]

        # ── Streaming: hand finished envelopes to the caller every
        # `chunk_size` messages so the inbox fills while the fetch runs.
        pending_chunk: List[Dict] = []

        def _flush_chunk(force: bool = False) -> None:
            if on_chunk is None or not pending_chunk:
                return
            if not force and len(pending_chunk) < chunk_size:
                return
            batch = list(pending_chunk)
            pending_chunk.clear()
            try:
                on_chunk({
                    "emails": batch,
                    "server_uidvalidity": server_uidvalidity,
                    "uidvalidity_changed": uidvalidity_changed,
                })
            except Exception as e:  # noqa: BLE001 — a consumer bug must not abort the fetch
                logger.warning(f"[{account['email']}] on_chunk a échoué : {e}")

        # ── Batched FETCH: one round-trip per `fetch_batch` UIDs instead of
        # one per message (500 messages → 10 round-trips). Servers that
        # reject the grouped form fall back to the per-message path below.
        prefetched: Dict[bytes, Tuple[bytes, str]] = {}
        if envelope_only and fetch_batch > 1 and len(uids) > 1:
            for start in range(0, len(uids), fetch_batch):
                batch_uids = uids[start:start + fetch_batch]
                try:
                    status, msg_data = conn.uid(
                        "fetch", b",".join(batch_uids), "(UID FLAGS BODY.PEEK[HEADER])"
                    )
                except imaplib.IMAP4.abort:
                    raise
                except Exception as e:  # noqa: BLE001 — grouped form refused
                    logger.info(f"[{account['email']}] FETCH groupé refusé ({e}), repli message par message")
                    break
                if status != "OK" or not msg_data:
                    break
                for uid_b, raw_b, meta in _parse_fetch_items(msg_data):
                    prefetched[uid_b] = (raw_b, meta)

        for uid in uids:
            try:
                is_read, is_fav = False, False
                raw = None
                hit = prefetched.pop(uid, None)
                if hit is not None:
                    raw, meta = hit
                    is_read, is_fav = _parse_flags(meta)
                else:
                    if envelope_only:
                        status, msg_data = conn.uid("fetch", uid, "(FLAGS BODY.PEEK[HEADER])")
                        if status != "OK" or not msg_data or not msg_data[0]:
                            # Fallback to full fetch if server rejects partial fetch
                            status, msg_data = conn.uid("fetch", uid, "(RFC822)")
                    else:
                        status, msg_data = conn.uid("fetch", uid, "(RFC822)")

                    if status != "OK" or not msg_data or not msg_data[0]:
                        continue

                    for part in msg_data:
                        if isinstance(part, tuple) and len(part) >= 2 and isinstance(part[1], (bytes, bytearray)):
                            raw = bytes(part[1])
                            is_read, is_fav = _parse_flags(part[0])
                            break
                        elif isinstance(part, bytes):
                            is_read, is_fav = _parse_flags(part)

                if raw is None:
                    continue

                try:
                    msg = email.message_from_bytes(raw)
                except Exception as e:
                    logger.warning(f"[{account['email']}] Header parse failed for UID {uid}: {e}")
                    continue

                subject = _decode_header(msg.get("Subject", "(Sans objet)"))
                sender = _decode_header(msg.get("From", ""))
                recipient = _decode_header(msg.get("To", ""))
                date_str = msg.get("Date", "")
                message_id = (msg.get("Message-ID") or "").strip()
                if not message_id:
                    message_id = _fallback_id(uid.decode(), account["email"], subject)

                in_reply_to = "".join((msg.get("In-Reply-To") or "").split()) or None
                references = (msg.get("References") or "").strip() or None

                from src.database import parse_list_unsubscribe
                lu_raw = msg.get("List-Unsubscribe")
                lu_post = msg.get("List-Unsubscribe-Post")
                parsed_lu = parse_list_unsubscribe(lu_raw, lu_post)

                from src.auth_results import parse_email as _parse_auth
                from json import dumps as _json_dumps
                auth_dict = _parse_auth(msg)
                auth_json = _json_dumps(auth_dict) if any(auth_dict.values()) else None

                if envelope_only:
                    body_text, body_html, attachment_parts = "", "", []
                    body_state = "envelope"
                else:
                    body_text, body_html, attachment_parts = _extract_body(msg)
                    body_state = "full"

                results.append({
                    "uid": uid.decode(),
                    "message_id": message_id,
                    "account": account["email"],
                    "subject": subject,
                    "sender": sender,
                    "recipient": recipient,
                    "date_str": date_str,
                    "body_text": body_text,
                    "body_html": body_html,
                    "body_state": body_state,
                    "is_read": is_read,
                    "is_favourite": is_fav,
                    "list_unsubscribe": parsed_lu["list_unsubscribe"],
                    "list_unsubscribe_post": parsed_lu["list_unsubscribe_post"],
                    "unsubscribe_url": parsed_lu["unsubscribe_url"],
                    "unsubscribe_mailto": parsed_lu["unsubscribe_mailto"],
                    "auth_results": auth_json,
                    "in_reply_to": in_reply_to,
                    "references": references,
                    "_attachment_parts": attachment_parts,
                })
                pending_chunk.append(results[-1])
                _flush_chunk()
            except Exception as e:
                logger.warning(f"[{account['email']}] UID {uid} skipped: {e}")

        _flush_chunk(force=True)
        conn.logout()
        return results, None, server_uidvalidity, uidvalidity_changed

    except imaplib.IMAP4.error as e:
        msg = f"IMAP error: {e}"
        logger.error(f"[{account['email']}] {msg}")
        return results, msg, server_uidvalidity, uidvalidity_changed
    except OSError as e:
        msg = f"Connection error: {e}"
        logger.error(f"[{account['email']}] {msg}")
        return results, msg, server_uidvalidity, uidvalidity_changed
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        logger.error(f"[{account['email']}] Unexpected error: {msg}")
        return results, msg, server_uidvalidity, uidvalidity_changed

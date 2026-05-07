import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from dateutil import parser as dateparser

from src import config as cfg
from src import database as db
from src.ai_processor import init_client, process_email, enrich_draft
from src.attachment_security import policy_from_config
from src.email_fetcher import fetch_emails, persist_attachments
from src.local_classifier import classify as local_classify, extract_domain
from src.notifier import send

logger = logging.getLogger(__name__)


def _is_too_old(date_str: str, max_age_days: int) -> bool:
    if not date_str or max_age_days <= 0:
        return False
    try:
        dt = dateparser.parse(date_str)
        if dt is None:
            return False
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        age = datetime.now(timezone.utc) - dt
        return age.days > max_age_days
    except Exception:
        return False

_running = False
_last_sync: Optional[str] = None


def get_last_sync() -> Optional[str]:
    return _last_sync


def run_sync():
    global _running, _last_sync
    if _running:
        logger.info("Sync déjà en cours, ignoré.")
        return

    _running = True
    try:
        conf = cfg.get()
        api_key = (conf.get("openai") or {}).get("api_key", "")
        ai_on = bool(api_key)
        if ai_on:
            init_client(api_key)

        accounts = [a for a in conf.get("accounts", []) if a.get("enabled", True)]
        limit = conf.get("polling", {}).get("initial_fetch_count", 100)
        model = conf.get("openai", {}).get("model", "gpt-4o-mini")
        ntfy = conf.get("ntfy", {})
        min_score = ntfy.get("min_importance", 7)
        ntfy_ok = bool(ntfy.get("topic") and not str(ntfy.get("topic", "")).startswith("TODO"))
        att_policy = policy_from_config(conf)

        total_new = 0
        for acc in accounts:
            logger.info(f"→ Sync {acc['email']} ...")
            state = db.get_sync_state(acc["email"])
            last_uid = state["last_uid"] if state else None

            emails, fetch_error = fetch_emails(acc, last_uid=last_uid, limit=limit)

            if fetch_error:
                db.set_sync_error(acc["email"], fetch_error)
                logger.warning(f"[{acc['email']}] Erreur enregistrée : {fetch_error}")
                continue

            new, max_uid = [], last_uid

            # Detect UID regression: server reset UIDs (mailbox migration).
            # When ALL fetched UIDs are below our stored last_uid, the old
            # value would never be updated, causing new emails to be missed
            # forever. Reset max_uid so we track the actual server max.
            if emails and last_uid:
                try:
                    max_fetched = max(int(em["uid"]) for em in emails)
                    if max_fetched < int(last_uid):
                        logger.warning(
                            f"[{acc['email']}] Régression d'UID détectée "
                            f"(server max={max_fetched} < last_uid={last_uid}), "
                            "réinitialisation du curseur."
                        )
                        max_uid = None
                except (ValueError, TypeError):
                    pass

            for em in emails:
                if not db.email_exists(em["message_id"]):
                    db.insert_email(em)
                    new.append(em)
                    # Attachments are persisted only the FIRST time we see
                    # the message — re-syncs of an existing UID never write
                    # duplicate files. Failures are logged but never fatal:
                    # the email still lands in the inbox even if PJ
                    # extraction explodes.
                    parts = em.get("_attachment_parts") or []
                    if parts and att_policy.enabled:
                        try:
                            persist_attachments(
                                message_id=em["message_id"],
                                account_email=em["account"],
                                parts=parts,
                                policy=att_policy,
                            )
                        except Exception as e:
                            logger.warning(
                                f"[{em['account']}] persist_attachments "
                                f"crashed for {em['message_id']}: {e}"
                            )
                try:
                    uid_int = int(em["uid"])
                    max_int = int(max_uid) if max_uid else 0
                    if uid_int > max_int:
                        max_uid = em["uid"]
                except (ValueError, TypeError):
                    pass

            db.update_sync_state(acc["email"], last_uid=max_uid)
            logger.info(f"   {len(new)} nouveau(x)")
            total_new += len(new)

        # Traitement AI des emails en attente
        max_age_days = conf.get("polling", {}).get("max_age_days", 30)
        pending = db.get_pending_emails(limit=30)

        to_process = []
        skipped = 0
        for em in pending:
            if _is_too_old(em.get("date_received", ""), max_age_days):
                db.skip_old_email(em["message_id"])
                skipped += 1
            else:
                to_process.append(em)

        if skipped:
            logger.info(f"   {skipped} email(s) trop ancien(s) ignorés (>{max_age_days}j)")
        logger.info(f"Traitement AI : {len(to_process)} email(s) en attente...")

        local_hits = 0
        cache_hits = 0
        ai_calls   = 0

        for em in to_process:
            result = None

            # ── Niveau 1 : règles locales (0 token) ───────────────────────────
            result = local_classify(em)
            if result:
                local_hits += 1

            # ── Niveau 2 : mémoisation domaine expéditeur (0 token) ───────────
            if result is None:
                domain = extract_domain(em.get("sender", "") or "")
                if domain:
                    cached_cat = db.get_sender_category(domain)
                    if cached_cat and cached_cat not in ("important", "other"):
                        # Only trust cached category for low-value types;
                        # "important" / "other" are too broad to skip AI.
                        result = {
                            "category": cached_cat,
                            "importance_score": 2 if cached_cat == "newsletter" else 3,
                            "importance_reason": f"Domaine {domain} connu ({cached_cat})",
                            "summary": "",
                            "needs_reply": False,
                            "draft_response": None,
                            "tokens_in": 0,
                            "tokens_out": 0,
                            "local_classified": True,
                        }
                        cache_hits += 1

            # ── Niveau 3 : IA classification (body réduit à 800 cars.) ─────────
            # In no-AI mode we fabricate a neutral result so the email still
            # lands in the inbox with a predictable category/score. The user
            # has explicitly opted out — no GPT call must happen here.
            if result is None and not ai_on:
                result = {
                    "category": "other",
                    "importance_score": 5,
                    "importance_reason": "Non classé (mode sans IA)",
                    "summary": "",
                    "needs_reply": False,
                    "draft_response": None,
                    "tokens_in": 0,
                    "tokens_out": 0,
                    "local_classified": True,
                }

            if result is None:
                result = process_email(em, model=model)
                if result:
                    ai_calls += 1
                    # Apprendre le domaine pour les prochains emails
                    domain = extract_domain(em.get("sender", "") or "")
                    if domain and result.get("category") not in ("important", "other", None):
                        db.set_sender_category(domain, result["category"])
                else:
                    # AI call failed — track attempts; after 3 give up to unblock the queue.
                    attempts = db.increment_ai_attempts(em["message_id"])
                    if attempts >= 3:
                        db.mark_ai_failed(em["message_id"])
                        skipped += 1
                    continue

            # Niveau 4 (brouillon IA) supprimé : généré à la demande via /api/emails/{id}/draft

            if not result:
                continue

            db.update_email_ai(em["message_id"], result)

            if (
                ntfy_ok
                and result.get("importance_score", 0) >= min_score
                and not em.get("is_notified")
            ):
                payload = {**em, **result, "account_email": em["account_email"]}
                if send(payload, server=ntfy["server"], topic=ntfy["topic"]):
                    db.mark_notified(em["message_id"])

        logger.info(
            f"   Classification : {local_hits} règles locales, "
            f"{cache_hits} cache domaine, {ai_calls} appels IA"
        )

        from datetime import datetime
        _last_sync = datetime.now().strftime("%H:%M:%S")
        logger.info(f"Sync terminée. {total_new} nouveau(x) email(s).")

    except Exception as e:
        logger.error(f"Erreur sync : {e}", exc_info=True)
    finally:
        _running = False


def is_running() -> bool:
    return _running

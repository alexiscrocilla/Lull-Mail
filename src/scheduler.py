# SPDX-License-Identifier: GPL-3.0-or-later
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from typing import Optional

from dateutil import parser as dateparser

from src import config as cfg
from src import database as db
from src import injection_guard
from src import draft_verify
from src.ai_processor import init_client, process_email, enrich_draft
from src.attachment_security import policy_from_config
from src.email_fetcher import fetch_emails, persist_attachments
from src.local_classifier import classify as local_classify, extract_domain
from src.notifier import send

logger = logging.getLogger(__name__)


# Importance_reason value written by the no-AI fallback below. Used as the
# match key by db.requeue_emails_by_reason so a later AI-on sync can
# re-queue these emails for real analysis. Keep in sync with the literal
# in the fabricated result dict.
NO_AI_FALLBACK_REASON = "Non classé (mode sans IA)"


def _neutral_result(category: str, score: int, reason: str, summary: str = "") -> dict:
    """No-token classification result for the non-LLM paths (local cache hit,
    per-account AI off, injection-flagged, no-AI mode). Single source of truth
    for the result contract consumed by db.update_email_ai."""
    return {
        "category": category,
        "importance_score": score,
        "importance_reason": reason,
        "summary": summary,
        "needs_reply": False,
        "draft_response": None,
        "tokens_in": 0,
        "tokens_out": 0,
        "local_classified": True,
    }


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
        provider = (conf.get("llm") or {}).get("provider", "openai")
        # `cfg.ai_enabled()` comprend les deux providers : OpenAI (clé non
        # vide) ET local (GGUF analyzer présent sur disque). Avant ce fix
        # on testait uniquement `bool(api_key)`, donc en mode local le
        # scheduler tombait dans le fallback no-AI et les emails étaient
        # marqués "Non classé" sans jamais être soumis au LLM local —
        # le bouton "Analyse" du dashboard ne faisait rien d'utile.
        ai_on = cfg.ai_enabled()
        if ai_on:
            # init_client n'est nécessaire que pour OpenAI ; en mode local
            # l'AnalyzerServer a déjà été démarré par lifecycle au boot
            # (ou par /api/llm/activate après un switch de provider).
            if provider == "openai":
                api_key = (conf.get("openai") or {}).get("api_key", "")
                init_client(api_key)
            # Re-queue any emails that were classified by the no-AI
            # fallback during a prior run. They were marked as 'other'
            # to keep them visible in the inbox, but the user has now
            # enabled AI — give them a real classification.
            requeued = db.requeue_emails_by_reason(NO_AI_FALLBACK_REASON)
            if requeued:
                logger.info(
                    f"{requeued} email(s) classés en mode sans IA "
                    "remis en file pour analyse IA"
                )

        accounts = [a for a in conf.get("accounts", []) if a.get("enabled", True)]
        limit = conf.get("polling", {}).get("initial_fetch_count", 500)
        model = conf.get("openai", {}).get("model", "gpt-4o-mini")
        ntfy = conf.get("ntfy", {})
        min_score = ntfy.get("min_importance", 7)
        ntfy_ok = bool(ntfy.get("topic") and not str(ntfy.get("topic", "")).startswith("TODO"))
        att_policy = policy_from_config(conf)

        # ── Phase réseau : fetch IMAP de tous les comptes EN PARALLÈLE ────
        # fetch_emails() ouvre sa propre connexion IMAP et ne touche pas la DB
        # (il renvoie une liste) → parallélisable sans risque. On ne parallélise
        # QUE le réseau ; toutes les écritures DB restent sur le thread principal
        # (phase suivante) pour éviter toute contention SQLite.
        fetch_workers = int(conf.get("polling", {}).get("fetch_workers", 4))
        jobs = []  # (acc, last_uid)
        for acc in accounts:
            state = db.get_sync_state(acc["email"])
            jobs.append((acc, state["last_uid"] if state else None))

        # Keyed by job INDEX, not email: two accounts that share an email
        # address (hand-edited config) must not collapse into one result.
        fetched = {}  # index -> (emails, error)
        if jobs:
            with ThreadPoolExecutor(max_workers=min(fetch_workers, len(jobs))) as ex:
                futs = {
                    ex.submit(fetch_emails, acc, last_uid=luid, limit=limit): idx
                    for idx, (acc, luid) in enumerate(jobs)
                }
                for fut in as_completed(futs):
                    idx = futs[fut]
                    try:
                        fetched[idx] = fut.result()
                    except Exception as e:  # noqa: BLE001 — isolate per-account
                        fetched[idx] = ([], f"{type(e).__name__}: {e}")

        # ── Phase DB : traitement séquentiel (toutes les écritures ici) ───
        total_new = 0
        for idx, (acc, last_uid) in enumerate(jobs):
            logger.info(f"→ Sync {acc['email']} ...")
            emails, fetch_error = fetched.get(idx, ([], "aucun résultat"))

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
        ai_batch = int(conf.get("polling", {}).get("ai_batch_size", 200))
        injection_mode = ((conf.get("security") or {}).get("injection_scan") or {}).get("mode", "hybrid")
        # Per-account AI profiles (P1.2/P1.3), keyed by email address.
        profiles = {a["email"]: a for a in accounts}
        pending = db.get_pending_emails(limit=ai_batch)

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
            acc_profile = profiles.get(em.get("account_email")) or {}
            # Injection verdict from the classification phase — reused by the
            # auto-draft gate so the same body is never scanned twice.
            injection_verdict = None

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
                        result = _neutral_result(
                            cached_cat,
                            2 if cached_cat == "newsletter" else 3,
                            f"Domaine {domain} connu ({cached_cat})",
                        )
                        cache_hits += 1

            # ── Niveau 2.6 : IA désactivée pour CE compte (P1.2) ──────────────
            # Garde les règles locales gratuites mais n'appelle jamais le LLM.
            if result is None and acc_profile.get("ai_account_enabled") is False:
                result = _neutral_result("other", 5, "IA désactivée pour ce compte")

            # ── Niveau 2.5 : scan anti-injection avant tout appel LLM ─────────
            # Un corps hostile ne doit jamais atteindre le modèle. Fail-OPEN :
            # un scan non vérifiable (LLM indispo) ne signale PAS — on classe.
            if result is None and ai_on and injection_mode != "off":
                injection_verdict = injection_guard.scan(
                    em.get("body_text", "") or "", injection_mode)
                if injection_verdict["injection"]:
                    db.flag_injection(em["message_id"], injection_verdict["reason"])
                    result = _neutral_result(
                        "other", 4, "Contenu suspect — analyse IA ignorée",
                        "⚠ Email potentiellement malveillant (injection détectée).")

            # ── Niveau 3 : IA classification (body réduit à 800 cars.) ─────────
            # In no-AI mode we fabricate a neutral result so the email still
            # lands in the inbox with a predictable category/score. The user
            # has explicitly opted out — no LLM call must happen here.
            if result is None and not ai_on:
                result = _neutral_result("other", 5, NO_AI_FALLBACK_REASON)

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

            if not result:
                continue

            # ── Auto-draft opt-in par compte (P1.3) ───────────────────────────
            # Pré-rédige une réponse pour les mails qui attendent une réponse et
            # dépassent le seuil du compte. JAMAIS envoyé. Enrichit `result`
            # AVANT update_email_ai pour persister brouillon + tokens en une
            # passe. Seuil 0/absent hérite du global.
            acc_threshold = acc_profile.get("ai_importance_threshold") or min_score
            auto_drafted = False
            if (
                acc_profile.get("auto_draft")
                and ai_on
                and result.get("needs_reply")
                and result.get("importance_score", 0) >= acc_threshold
            ):
                # Reuse the classification-phase verdict; only scan here if the
                # email skipped that phase. Fail-CLOSED: never draft on a flagged
                # OR unverified body.
                v = injection_verdict
                if v is None:
                    v = injection_guard.scan(em.get("body_text", "") or "", injection_mode)
                if not v["injection"] and not v.get("unverified"):
                    enrich_draft(em, result, model=model)  # fills result + tokens
                    if result.get("draft_response"):
                        result["draft_response"] = draft_verify.verify_draft(
                            result["draft_response"], model=model)
                        auto_drafted = True

            db.update_email_ai(em["message_id"], result)
            if auto_drafted:
                db.mark_auto_draft(em["message_id"])

            if (
                ntfy_ok
                and result.get("importance_score", 0) >= acc_threshold
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

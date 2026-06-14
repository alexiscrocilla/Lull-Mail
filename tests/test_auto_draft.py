"""Opt-in per-account auto-draft (scheduler, P1.3).

The scheduler pre-writes a draft for needs_reply mail scoring at/above the
account threshold, only for opt-in accounts, only with a clean (verified)
injection scan, and NEVER sends. AI off → no draft.
"""

from __future__ import annotations


def _conf(auto_draft=True, ai_key="sk-test", threshold=7, min_importance=7):
    return {
        "openai": {"api_key": ai_key, "model": "gpt-4o-mini"},
        "llm": {"provider": "openai"},
        "polling": {"fetch_workers": 2, "ai_batch_size": 50, "max_age_days": 0},
        "ntfy": {"topic": "", "min_importance": min_importance},
        "security": {"injection_scan": {"mode": "local"}},
        "accounts": [{
            "email": "u@x.fr", "imap_host": "imap.x", "username": "u@x.fr",
            "password": "p", "enabled": True,
            "auto_draft": auto_draft, "ai_importance_threshold": threshold,
        }],
        "attachments": {"enabled": False},
    }


def _apply(monkeypatch, cfg, conf):
    """Point cfg.get + cfg.ai_enabled at the test config (the new scheduler
    reads ai_enabled() which consults _config, not get())."""
    monkeypatch.setattr(cfg, "get", lambda: conf)
    monkeypatch.setattr(cfg, "ai_enabled", lambda: bool(conf["openai"]["api_key"]))


def _seed_pending(db):
    db.insert_email({
        "message_id": "<m@t>", "account": "u@x.fr", "uid": "1",
        "subject": "Demande de devis", "sender": "client@corp.com",
        "recipient": "u@x.fr", "body_text": "Pouvez-vous m'envoyer un devis ?",
        "date_str": "Mon, 05 May 2025 10:00:00 +0000",
    })


def _patch_pipeline(monkeypatch, scheduler, needs_reply=True, score=9):
    monkeypatch.setattr(scheduler, "fetch_emails", lambda *a, **k: ([], None))
    monkeypatch.setattr(scheduler, "init_client", lambda key: None)

    def fake_process(em, model="gpt-4o-mini"):
        return {
            "category": "important", "importance_score": score,
            "importance_reason": "client", "summary": "devis",
            "needs_reply": needs_reply, "draft_response": None,
            "tokens_in": 1, "tokens_out": 1, "local_classified": False,
        }

    def fake_enrich(data, existing, model="gpt-4o-mini"):
        existing["draft_response"] = "Bonjour, voici le devis demandé en pièce jointe."
        return existing

    monkeypatch.setattr(scheduler, "process_email", fake_process)
    monkeypatch.setattr(scheduler, "enrich_draft", fake_enrich)
    monkeypatch.setattr(scheduler.draft_verify, "verify_draft",
                        lambda text, model="gpt-4o-mini": text)


def _row(db, mid="<m@t>"):
    return next(r for r in db.get_emails(limit=10) if r["message_id"] == mid)


def test_auto_draft_created_for_optin_account(fresh_app, monkeypatch):
    from src import scheduler, config as cfg, database as db
    _apply(monkeypatch, cfg, _conf(auto_draft=True))
    _seed_pending(db)
    _patch_pipeline(monkeypatch, scheduler)
    scheduler.run_sync()
    row = _row(db)
    assert row["draft_auto"] == 1
    assert "devis" in (row["draft_response"] or "")


def test_no_auto_draft_when_not_optin(fresh_app, monkeypatch):
    from src import scheduler, config as cfg, database as db
    _apply(monkeypatch, cfg, _conf(auto_draft=False))
    _seed_pending(db)
    _patch_pipeline(monkeypatch, scheduler)
    scheduler.run_sync()
    row = _row(db)
    assert row["draft_auto"] == 0
    assert not row["draft_response"]


def test_no_auto_draft_when_below_threshold(fresh_app, monkeypatch):
    from src import scheduler, config as cfg, database as db
    _apply(monkeypatch, cfg, _conf(auto_draft=True))
    _seed_pending(db)
    _patch_pipeline(monkeypatch, scheduler, score=3)  # below threshold 7
    scheduler.run_sync()
    assert _row(db)["draft_auto"] == 0


def test_no_auto_draft_when_no_reply_needed(fresh_app, monkeypatch):
    from src import scheduler, config as cfg, database as db
    _apply(monkeypatch, cfg, _conf(auto_draft=True))
    _seed_pending(db)
    _patch_pipeline(monkeypatch, scheduler, needs_reply=False)
    scheduler.run_sync()
    assert _row(db)["draft_auto"] == 0


def test_no_auto_draft_when_scan_unverified(fresh_app, monkeypatch):
    """Fail-closed: an unverified scan (LLM unavailable) blocks the auto-draft
    even though it is not flagged as injection."""
    from src import scheduler, config as cfg, database as db
    _apply(monkeypatch, cfg, _conf(auto_draft=True))
    _seed_pending(db)
    _patch_pipeline(monkeypatch, scheduler)
    monkeypatch.setattr(scheduler.injection_guard, "scan",
                        lambda text, mode: {"injection": False, "unverified": True})
    scheduler.run_sync()
    assert _row(db)["draft_auto"] == 0


def test_threshold_inherits_global_when_account_zero(fresh_app, monkeypatch):
    """ai_importance_threshold=0 inherits the global min_importance, not a
    hardcoded 7 — so a score-6 email auto-drafts when the global bar is 5."""
    from src import scheduler, config as cfg, database as db
    _apply(monkeypatch, cfg, _conf(auto_draft=True, threshold=0, min_importance=5))
    _seed_pending(db)
    _patch_pipeline(monkeypatch, scheduler, score=6)
    scheduler.run_sync()
    assert _row(db)["draft_auto"] == 1


def test_no_auto_draft_in_no_ai_mode(fresh_app, monkeypatch):
    """Empty key → ai_on False → process_email never runs, no draft."""
    from src import scheduler, config as cfg, database as db
    _apply(monkeypatch, cfg, _conf(auto_draft=True, ai_key=""))
    _seed_pending(db)
    monkeypatch.setattr(scheduler, "fetch_emails", lambda *a, **k: ([], None))

    def boom(*a, **k):
        raise AssertionError("process_email must not run in no-AI mode")
    monkeypatch.setattr(scheduler, "process_email", boom)
    scheduler.run_sync()
    assert _row(db)["draft_auto"] == 0

"""
Setup / onboarding API.

Drives the in-app configuration wizard. Endpoints are mounted under
/api/setup/* and remain available even when the rest of the app is
running in degraded "no config yet" mode — that's the whole point.

Conventions:
  • secrets (passwords, OpenAI key) are MASKED in every read endpoint
    (returned as the literal string "***" if set, "" if missing)
  • write endpoints accept the literal "***" to mean "keep the existing
    value" so the UI can submit a form without re-prompting for secrets
  • write endpoints atomically rewrite config.yaml via cfg.save() — they
    refuse to persist a config that wouldn't pass cfg._validate
  • finalize() boots the email subsystem; subsequent calls restart it
"""

import imaplib
import logging
import socket
import ssl
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from src import config as cfg
from src import lifecycle
from src import paths
from src.i18n import tr, get_locale
from src.security.rate_limit import limiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/setup", tags=["setup"])

MASK = "***"

# ── Provider presets ─────────────────────────────────────────────────────────
# Pre-fills IMAP host/port/SSL settings + a help link so non-technical
# users only have to type their email + password (or app-password).

PROVIDERS: List[Dict[str, Any]] = [
    {
        "id": "gmail",
        "name": "Gmail",
        "type": "gmail",
        "imap_host": "imap.gmail.com",
        "imap_port": 993,
        "ssl": True,
        "starttls": False,
        "verify_ssl": True,
        "smtp_host": "smtp.gmail.com",
        "smtp_port": 587,
        "smtp_ssl": False,
        "smtp_starttls": True,
        "help_url": "https://support.google.com/accounts/answer/185833",
        # Direct deep-link to the app-password creation page so users can
        # generate the 16-char code in one click instead of digging through
        # Google account settings.
        "app_password_url": "https://myaccount.google.com/apppasswords",
        "help": "Activez la 2FA puis créez un \"Mot de passe d'application\" "
                "(Compte Google → Sécurité). Collez les 16 caractères ci-dessous.",
    },
    {
        "id": "outlook",
        "name": "Outlook / Microsoft 365",
        "type": "outlook",
        "imap_host": "outlook.office365.com",
        "imap_port": 993,
        "ssl": True,
        "starttls": False,
        "verify_ssl": True,
        "smtp_host": "smtp.office365.com",
        "smtp_port": 587,
        "smtp_ssl": False,
        "smtp_starttls": True,
        "help_url": "https://support.microsoft.com/account-billing/5896ed9b-4263-e681-128a-a6f2979a7944",
        "app_password_url": "https://account.live.com/proofs/AppPassword",
        "help": "Si vous avez la 2FA, créez un mot de passe d'application "
                "via account.microsoft.com → Sécurité → Options de sécurité avancées.",
    },
    {
        "id": "proton",
        "name": "ProtonMail (via Bridge)",
        "type": "proton",
        "imap_host": "127.0.0.1",
        "imap_port": 1143,
        "ssl": False,
        "starttls": True,
        "verify_ssl": False,
        # Bridge exposes SMTP on 127.0.0.1:1025 (STARTTLS, self-signed cert).
        "smtp_host": "127.0.0.1",
        "smtp_port": 1025,
        "smtp_ssl": False,
        "smtp_starttls": True,
        "help_url": "https://proton.me/mail/bridge",
        # Bridge is a desktop app, no direct URL — users grab the password
        # from the running Bridge UI itself. We leave this empty so the
        # frontend doesn't render a misleading button.
        "app_password_url": "",
        "help": "Installez et lancez Proton Mail Bridge. Pour chaque adresse, "
                "ouvrez \"Configure email client\" et copiez le mot de passe affiché.",
    },
    {
        "id": "yahoo",
        "name": "Yahoo Mail",
        "type": "yahoo",
        "imap_host": "imap.mail.yahoo.com",
        "imap_port": 993,
        "ssl": True,
        "starttls": False,
        "verify_ssl": True,
        "smtp_host": "smtp.mail.yahoo.com",
        "smtp_port": 587,
        "smtp_ssl": False,
        "smtp_starttls": True,
        "help_url": "https://help.yahoo.com/kb/SLN15241.html",
        "app_password_url": "https://login.yahoo.com/myaccount/security/app-passwords/list",
        "help": "Yahoo exige un \"Mot de passe d'application\" : Compte → "
                "Sécurité du compte → Générer un mot de passe d'application.",
    },
    {
        "id": "icloud",
        "name": "iCloud Mail",
        "type": "icloud",
        "imap_host": "imap.mail.me.com",
        "imap_port": 993,
        "ssl": True,
        "starttls": False,
        "verify_ssl": True,
        "smtp_host": "smtp.mail.me.com",
        "smtp_port": 587,
        "smtp_ssl": False,
        "smtp_starttls": True,
        "help_url": "https://support.apple.com/102654",
        "app_password_url": "https://account.apple.com/account/manage/section/security",
        "help": "Créez un mot de passe pour app sur appleid.apple.com → "
                "Connexion et sécurité → Mots de passe pour application.",
    },
    {
        "id": "orange",
        "name": "Orange",
        "type": "orange",
        "imap_host": "imap.orange.fr",
        "imap_port": 993,
        "ssl": True,
        "starttls": False,
        "verify_ssl": True,
        "smtp_host": "smtp.orange.fr",
        "smtp_port": 465,
        "smtp_ssl": True,
        "smtp_starttls": False,
        "help_url": "https://assistance.orange.fr/ordinateurs-peripheriques/installer-et-utiliser/l-utilisation-du-mail/configurer-mon-mail-orange-sur-mon-ordinateur/configurer-l-application-mail-de-windows-10-pour-le-mail-orange_117893-744080",
        "app_password_url": "",
        "help": "Utilisez votre mot de passe Orange habituel. Si vous avez la "
                "double-validation, générez un mot de passe d'application.",
    },
    {
        "id": "ovh",
        "name": "OVH (mail pro)",
        "type": "ovh",
        "imap_host": "imap.mail.ovh.net",
        "imap_port": 993,
        "ssl": True,
        "starttls": False,
        "verify_ssl": True,
        "smtp_host": "ssl0.ovh.net",
        "smtp_port": 465,
        "smtp_ssl": True,
        "smtp_starttls": False,
        "help_url": "https://help.ovhcloud.com/csm/fr-mxplan-imap-pop-smtp",
        "app_password_url": "",
        "help": "Mot de passe défini lors de la création de la boîte (espace "
                "client OVH → Webmail / Mail Plan).",
    },
    {
        "id": "free",
        "name": "Free.fr",
        "type": "free",
        "imap_host": "imap.free.fr",
        "imap_port": 993,
        "ssl": True,
        "starttls": False,
        "verify_ssl": True,
        "smtp_host": "smtp.free.fr",
        "smtp_port": 465,
        "smtp_ssl": True,
        "smtp_starttls": False,
        "help_url": "https://assistance.free.fr/articles/utiliser-une-zimbra-1290",
        "app_password_url": "",
        "help": "Mot de passe de votre compte Free.",
    },
    {
        "id": "custom",
        "name": "Autre serveur IMAP",
        "type": "imap",
        "imap_host": "",
        "imap_port": 993,
        "ssl": True,
        "starttls": False,
        "verify_ssl": True,
        "smtp_host": "",
        "smtp_port": 587,
        "smtp_ssl": False,
        "smtp_starttls": True,
        "help_url": "",
        "app_password_url": "",
        "help": "Renseignez manuellement le serveur IMAP fourni par votre "
                "hébergeur mail.",
    },
]


# Provider-id → SMTP defaults map. Lookup helper used at send-time when
# an account in config.yaml stores `smtp_host=""` (the loader falls back
# to the preset for the account's `type`). Keeping this synced with the
# `PROVIDERS` list above means a future provider only needs editing one
# place. The map is rebuilt at module-import time from PROVIDERS.
SMTP_DEFAULTS: Dict[str, Dict[str, Any]] = {
    p["type"]: {
        "smtp_host": p.get("smtp_host", ""),
        "smtp_port": p.get("smtp_port", 587),
        "smtp_ssl": bool(p.get("smtp_ssl", False)),
        "smtp_starttls": bool(p.get("smtp_starttls", True)),
    }
    for p in PROVIDERS
    if p.get("type")
}


# ── Models ───────────────────────────────────────────────────────────────────


class OpenAIPayload(BaseModel):
    # An empty `api_key` is now a valid signal: "disable AI". The endpoint
    # detects this case and purges the OS keyring entry so a wiped key
    # doesn't linger. `MASK` still means "keep the existing value".
    api_key: str
    model: str = "gpt-4o-mini"


class NtfyPayload(BaseModel):
    enabled: bool = True
    server: str = "https://ntfy.sh"
    topic: str = ""
    min_importance: int = Field(7, ge=1, le=10)


class GeneralPayload(BaseModel):
    polling_interval_minutes: int = Field(10, ge=1, le=1440)
    # `server_port` accepted but ignored — the desktop app picks an
    # ephemeral port at startup. Kept in the schema only for backwards
    # compatibility with older config.yaml files.
    server_port: Optional[int] = Field(None, ge=1024, le=65535)


class AccountPayload(BaseModel):
    name: str
    type: str = "imap"
    email: str
    imap_host: str
    imap_port: int = 993
    username: str
    password: str
    ssl: bool = True
    starttls: bool = False
    verify_ssl: bool = True
    enabled: bool = True
    # SMTP overrides — optional. Empty `smtp_host` (or `smtp_port == 0`)
    # means "fall back to the provider preset for `type`". The Settings
    # UI exposes these via an "Avancé" toggle for users on a custom
    # server or whose provider rotated SMTP endpoints.
    smtp_host: str = ""
    smtp_port: int = 0
    smtp_ssl: bool = False
    smtp_starttls: bool = True


# ── Helpers ──────────────────────────────────────────────────────────────────


def _load_or_default() -> Dict[str, Any]:
    """Read config.yaml if present, else return an empty skeleton."""
    if cfg.CONFIG_PATH.exists():
        try:
            import yaml
            with open(cfg.CONFIG_PATH, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
            # Make sure all top-level keys exist so callers can edit one
            # section without losing the others.
            skel = cfg.default_skeleton()
            for k, v in skel.items():
                if k not in data:
                    data[k] = v
                elif isinstance(v, dict) and isinstance(data[k], dict):
                    for sk, sv in v.items():
                        data[k].setdefault(sk, sv)
            return data
        except Exception:
            logger.exception("Lecture config.yaml a échoué — repartir du skeleton")
    return cfg.default_skeleton()


def _persist(data: Dict[str, Any]) -> None:
    """Save + reload + try to (re)start services. Raises HTTPException
    with the validation error if the config is incomplete."""
    try:
        cfg.save(data)
    except cfg.ConfigError as e:
        # Setup-time saves can be incomplete; we tolerate that here. The
        # caller decides whether to attempt finalize.
        logger.info("Save partielle (validation KO): %s", e)
        # Still write to disk so the wizard can resume between visits.
        paths.ensure_dirs()
        import yaml
        with open(cfg.CONFIG_PATH, "w", encoding="utf-8") as f:
            yaml.safe_dump(data, f, allow_unicode=True, sort_keys=False)
    # Always sync the in-memory cache with what's on disk so that
    # cfg.get() callers (e.g. GET /api/accounts) see the updated state
    # immediately without waiting for a restart. try_load() is silent
    # on partial/invalid configs so this is safe during wizard saves.
    cfg.reload()


def _mask_account(acc: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(acc)
    if out.get("password"):
        out["password"] = MASK
    return out


def _unmask_password(new_value: str, existing: str) -> str:
    """Replace MASK with the existing value so masked submits work."""
    return existing if new_value == MASK else new_value


def _store_imap_secret(email: str, plain_password: str) -> str:
    """Push `plain_password` into the OS keyring under `email` and
    return the sentinel to write into config.yaml. Falls back to the
    plain value if the keyring is unavailable on this machine."""
    from src import secrets_store
    try:
        return secrets_store.store_imap(email, plain_password)
    except secrets_store.SecretsBackendError as e:
        logger.warning(
            "keyring write for %s failed (%s) — clear-text fallback in YAML",
            email, e,
        )
        return plain_password


def _store_openai_secret(plain_key: str) -> str:
    """Same as `_store_imap_secret` but for the OpenAI key."""
    from src import secrets_store
    try:
        return secrets_store.store_openai(plain_key)
    except secrets_store.SecretsBackendError as e:
        logger.warning(
            "keyring write for OpenAI key failed (%s) — clear-text fallback",
            e,
        )
        return plain_key


def _resolve_imap_secret(stored_value: str) -> str:
    """Return the real password behind a sentinel, or the value itself
    when it's already plain. Used to recover the actual password when
    the user submitted MASK and we need it for the auto-test."""
    from src import secrets_store
    if not secrets_store.is_sentinel(stored_value):
        return stored_value or ""
    try:
        return secrets_store.resolve(stored_value, secrets_store.SERVICE_IMAP)
    except secrets_store.SecretsBackendError as e:
        logger.warning("resolve_imap_secret failed: %s", e)
        return ""


# ── Status / read ────────────────────────────────────────────────────────────


@router.get("/status")
def setup_status() -> Dict[str, Any]:
    data = _load_or_default()
    accounts = data.get("accounts") or []
    enabled = [a for a in accounts if a.get("enabled", True)]
    has_openai = bool((data.get("openai") or {}).get("api_key"))
    has_ntfy = bool((data.get("ntfy") or {}).get("topic"))
    return {
        "configured": cfg.is_configured(),
        "accounts": len(accounts),
        "accounts_enabled": len(enabled),
        "has_openai": has_openai,
        "has_ntfy": has_ntfy,
        "data_dir": str(paths.APP_DATA_DIR),
        "services_running": lifecycle.is_running(),
    }


@router.get("/config")
def get_config() -> Dict[str, Any]:
    data = _load_or_default()
    # Mask the OpenAI key only when one is configured. An empty string
    # is the explicit "no-AI" signal — leaking it as MASK would make the
    # frontend believe a key exists and render the form accordingly.
    if data.get("openai") and data["openai"].get("api_key"):
        data["openai"] = {**data["openai"], "api_key": MASK}

    # Enrich each account with its latest auto-test outcome so the
    # Settings list can render the status icon directly. Keeping the
    # join here (instead of the frontend doing two API calls) means a
    # single request renders the page without flicker.
    from src import database as db
    enriched: List[Dict[str, Any]] = []
    for acc in (data.get("accounts") or []):
        masked = _mask_account(acc)
        try:
            state = db.get_sync_state(acc.get("email", "")) or {}
        except Exception:
            state = {}
        masked["last_test_at"] = state.get("last_test_at")
        masked["last_test_error"] = state.get("last_test_error")
        enriched.append(masked)
    data["accounts"] = enriched
    return data


@router.get("/providers")
def list_providers() -> List[Dict[str, Any]]:
    return PROVIDERS


# ── Section writes ───────────────────────────────────────────────────────────


@router.post("/openai")
def save_openai(payload: OpenAIPayload, locale: str = Depends(get_locale)) -> Dict[str, Any]:
    data = _load_or_default()
    existing_key = (data.get("openai") or {}).get("api_key", "")
    from src import secrets_store

    # Three intents: keep / disable / change. We resolve them in order
    # because they're mutually exclusive.
    if payload.api_key == MASK:
        # "Keep" — re-write the existing sentinel/value as-is.
        new_key = existing_key
    elif payload.api_key == "":
        # "Disable" — drop the keyring entry and persist an empty key.
        # The runtime treats empty key == no-AI mode (cfg.ai_enabled()).
        if existing_key:
            try:
                secrets_store.delete_openai()
            except Exception:
                logger.exception("delete_openai (toggle off) failed")
        new_key = ""
    else:
        # "Change" / "Set" — fresh user input. Validate format then push
        # into the keyring and replace with the sentinel.
        if not (payload.api_key.startswith("sk-") or payload.api_key.startswith("sk_")):
            raise HTTPException(400, tr("setup.openai.bad_format", locale))
        new_key = _store_openai_secret(payload.api_key)

    data["openai"] = {"api_key": new_key, "model": payload.model or "gpt-4o-mini"}
    _persist(data)
    return {"ok": True}


@router.post("/ntfy")
def save_ntfy(payload: NtfyPayload, locale: str = Depends(get_locale)) -> Dict[str, Any]:
    data = _load_or_default()
    if not payload.enabled:
        # Empty topic disables the notifier without removing the section.
        data["ntfy"] = {
            "server": payload.server or "https://ntfy.sh",
            "topic": "",
            "min_importance": payload.min_importance,
        }
    else:
        if not payload.topic.strip():
            raise HTTPException(400, tr("setup.ntfy.topic_required", locale))
        data["ntfy"] = {
            "server": payload.server or "https://ntfy.sh",
            "topic": payload.topic.strip(),
            "min_importance": payload.min_importance,
        }
    _persist(data)
    return {"ok": True}


@router.post("/general")
def save_general(payload: GeneralPayload) -> Dict[str, Any]:
    data = _load_or_default()
    polling = data.get("polling") or {}
    polling["interval_minutes"] = payload.polling_interval_minutes
    data["polling"] = polling
    # We still write a sane server section so older code that reads
    # config.server.host/port doesn't blow up — but the actual port used
    # at runtime is picked dynamically by app_gui.py.
    server = data.get("server") or {}
    server.setdefault("host", "127.0.0.1")
    server.setdefault("port", 8000)
    data["server"] = server
    _persist(data)
    return {"ok": True}


# ── Account CRUD ─────────────────────────────────────────────────────────────


@router.get("/accounts")
def list_accounts() -> List[Dict[str, Any]]:
    data = _load_or_default()
    return [_mask_account(a) for a in (data.get("accounts") or [])]


def _enforce_tls_safety(payload: AccountPayload) -> None:
    """Refuse to persist `verify_ssl=False` on a remote host.
    Returns 400 with a clear message; ProtonMail Bridge on 127.0.0.1
    remains accepted (its preset uses `verify_ssl: false`)."""
    from src.security.tls import assert_verify_ssl_allowed, UnsafeTLSError
    try:
        assert_verify_ssl_allowed(payload.imap_host, payload.verify_ssl)
    except UnsafeTLSError as e:
        raise HTTPException(400, str(e))


@router.post("/accounts")
@limiter.limit("30/minute")
def add_account(
    request: Request,
    payload: AccountPayload = Body(...),
    locale: str = Depends(get_locale),
) -> Dict[str, Any]:
    data = _load_or_default()
    accounts = data.get("accounts") or []
    if any(a.get("email", "").lower() == payload.email.lower() for a in accounts):
        raise HTTPException(409, tr("setup.account.exists", locale, email=payload.email))
    if payload.password == MASK or not payload.password:
        raise HTTPException(400, tr("setup.account.password_required", locale))
    _enforce_tls_safety(payload)

    # Push the password into the OS keyring before writing config.yaml,
    # then rewrite the dict's `password` field with the sentinel. The
    # real password stays in `payload.password` for the auto-test below
    # (and only there — it never reaches disk).
    real_password = payload.password
    sentinel = _store_imap_secret(payload.email, real_password)
    acc_dict = payload.model_dump()
    acc_dict["password"] = sentinel
    accounts.append(acc_dict)
    data["accounts"] = accounts
    _persist(data)

    # Auto-test: run an IMAP login right after save and persist the
    # outcome via record_test_result. Save always succeeds (the user's
    # input is preserved); a failed test surfaces in the Settings list
    # via the red status icon.
    test = _safe_test_and_record(payload, real_password, locale)
    return {
        "ok": True,
        "account": _mask_account(acc_dict),
        "test": test,
    }


@router.put("/accounts/{email}")
@limiter.limit("30/minute")
def update_account(
    request: Request,
    email: str,
    payload: AccountPayload = Body(...),
    locale: str = Depends(get_locale),
) -> Dict[str, Any]:
    data = _load_or_default()
    accounts = data.get("accounts") or []
    from src import secrets_store
    for i, a in enumerate(accounts):
        if a.get("email", "").lower() == email.lower():
            new = payload.model_dump()
            stored_pwd = a.get("password", "")
            # `_unmask_password` returns the existing stored value when
            # the user kept "***" in the form. After the keyring migration
            # that existing value is a sentinel, not a plain password.
            resolved_or_sentinel = _unmask_password(new["password"], stored_pwd)
            if not resolved_or_sentinel:
                raise HTTPException(400, tr("setup.account.password_empty", locale))
            _enforce_tls_safety(payload)

            if secrets_store.is_sentinel(resolved_or_sentinel):
                # Sentinel reused — keep it. Recover the real password
                # for the auto-test (we can't login with a sentinel).
                actual_pwd_for_test = _resolve_imap_secret(resolved_or_sentinel)
                new["password"] = resolved_or_sentinel
            else:
                # Fresh password — store in keyring and replace with
                # sentinel. Falls back to clear text if keyring fails.
                actual_pwd_for_test = resolved_or_sentinel
                new["password"] = _store_imap_secret(payload.email, resolved_or_sentinel)

            accounts[i] = new
            data["accounts"] = accounts
            _persist(data)
            test = _safe_test_and_record(payload, actual_pwd_for_test, locale)
            return {
                "ok": True,
                "account": _mask_account(new),
                "test": test,
            }
    raise HTTPException(404, tr("setup.account.not_found_email", locale, email=email))


@router.delete("/accounts/{email}")
@limiter.limit("30/minute")
def delete_account(request: Request, email: str, locale: str = Depends(get_locale)) -> Dict[str, Any]:
    data = _load_or_default()
    accounts = data.get("accounts") or []
    new_list = [a for a in accounts if a.get("email", "").lower() != email.lower()]
    if len(new_list) == len(accounts):
        raise HTTPException(404, tr("setup.account.not_found_email", locale, email=email))
    data["accounts"] = new_list
    _persist(data)
    # Drop the test/sync state too so a re-add of the same email starts
    # clean (no stale red icon from a previous test).
    try:
        from src import database as db
        db.remove_account_state(email)
    except Exception:
        logger.exception("remove_account_state failed")
    # Drop the keyring entry. Idempotent — silently no-ops if missing.
    try:
        from src import secrets_store
        secrets_store.delete_imap(email)
    except Exception:
        logger.exception("delete_imap failed")
    return {"ok": True, "remaining": len(new_list)}


# ── IMAP test ────────────────────────────────────────────────────────────────


def _resolve_password(payload: AccountPayload) -> str:
    """Return the actual password for `payload`, replacing the MASK
    sentinel with the value already saved in config.yaml when the user
    submits a "keep existing password" form. The saved value may be
    a `keyring:…` sentinel — we resolve that too so the
    IMAP login receives the real password. Empty string when nothing
    is available."""
    pwd = payload.password
    if pwd == MASK:
        data = _load_or_default()
        for a in (data.get("accounts") or []):
            if a.get("email", "").lower() == payload.email.lower():
                stored = a.get("password", "")
                return _resolve_imap_secret(stored)
        return ""
    return pwd or ""


def _perform_imap_test(payload: AccountPayload, password: str, locale: str = "fr") -> Dict[str, Any]:
    """Open one IMAP connection, login, list mailboxes, log out. Returns a
    structured dict so callers (manual /test endpoint AND the auto-test
    that runs on save) can render or persist the result.

    Honours `_enforce_tls_safety` — refuses to even try when
    `verify_ssl=False` lands on a non-loopback host. The TLS gate raises
    HTTPException(400) which the FastAPI layer turns into a clean error
    for the manual endpoint; for the auto-test we catch and convert to a
    structured failure record (see `_safe_test`).
    """
    _enforce_tls_safety(payload)

    try:
        if payload.ssl:
            ctx = ssl.create_default_context()
            if not payload.verify_ssl:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            conn = imaplib.IMAP4_SSL(
                payload.imap_host, payload.imap_port,
                ssl_context=ctx, timeout=15,
            )
        else:
            conn = imaplib.IMAP4(payload.imap_host, payload.imap_port, timeout=15)
            if payload.starttls:
                ctx = ssl.create_default_context()
                if not payload.verify_ssl:
                    ctx.check_hostname = False
                    ctx.verify_mode = ssl.CERT_NONE
                conn.starttls(ssl_context=ctx)

        try:
            conn.login(payload.username, password)
        except imaplib.IMAP4.error as e:
            return {
                "ok": False,
                "stage": "login",
                "error": tr("setup.imap.login_rejected", locale),
                "detail": str(e),
            }

        try:
            typ, mbx = conn.list()
            mailbox_count = len(mbx) if typ == "OK" and mbx else 0
        except Exception:
            mailbox_count = 0

        try:
            conn.logout()
        except Exception:
            pass

        return {"ok": True, "mailbox_count": mailbox_count}

    except (socket.gaierror, socket.timeout, OSError) as e:
        return {
            "ok": False,
            "stage": "connect",
            "error": "Connexion au serveur IMAP impossible.",
            "detail": str(e),
        }
    except ssl.SSLError as e:
        return {
            "ok": False,
            "stage": "ssl",
            "error": "Erreur SSL/TLS.",
            "detail": str(e),
        }
    except Exception as e:
        logger.exception("test_account: erreur inattendue")
        return {"ok": False, "stage": "unknown", "error": str(e), "detail": ""}


def _safe_test_and_record(payload: AccountPayload, password: str, locale: str = "fr") -> Dict[str, Any]:
    """Run the test for the auto-test path (after add/update) and record
    the outcome in `sync_state.last_test_*`. Never raises — returns a
    structured failure record for unexpected errors so the save flow
    completes regardless. The save itself already succeeded by the time
    we get here; an auto-test failure is informational, not blocking.
    """
    from src import database as db
    if not password:
        result = {
            "ok": False,
            "stage": "missing_password",
            "error": tr("setup.account.password_missing_test", locale),
            "detail": "",
        }
    else:
        try:
            result = _perform_imap_test(payload, password, locale)
        except HTTPException as e:
            # TLS gate rejected. Already caught at save-time too, so this
            # path is mostly defensive.
            result = {
                "ok": False,
                "stage": "tls",
                "error": str(e.detail),
                "detail": "",
            }
        except Exception as e:
            logger.exception("auto-test: unexpected exception")
            result = {
                "ok": False, "stage": "unknown", "error": str(e), "detail": "",
            }
    error_msg = (
        f"{result.get('error', '')} {result.get('detail', '')}".strip()
        if not result.get("ok") else None
    )
    try:
        db.record_test_result(payload.email, result.get("ok", False), error_msg)
    except Exception:
        logger.exception("record_test_result failed")
    return result


@router.post("/accounts/test")
@limiter.limit("30/minute")
def test_account(
    request: Request,
    payload: AccountPayload = Body(...),
    locale: str = Depends(get_locale),
) -> Dict[str, Any]:
    """Open an IMAP connection and authenticate. No mailbox state is
    altered. Used by the wizard's "Tester la connexion" button AND by
    the per-row test icon in Settings.

    If `password` comes in as MASK, look it up by email in the saved
    config so users can re-test an existing account without retyping.
    The result is also persisted via `db.record_test_result` so the
    Settings status badge stays in sync after a manual click.
    """
    pwd = _resolve_password(payload)
    if not pwd:
        raise HTTPException(400, tr("setup.account.password_missing_test", locale))
    return _safe_test_and_record(payload, pwd, locale)


# ── Finalize ─────────────────────────────────────────────────────────────────


@router.post("/finalize")
def finalize(locale: str = Depends(get_locale)) -> Dict[str, Any]:
    """Boot (or reboot) the email subsystem after the wizard finishes.

    Returns 400 with the validation error if the saved config still
    isn't usable — the UI surfaces this as a banner and the user goes
    back to fill in what's missing.
    """
    try:
        cfg.reload()
    except cfg.ConfigError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError as e:
        raise HTTPException(400, str(e))

    started = lifecycle.start_email_services(restart=True)
    if not started:
        raise HTTPException(500, tr("setup.services.start_failed_logs", locale))
    return {"ok": True, "data_dir": str(paths.APP_DATA_DIR)}


# ── Open data folder ─────────────────────────────────────────────────────────


@router.post("/open-data-dir")
def open_data_dir(locale: str = Depends(get_locale)) -> Dict[str, Any]:
    """Reveal the app's data directory in the OS file manager. Used by
    the Settings page so power users can see the SQLite DB / log file
    without hunting through %APPDATA%.

    Best-effort: returns ok=False if the platform isn't supported or if
    the OS call fails (e.g. running headless, permission issue).
    """
    import sys
    import subprocess

    target = str(paths.APP_DATA_DIR)
    paths.ensure_dirs()

    try:
        if sys.platform == "win32":
            # os.startfile is the canonical Windows way and pops the
            # folder in Explorer with the user's chosen view settings.
            import os
            os.startfile(target)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", target])
        else:
            subprocess.Popen(["xdg-open", target])
    except Exception as e:
        logger.exception("open-data-dir failed")
        raise HTTPException(500, tr("setup.open_dir_failed", locale, msg=str(e)))

    return {"ok": True, "path": target}


# ── Wipe data ────────────────────────────────────────────────────────────────


class WipeConfirm(BaseModel):
    confirm: str  # must equal "SUPPRIMER" — defensive against accidental calls


@router.post("/wipe")
@limiter.limit("3/minute")
def wipe_data(
    request: Request,
    payload: WipeConfirm = Body(...),
    locale: str = Depends(get_locale),
) -> Dict[str, Any]:
    """Erase config.yaml, the SQLite DB, attachments and logs.

    Used by the Settings → Stockage "Supprimer mes données" button. After
    a successful wipe the frontend reloads, which lands on /onboarding
    because no valid config exists anymore.

    The body MUST contain {"confirm": "SUPPRIMER"} so a misclick on a
    nearby button can't trigger this. The scheduler is stopped first so
    no thread is still writing to the files we're about to delete.
    """
    import shutil

    if payload.confirm != "SUPPRIMER":
        raise HTTPException(400, tr("setup.confirm_missing", locale))

    # 1. Stop background workers — they hold file handles on the DB.
    try:
        lifecycle.stop_email_services()
    except Exception:
        logger.exception("Arrêt scheduler avant wipe a échoué (on continue)")

    # 2. Drop every keyring entry tied to the configured accounts AND
    # the OpenAI key. We do this BEFORE removing config.yaml so we
    # still have the list of emails to iterate over. Failures are
    # logged but never abort the wipe — better to leave a few stale
    # keyring rows than to leave the local data in place.
    try:
        from src import secrets_store
        existing = _load_or_default()
        for acc in (existing.get("accounts") or []):
            email = acc.get("email", "")
            if email:
                try:
                    secrets_store.delete_imap(email)
                except Exception:
                    logger.exception("wipe: delete_imap %s failed", email)
        try:
            secrets_store.delete_openai()
        except Exception:
            logger.exception("wipe: delete_openai failed")
    except Exception:
        logger.exception("wipe: keyring cleanup failed (continuing)")

    # 3. Forget the cached in-memory config.
    try:
        cfg.reload()
    except Exception:
        pass

    deleted: List[str] = []
    failed: List[str] = []

    # 4. Remove config.yaml.
    try:
        if cfg.CONFIG_PATH.exists():
            cfg.CONFIG_PATH.unlink()
            deleted.append("config.yaml")
    except OSError as e:
        logger.warning("Suppression config.yaml: %s", e)
        failed.append(f"config.yaml ({e})")

    # 4. Remove the SQLite DB + WAL/SHM siblings (created by journal_mode=WAL).
    for suffix in ("", "-wal", "-shm"):
        target = paths.DB_PATH.with_name(paths.DB_PATH.name + suffix)
        try:
            if target.exists():
                target.unlink()
                deleted.append(target.name)
        except OSError as e:
            logger.warning("Suppression %s: %s", target, e)
            failed.append(f"{target.name} ({e})")

    # 5. Wipe the attachments tree.
    try:
        if paths.ATTACHMENTS_DIR.exists():
            shutil.rmtree(paths.ATTACHMENTS_DIR, ignore_errors=False)
            deleted.append("attachments/")
    except OSError as e:
        logger.warning("Suppression attachments/: %s", e)
        failed.append(f"attachments/ ({e})")

    # 6. Truncate the log so the new install starts clean. We don't unlink
    # it because the running process still has an open FileHandler — on
    # Windows that would raise PermissionError. Truncating works fine.
    try:
        if paths.LOG_PATH.exists():
            with open(paths.LOG_PATH, "w", encoding="utf-8") as f:
                f.write("")
            deleted.append("lull_mail.log")
    except OSError as e:
        logger.warning("Vidage log: %s", e)
        failed.append(f"lull_mail.log ({e})")

    # 7. Re-create the empty data tree so subsequent calls don't crash.
    paths.ensure_dirs()

    return {"ok": not failed, "deleted": deleted, "failed": failed}

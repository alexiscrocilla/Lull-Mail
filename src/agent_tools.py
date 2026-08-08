"""Shared email-tool layer — pure functions over the DB, consumed by BOTH
the OpenAI agent loop (src/agent.py) and the local MCP server
(src/mcp_server.py).

Mirrors agentic-inbox's design where ``workers/lib/tools.ts`` is shared
between the Agent and the MCP server. Read-centred and draft-only: there
is deliberately NO send tool — Lull Mail never sends on the user's behalf.

Email bodies surfaced to the model are scanned for prompt injection and
returned as data, never trusted as instructions.
"""

from typing import Optional

from src import database as db
from src.search_query import parse_search_query

# Folders an email may be moved into. Built-ins mirror api._BUILTIN_FOLDERS;
# custom folders are merged in at call time. Used to validate move_email so
# the agent can't strand a message in a non-existent folder.
_BUILTIN_FOLDERS = {"inbox", "deleted", "sent", "draft"}


def _meta(row: dict) -> dict:
    """Compact metadata for list/search results (no body)."""
    return {
        "int_id": row.get("int_id"),
        "subject": row.get("subject"),
        "sender": row.get("sender"),
        "recipient": row.get("recipient"),
        # Which of the user's accounts received it — the "source" mailbox,
        # useful in multi-account answers.
        "account": row.get("account_email"),
        "date": row.get("date_received_iso") or row.get("date_received"),
        "is_read": bool(row.get("is_read")),
        "category": row.get("category"),
        "importance_score": row.get("importance_score"),
        "needs_reply": bool(row.get("needs_reply")),
        "thread_id": row.get("thread_id"),
        "folder": row.get("folder"),
    }


# ── tools ───────────────────────────────────────────────────────────

def list_emails(account: Optional[str] = None, folder: str = "inbox",
                limit: int = 20) -> dict:
    rows = db.get_emails(account=account, folder=folder, limit=min(int(limit), 50))
    return {"emails": [_meta(r) for r in rows]}


def get_email(int_id: int) -> dict:
    row = db.get_email_by_id(int(int_id))
    if not row:
        return {"error": "Email introuvable"}
    out = _meta(row)
    out["body_text"] = (row.get("body_text") or "")[:4000]
    out["summary"] = row.get("summary")
    # Surface the verdict already computed + persisted at ingest by the
    # scheduler — don't re-scan on every read (avoids extra cost and a
    # fail-closed flag when this process has no OpenAI client, e.g. MCP).
    out["injection_suspected"] = bool(row.get("injection_flag"))
    return out


def get_thread(int_id: int) -> dict:
    row = db.get_email_by_id(int(int_id))
    if not row:
        return {"error": "Email introuvable"}
    thread_id = row.get("thread_id") or row.get("message_id")
    msgs = db.get_thread(thread_id)
    return {
        "thread_id": thread_id,
        "messages": [
            {**_meta(m), "body_text": (m.get("body_text") or "")[:2000]}
            for m in msgs
        ],
    }


def search_emails(query: str, account: Optional[str] = None) -> dict:
    parsed = parse_search_query(query or "")
    rows = db.search_emails(parsed, account=account, limit=30)
    return {"parsed": parsed, "results": [_meta(r) for r in rows]}


def top_senders(limit: int = 10, account: Optional[str] = None,
                category: Optional[str] = None) -> dict:
    """Aggregated sender ranking — the cleanup view's SQL, exposed to the
    agent so "which newsletters do I get most" is one call, not a guess.

    `category` narrows the ranking to senders with at least one email in
    that category, re-sorted by that category's count. Added after watching
    the model guess this exact parameter — it is the natural way to ask
    "top newsletter senders"."""
    lim = min(int(limit), 25)
    if category:
        cat = str(category).strip().lower()
        valid = {"important", "newsletter", "transactional", "spam", "other", "pending"}
        if cat not in valid:
            return {"error": f"Catégorie inconnue : {category}. Valides : {sorted(valid)}"}
        # Rank over the full sender set, then narrow — asking db for `lim`
        # first would truncate before the category sort.
        rows = db.top_senders(limit=1000, account=account)
        rows = [r for r in rows if (r.get(cat) or 0) > 0]
        rows.sort(key=lambda r: (r.get(cat) or 0), reverse=True)
        rows = rows[:lim]
    else:
        rows = db.top_senders(limit=lim, account=account)
    return {"senders": [
        {
            "email": r.get("email"),
            "name": r.get("name"),
            "total": r.get("total"),
            "unread": r.get("unread"),
            "newsletter": r.get("newsletter"),
            "important": r.get("important"),
            "transactional": r.get("transactional"),
            "spam": r.get("spam"),
            "avg_score": r.get("avg_score"),
            "last_seen": r.get("last_seen"),
        }
        for r in rows
    ]}


def mailbox_stats() -> dict:
    """Global counters: totals, unread, needs_reply, per-category."""
    return db.get_stats()


def unsubscribe_candidates(limit: int = 10, account: Optional[str] = None) -> dict:
    """Senders with a captured unsubscribe link — the cleanup Unsubscribe
    tab's data. Read-only: the agent can point at candidates, the user
    unsubscribes from the Cleanup page."""
    rows = db.unsubscribe_senders(account=account)
    out = []
    for r in rows[: min(int(limit), 25)]:
        out.append({
            "email": r.get("email"),
            "name": r.get("name"),
            "total": r.get("total") or r.get("count"),
            "last_seen": r.get("last_seen"),
            "one_click": bool(r.get("one_click")),
            "already_unsubscribed": bool(r.get("unsubscribed_at")),
        })
    return {"senders": out}


def list_labels() -> dict:
    """The user's personal labels (name + colour)."""
    return {"labels": [
        {"id": l.get("id"), "name": l.get("name"), "color": l.get("color")}
        for l in db.list_labels()
    ]}


def list_folders() -> dict:
    """Every folder an email can live in or be moved to."""
    return {"folders": sorted(_BUILTIN_FOLDERS | db.custom_folder_names())}


def list_accounts() -> dict:
    """The mail accounts present in the mailbox (for scoping searches)."""
    return {"accounts": db.distinct_account_emails()}


def set_favourite(int_id: int, favourite: bool = True) -> dict:
    row = db.get_email_by_id(int(int_id))
    if not row:
        return {"error": "Email introuvable"}
    db.set_favourite(row["message_id"], bool(favourite))
    return {"status": "updated", "int_id": int(int_id), "favourite": bool(favourite)}


def label_email(int_id: int, label: str, add: bool = True) -> dict:
    """Attach/detach an EXISTING personal label (by name) on an email. The
    agent cannot create labels — that stays a deliberate user action."""
    row = db.get_email_by_id(int(int_id))
    if not row:
        return {"error": "Email introuvable"}
    wanted = (label or "").strip().lower()
    match = next((l for l in db.list_labels()
                  if (l.get("name") or "").strip().lower() == wanted), None)
    if not match:
        names = [l.get("name") for l in db.list_labels()]
        return {"error": f"Étiquette inconnue : {label}. Existantes : {names}"}
    current = {l["id"] for l in db.get_labels_for_email(int(int_id))}
    if add:
        current.add(match["id"])
    else:
        current.discard(match["id"])
    db.set_email_labels(int(int_id), sorted(current))
    return {"status": "updated", "int_id": int(int_id),
            "label": match.get("name"), "attached": bool(add)}


def draft_reply(int_id: int, body: str) -> dict:
    """Save a reply draft on the email. Does NOT send."""
    row = db.get_email_by_id(int(int_id))
    if not row:
        return {"error": "Email introuvable"}
    db.set_draft_response(row["message_id"], body or "")
    db.set_needs_reply(row["message_id"], True)
    return {"status": "draft_saved", "int_id": int(int_id),
            "message": "Brouillon enregistré (non envoyé). À relire et envoyer manuellement."}


def mark_email_read(int_id: int, read: bool = True) -> dict:
    row = db.get_email_by_id(int(int_id))
    if not row:
        return {"error": "Email introuvable"}
    (db.mark_read if read else db.mark_unread)(row["message_id"])
    return {"status": "updated", "int_id": int(int_id), "read": bool(read)}


def move_email(int_id: int, folder: str) -> dict:
    row = db.get_email_by_id(int(int_id))
    if not row:
        return {"error": "Email introuvable"}
    # Validate the target so the agent can't strand mail in a folder no view
    # lists (every get_emails/get_threads query filters on known folders).
    valid = _BUILTIN_FOLDERS | db.custom_folder_names()
    if folder not in valid:
        return {"error": f"Dossier inconnu : {folder}. Valides : {sorted(valid)}"}
    db.update_email_folder(row["message_id"], folder)
    return {"status": "moved", "int_id": int(int_id), "folder": folder}


# ── registry shared by agent.py and mcp_server.py ───────────────────

TOOL_FUNCS = {
    "list_emails": list_emails,
    "get_email": get_email,
    "get_thread": get_thread,
    "search_emails": search_emails,
    "top_senders": top_senders,
    "mailbox_stats": mailbox_stats,
    "unsubscribe_candidates": unsubscribe_candidates,
    "list_labels": list_labels,
    "list_folders": list_folders,
    "list_accounts": list_accounts,
    "draft_reply": draft_reply,
    "mark_email_read": mark_email_read,
    "move_email": move_email,
    "set_favourite": set_favourite,
    "label_email": label_email,
}

# Exhaustive operator reference for search_emails. Injected in the tool
# description (cloud) AND the local system prompt — the agent can only use
# operators it has been TOLD exist; before this doc it guessed (and invented
# filters like a free-text "attend une réponse" search).
SEARCH_OPERATORS_DOC = (
    "Opérateurs (combinables, le reste = texte libre cherché dans "
    "sujet/corps/expéditeur) : "
    "from:<expéditeur> · to:<destinataire> · subject:<texte> · "
    "in:<inbox|sent|draft|nom-de-dossier> · "
    "is:<unread|read|starred|unstarred|needs_reply> "
    "(is:needs_reply = mails attendant une réponse de l'utilisateur) · "
    "has:attachment · "
    "category:<important|newsletter|transactional|spam|other|pending> · "
    "min_score:<1-10> (importance minimale) · "
    "label:<nom d'étiquette> · before:AAAA-MM-JJ · after:AAAA-MM-JJ"
)

# OpenAI function-calling schema (1:1 with TOOL_FUNCS). The MCP server
# reuses the same parameter shapes.
TOOL_SPECS = [
    {
        "type": "function",
        "function": {
            "name": "list_emails",
            "description": "Lister les emails d'un dossier (métadonnées seulement).",
            "parameters": {
                "type": "object",
                "properties": {
                    "account": {"type": "string", "description": "Adresse du compte (optionnel)"},
                    "folder": {"type": "string", "description": "inbox|sent|draft|deleted", "default": "inbox"},
                    "limit": {"type": "integer", "default": 20},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_email",
            "description": "Lire le contenu complet d'un email par son int_id.",
            "parameters": {
                "type": "object",
                "properties": {"int_id": {"type": "integer"}},
                "required": ["int_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_thread",
            "description": "Lire toute la conversation (fil) d'un email, du plus ancien au plus récent.",
            "parameters": {
                "type": "object",
                "properties": {"int_id": {"type": "integer"}},
                "required": ["int_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_emails",
            "description": "Rechercher des emails. " + SEARCH_OPERATORS_DOC
                           + " Exemple : \"is:needs_reply after:2026-08-01\".",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Requête avec opérateurs"},
                    "account": {"type": "string", "description": "Limiter à un compte (adresse)"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "top_senders",
            "description": "Classement agrégé des expéditeurs (total, non-lus, répartition par "
                           "catégorie, score moyen, dernière réception). LE bon outil pour "
                           "« quelles newsletters je reçois le plus », « qui m'écrit le plus », etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "default": 10, "description": "Max 25"},
                    "account": {"type": "string"},
                    "category": {
                        "type": "string",
                        "description": "Restreindre et trier par cette catégorie "
                                       "(important|newsletter|transactional|spam|other|pending)",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mailbox_stats",
            "description": "Compteurs globaux de la boîte : total, non-lus, mails à répondre, "
                           "répartition par catégorie.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "unsubscribe_candidates",
            "description": "Expéditeurs avec lien de désabonnement capturé (newsletters). "
                           "Lecture seule — le désabonnement se fait depuis la page Nettoyage.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "default": 10, "description": "Max 25"},
                    "account": {"type": "string"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_labels",
            "description": "Lister les étiquettes personnelles de l'utilisateur.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_folders",
            "description": "Lister tous les dossiers (intégrés + personnalisés) valides pour move_email.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_accounts",
            "description": "Lister les comptes mail présents dans la boîte (pour limiter une recherche).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "draft_reply",
            "description": "Enregistrer un brouillon de réponse (NON envoyé) sur un email.",
            "parameters": {
                "type": "object",
                "properties": {
                    "int_id": {"type": "integer"},
                    "body": {"type": "string", "description": "Texte du brouillon"},
                },
                "required": ["int_id", "body"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mark_email_read",
            "description": "Marquer un email lu ou non lu.",
            "parameters": {
                "type": "object",
                "properties": {
                    "int_id": {"type": "integer"},
                    "read": {"type": "boolean", "default": True},
                },
                "required": ["int_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "move_email",
            "description": "Déplacer un email vers un dossier (voir list_folders pour les noms valides).",
            "parameters": {
                "type": "object",
                "properties": {
                    "int_id": {"type": "integer"},
                    "folder": {"type": "string"},
                },
                "required": ["int_id", "folder"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_favourite",
            "description": "Ajouter ou retirer un email des favoris (étoile).",
            "parameters": {
                "type": "object",
                "properties": {
                    "int_id": {"type": "integer"},
                    "favourite": {"type": "boolean", "default": True},
                },
                "required": ["int_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "label_email",
            "description": "Attacher (add=true) ou détacher (add=false) une étiquette personnelle "
                           "EXISTANTE sur un email, par son nom (voir list_labels).",
            "parameters": {
                "type": "object",
                "properties": {
                    "int_id": {"type": "integer"},
                    "label": {"type": "string", "description": "Nom exact de l'étiquette"},
                    "add": {"type": "boolean", "default": True},
                },
                "required": ["int_id", "label"],
            },
        },
    },
]


def dispatch(name: str, args: dict) -> dict:
    """Invoke a tool by name with a kwargs dict. Returns a plain dict."""
    fn = TOOL_FUNCS.get(name)
    if fn is None:
        return {"error": f"Outil inconnu : {name}"}
    try:
        return fn(**(args or {}))
    except TypeError as e:
        return {"error": f"Arguments invalides pour {name}: {e}"}
    except Exception as e:  # noqa: BLE001 — tool errors are data, not crashes
        return {"error": f"{type(e).__name__}: {e}"}


def tools_for_prompt() -> str:
    """One-line-per-tool description for the local-model system prompt.

    The original version dumped the full JSON Schema of every tool — ~2500
    tokens out of the 4096 context budget, which left almost no room for the
    actual conversation + tool results. This version emits compact textual
    signatures that tool-trained 7B models parse just as well, leaving real
    context budget for real work.

    Only the FIRST SENTENCE of each description is kept. Growing the toolset
    from 7 to 15 pushed the block back over budget, and the verbose tails are
    redundant here: the search operators are injected separately by the local
    prompt, and the rest is guidance the cloud schema still carries in full.
    """
    lines = []
    for spec in TOOL_SPECS:
        fn = spec["function"]
        name = fn["name"]
        params = fn.get("parameters", {}) or {}
        required = set(params.get("required") or [])
        props = params.get("properties") or {}
        sig_parts = []
        for pname, pmeta in props.items():
            ptype = pmeta.get("type", "string")
            default = pmeta.get("default")
            if pname in required:
                sig_parts.append(f"{pname}: {ptype}")
            elif default is not None:
                sig_parts.append(f"{pname}?: {ptype} = {default!r}")
            else:
                sig_parts.append(f"{pname}?: {ptype}")
        sig = ", ".join(sig_parts)
        desc = (fn.get("description", "") or "").strip()
        # First sentence only. Split on ". " so decimals/ellipses survive.
        head = desc.split(". ", 1)[0].rstrip(".")
        lines.append(f"- {name}({sig}) — {head}.")
    return "\n".join(lines)

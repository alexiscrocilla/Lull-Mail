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
    "draft_reply": draft_reply,
    "mark_email_read": mark_email_read,
    "move_email": move_email,
}

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
            "description": "Rechercher des emails (opérateurs from:/to:/subject:/is:/has:/before:/after:).",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "account": {"type": "string"},
                },
                "required": ["query"],
            },
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
            "description": "Déplacer un email vers un dossier (inbox|deleted|...).",
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
    """Compact JSON description of every tool, ready to inline in a system
    prompt. Used by the local-model loop where ``tools=`` isn't reliable
    through llama_cpp.server — we have to tell the model directly what's
    available and how to call it."""
    import json as _json
    descs = []
    for spec in TOOL_SPECS:
        fn = spec["function"]
        descs.append({
            "name": fn["name"],
            "description": fn["description"],
            "parameters": fn["parameters"],
        })
    return _json.dumps(descs, ensure_ascii=False, indent=2)

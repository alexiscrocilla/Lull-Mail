# SPDX-License-Identifier: GPL-3.0-or-later
"""Tool-call extraction for local GGUF models.

llama_cpp.server v0.3.0 does not reliably forward `tools=` / `tool_choice="auto"`
to the OpenAI response shape. Local-trained-for-tool-calling models emit their
NATIVE format in the response body instead:

  - Qwen 2.5 (Hermes/ChatML): ``<tool_call>{"name": "...", "arguments": {...}}</tool_call>``
  - Mistral 7B v0.3:          ``[TOOL_CALLS][{"name": "...", "arguments": {...}}]``
  - Hermes / generic JSON:    ``{"tool_calls":[{"name": "...", "arguments": {...}}]}``
                              or a bare ``{"name": "...", "arguments": {...}}``

The agent loop in :mod:`src.agent` calls :func:`parse_tool_calls` on every
non-empty response. If anything is recognised it's executed; whatever remains in
the text is cleaned by :func:`strip_tool_artifacts` before being shown to the
user (defence-in-depth — even if the loop terminates early on a malformed call,
the UI never displays raw ``<tool_call>`` XML).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, List, Optional


@dataclass
class LocalToolCall:
    """Normalised tool call extracted from a local model's text response.

    Mirrors the fields the OpenAI loop uses (``name`` + parsed ``args``) so the
    dispatcher can stay format-agnostic. ``raw`` is kept for debugging — if a
    tool-call block parsed but the *arguments* didn't JSON-decode we still know
    what the model emitted."""

    name: str
    args: dict
    raw: str


# Qwen / Hermes ChatML form: <tool_call>…</tool_call>. We match the WHOLE
# block (any content) and let _extract_balanced pull the first balanced JSON
# object out of it — Python's `re` can't count braces, and a lazy `\{.*?\}`
# misses calls where the JSON contains nested objects (arguments often do).
_QWEN_RE = re.compile(r"<tool_call>(.*?)</tool_call>", re.DOTALL)

# Mistral v0.3 form: [TOOL_CALLS] followed by either an array or a single
# object. Same balanced-extraction strategy as Qwen.
_MISTRAL_RE = re.compile(r"\[TOOL_CALLS\]\s*([\[{].*)", re.DOTALL)

# Function-call sentinel some Hermes variants use when chat_format != "chatml".
_FUNC_RE = re.compile(r"<function_call>(.*?)</function_call>", re.DOTALL)

# Strip-only patterns: match the wrapper regardless of inner content so
# leaked / malformed blocks still get scrubbed from the user-facing text.
_QWEN_STRIP_RE = re.compile(r"<tool_call\b[^>]*>.*?</tool_call>", re.DOTALL)
_FUNC_STRIP_RE = re.compile(r"<function_call\b[^>]*>.*?</function_call>", re.DOTALL)
_TOOL_RESP_STRIP_RE = re.compile(r"<tool_response\b[^>]*>.*?</tool_response>", re.DOTALL)
_MISTRAL_SENTINEL_RE = re.compile(r"\[TOOL_CALLS\]")


def _extract_balanced(text: str, opener: str) -> Optional[str]:
    """Return the substring starting at the first ``opener`` (``{`` or ``[``)
    in ``text`` that closes balanced. ``None`` if the braces never balance —
    the caller treats that as "no parseable JSON here" and moves on.

    Local models occasionally truncate their tool-call block (output cap,
    early-stop on a rogue ``</s>``). We must not crash on those; we just
    fail to parse and the next step picks up the slack."""
    start = text.find(opener)
    if start < 0:
        return None
    closer = "}" if opener == "{" else "]"
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def _coerce_one(obj: Any) -> Optional[LocalToolCall]:
    """Turn one parsed JSON blob into a ``LocalToolCall`` if it looks like one.

    Accepts both ``{"name": ..., "arguments": ...}`` (most common) and the
    OpenAI-flavoured ``{"function": {"name": ..., "arguments": ...}}`` (Hermes
    sometimes emits this). ``arguments`` may be a JSON object OR a JSON-encoded
    string — handle both so we don't lose calls to a quirky stringification."""
    if not isinstance(obj, dict):
        return None
    name = obj.get("name")
    args: Any = obj.get("arguments")
    if name is None and isinstance(obj.get("function"), dict):
        fn = obj["function"]
        name = fn.get("name")
        args = fn.get("arguments")
    if not isinstance(name, str) or not name:
        return None
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            args = {}
    if not isinstance(args, dict):
        args = {}
    return LocalToolCall(name=name, args=args, raw=json.dumps(obj, ensure_ascii=False))


def _safe_loads(s: str) -> Any:
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return None


def parse_tool_calls(text: str) -> List[LocalToolCall]:
    """Best-effort tool-call extraction from any of the known local formats.

    Returns an empty list when the response is a plain natural-language answer
    (the agent loop treats that as the final reply). Order is preserved — when
    a model emits multiple ``<tool_call>`` blocks, they're returned in textual
    order so the dispatch loop runs them as written."""
    if not text or "{" not in text:
        return []
    calls: List[LocalToolCall] = []
    for rx in (_QWEN_RE, _FUNC_RE):
        for match in rx.finditer(text):
            blob = _extract_balanced(match.group(1), "{")
            obj = _safe_loads(blob) if blob else None
            tc = _coerce_one(obj)
            if tc is not None:
                calls.append(tc)
    for match in _MISTRAL_RE.finditer(text):
        body = match.group(1)
        opener = "[" if body.lstrip().startswith("[") else "{"
        blob = _extract_balanced(body, opener)
        obj = _safe_loads(blob) if blob else None
        if isinstance(obj, list):
            for item in obj:
                tc = _coerce_one(item)
                if tc is not None:
                    calls.append(tc)
        elif obj is not None:
            tc = _coerce_one(obj)
            if tc is not None:
                calls.append(tc)
    if calls:
        return calls
    # Last-resort: the model may have emitted a bare JSON object/array with no
    # sentinel — Hermes ``{"tool_calls":[…]}`` or just ``{"name":..,"arguments":..}``
    # on the first line. Only attempt this when the text starts (after optional
    # whitespace/fence) with ``{`` or ``[`` so we don't false-positive on prose
    # that mentions JSON.
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z]*\s*", "", stripped)
        stripped = re.sub(r"\s*```$", "", stripped).strip()
    if not stripped.startswith("{") and not stripped.startswith("["):
        return []
    obj = _safe_loads(stripped)
    if isinstance(obj, dict) and isinstance(obj.get("tool_calls"), list):
        for item in obj["tool_calls"]:
            tc = _coerce_one(item)
            if tc is not None:
                calls.append(tc)
        return calls
    if isinstance(obj, list):
        for item in obj:
            tc = _coerce_one(item)
            if tc is not None:
                calls.append(tc)
        return calls
    if isinstance(obj, dict):
        tc = _coerce_one(obj)
        if tc is not None:
            calls.append(tc)
    return calls


def strip_tool_artifacts(text: str) -> str:
    """Remove any leaked tool-call markup from a text the UI is about to show.

    Called on the FINAL assistant turn — if the parser already executed every
    call this is a no-op, but if the model ended the conversation with a stray
    ``<tool_call>`` block the user must never see it. Also collapses the
    leading "Pour trouver X, je vais …" preamble Qwen sometimes glues to its
    XML, since with the XML gone that preamble is meaningless to the user."""
    if not text:
        return text
    cleaned = _QWEN_STRIP_RE.sub("", text)
    cleaned = _FUNC_STRIP_RE.sub("", cleaned)
    cleaned = _TOOL_RESP_STRIP_RE.sub("", cleaned)
    cleaned = _strip_mistral_blocks(cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _strip_mistral_blocks(text: str) -> str:
    """Remove every ``[TOOL_CALLS] …balanced-JSON…`` block from the text.

    A previous version used a regex with a lookahead on the next paragraph or
    capitalised line — fragile, it leaked into trailing prose when the model
    didn't insert a blank line. We now hunt for the literal sentinel, then
    rely on the same balanced-brace extractor that powers ``parse_tool_calls``
    so we never over- or under-cut."""
    parts: List[str] = []
    cursor = 0
    while True:
        m = _MISTRAL_SENTINEL_RE.search(text, cursor)
        if m is None:
            parts.append(text[cursor:])
            return "".join(parts)
        parts.append(text[cursor:m.start()])
        # Skip whitespace after the sentinel, find an opener, extract balanced.
        i = m.end()
        while i < len(text) and text[i] in " \t\r\n":
            i += 1
        if i >= len(text) or text[i] not in "[{":
            # Sentinel with no JSON body — drop the sentinel only.
            cursor = m.end()
            continue
        blob = _extract_balanced(text[i:], text[i])
        if blob is None:
            # Unbalanced — drop the rest of the text after the sentinel; better
            # than leaving raw JSON in the user-facing reply.
            return "".join(parts)
        cursor = i + len(blob)

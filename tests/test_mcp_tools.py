"""Local MCP server (P3.2) — reuses the shared tool layer, no send tool.

The `mcp` SDK is an OPTIONAL dependency: the MCP server lets external
tools drive the mailbox, but the app itself runs fine without it, so it is
absent from requirements-dev.txt. These tests skip rather than fail when
it isn't installed — otherwise CI is permanently red for a feature nobody
broke, which trains everyone to ignore the signal.

Install it (`pip install mcp`) to exercise them locally.
"""

from __future__ import annotations

import pytest

mcp_sdk = pytest.importorskip(
    "mcp.server.fastmcp",
    reason="optional `mcp` SDK not installed — MCP server tests skipped",
)


def test_build_server_registers_shared_tools(fresh_app):
    import asyncio
    from src import mcp_server, agent_tools
    server = mcp_server.build_server()
    tools = asyncio.run(server.list_tools())
    names = {t.name for t in tools}
    assert names == set(agent_tools.TOOL_FUNCS)


def test_mcp_has_no_send_tool(fresh_app):
    import asyncio
    from src import mcp_server
    server = mcp_server.build_server()
    tools = asyncio.run(server.list_tools())
    assert not any(t.name.startswith("send") or t.name in ("send", "send_email", "send_mail") for t in tools)


def test_mcp_tools_dispatch_through_server(fresh_app):
    """Invoke a tool THROUGH the FastMCP server (not the raw function) so the
    MCP introspection + dispatch path is actually exercised."""
    import asyncio
    from src import mcp_server, database as db
    db.insert_email({
        "message_id": "<m@t>", "account": "u@x.fr", "uid": "1",
        "subject": "Hi", "sender": "a@b.c", "recipient": "u@x.fr",
        "body_text": "hello", "date_str": "Mon, 05 May 2025 10:00:00 +0000",
    })
    server = mcp_server.build_server()
    result = asyncio.run(server.call_tool("list_emails", {"folder": "inbox"}))
    # call_tool returns content blocks (and/or a structured result); the
    # seeded email's subject must appear in the serialized output.
    assert "Hi" in str(result)

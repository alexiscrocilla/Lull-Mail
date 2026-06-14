"""Local MCP server exposing the triaged mailbox over the Model Context
Protocol (stdio transport).

Lets the user's own Claude Desktop / Cursor query their inbox WITHOUT the
data leaving the machine — a differentiator versus a hosted agentic inbox.

Reuses the exact same tool layer as the in-app agent (src/agent_tools.py),
mirroring agentic-inbox where ``workers/mcp/index.ts`` reuses
``workers/lib/tools.ts``. Read + draft only; there is no send tool.

Run it as a standalone process::

    python -m src.mcp_server

Then point Claude Desktop at it (claude_desktop_config.json)::

    {
      "mcpServers": {
        "lull-mail": {
          "command": "python",
          "args": ["-m", "src.mcp_server"],
          "cwd": "/path/to/lull-mail"
        }
      }
    }
"""

import logging

from mcp.server.fastmcp import FastMCP

from src import agent_tools

logger = logging.getLogger(__name__)


def build_server() -> FastMCP:
    """Construct the MCP server, registering every shared tool. Pure (no
    side effects) so it can be built and inspected in tests."""
    server = FastMCP("lull-mail")
    descriptions = {
        s["function"]["name"]: s["function"]["description"]
        for s in agent_tools.TOOL_SPECS
    }
    for name, fn in agent_tools.TOOL_FUNCS.items():
        server.add_tool(fn, name=name, description=descriptions.get(name, ""))
    return server


def main() -> None:
    # Standalone process: load config + ensure the DB schema exists, then
    # serve over stdio.
    from src import config as cfg
    from src import database as db
    cfg.try_load()
    db.init_db()
    logging.basicConfig(level=logging.INFO)
    build_server().run()


if __name__ == "__main__":
    main()

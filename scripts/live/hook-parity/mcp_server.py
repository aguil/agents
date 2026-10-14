#!/usr/bin/env python3
"""A one-tool MCP stdio server for the hook-parity live checks.

Offers `echo_token`, which returns "hp-mcp-<token>" with <token> from
$HP_MCP_TOKEN. Every request is appended to $HP_MCP_LOG, so a cell can tell a
call that ran from one the CLI refused before it reached the server.
"""

import json
import os
import sys

TOKEN = os.environ.get("HP_MCP_TOKEN", "none")
LOG = os.environ.get("HP_MCP_LOG")


def log(entry):
    if LOG:
        with open(LOG, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")


def reply(request_id, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        message = json.loads(line)
    except ValueError:
        continue
    method = message.get("method")
    log({"method": method})
    if "id" not in message:
        continue
    if method == "initialize":
        reply(message["id"], {
            "protocolVersion": message.get("params", {}).get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "hpprobe", "version": "1.0.0"},
        })
    elif method == "tools/list":
        reply(message["id"], {"tools": [{
            "name": "echo_token",
            "description": "Returns this run's probe token.",
            "inputSchema": {"type": "object", "properties": {}},
        }]})
    elif method == "tools/call":
        reply(message["id"], {"content": [{"type": "text", "text": f"hp-mcp-{TOKEN}"}]})
    else:
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": message["id"],
                                     "error": {"code": -32601, "message": "method not found"}}) + "\n")
        sys.stdout.flush()

#!/usr/bin/env python3
"""Hook handler for the hook-parity live checks: log one call, then answer.

Appends one JSON line to $HP_LOG: the label, the payload's event and tool
name, HOOK_MATCHER, and the raw stdin. Prints nothing unless a mode asks for
a deny, so it never widens what a run may do.
"""

import json
import os
import sys
import time

label = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else ""
raw = sys.stdin.buffer.read()
try:
    payload = json.loads(raw)
except ValueError:
    payload = None
fields = payload if isinstance(payload, dict) else {}
record = {
    "t": time.time(),
    "label": label,
    "event": fields.get("hook_event_name"),
    "tool_name": fields.get("tool_name"),
    "hook_matcher": os.environ.get("HOOK_MATCHER"),
    "raw": raw.decode("utf-8", "replace"),
}
with open(os.environ["HP_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps(record) + "\n")
if mode == "deny-cursor":
    print(json.dumps({"permission": "deny", "user_message": "hp: edit denied",
                      "agent_message": "hp: edit denied by a user hook"}))

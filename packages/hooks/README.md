# `@aguil/agents-hooks`

Project a harness's canonical `hooks:` block onto each adapter's native hook
configuration.

## Generators

| Adapter    | Function                    | Output                                     | Written where                                    |
| ---------- | --------------------------- | ------------------------------------------ | ------------------------------------------------ |
| `cursor`   | `generateCursorHooksConfig` | `.cursor/hooks.json` shape                 | `<workspace>/.cursor/hooks.json` (grandfathered) |
| `claude`   | `generateClaudeHooksConfig` | Claude Code `settings.json` `hooks` object | run scratchpad → `claude --settings` (ADR 0023)  |
| `opencode` | —                           | out of scope (plugin / executable JS)      | keeps the unenforced-policy refusal              |

Both generators share the same source: the harness `HooksSpec`. Events with no
native equivalent are returned in `skippedEvents`, never dropped silently.

## Enforcement claim (ADR 0023)

`ADAPTER_HOOK_CAPABILITIES` is the per-adapter table the refusal consults:

- `canDeny` — whether the adapter's hook mechanism can block a tool call
- `nativeEvents` — every `HookEvent` → native name(s), or `[]` if unmappable

`setUpHookEnforcement` lifts the fail-closed refusal only when `canDeny` is
true. Adding a `HookEvent` without filling every adapter column fails
`hookEventAdapterDispatchability`'s contract test.

## Policy bridge

When `policyBridge: true`, the generator registers `agents policy-eval` first on
every mapped tool event except Cursor's user-hook events (see below). Claude is
the exception: there the bridge is a `PreToolUse` hook only, and
harness-declared `post_tool_call` handlers still map to `PostToolUse` (ADR 0023
decision 9). Claude's bridge passes `--format claude` so the response encoding
matches what the CLI expects (`hookSpecificOutput.permissionDecision`). Cursor
keeps the default `{ permission }` shape. Given `workspaceRoot`, Claude's bridge
also passes `--workspace <root>`. Claude Code sends absolute file paths, so the
bridge rewrites the ones inside the root as workspace-relative before filesystem
rules see them. A path outside the root stays absolute and stays denied.
Cursor's bridge is given `workspaceRoot` the same way, since a native read's
path is absolute too.

## Cursor reads (#198)

Given `readHook: true`, the Cursor generator registers the bridge on
`beforeReadFile`, so `filesystem.deny` covers Cursor's native read tool. Only
the bridge attaches: no harness-declared handler runs on the event, because its
payload carries the file's content and no `applies_to` class scopes a handler
away from reads. The bridge reads `file_path` and nothing else from it.

The event is registered only on a `cursor-agent` listed in
`CURSOR_READ_HOOK_VERSIONS`, the versions a measurement has shown firing the
event and honouring its deny. An event the installed CLI does not know turns off
every other hook in the workspace (#239), so "this version or later" would fail
open. On any other version, `agents harness run` withholds the event, prints a
warning, and records `beforeReadFile` in `undeliverable_hooks`; native reads
then go unchecked, as they did before. A new version joins the list by repeating
that measurement on it.

`agentsCli` names the bridge's executable, or an argv prefix such as
`[bun, entry]`, with each word quoted. `agents harness run` defaults Claude's
bridge to the running CLI itself rather than the `agents` on the hook's `PATH`,
and runs the bridge once before any role with no policy identity. A bridge that
does not answer `deny` there fails the run, because Claude Code runs the tool
after a hook error (ADR 0023 decision 10).

## User tool-call hooks run behind a gate (ADR 0028)

Every harness-declared `pre_tool_call` or `post_tool_call` handler is generated
as `agents hook-gate`, which decides whether the call is in the handler's scope
and runs the handler only if it is:

```text
<agents> hook-gate --adapter <cursor|claude> --event <native event>
  --classes <class>[,<class>…] [--matcher '<regex>'] -- '<handler command>'
```

Every value is a single-quoted shell word. `--classes` is the event's classes
narrowed by the handler's `applies_to`; an empty intersection registers nothing.
The gate reads the payload from stdin and takes the call's class and tool name
from `toolEvents` in `ADAPTER_HOOK_CAPABILITIES`. It tests the tool name against
`matcher` as a whole-name JavaScript regex, `^(?:<matcher>)$`. A call that names
no tool, such as Cursor's `beforeShellExecution` or `afterFileEdit`, is tested
against every name in its class (`HOOK_CLASS_TOOL_NAMES`), and a shell call
against both `Bash` and `Shell`. Cursor MCP calls are named
`mcp__<mcp_server_name>__<tool_name>`, as on Claude Code.

- In scope, it runs the handler as `/bin/sh -c '<command>'` with the payload on
  stdin and `HOOK_MATCHER` set to the matcher. The handler's stdout, stderr and
  exit status pass through unchanged, so a deny, or Claude Code's exit-2 block,
  still blocks.
- Out of scope, it exits 0 and prints nothing. It never prints an allow: on
  Claude Code an allow would lift the headless permission default.
- When it cannot tell, it writes one line to stderr and runs the handler. That
  covers stdin that is not a JSON object, a missing tool name, and a name that
  is in no class and not in the adapter's `otherToolNames`.

Lifecycle handlers are not gated.

On Claude Code the native `matcher` is the class projection (`Bash`, `mcp__.*`,
`Edit|Write|NotebookEdit`), and the gate runs as the running CLI's Bun
executable and entry script. On Cursor the gate is `agents` on the hook's
`PATH`, or `agentsCli`. Each generator returns `gateProbes`, the distinct gate
commands with `--probe`, and `agents harness run` runs each once before any
role. Any output or a non-zero exit fails the run.

Cursor's user hooks also register on `preToolUse` (edit), `afterShellExecution`
(shell) and `afterMCPExecution` (mcp). These events carry no bridge, so a
pre-edit user hook runs without the bridge before it. Cursor's bridge still
checks edits on `afterFileEdit`. Like `beforeReadFile`, these events are written
only when `userHookEvents` is set, which `agents harness run` does only on a
`cursor-agent` listed in `CURSOR_USER_HOOK_EVENT_VERSIONS`. Otherwise they are
returned in `withheldEvents`, warned about, and recorded in
`undeliverable_hooks`.

## Lifecycle honesty (ADR 0024)

`LIFECYCLE_HOOK_EVENTS` is the checklist of lifecycle events that _may_ be inert
(`role_start`, `role_stop`, `run_start`, `run_end`).
`undispatchableLifecycleHookWarnings(hooks, adapter)` warns for each declared
member that the active adapter does not map — `run_*` always, `role_start` and
`role_stop` only when the generator has no native equivalent (`role_start` on
Cursor, where Claude maps `SessionStart`; `role_stop` on adapters with no
generator, such as `opencode` and `fake`). `run_*` must never be projected onto
a session-end event. `undeliverableLifecycleHookEvents(hooks, adapter)` returns
the same events the warnings name; `agents harness run` records them in the run
result's `metadata` as `undeliverable_hooks`, comma-separated, followed by any
native event withheld from the run, such as `beforeReadFile` or Cursor's
user-hook events.

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
every mapped tool event. Claude is the exception: there the bridge is a
`PreToolUse` hook only, and harness-declared `post_tool_call` handlers still map
to `PostToolUse` (ADR 0023 decision 9). Claude's bridge passes `--format claude`
so the response encoding matches what the CLI expects
(`hookSpecificOutput.permissionDecision`). Cursor keeps the default
`{ permission }` shape. Given `workspaceRoot`, Claude's bridge also passes
`--workspace <root>`. Claude Code sends absolute file paths, so the bridge
rewrites the ones inside the root as workspace-relative before filesystem rules
see them. A path outside the root stays absolute and stays denied.

`agentsCli` names the bridge's executable, or an argv prefix such as
`[bun, entry]`, with each word quoted. `agents harness run` defaults Claude's
bridge to the running CLI itself rather than the `agents` on the hook's `PATH`,
and runs the bridge once before any role with no policy identity. A bridge that
does not answer `deny` there fails the run, because Claude Code runs the tool
after a hook error (ADR 0023 decision 10).

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
result's `metadata` as `undeliverable_hooks`, comma-separated.

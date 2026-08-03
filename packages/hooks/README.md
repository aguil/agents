# `@aguil/agents-hooks`

Project a harness's canonical `hooks:` block onto each adapter's native hook
configuration.

## Generators

| Adapter  | Function                     | Output                                      | Written where                                      |
| -------- | ---------------------------- | ------------------------------------------- | -------------------------------------------------- |
| `cursor` | `generateCursorHooksConfig`  | `.cursor/hooks.json` shape                  | `<workspace>/.cursor/hooks.json` (grandfathered)   |
| `claude` | `generateClaudeHooksConfig`  | Claude Code `settings.json` `hooks` object  | run scratchpad → `claude --settings` (ADR 0023)    |
| `opencode` | —                          | out of scope (plugin / executable JS)       | keeps the unenforced-policy refusal                |

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

When `policyBridge: true`, the generator registers `agents policy-eval` first
on every mapped tool event. Claude's bridge passes `--format claude` so the
response encoding matches what the CLI expects
(`hookSpecificOutput.permissionDecision`). Cursor keeps the default
`{ permission }` shape.

## Lifecycle honesty (ADR 0024)

`undispatchableLifecycleHookWarnings(hooks, adapter)` names `run_start` /
`run_end` (always) and `role_start` when the active generator does not map it.
`run_*` must never be projected onto a session-end event.

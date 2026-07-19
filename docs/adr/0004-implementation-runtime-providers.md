# ADR 0004: Provider-agnostic implementation runtime

**Status:** Accepted  
**Context:** ADR 0003 introduced `agentsd` with an `implementation` worker.
Early docs named Codex app-server as the only path. The monorepo already
standardizes on [`AgentAdapter`](../../packages/execution/src/index.ts) for
OpenCode, Claude Code, and Cursor CLI. Symphony’s `codex:` WORKFLOW block is a
reference profile, not a required dependency.

**Decision:**

1. **`WORKFLOW.md` runtime config** (neutral names):
   - `agent.runtime`: `subprocess` (default) or `app_server`
   - `agent.command`, `agent.protocol`, timeouts — used when `app_server`
   - `execution.implementation`: `{ mode, adapter }` overrides defaults
   - Optional **`codex:`** front matter is aliased into `agent.*` for Symphony
     migrators (command, stall/turn timeouts only).

2. **Phase 1 — subprocess:** `implementation` worker runs one `AgentRunRequest`
   per dispatch via existing subprocess adapters (`fake`, `opencode`, `claude`,
   `cursor`).

3. **Phase 2 — app_server:** `AgentSessionClient` interface with `startSession`
   / `continueTurn`; `FakeAgentSessionClient` and `SessionAgentAdapter` (stdio
   stub) as drivers; turn loop honors `agent.max_turns`.

4. **Naming:** Prefer `session_*` / `usage_*` telemetry fields; avoid `codex_*`
   in shared types. `CodexAppServerAdapter` remains a deprecated alias for
   `SessionAgentAdapter`.

5. **Preflight:** When `runtime=app_server`, require non-empty `agent.command`
   after `$VAR` resolution — not a Codex-specific check.

**Consequences:** See [`docs/agentsd.md`](../agentsd.md) for operator-facing
runtime options. `applyCodexAlias` maps only `command`, `runtime` (when
`command` is set), and stall/turn timeouts — not `codex.protocol` (set
`agent.protocol` explicitly when needed).

**References:** ADR 0003; provider-agnostic execution review plan.

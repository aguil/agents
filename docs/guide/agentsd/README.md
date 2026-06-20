# agentsd — User Guide

Long-running work-queue host for tracker-backed automation. Loads a
`WORKFLOW.md` file, polls configured feeds, dispatches workers, and writes
artifacts under `workspace.root`.

## Running

```bash
bun run agentsd
# or after build:
./dist/agentsd
```

By default loads `./WORKFLOW.md` from the current working directory. Pass a path
as the first argument to override.

One-shot CLI commands (`agents code-review`, `agents pr-feedback`,
`agents triage`) are unaffected — `agentsd` does not replace them.

## WORKFLOW.md structure

See [example WORKFLOW.md](../../examples/WORKFLOW.example.md). Key sections:

- **`feeds`** — `github_issues`, `github_pr_review`, `github_pr_feedback`, `mcp`
- **`workers`** — maps feed kinds to `implementation`, `code_review`,
  `pr_feedback` worker types
- **`publish`** — defaults **`off`** for both code review and pr-feedback
- **`agent` / `execution.implementation`** — how the implementation worker runs
  agents (see below)

### Implementation runtime fields

| Field                              | Default                   | Meaning                                        |
| ---------------------------------- | ------------------------- | ---------------------------------------------- |
| `agent.runtime`                    | `subprocess`              | `subprocess` or `app_server`                   |
| `execution.implementation.mode`    | (same as `agent.runtime`) | Per-worker override                            |
| `execution.implementation.adapter` | `fake`                    | `fake`, `opencode`, `claude`, `cursor`         |
| `agent.command`                    | —                         | Shell command when `app_server` (any provider) |
| `agent.protocol`                   | —                         | Protocol id (e.g. `json_rpc_session_v1`)       |
| `agent.turn_timeout_ms`            | —                         | Per-turn timeout (`app_server`)                |
| `agent.stall_timeout_ms`           | `300000`                  | Stall detection hint (`app_server`)            |

**Subprocess (default):** one `AgentAdapter` invocation per work-item dispatch,
same adapter family as `agents code-review`. `execution.implementation.adapter`
also drives code review and pr-feedback fix workers.

**App server:** multi-turn loop via `AgentSessionClient` and the
`json_rpc_session_v1` line-delimited JSON-RPC driver (`agent.command` required).
Set `agent.protocol` to `json_rpc_session_v1` explicitly.

Symphony-style **`codex:`** block is supported as an alias mapping `command` and
timeouts into `agent.*`. No Codex install is required unless you configure a
Codex command.

### Publish lanes

| Lane        | Behavior when enabled                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Code review | Posts a **pending** GitHub review in-process via `@aguil/agents-code-review-post` when gates pass             |
| PR feedback | Collect → triage → fix (subprocess adapter) → re-collect → submit when `responses.json` exists and gates pass |

### Code review worker options

```yaml
policy:
  code_review:
    use_worktree: true # detached PR worktree (CLI parity)
    publish_with_findings: true # allow pending post when triage items exist
```

## Stall and reload behavior

- When `agent.stall_timeout_ms` fires, the orchestrator aborts the in-flight
  worker via `AbortSignal` and retries after the dispatch settles.
- Editing `WORKFLOW.md` reloads feed clients, per-feed concurrency caps,
  workspace hooks, implementation stall timeout, and subprocess adapter
  selection on the next dispatch.
- Poll interval follows the reloaded definition on the next tick.
- SIGINT/SIGTERM call `stopAndDrain` to await in-flight workers (up to 60s).

## MCP feed

Configure `feeds: [{ kind: mcp, server: …, list_tool: … }]` and run
`agentsd --with-mcp` with `AGENTSD_MCP_HANDLER` (module exporting `mcpInvoke`)
or `AGENTSD_MCP_COMMAND` (stdio JSON bridge). Tool output must normalize to
`{ issues: [...] }` for list/get.

## Startup terminal cleanup

Runs in the background (does not block the poll loop). For `github_pr_feedback`,
only re-checks PRs that already have a per-item workspace under `workspace.root`
(`.agents-work-item.json` marker), not every authored open PR.

## Further reading

| Topic                                | Doc                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Interactive PR feedback selection    | [pr-feedback.md](pr-feedback.md)                                         |
| `AGENTSD_*` env vars                 | [environment.md](environment.md)                                         |
| Production profile and notifications | [production.md](production.md)                                           |
| Architecture and trust posture       | [../../agentsd/architecture.md](../../agentsd/architecture.md)           |
| Example WORKFLOW files               | [../../examples/WORKFLOW.example.md](../../examples/WORKFLOW.example.md) |

# agentsd

Long-running work-queue host for tracker-backed automation. Implements the
coordination patterns from [Symphony](https://github.com/openai/symphony)
without exposing Symphony on the CLI.

## Usage

```bash
bun run agentsd
# or after build:
./dist/agentsd
```

Loads `./WORKFLOW.md` from the current working directory (or pass a path as the
first argument). Polls configured **feeds**, dispatches **workers**, and writes
artifacts under `workspace.root`.

## WORKFLOW.md

See [example WORKFLOW.md](examples/WORKFLOW.example.md). Key sections:

- `feeds` — `github_issues`, `github_pr_review`, `github_pr_feedback`, `mcp`
- `workers` — maps feed kinds to `implementation`, `code_review`, `pr_feedback`
- `publish` — defaults **`off`** for both code review and pr-feedback (see
  ADR 0003)
- **`agent` / `execution.implementation`** — how the implementation worker runs
  agents (see below)

### Implementation runtime (provider-agnostic)

| Field                              | Default                   | Meaning                                                |
| ---------------------------------- | ------------------------- | ------------------------------------------------------ |
| `agent.runtime`                    | `subprocess`              | `subprocess` or `app_server`                           |
| `execution.implementation.mode`    | (same as `agent.runtime`) | Per-worker override                                    |
| `execution.implementation.adapter` | `fake`                    | `fake`, `opencode`, `claude`, `cursor` (subprocess)    |
| `agent.command`                    | —                         | Shell command when `app_server` (any provider)         |
| `agent.protocol`                   | —                         | Protocol id (e.g. `codex_app_server_v2`); pass-through |
| `agent.turn_timeout_ms`            | —                         | Per-turn timeout (app_server)                          |
| `agent.stall_timeout_ms`           | `300000`                  | Stall detection hint (app_server)                      |

Symphony-style **`codex:`** block is supported as an alias (maps `command` and
timeouts into `agent.*`). No Codex install is required unless you configure a
Codex command.

**Subprocess (default):** one `AgentAdapter` invocation per work-item dispatch,
same adapter family as `agents code-review`. `execution.implementation.adapter`
also drives **code review** and **pr-feedback fix** workers (not a separate fake
default in `agentsd`).

**App server:** multi-turn loop via `AgentSessionClient` (stub session driver
until a full JSON-RPC client is added). Requires `agent.command`.

### Publish execution (when enabled in `WORKFLOW.md`)

| Lane        | `pending` / `submit` behavior                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code review | Posts a **pending** GitHub review in-process via `@aguil/agents-code-review-post` when gates pass (no `agents` subprocess).                                           |
| PR feedback | Collect → triage → **fix** (subprocess adapter per triage item in `AGENTSD_WORKSPACE`) → re-collect/re-triage → `submit` when `responses.json` exists and gates pass. |

Implementation workers exceeding `agent.stall_timeout_ms` are released and
retried on the next poll tick (best-effort; in-flight work may still complete).

## Environment

| Variable                   | Effect                                                   |
| -------------------------- | -------------------------------------------------------- |
| `AGENTSD_PUBLISH=disabled` | Force all publish modes off                              |
| `AGENTSD_WORKSPACE`        | Host repo path for `gh` / harness context (default: cwd) |

## Trust posture

- Code review auto-post (`publish.code_review: pending`) creates **pending**
  GitHub reviews only, never submits them.
- PR feedback auto-submit requires an operator-authored responses document.
- Implementation workers follow configured runtime; subprocess adapters use the
  same CLI boundaries as the code-review harness.

## One-shot CLI

Manual workflows remain on `agents` (`code-review`, `pr-feedback`, `triage`).
`agentsd` does not replace those commands.

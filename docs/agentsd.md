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
- PR feedback **fix** workers treat review-thread bodies as operational input;
  untrusted-reviewer / allowlist policy is **not** enforced yet — see
  [#36](https://github.com/aguil/agents/issues/36).

## Known limitations (platform landed)

PR [#33](https://github.com/aguil/agents/pull/33) lands the scheduler and
workers; the items below are tracked for **shippable E2E**, not blockers for
merging the platform PR.

| Topic                                                                         | GitHub issue                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------ |
| PR feedback playbook + operator policy (ingest, allowlist, multi-round drain) | [#36](https://github.com/aguil/agents/issues/36) |
| Work-item terminal semantics; stop post-success retry churn                   | [#37](https://github.com/aguil/agents/issues/37) |
| `WORKFLOW.md` hot reload (orchestrator/router/publish); graceful shutdown     | [#38](https://github.com/aguil/agents/issues/38) |
| Code-review worker parity (worktree, publish-with-findings)                   | [#39](https://github.com/aguil/agents/issues/39) |
| Per-feed concurrency, JSONL observability, production runbook                 | [#40](https://github.com/aguil/agents/issues/40) |
| Stall timeout: cancel or isolate in-flight implementation workers             | [#41](https://github.com/aguil/agents/issues/41) |
| `codex:` alias vs ADR 0004 (`codex.protocol` field)                           | [#42](https://github.com/aguil/agents/issues/42) |
| Real `app_server` JSON-RPC client                                             | [#34](https://github.com/aguil/agents/issues/34) |
| MCP feed, `github_issues` dogfood, publish integration tests                  | [#35](https://github.com/aguil/agents/issues/35) |

**Stall / reload behavior today:** `agent.stall_timeout_ms` releases a work item
from the running map and may retry while the prior worker is still executing
([#41](https://github.com/aguil/agents/issues/41)). Editing `WORKFLOW.md` on
disk updates prompt templates via reload, but poll interval, workers, publish,
and adapter settings require restart until
[#38](https://github.com/aguil/agents/issues/38).

## One-shot CLI

Manual workflows remain on `agents` (`code-review`, `pr-feedback`, `triage`).
`agentsd` does not replace those commands.

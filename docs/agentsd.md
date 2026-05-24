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
- PR feedback **fix** workers run only for operator-**approved** PRs
  (interactive selection via `agents pr-feedback select` after notification).
  Treat review-thread bodies as operational input; use trusted reviewers on
  approved PRs.

## Known limitations (platform landed)

PR [#33](https://github.com/aguil/agents/pull/33) lands the scheduler and
workers; the items below are tracked for **shippable E2E**, not blockers for
merging the platform PR.

| Topic                                                                        | GitHub issue                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| PR feedback ingest on posted review activity (beyond static thread snapshot) | [#36](https://github.com/aguil/agents/issues/36) (partial: interactive selection shipped) |
| Work-item terminal semantics; stop post-success retry churn                  | [#37](https://github.com/aguil/agents/issues/37) (shipped)                                |
| `WORKFLOW.md` hot reload (orchestrator/router/publish); graceful shutdown    | [#38](https://github.com/aguil/agents/issues/38)                                          |
| Code-review worker parity (worktree, publish-with-findings)                  | [#39](https://github.com/aguil/agents/issues/39)                                          |
| Per-feed concurrency, JSONL observability, production runbook                | [#40](https://github.com/aguil/agents/issues/40)                                          |
| Stall timeout: cancel or isolate in-flight implementation workers            | [#41](https://github.com/aguil/agents/issues/41) (shipped)                                |
| Real `app_server` JSON-RPC client                                            | [#34](https://github.com/aguil/agents/issues/34)                                          |
| MCP feed, `github_issues` dogfood, publish integration tests                 | [#35](https://github.com/aguil/agents/issues/35)                                          |

**Stall / reload behavior today:** when `agent.stall_timeout_ms` fires, the
orchestrator aborts the in-flight worker via `AbortSignal` and retries after the
dispatch settles ([#41](https://github.com/aguil/agents/issues/41)). Editing
`WORKFLOW.md` reloads the workflow definition, feed clients, and per-feed
concurrency without restart ([#38](https://github.com/aguil/agents/issues/38)
partial). Poll interval follows the reloaded definition on the next tick; worker
router and implementation adapter wiring are still fixed at process start.

## Interactive PR feedback selection

Default `policy.pr_feedback.profile` is **`interactive`**:

1. `agentsd` discovers authored PRs with unresolved threads and writes
   `.agentsd/pr-feedback-selection.json` under `AGENTSD_WORKSPACE`.
2. JSONL event `pr_feedback_selection_required` plus optional **system**
   notification (`notify-send` / `terminal-notifier`) and **webhook**.
3. Operator approves PRs:
   `agents pr-feedback select --selection-id <id> --approve owner/repo#n`.
4. Only approved PRs run the `pr_feedback` worker (collect → triage → fix).

`profile: unattended` requires explicit `policy.pr_feedback.allow` list.

## Production profile

| Setting                      | Recommendation                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `AGENTSD_WORKSPACE`          | Host repo path for `gh` and selection state                                      |
| `publish.*`                  | Keep **`off`** until playbook gates are configured                               |
| `policy.pr_feedback.profile` | `interactive` for operator-approved PRs                                          |
| `feeds[].max_concurrent`     | Cap per-feed parallelism (see `WORKFLOW.example.md`)                             |
| Notifications                | `notify-send` (Linux) or Slack via `SLACK_WEBHOOK_URL` + `slack_webhook` channel |

Golden-path smoke: `bun test tests/agentsd-followup.test.ts`. Example issue
feed:
[`docs/examples/WORKFLOW.github-issues.example.md`](examples/WORKFLOW.github-issues.example.md).
Notify receiver example:
[`docs/examples/notify-receiver/`](examples/notify-receiver/).

## One-shot CLI

Manual workflows remain on `agents` (`code-review`, `pr-feedback`, `triage`).
`agentsd` does not replace those commands.

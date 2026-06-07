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

**App server:** multi-turn loop via `AgentSessionClient` and the
`json_rpc_session_v1` line-delimited JSON-RPC driver (`agent.command` required).
Set `agent.protocol` to `json_rpc_session_v1` explicitly; the `codex:` alias
maps command and timeouts only (not `codex.protocol` — see ADR 0004).

### Publish execution (when enabled in `WORKFLOW.md`)

| Lane        | `pending` / `submit` behavior                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code review | Posts a **pending** GitHub review in-process via `@aguil/agents-code-review-post` when gates pass (no `agents` subprocess).                                           |
| PR feedback | Collect → triage → **fix** (subprocess adapter per triage item in `AGENTSD_WORKSPACE`) → re-collect/re-triage → `submit` when `responses.json` exists and gates pass. |

Implementation workers exceeding `agent.stall_timeout_ms` are released and
retried on the next poll tick (best-effort; in-flight work may still complete).

## Environment

| Variable                   | Effect                                                                  |
| -------------------------- | ----------------------------------------------------------------------- |
| `AGENTSD_PUBLISH=disabled` | Force all publish modes off                                             |
| `AGENTSD_WORKSPACE`        | Host repo path for `gh` / harness context (default: cwd)                |
| `AGENTSD_MCP_HANDLER`      | Module path exporting `mcpInvoke` (with `agentsd --with-mcp`)           |
| `AGENTSD_MCP_COMMAND`      | Shell command: JSON request on stdin, JSON response on last stdout line |
| `AGENTSD_NOTIFY_EMAIL_TO`  | When set, selection notify emits `pr_feedback_selection_email` JSONL    |

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

| Topic                                                                     | GitHub issue                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| PR feedback playbook (work report, deny list, commit verify)              | [#36](https://github.com/aguil/agents/issues/36) (shipped)                               |
| Work-item terminal semantics; stop post-success retry churn               | [#37](https://github.com/aguil/agents/issues/37) (shipped)                               |
| `WORKFLOW.md` hot reload (orchestrator/router/publish); graceful shutdown | [#38](https://github.com/aguil/agents/issues/38) (shipped: reload diff + `stopAndDrain`) |
| Code-review worker parity (worktree, publish-with-findings, notify)       | [#39](https://github.com/aguil/agents/issues/39) (shipped)                               |
| Per-feed concurrency, JSONL observability, production runbook             | [#40](https://github.com/aguil/agents/issues/40) (shipped: log sink + runbook)           |
| Stall timeout: cancel or isolate in-flight implementation workers         | [#41](https://github.com/aguil/agents/issues/41) (shipped)                               |
| Real `app_server` JSON-RPC client                                         | [#34](https://github.com/aguil/agents/issues/34) (shipped: `json_rpc_session_v1`)        |
| MCP feed, `github_issues` dogfood, publish integration tests              | [#35](https://github.com/aguil/agents/issues/35) (shipped: dogfood WORKFLOW + smoke doc) |
| PR feedback per-poll disk I/O optimization                                | [#51](https://github.com/aguil/agents/issues/51) (shipped: tick-scoped read cache)       |

**Stall / reload behavior today:** when `agent.stall_timeout_ms` fires, the
orchestrator aborts the in-flight worker via `AbortSignal` and retries after the
dispatch settles ([#41](https://github.com/aguil/agents/issues/41)). Editing
`WORKFLOW.md` reloads the workflow definition, feed clients, per-feed
concurrency caps (keyed by work-item `kind`), workspace hooks, implementation
stall timeout, and subprocess adapter selection on the next dispatch
([#38](https://github.com/aguil/agents/issues/38)). Poll interval follows the
reloaded definition on the next tick. SIGINT/SIGTERM call `stopAndDrain` to
await in-flight workers (up to 60s). Implementation workers read
`implementation.*` from the active definition each dispatch.

**MCP feed:** configure `feeds: [{ kind: mcp, server: …, list_tool: … }]` and
run `agentsd --with-mcp` with `AGENTSD_MCP_HANDLER` (module exporting
`mcpInvoke`) or `AGENTSD_MCP_COMMAND` (stdio JSON bridge). Tool output must
normalize to `{ issues: [...] }` for list/get (see `McpTrackerFeed`).

**Startup terminal cleanup** runs in the background (does not block the poll
loop). For `github_pr_feedback`, it only re-checks PRs that already have a
per-item workspace under `workspace.root` (`.agents-work-item.json` marker), not
every authored open PR.

## Interactive PR feedback selection

Default `policy.pr_feedback.profile` is **`interactive`**:

1. `agentsd` discovers authored PRs with unresolved threads (and **new review
   activity** when thread fingerprints change vs
   `.agentsd/pr-feedback-ingest.json`) and writes
   `.agentsd/pr-feedback-selection.json` under `AGENTSD_WORKSPACE`.
2. JSONL event `pr_feedback_selection_required` plus optional **system**
   notification (`notify-send` / `terminal-notifier`), **webhook**, **Slack**
   (`SLACK_WEBHOOK_URL`), or **email** (`AGENTSD_NOTIFY_EMAIL_TO` → JSONL
   event).
3. Optional **monitor** workspace: `policy.pr_feedback.notify.monitor` writes
   `monitor-context.json` for a control-repo IDE session.
4. Operator approves PRs:
   `agents pr-feedback select --selection-id <id> --approve owner/repo#n`.
5. Only approved PRs run the `pr_feedback` worker (collect → triage → fix).
   Multi-round drain re-dispatches while triage items or unresolved threads
   remain; the work item closes when both are empty (or submit completes).

`profile: unattended` requires explicit `policy.pr_feedback.allow` list. Use
`policy.pr_feedback.deny` to block specific `owner/repo#number` values in any
profile (deny wins over allow/approval).

Each `pr_feedback` worker pass writes a structured work report under
`.agentsd/pr-feedback-work-reports/` and emits JSONL `pr_feedback_work_report`
(disposition, triage/feedback paths, `item.id` → commit map).

## Production profile

| Setting                      | Recommendation                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `AGENTSD_WORKSPACE`          | Host repo path for `gh` and selection state                                      |
| `AGENTSD_LOG_FILE`           | Optional path to append stdout JSONL (file sink)                                 |
| `publish.*`                  | Keep **`off`** until playbook gates are configured                               |
| `policy.pr_feedback.profile` | `interactive` for operator-approved PRs                                          |
| `feeds[].max_concurrent`     | Cap per work-item kind (`github_issue`, `github_pr_feedback`, …) — see example   |
| Notifications                | `notify-send` (Linux) or Slack via `SLACK_WEBHOOK_URL` + `slack_webhook` channel |

### JSONL event catalog

Structured logs are one JSON object per line on stdout:

| Event                            | When                                                   |
| -------------------------------- | ------------------------------------------------------ |
| `agentsd_started`                | Process boot                                           |
| `workflow_reloaded`              | `WORKFLOW.md` changed on disk (`changed_fields` array) |
| `agentsd_stopping`               | SIGINT/SIGTERM drain started                           |
| `pr_feedback_selection_required` | Interactive selection pending                          |
| `pr_feedback_selection_email`    | Email channel configured (`AGENTSD_NOTIFY_EMAIL_TO`)   |
| `pr_feedback_work_report`        | Structured playbook work report written                |
| `pr_feedback_collected`          | `pr_feedback` worker finished a pass                   |
| `code_review_artifacts_ready`    | `publish.code_review: notify` — artifact paths only    |
| `publish_decision`               | Publish gate evaluated (workers)                       |
| `implementation_stalled`         | Stall timeout fired                                    |

Golden-path smoke: `bun test tests/agentsd-followup.test.ts`,
`tests/agentsd-publish-integration.test.ts`,
`tests/agentsd-reload-shutdown.test.ts`, `tests/pr-feedback-playbook.test.ts`,
`tests/agentsd-code-review-parity.test.ts`. Example issue feed:
[`docs/examples/WORKFLOW.github-issues.dogfood.md`](examples/WORKFLOW.github-issues.dogfood.md)
and smoke log
[`docs/examples/agentsd-github-issues-smoke.md`](examples/agentsd-github-issues-smoke.md).
Notify receiver example:
[`docs/examples/notify-receiver/`](examples/notify-receiver/).

### Code review worker options

```yaml
policy:
  code_review:
    use_worktree: true # detached PR worktree (CLI parity)
    publish_with_findings: true # allow pending post when triage items exist
```

## One-shot CLI

Manual workflows remain on `agents` (`code-review`, `pr-feedback`, `triage`).
`agentsd` does not replace those commands.

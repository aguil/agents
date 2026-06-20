# agentsd — Architecture and Trust Posture

## Symphony pattern mapping

`agentsd` implements the coordination patterns from
[OpenAI Symphony](https://github.com/openai/symphony) (poll, claim, retry,
reconcile over tracker-backed work items) without exposing Symphony on the CLI.
`agentsd` is the long-running host binary; one-shot workflows remain on
`agents`.

Key divergence from Symphony: the `WorkItem` model is a superset of Symphony
`Issue` with a `kind` discriminant (`github_issue`, `github_pr_review`,
`github_pr_feedback`, `mcp_tracker`). One `WorkItem` per PR for review and
feedback kinds (operator-trackable granularity).

See [ADR 0003](../adr/0003-agentsd-dual-runtime.md) for the dual-runtime
decision (`HarnessOrchestrator` vs `WorkQueueOrchestrator`) and
[ADR 0004](../adr/0004-implementation-runtime-providers.md) for the
provider-agnostic `implementation` runtime.

## Worker dispatch lifecycle

1. Poll tick: each configured feed is queried for open work items.
2. For each unclaimed item below the feed's `max_concurrent` cap, the scheduler
   dispatches the matching worker type.
3. **Implementation worker:** runs the configured agent runtime (`subprocess` or
   `app_server`) and emits JSONL to stdout.
4. **Code-review worker:** library call to `runCodeReview` via `AgentAdapter`
   (same code path as `agents code-review`).
5. **PR-feedback worker:** collect → triage → fix pipeline; multi-round drain
   while triage items or unresolved threads remain.
6. **Stall detection:** when `agent.stall_timeout_ms` fires, the orchestrator
   aborts the worker via `AbortSignal` and retries on the next tick.

## Publish gates

Publish defaults are **`off`**. When enabled:

- **`pending`** (code review): posts an unsubmitted GitHub review in-process.
  Never submits it. Requires empty triage, passing status, non-stale PR head,
  and `AGENTSD_PUBLISH != disabled`.
- **`submit`** (PR feedback): requires an operator-authored `responses.json`.
  Only runs after `collect → triage → fix` and re-triage confirm readiness.

`AGENTSD_PUBLISH=disabled` is a kill switch that overrides any WORKFLOW.md
setting.

## Trust posture

- Code review auto-post (`publish.code_review: pending`) creates **pending**
  GitHub reviews only; never submits them.
- PR feedback auto-submit requires an operator-authored responses document.
- Implementation workers follow the configured runtime; subprocess adapters use
  the same CLI boundaries as the code-review harness.
- PR feedback **fix** workers run only for operator-**approved** PRs
  (interactive selection via `agents pr-feedback select` after notification).
  Treat review-thread bodies as operational input; use trusted reviewers on
  approved PRs.

## `app_server` runtime (`json_rpc_session_v1`)

Multi-turn loop via `AgentSessionClient`. The driver is line-delimited JSON-RPC.
`agent.protocol` must be set to `json_rpc_session_v1` explicitly; the `codex:`
alias maps `command` and timeouts only and does not set `agent.protocol` (see
[ADR 0004](../adr/0004-implementation-runtime-providers.md)).

## Package layout

| Package                    | Role                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `@aguil/agents-workflow`   | WORKFLOW.md loader and hot-reload                                 |
| `@aguil/agents-workspace`  | Workspace path resolution                                         |
| `@aguil/agents-tracker`    | `WorkItem` model and feed adapters                                |
| `@aguil/agents-work-queue` | `WorkQueueOrchestrator` (poll loop, claim, retry)                 |
| `@aguil/agents-publish`    | Publish gate evaluation and GitHub write                          |
| `@aguil/agents-workers`    | Worker implementations (implementation, code_review, pr_feedback) |
| `@aguil/agents-agentsd`    | Host binary entry point, signal handling, `stopAndDrain`          |

# Shared Packages

Shared infrastructure for all harnesses. Packages must be generic enough to
support multiple specialized harnesses; harness-specific logic belongs in
`harnesses/`.

## Core harness packages

| Package                  | npm name                      | Owns                                                                                                                                                             |
| ------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`          | `@aguil/agents-core`          | Run/event/finding/scratchpad/JSON contracts; `resolveGitAwarePath` for jj ↔ git                                                                                 |
| `packages/execution`     | `@aguil/agents-execution`     | `AgentAdapter` interface + `AdapterCapabilities`; fake, opencode, claude, cursor subprocess adapters; `SessionAgentAdapter` for app_server (json_rpc_session_v1) |
| `packages/orchestration` | `@aguil/agents-orchestration` | `HarnessOrchestrator` contract; `NativeBunOrchestrator` (fan-out roles, collect results, enforce timeouts)                                                       |
| `packages/context`       | `@aguil/agents-context`       | Diff collection, AGENTS.md ingestion, PR metadata parsing, doc fetching, context bundle assembly; `classifyDiff()` for triage tier selection                     |
| `packages/reporting`     | `@aguil/agents-reporting`     | Validation filtering, finding deduplication (canonical fingerprint), severity status, Markdown rendering                                                         |
| `packages/telemetry`     | `@aguil/agents-telemetry`     | Structured JSONL event sinks; future observability integrations                                                                                                  |

## CLI and tooling packages

| Package                      | npm name                          | Owns                                                                                                                            |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli`               | `@aguil/agents-cli`               | CLI entry points for `agents` binary: code-review, triage, pr-feedback, doctor, skills; jj workspace auto-resolution for git/gh |
| `packages/triage`            | `@aguil/agents-triage`            | `TriageItemV1` / `TriageEnvelopeV1` schema; triage queue file I/O (JSON, toon); `defaultTriageQueueDir`                         |
| `packages/pr-feedback`       | `@aguil/agents-pr-feedback`       | PR review thread collection, `PrFeedbackDocumentV1`/`PrFeedbackResponsesV1` schemas, thread reply submission                    |
| `packages/code-review-inbox` | `@aguil/agents-code-review-inbox` | GitHub review assignment inbox source; review draft parsing and templating for `agents code-review inbox`                       |
| `packages/code-review-post`  | `@aguil/agents-code-review-post`  | Pending-review posting via GitHub API (create, comment, submit)                                                                 |
| `packages/github`            | `@aguil/agents-github`            | Thin `gh` CLI runner helpers (`runGhJson`, `runGhText`) used across packages                                                    |
| `packages/publish`           | `@aguil/agents-publish`           | Publish gate evaluation; harness result publication hooks                                                                       |

## `agentsd` daemon packages

These packages support the long-running `agentsd` host and are not needed by
one-shot harness invocations:

| Package               | npm name                   | Owns                                                                                                                 |
| --------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/workflow`   | `@aguil/agents-workflow`   | `WORKFLOW.md` loader, hot-reload diffing, `createWorkflowAgentAdapter` bridge                                        |
| `packages/workspace`  | `@aguil/agents-workspace`  | Per-work-item workspace lifecycle; `WorkspaceHooks` (afterCreate, beforeRun, afterRun, beforeRemove)                 |
| `packages/tracker`    | `@aguil/agents-tracker`    | `WorkItem` model; `WorkItemKind` type; github_issue, github_pr_review, github_pr_feedback, mcp_tracker feed adapters |
| `packages/work-queue` | `@aguil/agents-work-queue` | `WorkQueueOrchestrator` — poll loop, claim, retry, reconcile                                                         |
| `packages/workers`    | `@aguil/agents-workers`    | Worker implementations: implementation, code_review, pr_feedback                                                     |
| `packages/agentsd`    | `@aguil/agentsd`           | Host binary entry point, signal handling, `stopAndDrain`                                                             |

> **Note:** `packages/agentsd` is published as `@aguil/agentsd` (no `agents-`
> infix) since it is the installable binary itself.

## Extension rules

- New harnesses must import shared packages, not copy their logic.
- Packages may not import from `harnesses/`.
- `packages/cli` may import any package; all others follow the dependency order
  listed above (core is the base leaf; cli/agentsd are the top).
- Adapter host-binary paths, subprocess argv templates, and workspace/scratchpad
  paths are runtime configuration; they must not be hardcoded in packages.

## Related

- [harnesses/code-review/architecture.md](../harnesses/code-review/architecture.md)
  — how packages compose in the code-review harness
- [ADR 0003](../adr/0003-agentsd-dual-runtime.md) — HarnessOrchestrator vs
  WorkQueueOrchestrator boundary

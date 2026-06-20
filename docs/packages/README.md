# Shared Packages

Shared infrastructure for all harnesses. Packages must be generic enough to
support multiple specialized harnesses; harness-specific logic belongs in
`harnesses/`.

## Package responsibilities

| Package                  | npm name                      | Owns                                                                                                              | May import                                      |
| ------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `packages/core`          | `@aguil/agents-core`          | Run/event/finding/scratchpad/JSON contracts; `resolveGitAwarePath` for jj ↔ git                                  | (none — base layer)                             |
| `packages/execution`     | `@aguil/agents-execution`     | `AgentAdapter` interface; fake, opencode, claude, cursor subprocess adapters; `AgentSessionClient` for app_server | `@aguil/agents-core`                            |
| `packages/orchestration` | `@aguil/agents-orchestration` | `HarnessOrchestrator` contract; `NativeBunOrchestrator` (fan-out, timeouts)                                       | `@aguil/agents-core`, `@aguil/agents-execution` |
| `packages/context`       | `@aguil/agents-context`       | Diff collection, AGENTS.md ingestion, PR metadata parsing, doc fetching, context bundle assembly                  | `@aguil/agents-core`                            |
| `packages/reporting`     | `@aguil/agents-reporting`     | Validation filtering, finding deduplication (canonical fingerprint), severity status, Markdown rendering          | `@aguil/agents-core`                            |
| `packages/telemetry`     | `@aguil/agents-telemetry`     | Structured JSONL event sinks; future observability integrations                                                   | `@aguil/agents-core`                            |
| `packages/cli`           | `@aguil/agents-cli`           | CLI entry points; jj workspace auto-resolution for git/gh commands                                                | all packages                                    |

## agentsd-specific packages

These packages support the `agentsd` daemon and are not required by one-shot
harnesses:

| Package               | npm name                   | Owns                                                                                    |
| --------------------- | -------------------------- | --------------------------------------------------------------------------------------- |
| `packages/workflow`   | `@aguil/agents-workflow`   | WORKFLOW.md loader and hot-reload diffing                                               |
| `packages/workspace`  | `@aguil/agents-workspace`  | Workspace path resolution for multi-repo contexts                                       |
| `packages/tracker`    | `@aguil/agents-tracker`    | `WorkItem` model; github_issue, github_pr_review, github_pr_feedback, mcp feed adapters |
| `packages/work-queue` | `@aguil/agents-work-queue` | `WorkQueueOrchestrator` — poll loop, claim, retry, reconcile                            |
| `packages/publish`    | `@aguil/agents-publish`    | Publish gate evaluation; GitHub pending-review post                                     |
| `packages/workers`    | `@aguil/agents-workers`    | Worker implementations: implementation, code_review, pr_feedback                        |
| `packages/agentsd`    | `@aguil/agents-agentsd`    | Host binary entry point, signal handling, `stopAndDrain`                                |

## Extension rules

- New harnesses must import shared packages, not copy their logic.
- Packages may not import from `harnesses/`.
- `packages/cli` may import any package; all others follow the dependency order
  listed above (core → execution → orchestration/context/reporting/telemetry).
- Adapter host-binary paths, subprocess argv templates, and workspace/scratchpad
  paths are runtime configuration; they must not be hardcoded in packages.

## Related

- [harnesses/code-review/architecture.md](../harnesses/code-review/architecture.md)
  — how packages compose in the code-review harness
- [ADR 0003](../adr/0003-agentsd-dual-runtime.md) — HarnessOrchestrator vs
  WorkQueueOrchestrator boundary

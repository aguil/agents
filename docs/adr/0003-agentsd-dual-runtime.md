# ADR 0003: Dual runtime — harness orchestration and `agentsd` work queue

**Status:** Accepted  
**Context:**
[OpenAI Symphony](https://github.com/openai/symphony/blob/main/SPEC.md) defines
a long-running scheduler (poll, claim, retry, reconcile) over tracker-backed
work items. This monorepo already has a **one-shot harness** model: parallel
review roles, structured `Finding` outputs, and GitHub-centric CLIs
(`agents code-review`, inbox, pr-feedback). We need both without collapsing them
into one orchestrator type.

**Decision:**

1. **Rename the harness contract**

   - `HarnessOrchestrator` — fan-out roles for a single harness run (today’s
     `NativeBunOrchestrator`).
   - `Orchestrator` remains a deprecated alias for `HarnessOrchestrator`.
   - `WorkQueueOrchestrator` — poll loop, claims, retries, reconciliation over
     `WorkItem`s (`packages/work-queue`).

2. **`agentsd` boundary**

   - Long-running host binary (`packages/agentsd`); loads repo `WORKFLOW.md`.
   - No `agents symphony` subcommand — Symphony is an internal pattern only.
   - One-shot workflows stay on `agents`.

3. **`WorkItem` model** (`packages/tracker`)

   - Superset of Symphony `Issue` with `kind`: `github_issue`,
     `github_pr_review`, `github_pr_feedback`, `mcp_tracker`.
   - **One `WorkItem` per PR** for `github_pr_review` and `github_pr_feedback`
     (operator-trackable granularity).
   - `identifier` examples: `org/repo#42-review`, `org/repo#42-feedback`.

4. **Work feeds**

   - `github_issues` — primary issue tracker adapter (Linear deferred).
   - `github_pr_review` — inbox assignments → code-review worker.
   - `github_pr_feedback` — unresolved threads per PR → pr-feedback worker.
   - `mcp` — pluggable tracker via configured MCP tools (e.g. Jira); no in-tree
     REST adapter required.

5. **Publish policy** (`packages/publish`, `WORKFLOW.md` `publish` block)

   - Default: `publish.code_review: off`, `publish.pr_feedback: off`.
   - GitHub writes only when explicitly enabled and gates pass (empty triage,
     status, staleness, dry-run refusal).
   - `AGENTSD_PUBLISH=disabled` kill switch overrides workflow.

6. **Workers**
   - `implementation` — configurable agent runtime (`subprocess` or
     `app_server`); not tied to a single vendor (see ADR 0004).
   - `code_review` — library call to `runCodeReview` via `AgentAdapter`.
   - `pr_feedback` — collect → triage → fix pipeline; submit only when
     `publish.pr_feedback: submit`.

**Consequences:**

- New packages: `workflow`, `workspace`, `tracker`, `work-queue`, `publish`,
  `workers`, `agentsd`.
- `tsconfig` path aliases and contract tests for scheduler + workflow loader.
- Mastra remains optional; daemon scheduling follows Symphony-shaped contracts
  first.

**References:** Plan “Symphony spec fit for agents”;
[`AGENTS.md`](../../AGENTS.md);
[`docs/harnesses/code-review/architecture.md`](../harnesses/code-review/architecture.md).

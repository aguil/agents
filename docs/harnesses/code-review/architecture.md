# Code Review Harness — Architecture

## Design principles

- Native Bun/TypeScript orchestration owns role fan-out, JSONL logging,
  scratchpad persistence, timeout boundaries, and report synthesis.
- Execution is agent-agnostic. The adapter contract is the only coupling point
  between orchestration and the underlying agent CLI.
- CrewAI is intentionally out of scope. A TypeScript framework such as Mastra
  can be introduced later behind the same `HarnessOrchestrator` contract if
  workflow memory, graph tooling, or eval integrations justify it.

## Package layers

```
packages/core          Shared run, event, finding, scratchpad, and JSON contracts.
                       Also: resolveGitAwarePath() for jj ↔ git workspace mapping.

packages/execution     AgentAdapter interface + fake, opencode, claude, and cursor
                       subprocess adapters (SubprocessAgentAdapter base).
                       AgentSessionClient for app_server (json_rpc_session_v1).

packages/orchestration HarnessOrchestrator contract + NativeBunOrchestrator
                       (fan-out roles, collect results, enforce timeouts).

packages/context       Diff collection, AGENTS.md ingestion, PR metadata/body
                       parsing, referenced-doc fetching, context bundle assembly.

packages/reporting     Validation filtering, deduplication (canonical fingerprint),
                       severity status, Markdown report rendering.

packages/telemetry     Structured event sinks for JSONL logs and future
                       observability integrations.

harnesses/code-review  Review roles, prompts, triage flow, and harness assembly.
                       Exports review-contract.ts for CLI and agentsd consumers.
```

Allowed dependency direction: `harnesses/code-review` → `packages/*`. Packages
may depend on each other following the order listed above (core is the base;
harnesses are the leaves).

## Adapter contract

`AgentAdapter` is the single extension point for adding a new agent CLI:

```typescript
interface AgentAdapter {
  run(request: AdapterRequest): Promise<AdapterResult>;
}
```

`SubprocessAgentAdapter` provides the base implementation:

- Writes per-role request artifacts to the scratchpad.
- Spawns the agent CLI subprocess with a constructed argv.
- Enforces role timeouts via `AbortSignal`.
- Reads stdout as newline-delimited JSONL and normalizes finding events.
- Captures stderr to `roles/<role>/stderr.log` for debugging.

Current real adapters and their subprocess entry points:

| Adapter             | Subprocess                                                 |
| ------------------- | ---------------------------------------------------------- |
| `OpenCodeAdapter`   | `opencode run --format json`                               |
| `ClaudeCodeAdapter` | `claude` (configurable argv template)                      |
| `CursorAdapter`     | `agent --print --output-format stream-json` (configurable) |
| `FakeAgentAdapter`  | In-process deterministic output (no subprocess)            |

## Orchestration flow

```
1. Context collection
   └─ packages/context: diff, AGENTS.md, PR metadata, referenced docs → bundle.json

2. Triage
   └─ harnesses/code-review: score PR signals → select tier (trivial | lite | full)
      └─ write triage.json

3. Role fan-out (NativeBunOrchestrator)
   └─ For each role in expectedRolesForTriageTier(tier):
      ├─ Construct AdapterRequest (context bundle + role prompt)
      ├─ Write <role>.request.json to scratchpad
      ├─ adapter.run(request) with timeout
      └─ Collect AdapterResult (findings JSONL)

4. Report synthesis
   └─ packages/reporting:
      ├─ Filter to verified, substantive findings
      ├─ Deduplicate by canonical fingerprint
      ├─ Assign overall status
      └─ Render report.md

5. Write result.json, result.raw.json, events.jsonl
```

## Context retrieval

- Auto-discovers the active PR via `gh pr view`.
- When `--pr <number>` is set, checks out a detached git worktree at the PR head
  under `.agents-code-review/worktrees/` (workspace tree stays untouched).
- Reads PR title and body into context.
- Extracts and fetches docs linked in the PR body, scoped to the tracked remote
  org (non-fatal on failure).
- Context warnings are non-fatal; review continues with partial context.

## Scratchpad layout

See
[spec/review-contract.md](spec/review-contract.md#scratchpad-artifact-layout).

## Pending-review posting

Posting is a separate step from review execution and is never automatic:

1. `--pending-review` (or `agents code-review post`) calls GitHub API to create
   an unsubmitted review.
2. Staleness check: compares `pr_reviewed_head_sha` (captured at context
   collection) against the current PR head. Stale = warn or abort unless
   `--no-confirm`.
3. Anchorable findings (those with `file` + `line`) are posted as inline
   comments. Non-anchorable findings appear only in the review body.
4. When at least one hunk is mappable, the summary is the first inline thread
   (review `body` left empty to avoid blank GitHub submission).

## jj workspace support

`resolveGitAwarePath()` in `packages/core` maps a jj workspace path (`.jj/repo`
present, no `.git`) to its canonical colocated repo so git/gh commands work
correctly. The CLI passes the resolved path to all subprocess and API calls.

## Related

- [prd.md](prd.md) — requirements and acceptance criteria
- [spec/result-schema.md](spec/result-schema.md) — `result.json` field spec
- [spec/events-catalog.md](spec/events-catalog.md) — JSONL event catalog
- [spec/review-contract.md](spec/review-contract.md) — roles, triage tiers, wire
  keys
- [ADR 0003](../../adr/0003-agentsd-dual-runtime.md) — HarnessOrchestrator vs
  WorkQueueOrchestrator
- [ADR 0004](../../adr/0004-implementation-runtime-providers.md) — app_server
  runtime

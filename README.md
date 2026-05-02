# Agents

Reusable Bun/TypeScript harnesses for running specialized coding-agent workflows.

The repository starts with a code-review harness and shared runtime boundaries. Specialized harnesses should build on the shared packages instead of embedding process execution, context collection, reporting, or telemetry logic directly.

## Layout

```text
agents/
  docs/             Architecture notes, ADRs, and harness-specific planning.
  harnesses/        Specialized workflows built from shared packages.
  packages/         Shared contracts and runtime infrastructure.
```

## Commands

```bash
bun install
bun run typecheck
bun test
bun run agents run code-review --adapter fake
bun run agents run code-review --adapter opencode --model <provider/model>
bun run agents run code-review --adapter claude --model <model>
bun run agents run code-review --adapter claude --model <model> --strict
bun run agents run code-review --adapter opencode --model opencode/gpt-5.3-codex --pending-review
bun run agents run code-review --adapter opencode --model opencode/gpt-5.3-codex --pending-review --review-summary impact
```

## Review Summary Options

- `triage` (default): choose this when the PR author needs a fast, action-first queue. It surfaces what to fix immediately vs what can wait in follow-up.
- `impact`: choose this when changes span multiple concerns or teams. It groups findings by domain (security, performance, quality, compliance) so owners can pick up the right slice quickly.
- `evidence`: choose this when findings are nuanced, likely to be debated, or need stronger context. It expands each finding into "Why / Evidence / Fix" to support remediation decisions.

Examples:

```bash
bun run agents run code-review --adapter opencode --model opencode/gpt-5.3-codex --pending-review --review-summary triage
bun run agents run code-review --adapter opencode --model opencode/gpt-5.3-codex --pending-review --review-summary impact
bun run agents run code-review --adapter opencode --model opencode/gpt-5.3-codex --pending-review --review-summary evidence
```

## Principles

- Bun/TypeScript is the default runtime and implementation language.
- Harnesses are agent-agnostic and call execution adapters through typed contracts.
- OpenCode can be the first adapter, but it should not become the architecture.
- Native orchestration comes first; framework-backed orchestration can be added later behind the same contracts.
- Review outputs should be structured, resumable, and biased toward high-signal findings.

## Current Harnesses

- `harnesses/code-review`: multi-role code review using native Bun orchestration, JSONL events, scratchpad artifacts, risk-tier triage, and an agent-agnostic execution adapter.

The `fake` adapter is deterministic and intended for local smoke tests. The `opencode` and `claude` adapters shell out to their CLIs and normalize emitted finding JSONL into harness events.

The code-review harness also attempts to auto-discover the active PR, ingest PR title/description, and fetch PR-referenced docs scoped to the configured tracking-remote org.

## Human In The Loop

- Run review locally from your working branch.
- Inspect `report.md` for human-readable findings and `result.json` for machine-readable status.
- Fix code or mark rationale in your PR description/comments.
- Re-run until output is acceptable.
- Optionally post findings as an unsubmitted PR review with `--pending-review`.

See `harnesses/code-review/README.md` for the concrete run workflow and expected output artifacts.

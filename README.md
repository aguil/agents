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
```

## Principles

- Bun/TypeScript is the default runtime and implementation language.
- Harnesses are agent-agnostic and call execution adapters through typed contracts.
- OpenCode can be the first adapter, but it should not become the architecture.
- Native orchestration comes first; framework-backed orchestration can be added later behind the same contracts.
- Review outputs should be structured, resumable, and biased toward high-signal findings.

## Current Harnesses

- `harnesses/code-review`: multi-role code review using native Bun orchestration, JSONL events, scratchpad artifacts, risk-tier triage, and an agent-agnostic execution adapter.

The `fake` adapter is deterministic and intended for local smoke tests. The `opencode` adapter shells out to `opencode run --format json` and normalizes emitted finding JSONL into harness events.

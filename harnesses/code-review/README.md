# Code Review Harness

Multi-agent code review harness built on the shared Bun/TypeScript runtime. Runs
role-specialized reviewers in parallel through an agent-agnostic execution
adapter. OpenCode, Claude Code, Cursor CLI, and pi.dev can be added as adapters
without changing the code-review workflow.

Current adapters:

- `FakeAgentAdapter` — deterministic tests and local smoke runs
- `OpenCodeAdapter` — `opencode run --format json` subprocess
- `ClaudeCodeAdapter` — Claude Code CLI subprocess
- `CursorAdapter` — Cursor CLI subprocess

## Quick start

```bash
# Deterministic smoke test (no provider/API calls)
bun run agents code-review --adapter fake

# Real review runs
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex
bun run agents code-review --adapter claude  --model claude-sonnet-4
bun run agents code-review --adapter cursor  --model sonnet-4
```

```bash
bun run agents code-review --help   # full flag reference
```

## User guide

Full documentation lives under `docs/guide/code-review/`:

| Topic                                       | Doc                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------- |
| Adapter commands and model IDs              | [adapters.md](../../docs/guide/code-review/adapters.md)               |
| Config files, merge order, presets          | [configuration.md](../../docs/guide/code-review/configuration.md)     |
| `AGENTS_CODE_REVIEW_*` env vars             | [environment.md](../../docs/guide/code-review/environment.md)         |
| HITL workflow, pending review, post, replay | [workflows.md](../../docs/guide/code-review/workflows.md)             |
| Debugging and known limitations             | [troubleshooting.md](../../docs/guide/code-review/troubleshooting.md) |

## Internal docs

Architecture and data-contract specs live under `docs/harnesses/code-review/`:

| Doc                                                                                 | Contents                                              |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [prd.md](../../docs/harnesses/code-review/prd.md)                                   | Product requirements and acceptance criteria          |
| [architecture.md](../../docs/harnesses/code-review/architecture.md)                 | Package layers, adapter contract, orchestration flow  |
| [spec/result-schema.md](../../docs/harnesses/code-review/spec/result-schema.md)     | `result.json` and `result.raw.json` field spec        |
| [spec/events-catalog.md](../../docs/harnesses/code-review/spec/events-catalog.md)   | JSONL event types emitted by the harness              |
| [spec/review-contract.md](../../docs/harnesses/code-review/spec/review-contract.md) | Roles, triage tiers, finding shape, scratchpad layout |

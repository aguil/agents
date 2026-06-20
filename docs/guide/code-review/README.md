# Code Review — User Guide

Multi-agent code review harness. Runs role-specialized reviewers in parallel
through an agent-agnostic adapter and produces a structured `report.md` plus
`result.json`.

## Quick start

```bash
# Deterministic smoke test (no provider/API calls)
bun run agents code-review --adapter fake

# Real review with OpenCode
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex

# Real review with Claude
bun run agents code-review --adapter claude --model claude-sonnet-4

# Real review with Cursor
bun run agents code-review --adapter cursor --model sonnet-4
```

Context help:

```bash
bun run agents --help                      # overview of all commands
bun run agents code-review --help          # code-review flags
bun run agents code-review replay --help
bun run agents code-review post --help
```

## Choosing an adapter

| Adapter    | When to use                                           |
| ---------- | ----------------------------------------------------- |
| `fake`     | Local smoke tests and CI checks; deterministic output |
| `opencode` | Multi-provider flexibility, variant pinning           |
| `claude`   | Direct Claude Code CLI workflows                      |
| `cursor`   | Direct Cursor CLI workflows with MCP support          |

See [adapters.md](adapters.md) for command examples and model IDs.

## Further reading

| Topic                                       | Doc                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Adapter commands and model IDs              | [adapters.md](adapters.md)                                                                             |
| Config files, presets, merge order          | [configuration.md](configuration.md)                                                                   |
| `AGENTS_CODE_REVIEW_*` env vars             | [environment.md](environment.md)                                                                       |
| HITL workflow, pending review, post, replay | [workflows.md](workflows.md)                                                                           |
| Debugging and known limitations             | [troubleshooting.md](troubleshooting.md)                                                               |
| `result.json` / `events.jsonl` schemas      | [../../harnesses/code-review/spec/result-schema.md](../../harnesses/code-review/spec/result-schema.md) |

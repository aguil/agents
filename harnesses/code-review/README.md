# Code Review Harness

Multi-agent code review harness built on the shared Bun/TypeScript runtime.

The harness runs role-specialized reviewers in parallel through an agent-agnostic execution adapter. OpenCode, Claude Code, Cursor CLI, and pi.dev can be added as adapters without changing the code-review workflow.

The first implementation includes:

- `FakeAgentAdapter` for deterministic tests and local smoke runs.
- `OpenCodeAdapter` for real opt-in reviewer sessions through `opencode run --format json`.

Run locally with:

```bash
bun run agents run code-review --adapter fake
bun run agents run code-review --adapter opencode --model <provider/model>
```

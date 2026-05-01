### Code Review Harness Architecture

The first implementation uses a high-throughput multi-agent orchestration model implemented directly in Bun/TypeScript.

CrewAI is intentionally out of scope. Native orchestration owns role fan-out, JSONL logging, scratchpad persistence, timeout boundaries, and report synthesis. The orchestration contract remains internal so a TypeScript framework such as Mastra can be introduced later if workflow memory, graph tooling, or eval integrations justify it.

Execution is agent-agnostic. OpenCode can become the first production adapter, while Claude Code, Cursor CLI, pi.dev, or other coding agents can be swapped in through the same adapter contract.

Primary layers:

- `packages/core`: shared run, event, finding, scratchpad, and JSON contracts.
- `packages/execution`: adapter interface plus fake and subprocess-backed adapters.
- `packages/orchestration`: native Bun role orchestration behind an `Orchestrator` contract.
- `packages/context`: diff, `AGENTS.md`, and future MCP context bundle generation.
- `packages/reporting`: validation filtering, dedupe, severity status, and Markdown rendering.
- `harnesses/code-review`: code-review roles, prompts, triage flow, and final harness assembly.

Triage behavior:

- `trivial`: run quality review only.
- `lite`: run security, quality, and compliance review.
- `full`: run every configured role.

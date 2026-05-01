### Code Review Harness Architecture

The first implementation uses a high-throughput multi-agent orchestration model implemented directly in Bun/TypeScript.

CrewAI is intentionally out of scope. Native orchestration owns role fan-out, JSONL logging, scratchpad persistence, timeout boundaries, and report synthesis. The orchestration contract remains internal so a TypeScript framework such as Mastra can be introduced later if workflow memory, graph tooling, or eval integrations justify it.

Execution is agent-agnostic. OpenCode can become the first production adapter, while Claude Code, Cursor CLI, pi.dev, or other coding agents can be swapped in through the same adapter contract.

Current real adapters include:

- `OpenCodeAdapter`, which wraps `opencode run --format json` as a subprocess.
- `ClaudeCodeAdapter`, which wraps the Claude Code CLI as a subprocess with configurable argument templates.

Both adapters use the same `SubprocessAgentAdapter` base to write per-role request artifacts, enforce role timeouts, and normalize finding JSONL into harness events. The same base is intended to support Cursor CLI, pi.dev, and other CLIs later.

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

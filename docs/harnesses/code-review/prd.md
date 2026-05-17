### Product Requirement Document: Autonomous Code Review Agent Harness

This harness reduces code-review wait time by running a specialized,
deterministic, multi-agent review workflow. It should bias toward approval,
suppress nitpicks, and only report critical or warning findings with concrete
evidence and validation.

Core requirements:

- Risk-tier PRs into trivial, lite, and full review modes.
- Fetch context beyond the diff, including `AGENTS.md`, docs, dependency maps,
  and MCP sources later.
- Require validation evidence before findings are included in the final report.
- Track durable scratchpad artifacts so interrupted runs can be resumed.
- Use generic CLI tooling and agent-agnostic adapters instead of bespoke
  per-agent protocols.

Initial success criteria:

- Run a local review in under five minutes for normal PR-sized diffs.
- Produce a single Markdown report from normalized findings.
- Keep unverified findings out of the final actionable report.
- Make OpenCode, Claude Code, Cursor CLI, pi.dev, and future agents swappable
  through execution adapters.
- Keep real agent execution opt-in; deterministic local tests use the fake
  adapter.

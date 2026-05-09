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

## Quick Start

```bash
bun install
bun run build
bun run typecheck
bun test
```

## Prebuilt CLI

When running reviews from another terminal/host checkout of `aguil/agents`, build once after pulling updates:

```bash
cd /path/to/aguil/agents
bun run build
```

Then run reviews from your work-repo terminal with the bundled launcher:

```bash
/path/to/aguil/agents/dist/agents code-review --adapter opencode --model opencode/gpt-5.3-codex
```

`dist/` is gitignored, so the build stays local to each host checkout.

See `BUILD.md` for details.

## Principles

- Bun/TypeScript is the default runtime and implementation language.
- Harnesses are agent-agnostic and call execution adapters through typed contracts.
- OpenCode can be the first adapter, but it should not become the architecture.
- Native orchestration comes first; framework-backed orchestration can be added later behind the same contracts.
- Review outputs should be structured, resumable, and biased toward high-signal findings.

## Current Harnesses

- `harnesses/code-review`: multi-role code review using native Bun orchestration, JSONL events, scratchpad artifacts, risk-tier triage, and an agent-agnostic execution adapter.

The `fake` adapter is deterministic and intended for local smoke tests. The `opencode`, `claude`, and `cursor` adapters shell out to their CLIs and normalize emitted finding JSONL into harness events.

The code-review harness also attempts to auto-discover the active PR, ingest PR title/description, and fetch PR-referenced docs scoped to the configured tracking-remote org.

See `harnesses/code-review/README.md` for code-review commands, adapter examples, model references, and workflow details.

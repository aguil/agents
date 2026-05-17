# Agents

Reusable Bun/TypeScript harnesses for running specialized coding-agent workflows.

The repository starts with a code-review harness and shared runtime boundaries. Specialized harnesses should build on the shared packages instead of embedding process execution, context collection, reporting, or telemetry logic directly.

## Agent playbooks (optional)

Portable **Agent Skills** playbooks for `agents code-review` / `agents triage` workflows live under [`docs/skills/`](docs/skills/README.md). Use **`agents doctor`** (see **`agents doctor --help`**) to confirm your CLI semver satisfies bundled playbooks, then **`agents skills install <id>`** (see **`agents skills --help`**) to copy a playbook into your host’s skills directory (for example **`~/.agents/skills/<id>/`**) when you want that guidance in Cursor, Claude Code, or another compatible client. Published **`@aguil/agents`** tarballs include **`docs/skills/`** so the same commands work after `npm install -g`.

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
bun run check    # typecheck + Biome lint/format
bun test
bun run test:coverage   # optional: LCOV + text under coverage/
```

## Install from npm (when released)

Official releases publish [`@aguil/agents`](https://www.npmjs.com/package/@aguil/agents); the launcher still invokes **Bun**, so ensure Bun **`>= 1.3.13`** is installed before grabbing the tarball.

```bash
npm install -g @aguil/agents
agents code-review --help
```

Prefer building from git for day-to-day development of this repo; see **Prebuilt CLI** below and `BUILD.md` for tarball details.

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

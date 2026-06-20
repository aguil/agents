# Agents

Reusable Bun/TypeScript harnesses for running specialized coding-agent
workflows.

The repository starts with a code-review harness and shared runtime boundaries.
Specialized harnesses should build on the shared packages instead of embedding
process execution, context collection, reporting, or telemetry logic directly.

## Documentation

- **[docs/guide/](docs/guide/README.md)** — user guide: install, code-review,
  agentsd
- **[docs/](docs/README.md)** — full index (user guide, examples, skills, ADRs,
  architecture, specs)

## Layout

```text
agents/
  docs/
    guide/        User guide and reference (install, code-review, agentsd).
    adr/          Architecture Decision Records.
    harnesses/    PRDs, architecture, and data-contract specs per harness.
    packages/     Shared package boundary spec.
    agentsd/      agentsd internal architecture doc.
    examples/     Example WORKFLOW files and smoke runs.
    skills/       Portable agent playbooks (agents skills install).
  harnesses/      Specialized workflows built from shared packages.
  packages/       Shared contracts and runtime infrastructure.
```

## Quick start (development)

```bash
bun install
bun run build
bun run check    # typecheck + Biome lint/format
bun test
bun run test:coverage   # optional: LCOV + text under coverage/
```

See [docs/guide/install.md](docs/guide/install.md) for local build details,
running from another checkout, and npm install.

## Principles

- Bun/TypeScript is the default runtime and implementation language.
- Harnesses are agent-agnostic and call execution adapters through typed
  contracts.
- OpenCode can be the first adapter, but it should not become the architecture.
- Native orchestration comes first; framework-backed orchestration can be added
  later behind the same contracts.
- Review outputs should be structured, resumable, and biased toward high-signal
  findings.

## Current harnesses

- `harnesses/code-review` — multi-role code review using native Bun
  orchestration, JSONL events, scratchpad artifacts, risk-tier triage, and an
  agent-agnostic execution adapter.

See [harnesses/code-review/README.md](harnesses/code-review/README.md) for quick
start, adapter examples, and links to the full user guide and internal docs.

## Agent playbooks (optional)

Portable **Agent Skills** playbooks for `agents code-review` (including
`agents code-review inbox`) / `agents triage` workflows live under
[`docs/skills/`](docs/skills/README.md). Use **`agents doctor`** to confirm your
CLI semver satisfies bundled playbooks, then **`agents skills install`** (all
skills) or **`agents skills install <id>`** to copy playbooks into your host's
skills directory. Published `@aguil/agents` tarballs include `docs/skills/` so
the same commands work after `npm install -g`.

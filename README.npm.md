# `@aguil/agents`

Bundled **`agents`** CLI for the
[`aguil/agents`](https://github.com/aguil/agents) repository. Published builds
run the **`dist/agents`** launcher, which invokes **Bun** and loads the inlined
bundle.

## Requirements

- **[Bun](https://bun.sh)** `>= 1.3.13` on `PATH`

## Install

```bash
npm install -g @aguil/agents
```

(or `pnpm add -g @aguil/agents`, depending on how you manage global tooling)

## Smoke test

```bash
agents code-review --help
agents code-review inbox --help
```

Then follow the canonical docs in the upstream repository
[`README.md`](https://github.com/aguil/agents/blob/main/README.md) for
harness-specific workflows, adapters, models, and configuration (including
`.agents-code-review` semantics; discovery still considers legacy
`.review-agent/` trees).

Agent Skills playbooks for review/triage workflows live under
[`docs/skills/`](https://github.com/aguil/agents/blob/main/docs/skills/README.md).
After installing **`@aguil/agents`**, run **`agents doctor`**, then
**`agents skills list`** / **`agents skills install`** or
**`agents skills install <id>`** (see **`agents doctor --help`** and
**`agents skills --help`**); the publish tarball ships **`docs/skills/`** next
to the bundled CLI.

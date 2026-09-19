# `@aguil/agents`

Bundled **`agents`** CLI for the
[`aguil/agents`](https://github.com/aguil/agents) repository. Published builds
ship a **Node** `dist/agents` shim that locates **Bun** (the package dependency
first, then `PATH` / `BUN_INSTALL`) and runs the inlined Bun bundle.

## Requirements

- **Node.js** `>= 20` (used by the published bin shim and by npm/pnpm)
- **[Bun](https://bun.sh)** `>= 1.3.13` — pulled in automatically as the package
  dependency `bun@1.3.13` on install; a system Bun on `PATH` is also fine

## Install

```bash
npm install -g @aguil/agents
```

(or `pnpm add -g @aguil/agents`, depending on how you manage global tooling)

A fresh install does **not** require a pre-existing Bun on `PATH`; npm installs
the `bun` dependency and the shim resolves it.

Installers that skip lifecycle scripts (`--ignore-scripts`, pnpm, mise's `npm:`
backend) leave the `bun` dependency without a binary. The shim skips it and
falls back to `BUN_INSTALL`, then `PATH`. With no other Bun available, run the
dependency's postinstall by hand: `cd node_modules/bun && node install.js`.

## Smoke test

```bash
agents code-review --help
agents code-review inbox --help
```

The npm package includes the config-declared code-review harness, so
`agents code-review` works in repositories that do not commit their own
`.agents/` tree:

```bash
agents code-review --workspace /path/to/repo
agents harness install code-review   # optional: materialize a ~/.agents copy
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

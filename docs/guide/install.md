# Installation

## From npm (released builds)

Official releases publish
[`@aguil/agents`](https://www.npmjs.com/package/@aguil/agents). The launcher
requires Bun **`>= 1.3.13`**.

```bash
npm install -g @aguil/agents
agents code-review --help
```

## Local build (development / day-to-day)

Build once after pulling updates:

```bash
bun install
bun run build
```

This runs three steps:

1. `prebuild` — embeds role prompts into
   `harnesses/code-review/src/embedded-prompts.ts`
2. `build` — bundles the CLI to `dist/index.js` with `--target=bun`
3. `postbuild` — creates the executable Bun launcher at `dist/agents`

```bash
./dist/agents --help
./dist/agents code-review --adapter fake
```

`dist/` is gitignored and must be built per checkout/host. Dev runs
(`bun run agents ...`) still work without a build and continue using prompt
files from `harnesses/code-review/prompts/`.

## Running from another repo checkout

After building once in the `aguil/agents` checkout, invoke the launcher from any
other working directory:

```bash
/path/to/aguil/agents/dist/agents code-review \
  --workspace /path/to/work/repo \
  --adapter opencode \
  --model opencode/gpt-5.3-codex
```

## Verification

```bash
which opencode && opencode --version   # OpenCode adapter
which claude  && claude --version      # Claude adapter
which agent   && agent --version       # Cursor adapter
```

---

For maintainer release steps (npm tarball, OIDC trusted publishing, annotated
tags), see [`BUILD.md`](../../BUILD.md).

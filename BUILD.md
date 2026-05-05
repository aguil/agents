# Build Guide

Use the local build when you want a fast launcher for running reviews from another terminal or host checkout.

## Build

```bash
bun run build
```

This runs three steps:

1. `prebuild`: embeds role prompts into `harnesses/code-review/src/embedded-prompts.ts`
2. `build`: bundles the CLI to `dist/index.js` with `--target=bun`
3. `postbuild`: creates the executable Bun launcher at `dist/agents`

## Run

```bash
./dist/agents --help
./dist/agents run code-review --adapter fake
```

You can also invoke it from another repository:

```bash
/path/to/aguil/agents/dist/agents run code-review --workspace /path/to/work/repo --adapter opencode --model opencode/gpt-5.3-codex
```

## Notes

- `dist/` is gitignored and must be built per checkout/host.
- Missing embedded prompts fail fast because the harness imports the generated module directly.
- Dev runs (`bun run agents ...`) still work without a build and continue using prompt files from `harnesses/code-review/prompts/`.

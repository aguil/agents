# Adapters

## OpenCode

```bash
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex --variant minimal
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex --agent code-review
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex --no-deterministic
```

Common model IDs:

- `opencode/gpt-5.3-codex`
- `opencode/gpt-4.5`
- `opencode/claude-sonnet-4`
- `opencode/o1`

Discover models with `opencode models` (or `opencode models <provider>`).

## Claude

```bash
bun run agents code-review --adapter claude --model claude-sonnet-4
bun run agents code-review --adapter claude --model claude-opus-4
bun run agents code-review --adapter claude --model claude-haiku-4
bun run agents code-review --adapter claude --claude-args "-p,{prompt},--model,claude-sonnet-4"
```

Common model IDs:

- `claude-sonnet-4`
- `claude-opus-4`
- `claude-haiku-4`

## Cursor

```bash
bun run agents code-review --adapter cursor --model sonnet-4
bun run agents code-review --adapter cursor --model sonnet-4-thinking --cursor-mode plan
bun run agents code-review --adapter cursor --model gpt-5 --cursor "$(which agent)"
bun run agents code-review --adapter cursor --cursor-args "--print,--output-format,stream-json,--workspace,{workspace},--trust,--force,{prompt}"
# When the comma template would begin with bundled CLI-looking tokens, bind with =:
bun run agents code-review --adapter cursor --cursor-args="--strict,--trust,--print"
```

Common model IDs:

- `sonnet-4`
- `sonnet-4-thinking`
- `gpt-5`
- `o1`

Discover models with `agent models`.

Cursor non-interactive runs require a trusted workspace. If you override
`--cursor-args`, keep `--trust` in the template.

## Fake

```bash
bun run agents code-review --adapter fake
```

Deterministic output; no provider or API calls. Intended for local smoke tests
and CI checks.

## Deterministic mode

Enabled by default. Emits deterministic metadata in `result.json`.

- **OpenCode:** defaults enable `--pure`; use `--variant <id>` to pin a
  provider-specific effort profile.
- **Claude:** conservative defaults; no extra CLI args unless `--claude-args` is
  set.
- **Cursor:** defaults use
  `--print --output-format stream-json --trust --force`.

Use `--no-deterministic` to opt out. Determinism is best-effort;
seed/temperature controls are not currently surfaced by this harness CLI.

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
bun run agents code-review --adapter claude --claude-args "-p,{prompt},--output-format,stream-json,--verbose,--model,claude-sonnet-4"
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
bun run agents code-review --adapter cursor --cursor-args "--print,--output-format,stream-json,--workspace,{workspace},--trust,--sandbox,enabled,{prompt}"
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
`--cursor-args`, keep `--trust` in the template. Embedding `--force`, `--yolo`,
or `--auto-review` in that template does **not** opt into a weaker approval
posture on the code-review path: those flags are stripped unless the adapter is
constructed with `force: true` (issue #159 / ADR 0020). For
`agents harness run`, the opt-in is `--force-tool-calls`. The default template
uses `--sandbox enabled` so policy-allowed writes still run while escalation
stays enforceable.

## Fake

```bash
bun run agents code-review --adapter fake
```

A placeholder: no model runs and no provider or API is called, so it reports no
findings. Intended for local smoke tests and CI checks of the harness itself,
not for reviewing a change.

`fake` is the packaged default, so a run with no adapter configured uses it.
Every `fake` run says so:

- It prints a warning to stderr before the run starts, naming where to set a
  real adapter.
- Its `report.md` opens with a line saying no model ran and the report is not a
  review.
- Its `result.json` records `metadata.adapter` as `fake`.
- Its result is not posted to a pull request without `--allow-fake`, and agentsd
  never posts it (see [workflows.md](workflows.md)).

Every `report.md` names its adapter under the status line, and its model when
the run recorded one.

## Deterministic mode

Enabled by default. Emits deterministic metadata in `result.json`.

- **OpenCode:** defaults enable `--pure`; use `--variant <id>` to pin a
  provider-specific effort profile.
- **Claude:** defaults use `-p {prompt} --output-format stream-json --verbose`,
  plus `--settings` under a policy, so `stdout.log` records each tool call and
  denial. A `--claude-args` template replaces the defaults; one without
  `--output-format stream-json` records only Claude's final text.
- **Cursor:** defaults use
  `--print --output-format stream-json --trust --sandbox enabled` (no `--force`;
  see ADR 0020).

Use `--no-deterministic` to opt out. Determinism is best-effort;
seed/temperature controls are not currently surfaced by this harness CLI.

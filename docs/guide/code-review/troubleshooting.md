# Troubleshooting

## Check adapter executables

```bash
which opencode && opencode --version
which claude  && claude --version
which agent   && agent --version
```

## Inspect raw adapter output

```bash
cat .agents-code-review/runs/<run-id>/roles/<role>/stderr.log
cat .agents-code-review/runs/<run-id>/roles/<role>/stdout.log
```

## Re-run with full visibility

```bash
bun run agents code-review --adapter cursor --model sonnet-4 --dry-run --log all
```

Dry-run artifacts land under `.agents-code-review/dry-run/<run-id>/`.

## Cursor template issues

- Keep `--trust` in `--cursor-args` for non-interactive runs.
- When the comma template begins with tokens that look like bundled CLI flags
  (`--strict`, `--dry-run`, etc.), use the `=` binding form:
  `--cursor-args="--strict,--trust,--print"`.

## GitHub API errors (403 / 429)

Check quota with `gh api rate_limit`. The CLI does not implement automatic
retries or backoff; wait for quota reset or reduce `--consensus` passes.

## Run artifacts location

Default: `.agents-code-review/runs/<run-id>/`

`agents triage` and `agents code-review post` auto-discovery also check legacy
`.review-agent/{runs,dry-run}/` trees when present, so older local runs remain
addressable until you delete them.

## Known limitations

- Windows interactive prompt support is unavailable; use `--no-confirm`.
- Seed/temperature/top-p controls are not currently surfaced by the harness CLI;
  determinism is best-effort.
- The CLI does not implement automatic rate-limit retries.

# agents triage

Convert structured producer output into normalized triage queues for downstream
consumption (e.g. `agentsd` pr-feedback or implementation workers).

> **What triage does not do.** It does not run agent reviewers or collect PR
> threads. Produce the upstream artifact first, then pass it to `agents triage`.

## Supported producers

| `--from`      | Upstream artifact                                 |
| ------------- | ------------------------------------------------- |
| `code-review` | `result.json` from `agents code-review`           |
| `pr-feedback` | `feedback.json` from `agents pr-feedback collect` |

## Output

By default, `agents triage` writes files under:

```
<workspace>/.agents-triage/<outputSlug>/
  triage-queue.json       Normalized TriageEnvelopeV1 (always written)
  triage-queue.toon       Toon-encoded queue (requires @toon-format/toon; written with --format both)
```

The `outputSlug` is derived from `--from` and a fingerprint of the ingress
artifact. `.agents-triage/` is gitignored — queue files are local artifacts.

See [spec/triage-schema.md](../../harnesses/code-review/spec/triage-schema.md)
for the `TriageItemV1` / `TriageEnvelopeV1` schema reference.

## Synopsis

```
agents triage [options]
```

## Options

| Option                      | Description                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--from <producer>`         | **Required.** `code-review` or `pr-feedback`                                                                                  |
| `--workspace <dir>`         | Repo scope (default: cwd)                                                                                                     |
| `--result <path>`           | Ingress artifact path. For `code-review`, defaults to newest result under `.agents-code-review/`. For `pr-feedback`, required |
| `--format json\|toon\|both` | Output mode (default: `both` when `@toon-format/toon` is installed; falls back to `json` with a warning)                      |
| `--output <dir>`            | Override output directory (default: `<workspace>/.agents-triage/<outputSlug>/`)                                               |
| `--stdout`                  | Print exactly one format to stdout (`--format json` or `--format toon` required)                                              |

## Examples

Run code review then triage the result:

```bash
agents code-review --workspace /repo
agents triage --from code-review --workspace /repo
```

Collect PR feedback then triage it:

```bash
agents pr-feedback collect --pr 42 --repo org/repo --workspace /repo
agents triage --from pr-feedback \
  --result /repo/.agents-pr-feedback/org-repo-42/feedback.json \
  --workspace /repo
```

Print JSON to stdout without writing files:

```bash
agents triage --from code-review --format json --stdout
```

## Legacy alias

`agents triage ingest --from …` is accepted and behaves identically to
`agents triage --from …`. The `ingest` subcommand spelling is deprecated.

## Related

- [pr-feedback.md](pr-feedback.md) — collecting PR threads with
  `agents pr-feedback`
- [agentsd/README.md](agentsd/README.md) — how `agentsd` consumes triage queues
- [harnesses/code-review/spec/triage-schema.md](../../harnesses/code-review/spec/triage-schema.md)
  — `TriageEnvelopeV1` schema

# Harness Docs

Internal documentation for specialized harnesses: PRDs, architecture notes,
data-contract specs, and operating guides. User-facing docs live under
[`../guide/`](../guide/README.md).

## Code review harness (`harnesses/code-review`)

| Doc                                                                        | Contents                                             |
| -------------------------------------------------------------------------- | ---------------------------------------------------- |
| [code-review/prd.md](code-review/prd.md)                                   | Requirements and acceptance criteria                 |
| [code-review/architecture.md](code-review/architecture.md)                 | Package layers, adapter contract, orchestration flow |
| [code-review/spec/result-schema.md](code-review/spec/result-schema.md)     | `result.json` and `result.raw.json` field spec       |
| [code-review/spec/events-catalog.md](code-review/spec/events-catalog.md)   | JSONL events emitted by the harness and agentsd      |
| [code-review/spec/review-contract.md](code-review/spec/review-contract.md) | Roles, triage tiers, wire keys, scratchpad layout    |

## Adding a new harness

1. Create `harnesses/<name>/` and add a user-facing `README.md` there.
2. Create `docs/harnesses/<name>/` with at minimum `prd.md` and
   `architecture.md`.
3. Add a `docs/guide/<name>/` subtree for user-facing content.
4. Build on shared packages from `packages/`; do not embed execution, context,
   reporting, or telemetry logic directly in the harness.

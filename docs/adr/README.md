# Architecture Decision Records

Number files as `NNNN-short-title.md` (four digits, zero-padded) in creation
order.

Record durable technical decisions here once they affect multiple harnesses or
shared package boundaries.

- [0001-ts7-baseurl-paths.md](0001-ts7-baseurl-paths.md) — ADR 0001: remove
  deprecated `baseUrl` / align `paths` before TypeScript 7 (tracking).
- [0002-triage-pathname-io-accepted-risk.md](0002-triage-pathname-io-accepted-risk.md)
  — ADR 0002: accepted risk for pathname-based triage + harness pointer I/O
  without `openat` (and linear discovery scan).
- [0003-agentsd-dual-runtime.md](0003-agentsd-dual-runtime.md) — ADR 0003: dual
  runtime (`HarnessOrchestrator` vs `WorkQueueOrchestrator`), `agentsd`, work
  feeds, and publish defaults.
- [0004-implementation-runtime-providers.md](0004-implementation-runtime-providers.md)
  — ADR 0004: provider-agnostic `implementation` runtime (`subprocess` /
  `app_server`, optional `codex:` alias).
- [0005-harness-generalization-phase-0.md](0005-harness-generalization-phase-0.md)
  — ADR 0005: harness generalization Phase 0 — `HarnessOutcome`,
  chain/validation-loop execution modes, generic context providers, worker
  registry.
- [0006-harness-governance-phase-1.md](0006-harness-governance-phase-1.md) — ADR
  0006: harness governance Phase 1 — `.agents/` loader (`harness.yaml` spec
  v0.1), native policy evaluation (ACS 5-verdict, fail-closed), Cursor hook
  config generation with policy-eval bridge first.
- [0007-harness-governance-phase-2.md](0007-harness-governance-phase-2.md) — ADR
  0007: harness governance Phase 2 — spec extensions from the proof harness
  (per-role `policy:`, `{"outcome":...}` envelopes, unconditional per-role hook
  regeneration, fail-closed on unenforceable policy, `agents harness run`).

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

# Docs

Documentation is split by audience.

## For users

- [guide/README.md](guide/README.md) — user guide and reference for
  `agents code-review`, `agentsd`, and related commands
- [examples/WORKFLOW.example.md](examples/WORKFLOW.example.md) — example
  WORKFLOW files and smoke runs
- [skills/README.md](skills/README.md) — portable agent playbooks
  (`agents skills install`)

## For contributors and maintainers

### Architecture Decision Records

- [adr/README.md](adr/README.md) — durable cross-cutting decisions

### Harness internals

- [harnesses/README.md](harnesses/README.md) — harness list and shared package
  roles
- [harnesses/code-review/prd.md](harnesses/code-review/prd.md) — requirements
  and acceptance criteria
- [harnesses/code-review/architecture.md](harnesses/code-review/architecture.md)
  — package layers, adapter contract, orchestration flow
- [harnesses/code-review/spec/result-schema.md](harnesses/code-review/spec/result-schema.md)
  — `result.json` schema
- [harnesses/code-review/spec/events-catalog.md](harnesses/code-review/spec/events-catalog.md)
  — JSONL events catalog
- [harnesses/code-review/spec/review-contract.md](harnesses/code-review/spec/review-contract.md)
  — review contract

### Package boundaries

- [packages/README.md](packages/README.md) — what each shared package owns and
  its allowed dependencies

### Daemon internals

- [agentsd/architecture.md](agentsd/architecture.md) — Symphony-pattern mapping,
  worker lifecycle, trust posture
- [agentsd.md](agentsd.md) — index of agentsd docs (user and internal)

### Maintainer operations

- [release-checklist.md](release-checklist.md) — release-please flow, release PR
  checklist, post-publish verification and retries
- [`BUILD.md`](../BUILD.md) — npm tarball pipeline, OIDC trusted publishing,
  release automation

# Architecture Decision Records

Number files as `NNNN-short-title.md` (four digits, zero-padded) in creation
order.

Record durable technical decisions here once they affect multiple harnesses or
shared package boundaries.

## Before writing or editing one

Three requirements, decided in ADR 0014. Canonical wording:
[`.agents/rules/adr-authoring.md`](../../.agents/rules/adr-authoring.md).

1. **Standalone.** An ADR must be understandable from this repository alone. Do
   not reference documents held outside it — inline the reasoning instead. Other
   ADRs, repo-local files, issue numbers, package versions, and upstream specs
   are all fine.

2. **Immutable except for status.** Immutability attaches at merge to `main`.
   After that the only editable part is the status fields below; title, context,
   decision, consequences, and references are frozen. A changed mind is a new
   ADR that supersedes the old one. Before merge an ADR is under review and
   carries `Proposed`, not `Accepted`.

3. **Status format.** Two adjacent fields directly beneath the title:

   ```markdown
   **Status:** <State> [— <short qualifier>]

   **Status history:**

   - <YYYY-MM-DD> — <State>[: <what changed and why>].
   ```

   `**Status:**` may be rewritten; `**Status history:**` is append-only. Every
   change to the former appends a dated entry to the latter. States: `Proposed`,
   `Accepted`, `Rejected`, `Deprecated`, `Superseded by ADR NNNN`,
   `Partially superseded by ADR NNNN`.

Number the decision clauses, so a later ADR can supersede `§3` precisely, and
add the new file to the index below. Nothing here is enforced by CI yet (#131),
so it is upheld in review.

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
- [0008-env-carried-policy-enforcement.md](0008-env-carried-policy-enforcement.md)
  — ADR 0008: env-carried per-role policy enforcement — role-invariant hook
  config, `AGENTS_POLICY_ID`/`AGENTS_AGENTS_DIR` per spawn, `@none` token,
  per-role policies in all execution modes (supersedes ADR 0007 §3/§5 carrier).
- [0009-spec-v0.2-hook-scoping-and-bridge-cost.md](0009-spec-v0.2-hook-scoping-and-bridge-cost.md)
  — ADR 0009: spec v0.2 `applies_to` hook event-class scoping (#71), policy
  bridge per-hook cost accepted with measurement (#70), `agents hooks test`
  probe surface.
- [0010-context-providers-spec.md](0010-context-providers-spec.md) — ADR 0010:
  `context.providers` declarative context collection (spec v0.2) — builtin
  registry, YAML-unreachable build-time seams, shell-command trust model and
  bounds.
- [0011-cel-role-enablement.md](0011-cel-role-enablement.md) — ADR 0011: CEL
  role enablement (spec v0.2) — load-time compile checks, fail-closed
  evaluation, structural consistency, context-derived bindings.
- [0012-reporting-template-and-consensus-descope.md](0012-reporting-template-and-consensus-descope.md)
  — ADR 0012: `reporting.template` builtin renderers (byte-identical code-review
  markdown) and the consensus descope decision.
- [0013-code-review-config-cutover.md](0013-code-review-config-cutover.md) — ADR
  0013: flagged cutover of `agents code-review` to the config-declared harness —
  tier evidence, staged rollout, corpus as permanent referee.
- [0014-adrs-standalone-and-immutable.md](0014-adrs-standalone-and-immutable.md)
  — ADR 0014: ADRs are standalone (no references to documents outside this repo)
  and immutable (changed only by supersession); reference hygiene is editorial.
- [0015-project-local-harness-spec.md](0015-project-local-harness-spec.md) — ADR
  0015: the harness spec is project-local (AGENTS-1 convergence struck), the
  JSON Schema is its normative description, `0.2` current with `0.1` a
  deprecated alias, and `spec_version` is advisory only while increments stay
  additive.
- [0016-workflow-policy-decoupling.md](0016-workflow-policy-decoupling.md) — ADR
  0016: remove `prFeedbackPolicy` / `codeReviewPolicy` from
  `WorkflowDefinition`, but reject `.agents/policies/` and `x.harness` as
  destinations — harnesses parse their own config from `definition.config`;
  scheduled for a later pass.
- [0017-knowledge-governance.md](0017-knowledge-governance.md) — ADR 0017:
  knowledge governance answers — required staged-note schema with
  runtime-written provenance, no builtin extractor, a reserved machine
  identifier namespace that makes human collisions impossible, and an enforced
  auto-context budget that degrades visibly. Decisions only; implementation
  stays blocked on run-level hook dispatch. Partially superseded by ADR 0022 on
  §6's budget placement.
- [0018-harness-schema-and-spec-0-3.md](0018-harness-schema-and-spec-0-3.md) —
  ADR 0018: hand-authored `harness.schema.json` validated with ajv, enforcing
  unknown-key rejection while the loader keeps its more specific messages;
  `harness.description` declared; spec increments to 0.3 for `ref:`, additive.
- [0019-structured-finding-evidence.md](0019-structured-finding-evidence.md) —
  ADR 0019: `validation.evidence` carries structured evidence items, optional in
  the envelope and required by the filter; `builtin:actionable` classifies
  rather than discards, publishing unsubstantiated findings visibly but outside
  the gate; the eleven-substring prose heuristic is deleted; spec increments to
  0.4, additive in format but not in behavior, partially superseding ADR 0015
  §4.
- [0020-cursor-force-opt-in-and-sandbox-default.md](0020-cursor-force-opt-in-and-sandbox-default.md)
  — ADR 0020: Cursor `--force` is opt-in; unforced runs default to
  `--sandbox enabled` so hook `ask` / `exec.unknown` escalation remains
  enforceable while policy-allowed writes still run (issue #159).
- [0021-gate-owned-run-status.md](0021-gate-owned-run-status.md) — ADR 0021: run
  status is findings-blind only when a gate owns the run (`pass_check` /
  validation-loop), not merely because `execution` is declared (issue #157).
- [0022-knowledge-read-path.md](0022-knowledge-read-path.md) — ADR 0022:
  `knowledge` and `knowledge-search` context providers; a workspace-confined
  repository-local store, the note frontmatter a reader relies on, two
  independent opt-ins for automatic injection, a provider-declared budget with
  binding defaults, recency-then-identifier admission order, and overflow
  recorded in the bundle rather than failing the run. Qualifies ADR 0017 §6 on
  where the budget is declared.
- [0024-undispatchable-lifecycle-events.md](0024-undispatchable-lifecycle-events.md)
  — ADR 0024: run-level events are the orchestrator's to dispatch and no adapter
  mapping can supply them, because an adapter is invoked once per role
  invocation and cannot know which is the run's last; declaring `run_start`,
  `run_end` or `role_start` is reported to the author rather than silently
  accepted; harness-declared run-level handlers do not execute.

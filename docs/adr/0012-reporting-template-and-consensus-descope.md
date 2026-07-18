# ADR 0012: `reporting.template` and the consensus descope (spec v0.2)

**Status:** Accepted **Context:** #73 Tier 1 gates 5 and 6. Gate 5 requires
`harness.yaml` to select report rendering declaratively with `report.md` parity
against today's code-review output (Tier 3 demands byte-compatibility). Gate 6
required either an `extensions.post_run` mechanism for consensus or an explicit
descope decision; the operator chose descope (2026-07-18, plan approval for the
#73 arc).

**Decision:**

1. **`reporting.template` names a builtin renderer.**
   `builtin:code-review-markdown` resolves to the _existing_
   `renderMarkdownReport` function — the same reference, not a port — so a
   config-declared code-review harness produces byte-identical `report.md`.
   `builtin:outcomes-markdown` is the generic renderer for outcome-emitting
   harnesses (grouped by source role, deterministic, no timestamps). Unknown
   names fail at load listing the supported set.

2. **Consensus is descoped from the harness spec.** No `extensions.post_run`
   mechanism ships in v0.2:
   - Every recorded run in the replay corpus has `consensus_mode: "off"`; the
     feature is exercised nowhere in production history.
   - Consensus lives in `runCodeReview` _around_ orchestration (multi-pass
     loop + fingerprint intersection), not inside it — expressing it in the spec
     would require a general post-run extension mechanism designed against a
     single, unused consumer.
   - The imperative implementation remains available on the package path; if
     consensus is ever wanted for config harnesses, the extension-ref mechanism
     gets designed then, against real requirements.

**Consequences:**

- Tier 1 is fully expressible: with context.providers (ADR 0010), CEL enablement
  (ADR 0011), output schemas + finding pipelines (#99), and reporting templates,
  a `code-review/harness.yaml` can express the package's behavior with zero new
  TypeScript beyond registered builtins.
- The opt-in dispatch path (Tier 3 PR) must reject or warn on
  `--consensus-runs > 1` when routing to the config harness, until/unless the
  extension mechanism exists.
- Differential parity (Tier 2) compares single-pass behavior; consensus
  intersection stays out of scope for the corpus referee.

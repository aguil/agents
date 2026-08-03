# ADR 0021: run status is gate-owned, not implied by `execution` presence

**Status:** Proposed

**Status history:**

- 2026-08-02 — Proposed.

**Context:** Declaring `execution:` in `harness.yaml` was meant to choose how
roles are scheduled (`parallel`, `chain`, `validation-loop`). The orchestrator
also used `definition.execution !== undefined` as the switch between two status
rules:

- absent → `statusFromOutcomes` (finding severity drives status)
- present → `generalizedStatus` (findings are diagnostic; role failures and
  `passGate` / validation-loop convergence decide)

The runtime default when `execution` is absent is already
`{ mode: "parallel" }`. So writing `execution: { mode: parallel }` looks like
documenting the default. It was not: it silently opted the harness out of
finding-driven status. On `agents harness run`, that orchestrator status is the
published status. A parallel harness without `pass_check` gained no replacement
gate.

Issue #157. The code-review path shares the same predicate via
`statusAfterFindingPipelines({ findingsBlind })`; packaged code-review does not
declare `execution`, so the footgun was mostly `harness run`, but any config
harness that added the block for scheduling would hit it.

**Decision:**

1. **Split the two meanings of `execution`.** Presence still opts into emitting
   generic `outcomes` on the result. Status ownership is a separate predicate.
2. **Findings-blind status only when a gate owns the run.** Implemented as
   `harnessStatusIsFindingsBlind`: true when a runtime `passGate` is set, when a
   validation-loop internal gate ran, or when the document declares chain
   `pass_check` / `validation-loop`. Bare `execution: { mode: parallel }` or
   chain without `pass_check` keeps finding-driven status. This replaces ADR
   0007 §7's broader rule that any execution-configured harness is
   findings-blind.
3. **Schema descriptions state the rule.** The `execution` and `pass_check`
   field descriptions in `harness.schema.json` say scheduling vs gate ownership
   explicitly so an author does not need an experiment.
4. **No new `status:` key in this change.** An explicit status enum remains
   available later if authors need findings-blind status without a command gate;
   the footgun does not require it.

**Consequences:**

- Harnesses that declared `execution` only to document scheduling, and relied
  (perhaps unknowingly) on findings being ignored, will start failing on
  blocking findings again. That is the intended correction.
- Harnesses with `pass_check` or `validation-loop` are unchanged: gates still
  own status; critical diagnostic findings do not fail the run when the gate
  passes.
- Call sites that previously used `execution !== undefined` as `findingsBlind`
  must use `harnessStatusIsFindingsBlind` so both entry points agree (the
  divergence problem `statusAfterFindingPipelines` was introduced to solve).
- Behavioural break for `@aguil/agents-orchestration` consumers who treated any
  `execution` block as findings-blind (`fix(orchestration)!:`).

**References:**

- Issue #157
- Issue #156 (companion: wiring `pass_check` on every path)
- ADR 0007 §7 (partially superseded by Decision §2)
- `packages/orchestration/src/index.ts` — `harnessStatusIsFindingsBlind`,
  `assembleResult`
- `packages/reporting/src/index.ts` — `statusAfterFindingPipelines`

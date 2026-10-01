# ADR 0025: optional plan-conformance role gated on supplied acceptance criteria

**Status:** Proposed

**Status history:**

- 2026-10-01 — Proposed.

**Context:** The code-review harness reviews a diff for defects. It has no idea
what plan or design the change was written against. In one review round, two
changes passed every test in the repository and still diverged from a recorded
design. A canonical-hash helper hashed serializer bytes, which the design ruled
out because an earlier check showed serializer output depends on collection
iteration order. A fallback returned early where the design used stored values
whenever they were non-empty. A human reviewer caught both by reading the plan
next to the diff. The author's own self-review missed them for the same reason:
nothing in it referred to the plan.

The plan is usually a long document. Feeding the whole thing to a reviewer is
expensive and invites the reviewer to check things the plan never committed to.
A short list of rows, one per binding constraint, is easier to check and easier
for the author to write once and reuse.

**Decision:**

1. **One row format for author and reviewer.** Acceptance criteria are a JSON
   file, `version: 1`, holding a non-empty `criteria` list. Each row has an
   `id`, a `statement`, an optional `check` (`diff` or `runtime`), and optional
   `required_tests`. Any defect rejects the whole file. The format is specified
   alongside the harness spec and parsed by one function in the core package. An
   author-side constraint trace in the `self-review-checks` skill is to read the
   same file, so rows are written once; that skill change lands separately.

2. **A context provider collects the rows.** The `acceptance-criteria` builtin
   takes rows from, in order: the operator's `--criteria` path, its own `path`
   param, or `Acceptance-Criteria:` lines in the PR description. It always emits
   exactly one artifact with `status` `loaded`, `absent`, or `invalid` and a
   reason, so the run can say why there is nothing to check. Only the operator's
   own path is fatal when unusable, because the operator asked for it by name
   and a review without it would answer a different question. A PR-declared path
   stays inside the workspace and a PR-declared URL follows the same-owner rule
   PR-referenced docs already use, because the PR under review is not trusted to
   read host files into model context. `--criteria` is CLI-only for the same
   reason: repository config must not be able to point it outside the workspace.

3. **A new CEL binding, always present.** Role enablement gains
   `acceptance_criteria`, the number of loaded rows. ADR 0011 §5 requires new
   bindings to come from collected context; this one does. Unlike `tier`, it is
   bound even when no artifact exists, as `0`. A missing tier has no safe
   default, so failing closed is right there. A missing criteria artifact has an
   exact meaning, no rows, and failing closed would make every replay of a
   bundle recorded before the provider existed abort.

4. **An optional `conformance` role, not a tier role.** The packaged harness
   declares `conformance` with `enabled: acceptance_criteria > 0`. It runs at
   every tier when rows exist and never otherwise. It stays out of
   `CODE_REVIEW_ROLE_IDS`, which drive tier scheduling and coverage, and gets
   its own coverage line instead.

5. **Per-row results are outcomes; defects are findings.** The role emits one
   `conformance` outcome per row (`satisfied`, `unsatisfied`, or `unverifiable`)
   and, for each row that is not satisfied, a finding: `critical` for
   unsatisfied, `warning` for unverifiable. Findings keep run status, triage
   ingest, and posting working unchanged. Outcomes carry the satisfied rows that
   a findings-only model would drop. The orchestrator now includes `outcomes` in
   a result whenever a role emitted a non-finding outcome, even without an
   `execution` block; a run with no such outcome keeps its old shape.

6. **Never a silent pass.** When the harness declares the role, run metadata
   records `conformance` (`scheduled` or `not_run`) and `conformance_reason`,
   plus `conformance_criteria` (the row ids) when scheduled. `report.md` renders
   a Plan Conformance section from them: every row with its status, rows the
   role did not report listed as having no result, or the reason the role did
   not run. A harness without the role gets none of these keys and an unchanged
   report.

7. **Rows the diff cannot settle are unverifiable.** A `runtime` row is
   satisfied only when a test in the change, or one already in the repository
   that the change keeps passing, exercises it. Otherwise it is unverifiable,
   which is a warning finding rather than a pass.

**Consequences:**

- Every report from the packaged harness gains a Plan Conformance section,
  including replays of recorded bundles, which now say the role did not run. The
  private replay corpus needs its recorded `report.md` baselines re-adjudicated
  for that section before this merges.
- Every live run collects one more artifact, so `context_fingerprint` changes
  for live runs. Replays load the recorded bundle and keep theirs.
- The provider makes its own `gh pr view` call when neither `--criteria` nor a
  `path` param applies, as `pr-referenced-docs` already does.
- Rows the role leaves unreported are visible in the report but do not move run
  status. If that proves too weak in practice, a later change can count them,
  but synthesizing findings the agent did not produce is out of scope here.
- Checking `required_tests` against the diff is left to the role. A
  deterministic name match was considered and rejected for now: test names in
  the rows are descriptions as often as identifiers.

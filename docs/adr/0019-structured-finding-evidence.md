# ADR 0019: finding validation carries structured evidence; `builtin:actionable` stops discarding findings

**Status:** Proposed

**Status history:**

- 2026-07-29 — Proposed.

**Context:** `builtin:actionable` is the finding filter every code-review run
applies, declared as `filtering.findings: [builtin:actionable]` in
`.agents/harnesses/code-review/harness.yaml`. It decides whether a finding
reaches `result.json` — and therefore the report, the triage queue, and the
operator — by testing the finding's free-text validation prose against a
hardcoded list of eleven substrings
(`packages/harness-config/src/output-pipeline.ts`):

```
"reproduced", "validated", "verified", "inspection", "trace",
"command", "output", "test", "line", "diff", "path"
```

A finding whose agent already set `validation.status: "verified"` is discarded
unless the sentence _describing_ that validation happens to contain one of those
strings. The test is on vocabulary, not on evidence.

Four findings from auditing 93 recorded runs in a local
`.agents-code-review/runs/` history, comparing verified findings present in each
run's `result.raw.json` against its published `result.json`.

**The filter discards a large fraction of what it sees.** 37 of the 93 runs
dropped at least one verified finding on wording alone. 48 run-finding pairs in
total, 45 distinct finding identifiers, of which 43 were never published by any
run in the history. Eleven runs published zero findings while holding verified
findings that the filter removed — they reported clean.

**Two of the 43 were critical severity, and both were security findings.** One,
`security-harness-run-force-bypasses-exec-unknown`, describes a live defect that
remains in the code eleven days later and is now tracked as issue #159:
`harness run` hardcodes `--force` on the Cursor adapter, which auto-allows the
tool calls that `confirmations.requiredFor: [exec.unknown]` escalates to human
approval. Its validation prose recorded three `policy-eval` invocations and
their verdicts — stronger evidence than most findings that were published — and
contained none of the eleven strings.

**`validation.status` carries no signal.** All 173 unique findings across those
runs declare `status: "verified"`. Not one is `not_run` or `not_reproduced`.
Whatever the field was intended to discriminate, agents do not use it that way,
so a rule of "trust the status" would be equivalent to no filter at all. This
rules out the simplest alternative and is the reason a new signal is needed
rather than a better reading of an existing one.

**What agents actually cite is narrower than the word list implies.** Across the
same 173: 94 describe reading, comparing, or tracing named files; 62 cite a file
path; 27 describe running a command; 11 mention tests; and **2 cite a
`file:line` pair**. A rule requiring line-level citation would reject nearly
everything agents genuinely do. The dominant evidentiary act is naming the
artifacts examined, not producing a reproduction.

The intent behind the filter is sound: a finding claiming "verified" with no
supporting detail should not be trusted, and the accompanying 18-character floor
catches the empty case. The mechanism does not implement that intent. It fails
open on prose that merely mentions a file path, which is most prose about code,
and fails closed on an executed command whose description happens to avoid
eleven words.

The compounding problem is silence. Nothing records a discard — not the CLI
output, not `result.json`, not `report.md`, not run metadata. A run that removes
a critical security finding is indistinguishable from a clean run. That matters
beyond correctness because `agents code-review` is the gate this repository
requires before a pull request leaves draft, and the documented acceptance bar
is an empty triage queue. A filter that can empty that queue without saying so
undermines the gate it feeds.

**Decision:**

1. **`validation` gains a structured `evidence` list.** A finding may carry
   `validation.evidence`, an array of items each naming a concrete evidentiary
   act:
   - `{ kind: "command", command, exitCode? }` — something was run. Field naming
     is camelCase to match the rest of the envelope, which already has
     `sourceRole`.
   - `{ kind: "source", file, line? }` — a file was examined; `line` is optional
     because only 2 of 173 observed findings had one.
   - `{ kind: "artifact", path }` — a context bundle entry was examined.

   These three cover every case in the observed corpus. `validation.details` is
   unchanged and remains the human-readable account.

   An item names an act; it does not carry a transcript. There is deliberately
   no field for captured command output, because that invites pasting a build
   log into every finding, and `details` already holds the narrative. An
   evidence item exists so the claim can be re-checked later, and a command plus
   its exit code is enough to re-run it.

2. **`evidence` is optional in the envelope and required by the filter.**
   `validateFinding` accepts a finding without it, so every existing recording,
   the replay corpus, and any agent not yet emitting evidence continue to
   validate. `builtin:finding` is therefore unchanged in what it accepts. Only
   publication behavior depends on the new field.

3. **`builtin:actionable` never removes a finding.** It classifies. A finding
   with `status: "verified"` and at least one evidence item is _substantiated_;
   anything else is published with an `unsubstantiated` marker rather than
   discarded. Discarding is the failure this ADR exists to correct, and
   replacing one silent discard rule with a better silent discard rule would
   leave the class of defect intact.

4. **Unsubstantiated findings are visible but do not move the gate.** They
   appear in `result.json` and in a dedicated section of `report.md`, and their
   count is stated on both run paths — as `unsubstantiated_findings` in
   code-review run metadata, and in the `harness run` summary output. They are
   excluded from run status and from triage ingest. This is deliberate:
   including them would flip most runs from clean to non-empty overnight, before
   prompts or models emit evidence, and an operator facing a suddenly-noisy gate
   learns to ignore it. Visibility first, enforcement once the corpus has moved.

5. **The eleven-substring heuristic is deleted, not tuned.**
   `hasSubstantiveValidationDetails` is removed. The 18-character floor goes
   with it, subsumed by requiring a structured item.

6. **`spec_version` increments to `0.4`.** `builtin:actionable` is a construct a
   harness document declares, and this changes what it does, which ADR 0015 §5
   requires be recorded with an increment, an ADR, and a schema update.

   The increment is additive in **format** and not in **behavior**, and the
   distinction is worth stating rather than glossing. No construct is added,
   removed, or respelled, so every `0.1`, `0.2` and `0.3` document remains
   loadable with all of its keys meaning what they meant — which is the sense in
   which ADR 0015 §4 requires increments be additive, and the reason the
   loader's refusal to branch on the declared version stays sound. But a `0.2`
   document declaring `builtin:actionable` does stop discarding findings, since
   the behavior change applies uniformly across versions.

   That is intended, not overlooked. Version-gating it would preserve silent
   data loss for every document written before today, which is the defect and
   not a compatibility guarantee worth honoring. The change is applied the way a
   bug fix is applied: to everyone.

   Shipped documents keep their declared versions. `.agents/manifest.yaml` and
   `.agents/harnesses/code-review/harness.yaml` still say `0.2`, as they did
   through the `0.3` increment, because they use no surface newer than that and
   the schema describes one format across all accepted tokens (ADR 0015 §3).

7. **The prompts teach the new field.** The envelope contract in
   `packages/execution/src/index.ts` and the four role prompts under
   `harnesses/code-review/prompts/` instruct agents to emit `evidence`. Until a
   model reliably does, clause 4 keeps its output visible rather than lost.

**Consequences:**

- The 43 findings this history lost stay lost — recordings are not reprocessed.
  What changes is that the next one is visible. Two of the lost ones have been
  recovered by hand and triaged; #159 is the live one.
- Runs will publish more findings than before, most initially marked
  unsubstantiated. Reports get longer. This is the intended direction and the
  cost of clause 3: the alternative is continuing to decide what an operator
  sees using a rule that cannot distinguish evidence from vocabulary.
- Deduplication needs a tie-break it did not need before. Previously the filter
  ran first and removed unsubstantiated findings, so everything reaching
  `builtin:fingerprint` was substantiated. With clause 3 the two kinds now
  collide, and first-wins would let an unevidenced duplicate evict its evidenced
  twin — which, combined with clause 4, would report a run clean while it held a
  real finding. `dedupeFindings` therefore prefers a substantiated finding on a
  fingerprint tie. This is a consequence of clause 3 rather than a separate
  decision, and it is recorded because the failure it prevents is the same one
  this ADR exists to fix, arriving by a different route.
- Clause 4 creates a state where a finding is published, visible, and not
  counted. That is a genuine complication in the result contract, and it is
  accepted deliberately as a migration mechanism rather than a permanent shape.
  A later ADR should either promote unsubstantiated findings into the gate once
  emission is reliable, or record why they stay out.
- Clause 2 leaves the envelope permissive, so a model that ignores clause 7
  produces findings that are published-but-uncounted indefinitely, with no
  error. The signal for that is the unsubstantiated count in metadata, which is
  a metric someone has to look at rather than a failure someone cannot miss.
  Making `evidence` required is the obvious follow-up and is deliberately not
  taken here, because doing it in the same change would break the replay corpus
  and every recorded fixture at once.
- The replay corpus keeps validating, because clause 2 changes no envelope
  requirement. Recorded runs will classify their findings as unsubstantiated,
  which changes published output; corpus comparisons that assert on published
  findings need rebaselining, and that is the main implementation cost.
- `spec_version` `0.4` is the second increment in four days. The rate is worth
  noting rather than hiding: both increments came from discovering that a
  declared construct did not do what its name implied. That is a property of
  retrofitting a specification onto an implementation, and it should slow as the
  surface is covered.
- Deleting the heuristic removes the only mechanism that ever rejected a
  self-declared verification. Clause 1 replaces it with one an agent can also
  fabricate — a `source` item naming a file it never opened. The difference is
  that a fabricated structured citation is checkable after the fact, where
  fabricated prose is not; verifying evidence items against the workspace is a
  possible later change and is not attempted here.

**References:**

- ADR 0014 — ADRs are standalone; the reason this ADR inlines its evidence.
- ADR 0015 — the harness spec is project-local, the schema is its normative
  description, and §5 governs the increment clause 6 performs.
- ADR 0018 — the published schema and the `0.3` increment, whose format-level
  additivity clause 6 preserves while departing from it behaviorally.
- Issues #158 (this defect), #159 (the live critical finding it hid), #115
  (closed; its reported symptom was this filter).

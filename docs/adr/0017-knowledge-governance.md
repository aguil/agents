# ADR 0017: knowledge governance — staged-note schema, provenance namespacing, and a context budget

**Status:** Partially superseded by ADR 0022

**Status history:**

- 2026-07-26 — Proposed.
- 2026-07-26 — Accepted: merged in #142. Decisions only; implementation stays
  blocked on run-level hook dispatch.
- 2026-08-02 — Partially superseded by ADR 0022: §6's placement of the
  automatic-injection budget in a `knowledge:` harness block. ADR 0022 Decision
  §6 puts the read-path budget on provider params (`max_notes` / `max_bytes`)
  until a write path lands the block; what §6 enforces (off by default, dual
  bounds, runtime defaults, visible degradation) stands.

**Context:** A knowledge write-back capability has been designed for this
repository but not built. The intent is that a harness run can record what it
learned — a recurring failure mode, a subtle repository convention, an
expensive-to-rediscover fact — so later runs and later humans benefit. Issue
#136 asks three questions the design left open. This ADR answers those three and
nothing else; it does not authorize an implementation.

Because ADRs are standalone (ADR 0014), the governance model these questions
qualify is restated here rather than cited. It is not yet in force anywhere —
what follows describes the intended shape, so that the three answers have
something to attach to.

**The intended model, in this ADR's own words.** Knowledge is a set of Markdown
notes with structured frontmatter, held under a repository-local directory,
readable by agents through the context system. A harness declares its
relationship to that store in a `knowledge:` block in `harness.yaml`, whose
central field is a write policy with three settings:

- **`disabled`** — the run may read knowledge but writes nothing. The default,
  and the only setting appropriate to a harness whose output is already reviewed
  elsewhere.
- **`staging`** — the run writes notes to a staging area rather than the
  knowledge store. A human reviews and promotes them. Nothing a run produces
  becomes readable knowledge without that step.
- **`direct`** — the run writes into the store without review.

The block carries the operational bounds alongside the policy: where staging
writes land, a cap on how many notes one run may produce, whether promotion
requires approval, a provenance tag prefix marking notes as machine-authored, a
strategy for recognizing that a new note duplicates an existing one, and a
time-to-live after which an unpromoted staged note expires. Promoted notes are
repository-scoped and durable, surviving any single run; staged notes are
transient and expire; and both are distinct from per-run working state, which
does not survive the run at all.

**What exists today, and why the implementation is blocked.** Almost none of the
model above is built: no `knowledge:` block, no knowledge directory in either
`.agents/` tree, and no context provider that reads a knowledge store, so the
read path is absent too. The write path is blocked rather than merely unwritten.
It was designed to run at the end of a run through a `run_end` hook, and that
hook cannot fire — the event is declarable and the loader accepts a handler for
it, but hook generation drops it, a test pins that behavior, and the
orchestrator dispatches no run-level events of its own. `run_start` and
`role_start` are inert in the same way.

The evidence for that, with file and line references, is
`docs/design/knowledge-write-back-blockers.md`. It is kept separate
deliberately: it is a statement about the code at a moment, and this ADR is
immutable, so freezing line numbers here would guarantee they became wrong. That
note is maintained; this ADR is not.

The three questions are worth answering despite that, because they are cheap now
and expensive later. Each constrains an artifact — a note's frontmatter, an
identifier space, a context bundle — that becomes difficult to change once notes
exist, and the answers determine whether the eventual implementation is a
governed feature or a well-intentioned one.

**Question 1: extraction quality.** Should the harness spec define a schema for
staged notes, and should the runtime ship a builtin extractor driven by
structured outcome fields, or is extraction always harness-specific?

These pull in opposite directions and are best answered separately. A schema is
cheap and compounding: without required frontmatter, provenance, deduplication,
expiry and budgeting all become heuristics over free text, and every one of the
other two answers depends on fields being reliably present. A builtin extractor
is a different proposition. It would have to decide what, in an arbitrary
harness's structured outcome, is worth remembering. That judgment is exactly
what differs between harnesses: a code-review finding is a fact about one diff
and is usually worthless later, while an incident-triage root cause is a fact
about the system and may be valuable for years. A builtin extractor would encode
one harness's notion of significance as the default for all of them, and the
failure mode is not an error — it is a knowledge store quietly filling with
notes nobody wants, which is the specific outcome the governance model exists to
prevent.

**Question 2: conflict resolution.** When a run stages a note whose identifier
collides with a human-authored note already in the store, layer-precedence rules
do not help, because both notes are in the same layer. Overwrite, skip, or
append?

All three are answers to a question that should not arise. Overwrite destroys
human work. Append produces a note with two voices and no owner. Skip is safe
but silently discards the run's output, and "silently" is the problem: the
collision is the interesting event and it disappears. The better move is to make
the collision impossible rather than to arbitrate it.

**Question 3: context budget.** Notes marked for automatic injection enter every
agent's context window, and the set grows monotonically across runs. Should a
budget be enforced, or is a "prefer search-only" convention sufficient?

A convention is not sufficient, because the failure is gradual and invisible.
Each promoted note is individually reasonable; the aggregate degrades every
agent's context, and the degradation shows up as worse output rather than as an
error. The cost is also paid by roles that have nothing to do with the harness
that wrote the note. Automatic injection is a shared resource with no natural
back-pressure, which is the standard case for an enforced bound.

**Decision:**

1. **Staged notes have a required schema, defined by the harness spec.** A
   staged note is Markdown with frontmatter, and the frontmatter minimally
   carries: a stable identifier, provenance identifying the note as
   machine-authored and naming the harness, role and run that produced it, a
   creation timestamp, an expiry derived from the configured time-to-live, and a
   content digest used for deduplication. The runtime rejects a staged note that
   does not conform, rather than writing it and hoping. Harnesses may add their
   own fields; the reserved set above may not be supplied by the harness,
   because clause 2 depends on the runtime being the sole author of provenance.

2. **The runtime writes provenance; the harness supplies content.** Extraction —
   deciding what is worth recording and phrasing it — is harness-specific, and
   no builtin extractor is provided. Encoding one harness's notion of
   significance as a default for all of them would fill the store with notes
   nobody chose. The runtime owns the surrounding mechanics for every harness:
   validating against clause 1, stamping provenance, enforcing the per-run note
   cap, applying deduplication and expiry, and writing to the configured
   location. A harness cannot opt out of those, and cannot forge provenance.

3. **Machine-authored notes occupy a reserved identifier namespace.**
   Identifiers for staged and promoted machine-authored notes are prefixed by
   the configured provenance tag. Human-authored notes may not use that prefix,
   and the runtime rejects a machine note whose identifier does not carry it. A
   collision between a machine-staged note and a human-authored note therefore
   cannot occur, and question 2's overwrite-skip-append choice does not need to
   be made. This is the answer to question 2: eliminate the case rather than
   arbitrate it.

4. **Within the machine namespace, deduplication decides; collisions are never
   silent.** Two machine notes with the same identifier are the expected case —
   it is how a run says "this again" — and the configured deduplication strategy
   resolves them, ordinarily by refreshing the existing note's timestamp rather
   than adding a second copy. Any resolution is recorded in the note's
   provenance so the history is legible. If a collision arises that
   deduplication cannot resolve, the staged note is retained unpromoted and
   surfaced for human resolution; it is never discarded quietly.

5. **A promoted note edited by a human becomes human-owned.** Promotion is a
   human act, and a promoted note subsequently edited by a human ceases to be
   machine-managed: expiry no longer applies to it, and deduplication will not
   rewrite it. The note records the transition in its provenance. Without this,
   the automation would eventually undo human editing of its own output, which
   is the same harm as overwriting a human note by a slower route.

6. **Automatic context injection is off by default and bounded when on.** A
   promoted note is search-only unless explicitly marked for automatic
   injection. Where injection is enabled, the `knowledge:` block carries a
   budget in both note count and bytes, and the budget is enforced at context
   collection rather than left to convention. Both bounds have runtime defaults,
   so a harness that enables injection without stating a budget is bounded
   anyway.

7. **Budget overflow degrades deterministically and visibly.** When eligible
   notes exceed the budget, admission is deterministic — a stated, reproducible
   order rather than directory order — and the resulting context bundle records
   which notes were admitted and which were omitted. Overflow is reported, not
   silent. It is not an error: a run must not begin failing because the
   knowledge store grew, since that would make an unrelated success condition
   depend on unrelated accumulated state.

8. **These answers bind the implementation but do not authorize it.** Knowledge
   write-back remains blocked on run-level hook dispatch as described above.
   Nothing here should be read as scheduling that work, and an implementation
   arriving later conforms to these clauses or supersedes them.

**Consequences:**

- Every harness that wants knowledge write-back writes its own extraction. That
  is more work per harness than a builtin would be, and it is deliberate: the
  cost falls on the party with the context to judge significance. If several
  harnesses converge on the same extraction shape, a builtin becomes an
  evidenced proposal rather than a guess, and a later ADR can add one.
- Clause 3 costs some identifier ergonomics. Machine notes get prefixed
  identifiers that read less cleanly than a human would choose, and the prefix
  is load-bearing rather than decorative — renaming it later invalidates the
  guarantee for every existing note. The prefix is configurable per the model
  restated above, which means a repository that changes it must migrate existing
  notes; the implementation should treat the prefix as effectively permanent
  once notes exist.
- Clause 1's reserved-field rule means the frontmatter shape is a compatibility
  surface from the first note written. Adding a reserved field later is safe;
  changing the meaning of one is not, since notes on disk cannot be
  retroactively re-stamped with knowledge nobody recorded.
- Clause 6 makes the search-only path the primary one, which shifts load onto
  retrieval quality. A knowledge store that is only useful when automatically
  injected is a store whose search is inadequate, and this ADR chooses to
  surface that as a search problem rather than hide it by injecting everything.
  The read path does not exist yet (`packages/context` has no knowledge
  provider), so whoever builds it inherits that emphasis.
- Clause 7 rules out the simplest budget implementation, a hard failure on
  overflow, in favor of one that must define an admission order and report
  omissions. That is more work, and it is the difference between a budget that
  bounds context and one that turns accumulated notes into intermittent run
  failures.
- Clause 2 requires that the write path be runtime-owned rather than a harness
  hook command that writes files itself. That is a constraint on the eventual
  implementation, and it is the reason the blocked `run_end` route matters: a
  design where the harness writes notes through its own hook would already work
  today, and would also let a harness forge its own provenance.
- Answering these questions before implementing leaves them unvalidated by use.
  Clause 8 is the mitigation — the answers bind an implementation that must
  either conform or supersede, and supersession is the normal mechanism under
  ADR 0014 rather than an admission of failure.
- The inert-lifecycle-event problem is now written down rather than discoverable
  only by reading hook generation against the declared event list. That the
  loader accepts handlers for events that can never fire is a trap beyond
  knowledge write-back, and anyone hitting it will find the explanation.
- The blockers note may go unmaintained, in which case a reader is no worse off
  than if the same text had been frozen into this ADR.

**References:**

- ADR 0005 — structured harness outcomes, the input any harness-specific
  extraction would draw on.
- ADR 0008 — env-carried per-role policy enforcement and the role-invariant
  generated hook configuration.
- ADR 0009 — spec v0.2 hook scoping; the hook model whose event mapping leaves
  `run_end` unreachable.
- ADR 0010 — the context provider contract that a knowledge read path would
  implement.
- ADR 0014 — ADRs are standalone; the reason this ADR restates the governance
  model in its own words. Repo-local `docs/` material remains citable, which is
  what the blockers note below relies on.
- `docs/design/knowledge-write-back-blockers.md` — the maintained record of what
  exists and what blocks the write path.
- Issue #136 (this decision).

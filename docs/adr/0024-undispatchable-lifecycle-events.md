# ADR 0024: run-level lifecycle events are the orchestrator's to dispatch; declaring an undispatchable event is reported, not accepted

**Status:** Accepted

**Status history:**

- 2026-08-03 — Proposed.
- 2026-08-03 — Accepted: merged in #175. Revised under review to separate
  `role_start` (unmapped, per-adapter, fixable by a generator) from `run_start`
  / `run_end` (structurally undispatchable by that route), after implementation
  found Claude Code's `SessionStart` is a correct `role_start` native.

**Context:** `HOOK_EVENTS` in `packages/harness-config/src/index.ts` declares
six canonical hook events: `pre_tool_call`, `post_tool_call`, `role_start`,
`role_stop`, `run_start` and `run_end`. The loader accepts a handler declared
against any of them, validates its shape, and stores it. The policy layer's
intervention vocabulary in `packages/policy/src/index.ts` names all six as well.

Three of the six do not run today, and they do not fail to run for the same
reason — a distinction this ADR draws deliberately, because conflating them
would freeze a claim that stops being true as soon as a second generator exists.
`role_start` is merely **unmapped**: no adapter's generator projects it, and any
adapter with a per-session start event could map it, at which point it fires
correctly. `run_start` and `run_end` are **structurally undispatchable** by that
route, for the reason set out below, and no generator can fix them. Hook
generation maps `pre_tool_call`, `post_tool_call` and `role_stop`; the generator
reports the rest as skipped, and the orchestrator dispatches no lifecycle events
of its own beyond the `onRoleStart` callback its caller uses to regenerate
adapter hook configuration. So a harness author who declares a `run_end` handler
gets a document that loads cleanly, a run that completes normally, and a handler
that never executes — with no diagnostic at any point. `run_start` is inert in
exactly the same way, and `role_start` is inert for the weaker reason above:
unmapped under the only generator that exists, not impossible.

`tests/hooks-generation.test.ts` asserts that the set of skipped events equals
`["run_end"]`. That reads like a contract and is a fixture artifact: `run_end`
is simply the only unmapped event the test's sample hooks happen to declare, and
`run_start` and `role_start` would be reported identically if they were. A test
that pins an incidental property of its fixture is not a description of the
system, and the next person to change the mapping will discover which it was the
hard way.

**Why a new adapter cannot fix this.** The obvious reading is that the mapping
is thin because only one adapter has a generator, and that a second adapter —
one whose CLI has a session-end event — would supply `run_end`. It would not,
for a structural reason rather than a contingent one.

The adapters a harness run can select all extend `SubprocessAgentAdapter`
(`packages/execution/src/index.ts`), which spawns one CLI process per `run()`
call. `NativeBunOrchestrator` (`packages/orchestration/src/index.ts`) invokes
the adapter once **per role invocation**, in all three execution modes:
concurrently over roles in `parallel`, sequentially in `chain`, and once per
role per round in `validation-loop`. An adapter's own session-end event
therefore fires once per role invocation — which is `role_stop`, the event
already mapped. It is not a run boundary, and no mapping table can make it one:
in `parallel` mode there is no last session, in `validation-loop` mode there are
several per role, and in every mode **no adapter can know which of its
invocations is the run's last**. That knowledge exists only in the
orchestrator's `run` method, which is the single place that sees the whole run.

The near-counterexample is worth disposing of explicitly, because it is in the
same package and a reader who finds it unaided will reasonably think the
argument above was made without looking.
`packages/execution/src/session-agent-adapter.ts` and
`packages/execution/src/agent-session-client.ts` describe a session keyed to a
run identifier and continued across many turns, used by
`packages/workers/src/implementation-runtime.ts`. That is a genuine run-spanning
session — and it is a stub that emits synthetic events and spawns nothing, it is
single-role, it is not selectable from `agents harness run`, and it never
reaches `NativeBunOrchestrator`. More importantly the third argument above still
applies to it: a run-scoped session cannot identify its final turn as the run's
end either.

**Why this matters beyond one feature.** ADR 0017 decided how knowledge
write-back is governed and recorded that its implementation is blocked on
run-level hook dispatch, with its clause 2 requiring the write path be
runtime-owned rather than a harness-supplied hook command that writes files
itself. The maintained note `docs/design/knowledge-write-back-blockers.md`
enumerates what would unblock it, and offers two routes: hook generation gaining
a mapping, "only possible if the adapter grows an equivalent event", or the
orchestrator dispatching run-level events itself. The first route is the one
this ADR closes. Leaving it open costs more than a wrong sentence in a note — it
suggests that building hook generators for further adapters is progress toward
knowledge write-back, which it is not, and it invites a future mapping table to
project a session event onto `run_end` and get a handler that fires once per
role while claiming to fire once per run.

The trap is also wider than that feature. Any author declaring a lifecycle hook
hits it, and the loader's acceptance is what makes it a trap rather than an
absence.

**Decision:**

1. **Run-level lifecycle events are the orchestrator's to dispatch, not an
   adapter's to report.** No hook generator maps `run_start` or `run_end` onto
   an adapter event. A generator that did would be describing a per-role event
   as a per-run one, which is worse than the current absence: an inert handler
   is visible once someone looks, and a handler that fires the wrong number of
   times is not.

2. **Declaring an event that cannot fire is reported to the author.** When a
   harness declares a handler for a lifecycle event that cannot be dispatched in
   the current configuration, the runtime says so — naming the event and the
   reason — rather than accepting it silently. This covers `run_start`,
   `run_end` and `role_start` together; closing one third of the trap because
   one third is what a test fixture happened to name is how it stayed open.

   **The test is per-adapter, not global**, which is the practical form of the
   distinction drawn in the context above. `run_start` and `run_end` are
   undispatchable for every adapter and always will be, by decision 1.
   `role_start` is undispatchable only where the active adapter's generator does
   not map it, so an adapter that maps a per-session start event must stop
   warning for it. A warning that fires when the handler would in fact run is
   the same defect as silence, pointed the other way, and it is worse in one
   respect: an author who learns to ignore these warnings stops reading the ones
   that are true. The reason string names which case applies.

3. **The report is a warning, not a load failure.** A harness declaring an inert
   lifecycle handler continues to load and run. The defect being corrected is
   that the author is not told; it is not that the document is invalid, and this
   decision changes no other behaviour. Documents that load today keep loading.

4. **The skip contract becomes a contract.** The assertion in
   `tests/hooks-generation.test.ts` enumerates every canonical event and its
   dispatchability, rather than pinning whichever unmapped event a fixture
   declares. Its previous form is revised deliberately here rather than adjusted
   later to make a change pass, which is the outcome the note recording it as a
   blocker was meant to force.

5. **Harness-declared run-level handlers do not execute under this decision.**
   Making a command declared in configuration run at run level is a new
   host-execution surface, and this repository has repeatedly found that
   workspace-sourced configuration reaching host argv is the defect shape worth
   pre-empting rather than discovering. The problem decision 2 solves is that
   the runtime is not truthful about what it will run; solving it does not
   require running anything. No consumer for run-level execution exists today:
   ADR 0017 clause 2 forbids the knowledge write path from being such a handler,
   which removes the only candidate.

6. **These constraints bind a later run-level dispatch implementation, and do
   not authorize one.** When a consumer appears, dispatch is the orchestrator's,
   it is wired at **every** site that constructs an orchestrator rather than at
   one entry point — `packages/cli/src/harness-run-main.ts` and
   `harnesses/code-review/src/config-runner.ts` are both such sites today, and
   issue #156 is what a key honoured on one and dropped on the other costs — and
   a failure in a run-level step does not change run status, per ADR 0021's
   gate-owned status and ADR 0017 clause 7's rule that a run must not begin
   failing because of accumulated unrelated state. Whether a harness-declared
   handler executes at that point, and under what trust source, is that
   decision's to make, not this one's.

**Consequences:**

- An author who declares a lifecycle handler that cannot fire under the adapter
  they are running learns immediately. That is the whole of the user-visible
  change.
- Knowledge write-back stays blocked, and is now blocked on something precisely
  named. The false hope that a newer adapter release could unblock it is
  removed, which is worth more than it sounds: it was the reason a
  hook-generation item was sequenced ahead of it.
- `docs/design/knowledge-write-back-blockers.md` is corrected to drop the
  adapter-mapping route. That note is maintained rather than immutable, which is
  why the finding is recorded here as well — a note can go stale, and this
  argument should outlive the line numbers it was derived from.
- Under the generator that exists when this is written, `role_stop` is the only
  lifecycle event reaching an adapter. That is a statement about the generator,
  not a limit this decision imposes: an adapter with a per-session start event
  can map `role_start`, and decision 2 requires the warning follow. What this
  decision does refuse is papering over the run-level gap with an event that
  fires at the wrong granularity — `role_stop` is not `run_end` no matter how
  convenient the projection would be.
- The two categories degrade differently over time, and that is the point of
  separating them. The set of adapters mapping `role_start` can only grow, so
  that half of the warning shrinks toward nothing. The run-level half does not
  move at all until an orchestrator dispatch point exists, which is decision 6's
  territory. An ADR that had called all three "inert" would have read as
  progressively more wrong while being progressively less useful.
- Decision 3 means a harness with an inert handler still runs, so an author who
  ignores warnings is no better off than before. A hard refusal was considered
  and rejected: it would break documents that load today for a defect that is
  informational, and the repository's fail-closed refusals are reserved for
  cases where continuing would produce an unenforced guarantee rather than an
  unfired hook.
- No `spec_version` increment is part of this decision. The set of declarable
  events is unchanged; only whether the runtime tells the truth about them
  changes.
- Decision 5 leaves `run_end` declarable and inert rather than removing it from
  `HOOK_EVENTS`. Removing it would be the cleaner statement and would break the
  policy layer's intervention vocabulary, which names all six, and would discard
  the vocabulary a later dispatch implementation needs.

**References:**

- ADR 0009 — spec v0.2 hook scoping; the event mapping whose gaps this decision
  makes visible.
- ADR 0017 — knowledge governance. Clause 2 (the write path is runtime-owned)
  removes the only candidate consumer for harness-declared run-level execution;
  clause 7 constrains what a run-level failure may do; clause 8 is the precedent
  for a decision that binds an implementation without authorizing it.
- ADR 0021 — gate-owned run status, which decision 6 defers to.
- Issue #156 — a declared key honoured at one entry point and dropped at
  another; the reason decision 6 names both orchestrator construction sites.
- `packages/harness-config/src/index.ts`, `packages/policy/src/index.ts`,
  `packages/hooks/src/index.ts`, `packages/orchestration/src/index.ts`,
  `packages/execution/src/index.ts`,
  `packages/execution/src/session-agent-adapter.ts`,
  `packages/execution/src/agent-session-client.ts`,
  `tests/hooks-generation.test.ts`,
  `docs/design/knowledge-write-back-blockers.md`.

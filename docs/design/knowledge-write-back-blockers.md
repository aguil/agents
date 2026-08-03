# Knowledge write-back: what exists, and why it is blocked

Companion to ADR 0017, which decides how knowledge write-back is governed. That
ADR is immutable; this note is not, and it is the part that needs updating as
the code moves.

**Verified:** 2026-08-02, against the knowledge read path (ADR 0022).

Keep this current. If a line reference below has drifted, fix it. If a blocker
listed here is removed, say so and date it — a reader needs to know whether
"`run_end` never fires" is still true without re-deriving it.

## What exists today

| Surface                                          | State                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `knowledge:` block in a harness definition       | Does not exist in any `harness.yaml`                                      |
| Knowledge directory under either `.agents/` tree | Example store under `examples/incident-triage/fixture/.agents/knowledge/` |
| Knowledge read path (context providers)          | **Exists** — `knowledge` and `knowledge-search` (ADR 0022)                |
| Per-run shared working state                     | Does not exist; the identifier appears nowhere                            |

The context provider registry (`packages/context/src/index.ts`,
`BUILTIN_CONTEXT_PROVIDER_NAMES`) includes nine providers — the original seven
plus `knowledge` and `knowledge-search`. The write path remains blocked; the
read path does not need it (ADR 0022).

Budget for injection is declared on the provider (`max_notes` / `max_bytes`),
not via a `knowledge:` harness block — that block stays deferred to the write
path (ADR 0022 §6 qualifies ADR 0017 clause 6's placement).

## Why the write path is blocked

The write path was designed to run at the end of a run, through a `run_end`
hook. That hook cannot fire. Four facts compose into the blockage.

**1. The event is declarable.** `run_end` is a member of `HOOK_EVENTS`
(`packages/harness-config/src/index.ts:62-71`) and of the policy intervention
vocabulary (`packages/policy/src/index.ts:38-44`). The loader accepts a handler
declared against it without complaint.

**2. Generation drops it.** `CURSOR_EVENT_MAPPING`
(`packages/hooks/src/index.ts:20-26`) maps only three canonical events onto the
one adapter that has a hook generator:

| Canonical event                      | Cursor event(s)                              |
| ------------------------------------ | -------------------------------------------- |
| `pre_tool_call`                      | `beforeShellExecution`, `beforeMCPExecution` |
| `post_tool_call`                     | `afterFileEdit`                              |
| `role_stop`                          | `stop`                                       |
| `role_start`, `run_start`, `run_end` | none — reported as skipped                   |

**3. A test pins the behavior.** `tests/hooks-generation.test.ts:66` asserts
`expect(skippedEvents).toEqual(["run_end"])`. Any change that starts executing
`run_end` has to revise this contract deliberately rather than by accident.

Worth knowing: that assertion names only `run_end` because `run_end` is the only
unmapped event the test's sample hooks declare. `run_start` and `role_start`
would be skipped identically; the test simply does not exercise them.

**4. The orchestrator does not close the gap.** Its only lifecycle callback is
`onRoleStart` (`packages/orchestration/src/index.ts:458`), which the CLI uses to
regenerate adapter hook configuration. It dispatches no run-level events and
runs no hook commands itself — hook execution belongs entirely to the adapter.

So a declared `run_end` handler is accepted, never generated, and never run.
`run_start` and `role_start` are inert in exactly the same way. `role_stop` is
the only lifecycle event that reaches an adapter today.

This trap is wider than knowledge write-back: the loader accepting handlers for
events that can never fire will mislead anyone declaring a lifecycle hook, not
just this feature.

## What would unblock it

Enumerated as gaps, not as a design. ADR 0017 §2 additionally requires the write
path be runtime-owned rather than a harness-supplied hook command, so a harness
cannot forge its own provenance — which is why the routes below are all runtime
work.

1. **A dispatch path for run-level events.** Either `CURSOR_EVENT_MAPPING` gains
   a mapping (only possible if the adapter grows an equivalent event), or the
   orchestrator dispatches run-level events itself rather than delegating to the
   adapter.
2. **Revise the skip contract.** `tests/hooks-generation.test.ts:66`.
3. **A knowledge read path.** ~~A provider registered in
   `packages/context/src/index.ts`, conforming to the contract in ADR 0010.~~
   **Done (2026-08-02)** — `knowledge` and `knowledge-search` per ADR 0022.
4. **A knowledge configuration and filesystem surface.** The `knowledge:` block,
   a staging location, and a promoted store — the example ships a promoted store
   under `examples/incident-triage/fixture/.agents/knowledge/`; the loader still
   does not parse a `knowledge:` block (deferred with the write path, ADR 0022
   §6).
5. **Per-run shared state**, if the eventual design still depends on it.

## Related decisions

- **ADR 0017** — the governance this evidence supports: staged-note schema,
  runtime-written provenance, reserved machine identifier namespace, enforced
  auto-context budget.
- **ADR 0022** — the knowledge read path (store layout, frontmatter, bounded
  admission) that implements the read half of ADR 0017's constraints.
- **ADR 0010** — the context provider contract the read path implements.
- **ADR 0009** — spec v0.2 hook scoping, and the `applies_to` mechanism.
- **ADR 0008** — env-carried per-role policy enforcement and role-invariant
  generated hook configuration.

# ADR 0005: Harness generalization Phase 0 — generic core surfaces

**Status:** Accepted  
**Context:** The monorepo's shared packages were code-review-shaped: `Finding`
(file/line/severity) was the only outcome type in `packages/core`, the
orchestrator only ran roles in parallel, `ContextRequest` carried PR-specific
top-level fields, and worker routing hard-coded three kinds. Building a second
harness (incident triage: scout → diagnose → fix → verify) requires generic
surfaces that fail loudly if they are secretly code-review-shaped. Exploration
notes behind this work live in `docs/exploration/` (deliberately untracked
working notes); this ADR is the durable record of the accepted decisions.

**Decision:**

1. **Generic outcome type** (`packages/core`): `HarnessOutcome`
   `{ id, kind, sourceRole, title, data }` is the per-role outcome surface.
   `Finding` remains the code-review specialization (`kind: "finding"`), with
   lossless `findingToHarnessOutcome` / `harnessOutcomeToFinding` converters
   that refuse (rather than coerce) malformed or non-finding outcomes.
   `HarnessRunResult.outcomes` is populated **only** for definitions that
   declare an `execution` config, so legacy result shape and I/O are
   unchanged.

2. **Execution modes** (`packages/orchestration`):
   `HarnessDefinition.execution` selects `parallel` (default when absent —
   existing fan-out), `chain` (sequential; `{previous}` / `{outputs.<roleId>}`
   prompt interpolation; abort at first failed step), or `validation-loop`
   (implementation roles in parallel → validators via `{previous}`; retry
   with `{validation}` feedback up to `maxRounds`; pass condition defaults to
   "validators emitted zero outcomes" as a build-time predicate until an
   expression language lands). Inter-step output is truncated at 2000 lines /
   50KB (limits matching pi-subagents) to prevent context overflow.

3. **Generic context** (`packages/context`): `ContextRequest.params` is the
   harness-agnostic input channel; `diffPath` / `pullRequestNumber` top-level
   fields are deprecated but honored with precedence during migration.
   Generic providers `static-file`, `shell-command`, and `file-glob` cover
   fixture-style inputs. File-based providers enforce workspace containment
   by default (realpath-based, symlink-safe); escaping requires the explicit
   `allowOutsideWorkspace` opt-in. Reads are bounded (`maxBytes + 1`), glob
   selection is bounded (O(maxFiles) memory, `maxScannedMatches` scan cap).

4. **Worker registry** (`packages/workers`): `builtinWorkerHandlers()`
   registers `code_review` / `pr_feedback` / `implementation`;
   `WorkerRouterOptions.workers` merges harness-specific handlers over them.
   Unmapped kinds fail explicitly instead of falling through.

**Accepted risk — `ShellCommandProvider` exec surface:** the provider runs a
constructor-configured command and pipes stdout into LLM-bound context. Unlike
the file providers there is no containment guardrail beyond cwd. Commands are
declared in build-time harness code — the same trust domain as lifecycle hook
scripts — and are not influenced by runtime request params. Exec gating
(allow/deny lists, policy verdicts) is the Phase 1 policy-eval layer's job;
adding a bespoke allowlist here would duplicate that design. Until Phase 1
lands, treat `ShellCommandProvider` command choices as reviewed code, not
config. (Disposition for review finding
`compliance-shell-command-disclosure-gap`.)

**Consequences:**

- The incident-triage proof harness can be expressed without editing shared
  packages: outcomes via `kind: "diagnosis"` etc., orchestration via `chain`,
  fixture inputs via generic providers, dispatch via a registered worker kind.
- Code review behavior is unchanged: no `execution` config means the exact
  pre-Phase-0 result shape, providers keep legacy field precedence, and
  builtin worker routing is preserved.
- Follow-up phases: Phase 1 adds the `.agents/` loader, builtin policy-eval
  (5-verdict, fail-closed) and per-adapter hook config generation; Phase 2
  ships the synthetic incident fixture and the end-to-end proof.

# ADR 0029: under `--strict`, a conformance row with no verdict fails the conformance role

**Status:** Proposed

**Status history:**

- 2026-10-13 — Proposed.

**Context:** ADR 0025 added an optional `conformance` role that checks a change
against acceptance-criteria rows. Decision 6 made sure a row the role never
answers is never a silent pass in the report: `report.md` lists it as having no
result. Its Consequences left run status alone: "Rows the role leaves unreported
are visible in the report but do not move run status. If that proves too weak in
practice, a later change can count them."

It proved too weak (#277). On 2026-10-12, `agents code-review --pr <n>` with the
Claude adapter ran the conformance role in a detached worktree while its request
file, the only place the rows exist, sat in the run directory outside that
worktree. Claude Code refused to read it, the role emitted no verdict, and every
row showed "no result". Across three PRs and two rounds each, every run passed.
`result.json` showed `conformance: scheduled`, an empty `conformance_reported`
and an empty `failed_roles`. The only signal was one stdout line pointing at the
coverage section. The read failure itself is an adapter bug: the change that
proposes this ADR also passes Claude Code `--add-dir` for run inputs outside the
role's worktree. That fix is not a decision recorded here. The status rule is
the part that let it pass unnoticed: a role that checked nothing looked the same
as a clean review to anything that reads status.

`--strict` already turns role-execution problems that are warnings by default
into failures: a timed-out role, and an output line the run could not accept. An
unanswered row is the same kind of problem. The role was asked a question and
did not answer it.

**Decision:**

1. **Under `--strict`, every scheduled criterion needs a verdict.** When run
   metadata records `conformance: scheduled`, the `conformance` role fails if
   any id in `conformance_criteria` has no well-formed verdict from that role.
   The role fails the way any role with a rejected output does: the role is
   listed in `failed_roles`, and the run status is `error`. This applies to one
   unanswered row as well as to all of them. A role that answered most rows
   still left a stated constraint unchecked.

2. **Without `--strict`, nothing changes.** An unanswered row is listed as
   having no result, as ADR 0025 decision 6 set, and does not move run status.

3. **No finding is synthesized.** The failure is a role failure, not a finding
   for the missing row. ADR 0025 ruled out findings the agent did not produce,
   and a role failure already reaches status, the report's coverage section, and
   posted reviews.

4. **The check is deterministic and lives with the conformance contract.** It
   runs in the same per-role output validation that rejects a non-satisfied
   verdict without its finding. The orchestrator passes that validation the
   run's strict mode and metadata, so the check reads the scheduled rows from
   the run rather than from the role. For `agents harness run` it applies only
   to a harness that collects acceptance criteria, as the existing conformance
   checks do. Another harness's own `conformance` role is unaffected.

**Alternatives considered:**

- **Count unanswered rows in status without `--strict`.** Rejected for now. A
  default run treats a timed-out role as a warning, and an unanswered row is no
  worse than a role that never finished. Making the default stricter for this
  role alone would be inconsistent.
- **Fail only when no row at all is answered.** Rejected. It catches the failure
  seen in #277 but lets a role skip one inconvenient row and still pass, and
  under `--strict` the operator asked for unchecked rows to count.

**Consequences:**

- Partially supersedes the ADR 0025 consequence that unreported rows "do not
  move run status", for `--strict` runs only. ADR 0025's decisions stand.
- Strict runs with criteria can now end in `error` where they passed before, so
  a model that skips a row turns the run red. That is the intended outcome.
- The `--strict` help for `agents code-review` and `agents harness run`, the
  code-review workflows guide, and the acceptance-criteria spec state the new
  failure.

**References:**

- ADR 0025: optional plan-conformance role gated on supplied acceptance
  criteria.
- #277: the conformance role could not read its criteria under `--pr` with the
  Claude adapter, and the run still passed.

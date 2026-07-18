# ADR 0007: Harness governance Phase 2 — spec extensions from the proof harness

**Status:** Accepted (§3's regeneration-as-policy-carrier and §5's
non-sequential coarsening rule superseded by ADR 0008)  
**Context:** Phase 2 set out only to _prove_ the ADR 0005/0006 machinery with
the incident-triage example, not to extend the contract. In practice, building
and dogfooding the example (including a live real-adapter run) surfaced several
gaps whose fixes extend the `harness.yaml` v0.1 surface and the governance
runtime. Those are durable, cross-package contract decisions, so they are
recorded here rather than left implicit in the example PR (#74).

**Decision:**

1. **Per-role `policy:` field** (`packages/harness-config`). A role may declare
   its own `policy: <id>`, overriding the harness-level default.
   `LoadedHarness.rolePolicies` resolves the effective policy per role (role
   override > harness default). This is what lets one chain run mix a read-only
   investigation policy with a write-capable remediation policy — the
   incident-triage `fix` role runs under `triage-fix` while
   scout/diagnose/verify inherit `triage-readonly`. Role records also reject
   unknown fields (matching hook-handler strictness) so a mistyped `policy:`
   fails loudly instead of silently dropping enforcement.

2. **`{"outcome":{...}}` envelope as the generic-outcome wire format.** Adapters
   emit generic outcomes as `outcome` events; the subprocess adapter parses
   `{"outcome":{id,kind,sourceRole,title,data}}` envelopes both as standalone
   stdout lines and **nested inside stream-json assistant text** (how a real
   Cursor agent actually emits them — a gap the scripted E2E could not surface,
   caught by the manual run). Findings and outcomes are disjoint by top-level
   key.

3. **Per-role hook regeneration, unconditional.** In chain mode the runner
   regenerates `.cursor/hooks.json` with the role's effective policy before
   **every** role — not skipping when the policy id is unchanged. Skipping would
   let a role tamper with the on-disk hook file and have the next same-policy
   role reuse it; a governance surface must re-establish canonical enforcement
   per role. Defense in depth: example policies deny writes to `.cursor/**` and
   `.agents/**` so no role can tamper regardless.

4. **Fail closed when a policy cannot be enforced.** Hook config generation is
   cursor-only in v1. If a harness declares a policy and the selected adapter
   cannot generate enforcement, `agents harness run` refuses to start unless the
   operator passes `--allow-unenforced-policy`. Silently running unenforced is
   the wrong default for a governance layer.

5. **`agents harness run` runner.** The generic config-driven runner
   (loadHarness → adapter → per-role hook generation → orchestrator → outcome
   summary; exit 0 on `passed`). Non-sequential modes (parallel,
   validation-loop) generate hooks once from the harness-level policy and warn
   about any per-role policy that is therefore coarsened, since per-role
   regeneration would race on the shared hook file.

6. **Generic outcomes are deduplicated by `id` at collection, first occurrence
   wins.** Real subprocess agents repeat the same `{"outcome":...}` envelope in
   an intermediate assistant message and the terminal result event, so the
   nested-envelope scan captures duplicates. The outcome `id` is its identity:
   the orchestrator keeps the first occurrence per role run, and the merged
   outcomes view applies the same rule so a stream-echoed duplicate finding
   cannot appear twice after conversion. `result.findings` is deliberately
   exempt — code-review reporting owns finding dedup (canonical fingerprint)
   with different semantics. Companion fix: prompts must not contain
   copy-pasteable envelope examples (a literal example is valid JSON the model
   can echo verbatim and the pipeline would capture); prompt files describe the
   envelope as a field list instead.

7. **Run status is decoupled from finding severity for generalized harnesses.**
   A manual real-adapter run showed a live agent emits diagnostic findings (e.g.
   scout calling the bug "critical") even when prompted for outcomes, and the
   code-review status rule (`critical finding => failed`) then failed a run
   whose incident was actually healed. The scripted E2E masked this (the fake
   agent emits no happy-path findings). For execution-configured harnesses,
   findings and outcomes are diagnostic payload and never drive status. Status
   comes from role execution (failed/timed-out) plus an optional
   **`execution.pass_check`** — a command the runtime runs in the workspace
   after the chain (exit 0 => passed). It is deliberately runtime-evaluated, not
   agent-reported: agent self-report is the same fragility that caused the bug.
   Legacy harnesses (no `execution`) keep finding-severity status. For
   incident-triage, `pass_check: ["bun","run","check.ts"]` makes success mean
   "the incident is actually healed."

**Consequences:**

- The example lives under `examples/incident-triage/` as a reference, not a
  supported harness; promotion gates remain tracked in #73.
- Real-adapter outcome duplication and prompt-placeholder echo (#75) are
  resolved by §6 (outcome-id dedup + de-exemplified prompts).
- The v0.1 spec surface is now: harness metadata, roles (with optional per-role
  `policy:`), `execution` modes, `hooks` (command handlers), harness- and
  role-level `policy:` references, and `outcome` envelopes as the role output
  contract. A future v0.2 is the place for the deferred items (`applies_to` hook
  scoping #71, richer handler types).

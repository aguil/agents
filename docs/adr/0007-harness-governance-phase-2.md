# ADR 0007: Harness governance Phase 2 — spec extensions from the proof harness

**Status:** Accepted  
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

**Consequences:**

- The example lives under `examples/incident-triage/` as a reference, not a
  supported harness; promotion gates remain tracked in #73.
- Known non-blocking follow-up: real-adapter outcomes can be duplicated or echo
  prompt placeholders (#75).
- The v0.1 spec surface is now: harness metadata, roles (with optional per-role
  `policy:`), `execution` modes, `hooks` (command handlers), harness- and
  role-level `policy:` references, and `outcome` envelopes as the role output
  contract. A future v0.2 is the place for the deferred items (`applies_to` hook
  scoping #71, richer handler types).

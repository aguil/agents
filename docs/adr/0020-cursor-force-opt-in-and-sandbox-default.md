# ADR 0020: Cursor `--force` is opt-in; unforced runs default to `--sandbox enabled`

**Status:** Accepted

**Status history:**

- 2026-08-02 — Proposed.
- 2026-08-02 — Accepted: merged in #168.

**Context:** `agents harness run` constructed the Cursor adapter as
`new CursorAdapter({ force: true })`, and `buildCursorCommand` treated `--force`
as default-on (`force !== false`). The code-review CLI path also hardcoded
`force: true`. Cursor's help text for `--force` is "Force allow commands unless
explicitly denied."

Every shipped or example policy that declares
`confirmations.requiredFor: [exec.unknown]` (and the same category for
`filesystem.write`) relies on the policy evaluator returning `escalate`, which
`agents policy-eval` maps to hook `permission: "ask"`. The intended posture is
allowlist-plus-escalation: unrecognised commands stop for approval rather than
failing open. With `--force`, that escalation is inert — the deny list becomes
the only real control.

This was found by the repository's own code-review harness as
`security-harness-run-force-bypasses-exec-unknown` (critical). Issue #158 had
been discarding it on prose heuristics; after ADR 0019 it became issue #159.

**Measured against Cursor CLI `2026.07.23-e383d2b`** (headless
`agent --print --output-format stream-json --trust`, stub `beforeShellExecution`
hook emitting a fixed verdict). Single-trial cells; decisive pairs re-checked as
controls when extending the matrix.

| Hook verdict | Flags     | Command | Shell outcome        |
| ------------ | --------- | ------- | -------------------- |
| `ask`        | `--force` | `touch` | **success** (bypass) |
| `deny`       | `--force` | `touch` | rejected             |
| `ask`        | _(none)_  | `ls -a` | rejected             |
| `allow`      | _(none)_  | `ls -a` | success              |
| `allow`      | _(none)_  | `touch` | **rejected**         |

So: `--force` specifically collapses hook `ask` into allow while still honouring
`deny`; `ask` is a real distinct state without `--force`; and a hook `allow`
does **not** authorise a non-read-only write headlessly — Cursor's own approval
gate still rejects it. Nothing hung; the CLI rejects rather than waits.

That last row breaks the naive fix (drop `--force` alone): write-capable roles
would lose every policy-allowed write. Three mechanisms were checked for "policy
said allow, so actually approve it":

1. **Stronger hook response** — published `beforeShellExecution` output is only
   `permission: "allow" | "deny" | "ask"` plus optional messages. Probing
   `continue: true`, `permission: "approve"`, a `force: true` field, and the
   Claude nested `permissionDecision: "allow"` form — none authorised a headless
   write. Dead.
2. **`--auto-review`** — allowed writes succeed, but `ask` on a write still
   executed (sentinel created). Same hole as `--force`, plus a server-side
   classifier on the trust path. Rejected for this decision.
3. **`--sandbox enabled`** — `allow` + `touch` succeeds; `ask` and `deny` both
   reject (read and write); `allow` + `curl https://example.com` returned
   HTTP 200. Hook payloads report `sandbox: true`. Fits.

Scope of the measurement is `beforeShellExecution` / exec. `filesystem.write`
escalation uses the same `escalate → "ask"` bridge mapping and is covered by the
same CLI flags; `afterFileEdit` was not separately probed.

**Decision:**

1. **`CursorAdapterOptions.force` defaults off.** `buildCursorCommand` emits
   `--force` only when `force === true`. An omitted option must not weaken hook
   enforcement.
2. **When force is off, default `--sandbox enabled`.** Implemented by
   `resolveCursorApprovalFlags`: if `sandbox` is omitted and force is not true,
   emit `--sandbox enabled`. Explicit `sandbox: "disabled"` turns it off. Forced
   runs do not get a sandbox flag unless the caller sets one.
3. **`agents harness run` gains `--force-tool-calls`.** Default off. When set,
   constructs `CursorAdapter({ force: true })` and warns on stderr — loudly when
   the harness also declares a policy. Precedence for "weaker posture is stated,
   not inherited" matches `--allow-unenforced-policy`.
4. **Code-review CLI and worker callers adopt the safe default.** The
   code-review path stops hardcoding `force: true`. Workers that call
   `createCodeReviewAdapter(name)` with no options keep that shape deliberately
   (comments name this ADR); they must not silently regain force.
5. **Provenance.** Run metadata records `cursor_force` and `cursor_sandbox` on
   both the code-review and harness-run paths so a finished run's posture is
   reconstructable.

**Consequences:**

- External consumers of `@aguil/agents-execution` who constructed
  `CursorAdapter` / `buildCursorCommand` with no options previously got
  `--force` and now get `--sandbox enabled` instead. That is a behavioural break
  without a signature change (`fix(execution)!:`).
- Policy `escalate` / hook `ask` becomes enforceable on the default Cursor path.
  Operators who need the old auto-allow behaviour must pass `--force-tool-calls`
  (harness run) or `force: true` (library).
- Unattended `ask` still surfaces as a generic CLI rejection (empty reason
  string), indistinguishable from Cursor's own headless write rejection. A
  distinct `policy-approval-required` outcome needs the bridge to record its
  verdict out-of-band — follow-up work, not this ADR.
- Sandbox changes the execution environment (`sandbox: true` in hook payloads).
  Basic workspace writes and HTTPS egress worked in probes; roles that need
  broader host access may need an explicit `sandbox: "disabled"` or force
  opt-in, which must remain an operator statement.

**References:**

- Issue #159
- ADR 0006 (governance / policy bridge), ADR 0008 (env-carried enforcement), ADR
  0019 (finding that recovered this defect from the actionable filter)
- `packages/execution/src/index.ts` — `resolveCursorApprovalFlags`,
  `buildCursorCommand`
- `packages/cli/src/harness-run-main.ts` — `--force-tool-calls`
- Cursor Agent CLI `2026.07.23-e383d2b`

# ADR 0006: Harness governance Phase 1 — loader, policy evaluation, hook config

**Status:** Accepted  
**Context:** ADR 0005 generalized the core types and orchestration for
multi-harness support and forecast a governance layer: configuration loaded from
`.agents/`, declarative policies enforced before any agent tool call, and
per-adapter hook config generation. This ADR records the shipped decisions for
that layer. They are contract decisions — a versioned spec format, security
enforcement semantics, and a pipeline ordering guarantee — so they clear the bar
of "durable decisions affecting multiple harnesses or shared package
boundaries."

**Decision:**

1. **`harness.yaml` spec v0.1 with single-file resolution**
   (`packages/harness-config`). `loadHarness` reads
   `.agents/harnesses/<id>/harness.yaml`, requires `spec_version: "0.1"` /
   `kind: harness` / id-matches-directory, and maps roles, `execution:` modes,
   and `hooks:` onto the orchestration types. `policy: <id>` resolves to
   `.agents/policies/<id>.yaml` (AGENTS-1-style
   `capabilities.filesystem/exec/network` allow/deny lists,
   `limits.cost_usd/timeout_ms`, `confirmations.requiredFor`). **Deliberately
   excluded from v0.1:** scopes, profiles, user overlays (`~/.agents/`), and
   CLI-flag merging — the full AGENTS-1 resolution algorithm is deferred until a
   concrete need, not an oversight. Hook handlers are `command:` only; `prompt:`
   / `http:` handler types are out of spec v0.1.

2. **Native policy evaluation with the ACS 5-verdict model**
   (`packages/policy`). Verdicts: `allow | warn | deny | escalate | transform`.
   Composition orders deny > escalate > transform > warn > allow; a policy deny
   is never overridable by later verdicts. The evaluator never throws — internal
   failures return `deny` with the reserved `policy-runtime-error` reason (fail
   closed). Enforcement semantics chosen deliberately:

   - Exec rules match on word boundaries: deny `rm` blocks `rm -rf` but not
     `rmdir`; equality or `rule + " "` prefix, nothing fuzzier.
   - Deny overrides allow; a non-empty allow list denies unlisted
     commands/paths/hosts.
   - Cost budgets warn at 80% and deny at the limit.
   - Confirmation categories convert a would-be deny into `escalate` (approval
     path): `exec.unknown` for allow-list misses, `filesystem.write` for write
     tools. Deny-list hits stay hard denies.
   - Rego/ACS engines are out of scope; this is the default `engine: native`
     path, with the engine field reserved for later.

3. **Layered enforcement pipeline: policy first, user hooks supplement.** The
   builtin policy-eval handler is registered as the _first_ handler on every
   mapped tool event in generated adapter config. User hooks run after and can
   tighten but never loosen: verdict composition means a policy deny stands
   regardless of what user hooks return.

4. **Cursor is the Phase 1 hook config target** (`packages/hooks`).
   `generateCursorHooksConfig` projects canonical events into
   `.cursor/hooks.json` (version 1) using the dotagents-compatible mapping:
   `pre_tool_call → beforeShellExecution + beforeMCPExecution`,
   `post_tool_call → afterFileEdit`, `role_stop → stop`. Canonical events with
   no Cursor equivalent (`run_start`, `run_end`, `role_start`) are returned as
   `skippedEvents`, never silently dropped. Other adapters (Claude Code, Codex)
   follow the same projection pattern later.

5. **`agents policy-eval` is the hook-to-evaluator bridge** (`packages/cli`).
   Generated config invokes
   `agents policy-eval --policy <id> [--agents-dir <dir>]`; the subcommand reads
   the hook payload from stdin (Cursor's shape or the canonical contract),
   normalizes it, evaluates the policy, and answers with Cursor's permission
   protocol: allow/warn/transform → `allow` (warn also logs to stderr), deny →
   `deny` with an agent-facing reason, escalate → `ask`. Unreadable policies,
   unknown events, and invalid stdin all fail closed with `deny`.

**Consequences:**

- A harness gains policy enforcement by declaring `policy: <id>` — no build-time
  code. The incident-triage fix role (Phase 2) runs under an execute-profile
  policy with this pipeline as its guardrail.
- Spec v0.1 consumers can rely on unknown-version rejection rather than silent
  misparsing; spec evolution requires a version bump and loader support.
- The warn verdict currently reaches operators via stderr only; richer
  warn/telemetry routing is future work.
- `ShellCommandProvider` exec gating deferred in ADR 0005 now has its landing
  zone: a policy with exec rules governs commands at the adapter boundary,
  though provider-internal gating remains open (issue #67).

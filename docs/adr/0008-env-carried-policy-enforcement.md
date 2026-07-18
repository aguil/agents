# ADR 0008: Env-carried per-role policy enforcement (role-invariant hook config)

**Status:** Accepted **Context:** ADR 0007 §3/§5 enforced per-role policy by
rewriting `<workspace>/.cursor/hooks.json` with the role's effective policy id
before each role. Because Cursor reads one hook config at a fixed workspace
path, that mechanism was only race-free for sequential roles: parallel and
validation-loop modes deliberately coarsened to the harness-level policy (with a
warning), and two concurrent runs sharing a workspace could make a role execute
under the other run's policy (#76). The redesign constraints — per-role
enforcement in all modes, concurrent-run safety, and no re-introduction of the
mid-run tamper vector — are recorded in #77.

A spike against the real Cursor CLI (2026.07.16) established three facts the
design relies on:

1. Hook subprocesses inherit the environment of the `agent` CLI process that
   spawned them, and the runner controls that environment per spawn.
2. Shell commands run _by_ the agent cannot alter the environment that later
   hook invocations observe (they are children of the CLI, not ancestors).
3. `sessionStart` hooks can inject session-scoped env vars, but injected values
   do **not** override variables already present in the CLI process environment
   — so a tampered hook config cannot shadow the enforcement identity.

**Decision:**

1. **Policy identity travels in per-spawn process environment, not in the hook
   config file.** The runner sets `AGENTS_POLICY_ID` and `AGENTS_AGENTS_DIR`
   (absolute) on each role's agent subprocess. `AgentRunRequest.env` carries the
   variables; the orchestrator populates it via a `roleEnv(roleId)` callback.
   Because environment is process-scoped, N parallel roles and N concurrent runs
   each carry their own policy with no shared mutable state.

2. **The generated `.cursor/hooks.json` is role- and run-invariant.** The
   builtin bridge entry is `<agents-cli> policy-eval` with no embedded policy id
   or agents dir; `agents policy-eval` resolves them from its inherited
   environment (explicit flags still win, for direct invocation and tests). The
   file's bytes depend only on the harness's own `hooks:` handlers and the
   operator's CLI token, so concurrent same-harness runs write identical bytes —
   idempotent, hence race-free.

3. **Roles without a policy get the reserved token `AGENTS_POLICY_ID=@none`.**
   The bridge treats `@none` as an explicit no-op (allow). The token is not a
   valid policy id (ids match `^[A-Za-z0-9][A-Za-z0-9._-]*$`), so it cannot
   collide. A **missing** variable is different: the bridge fails closed (deny),
   because absence means the enforcement env was stripped or the bridge was
   invoked outside a governed run.

4. **Unconditional per-role regeneration is retained** — now in _all_ execution
   modes, since writers produce identical bytes. Regeneration re-establishes the
   canonical file if a role tampered with it (ADR 0007 §3's reasoning stands);
   the constant content is what makes doing so safe under parallel roles and
   concurrent runs. Defense in depth also stands: example policies deny writes
   to `.cursor/**` and `.agents/**`.

5. **The mode split and coarsening warning in `agents harness run` are
   removed.** Per-role policy is enforced in chain, parallel, and
   validation-loop modes alike. Fail-closed behavior for non-cursor adapters
   (ADR 0007 §4) is unchanged.

**Consequences:**

- Supersedes ADR 0007 §3 (per-role regeneration as the _carrier_ of policy
  identity) and the §5 coarsening rule. Regeneration remains, demoted from
  enforcement mechanism to tamper-repair.
- #76 is resolved; the residual (accepted) exposure is that the hook file still
  lives inside the role-writable workspace because Cursor offers no alternative
  discovery path with correct precedence — project-level config outranks
  user-level, so moving the bridge to `~/.cursor/hooks.json` would _weaken_ it.
  An upstream feature (configurable hook-config path) would let the file leave
  the workspace entirely.
- Concurrent runs of _different_ harnesses (different `hooks:` handlers) or
  different `--agents-cli` tokens on one workspace can still write differing
  bytes; this narrow case remains documented in #76's successor scope rather
  than blocked, since policy enforcement itself no longer depends on file
  content.
- The env names `AGENTS_POLICY_ID`, `AGENTS_AGENTS_DIR`, and the `@none` token
  are part of the enforcement contract and must not be repurposed.

# ADR 0023: hook generation beyond Cursor — per-adapter projection, run-scoped configuration, and a mechanical enforcement claim

**Status:** Proposed

**Status history:**

- 2026-08-03 — Proposed.

**Context:** `packages/hooks` exports one generator,
`generateCursorHooksConfig`, which projects a harness's canonical `hooks:` block
onto Cursor's `.cursor/hooks.json` shape. It is the only generator that exists.
`agents harness run` can construct four adapters — `cursor`, `claude`,
`opencode`, `fake` — so two of the three real ones have no hook configuration at
all, and therefore no policy enforcement.

That gap is already load-bearing. `setUpHookEnforcement`
(`packages/cli/src/harness-run-main.ts`) refuses to run a policy-declaring
harness on any adapter other than `cursor` unless the operator passes
`--allow-unenforced-policy`, on the reasoning that an unenforced policy is worse
than no policy — it looks like a guardrail and is not one. The refusal is
correct and is the right shape; what is wrong is that it is expressed as a
literal comparison against the adapter name `"cursor"`, with the reason living
in a comment and an error string rather than in anything a program can consult.

Three further couplings make "add a second generator" larger than it sounds.

**The policy bridge speaks Cursor on both sides.** `agents policy-eval` emits
`{ permission: "allow" | "deny" | "ask", agentMessage?, updated_input? }` on
every output path, which is Cursor's response shape. And while
`normalizeHookPayload` (`packages/cli/src/policy-eval-main.ts`) already reads
the field name `hook_event_name`, it maps only Cursor's event _values_. A Claude
Code payload therefore arrives carrying `hook_event: "PreToolUse"`, misses
`HOOK_EVENT_TO_INTERVENTION` in `packages/policy/src/index.ts`, and returns
`deny` with the runtime-error reason. That is the correct fail-closed default
and the wrong outcome: every tool call would be blocked, so the adapter is not
merely unenforced but unusable under a policy.

**The event vocabulary exists in more than one place.** Besides the generator's
mapping and the intervention table, `agents hooks test`
(`packages/cli/src/hooks-test-main.ts`) carries its own list of supported
events. ADR 0009 §3 made that command the probe surface for policy behaviour, so
a vocabulary it does not share with the bridge means the diagnostic disagrees
with the thing it diagnoses.

**Generated configuration currently mutates the user's workspace.** The Cursor
generator's output is written to `<workspace>/.cursor/hooks.json` — a file in a
tree the user owns and commits. The write is careful (temp file, random suffix,
atomic rename) because it had to be: concurrent role starts share a pid and a
timestamp, and a partially written file silently drops enforcement. That care is
evidence of the cost, not a reason to repeat the pattern.

**Measured against the installed CLIs, 2026-08-03.** Claude Code `2.1.220`
publishes `--settings <file-or-json>`, described as loading _additional_
settings, and `--setting-sources <sources>`, which selects which of the `user`,
`project` and `local` settings sources load at all. Together those are a seam
for supplying hook configuration without touching the workspace. The same CLI's
`--print` documentation states that **settings files which fail validation are
silently ignored in that mode, with no error shown** — so a malformed generated
file produces a run with no hooks and no signal, which is the exact failure this
ADR's refusal exists to prevent. `--bare` and `--safe-mode` both disable hooks
outright.

OpenCode `1.14.39` has no equivalent declarative hook file. Its extension
surface is a plugin — `opencode plugin <module>` installs an npm module and
edits config — so generating for it means emitting **executable JavaScript into
a user's tree**, and `opencode run --pure` ("run without external plugins") is
on the path `buildOpenCodeCommand` already uses.

What has _not_ been measured is whether hooks supplied through
`claude --settings` actually fire, and what response shape denies a tool call on
that CLI. This ADR is `Proposed`; that verification is a precondition of
accepting it, and if it refutes decision 3's mechanism the decision is revised
before merge rather than after (ADR 0014: an unmerged ADR revises normally).

**Decision:**

1. **Generation is per-adapter and table-driven.** One reified table maps, for
   each supported adapter, every canonical `HookEvent` onto its native event or
   events, carries the event-class classification spec v0.2 `applies_to` needs
   (ADR 0009 §1), and carries one further bit per adapter: whether its hook
   mechanism can return a **blocking** verdict. Events with no native equivalent
   are reported as skipped, never silently dropped — the behaviour the Cursor
   generator already has, generalized. Every consumer of the vocabulary derives
   from this table rather than restating it, including `agents hooks test`.

2. **The enforcement claim is mechanical, not editorial.** The refusal in
   `setUpHookEnforcement` consults decision 1's capability bit instead of
   comparing the adapter name against `"cursor"`. An adapter whose hook
   mechanism cannot deny keeps the refusal, whether or not a generator exists
   for it. This is the substance of the rule the current comparison encodes by
   accident: what matters is not "is this the adapter we happened to build
   first" but "can a policy `deny` stop the call".

3. **Generated hook configuration is run-scoped and does not mutate the
   workspace.** New generators write into the run scratchpad and the file is
   passed to the adapter by flag — for Claude Code, `--settings`. Nothing is
   written into the user's tree, nothing needs restoring after a crashed run,
   and no merge semantics against a user-owned file have to be defined. The
   existing `<workspace>/.cursor/hooks.json` write is grandfathered because
   changing it would alter behaviour this decision is not otherwise touching; it
   is not a precedent, and retrofitting Cursor onto the run-scoped shape is
   follow-up work.

4. **The generator validates what it writes.** Because the Claude Code CLI
   silently ignores an invalid settings file under `--print`, an unnoticed
   malformed file yields a run with no hooks and no error — enforcement lost in
   the permissive direction, silently. The generator therefore checks its own
   output is well-formed against the shape it intends before the adapter is
   spawned, and a configuration that cannot be shown well-formed fails the run.
   Failing a run is acceptable here in a way it is not elsewhere in this
   repository: the alternative is not a degraded run but an unenforced one.

5. **Adapter invocations that disable hooks are refused when a policy is
   declared.** `--bare` and `--safe-mode` skip hooks by design, and
   `ClaudeCodeAdapterOptions.argsTemplate` lets a caller build argv that omits
   the settings flag entirely. Under a declared policy each of those is the same
   condition decision 2 refuses, arriving by a different route, and is refused
   the same way rather than producing a silently unenforced run.

6. **The bridge's response encoding is selected explicitly, never inferred.**
   `agents policy-eval` takes a format argument naming the adapter's response
   shape, emitted by the same generator that emitted the event mapping. It
   defaults to Cursor's shape, so already-generated configurations keep working.
   Inference from the payload is rejected: `PolicyHookInput` already records
   that hook stdin comes from the adapter process rather than the runtime and is
   not a trustworthy channel, and deriving _how an enforcement decision is
   encoded_ from that channel extends the untrusted input's reach from the
   decision's subject to its form.

7. **An unrecognized hook event still denies.** Extending the vocabulary per
   decision 1 does not weaken the default. A payload naming an event the table
   does not know is a payload the runtime cannot reason about, and fail-closed
   remains correct. This is stated so the next person adding an adapter reads
   the deny as the design rather than as a defect.

8. **An adapter joins the supported set when it satisfies two conditions**: its
   hook mechanism can deny a tool call, and its configuration can be supplied
   run-scoped without installing code into the user's tree. Claude Code
   satisfies the second as measured and is expected to satisfy the first.
   OpenCode satisfies neither today — its extension surface is an installed npm
   plugin — so it stays out, keeps the refusal of decision 2, and the error
   message says why rather than saying "cursor-only". Should a mechanism appear
   that meets both, adding OpenCode is filling a table row; generating
   executable code into a workspace to get there is a different decision and is
   not authorized here.

**Consequences:**

- Claude Code becomes an adapter on which a declared policy is enforced, and
  OpenCode does not. The `--allow-unenforced-policy` escape hatch stays, and the
  set of adapters needing it shrinks by one.
- Adding an adapter now requires filling a table row that includes a capability
  claim. That is deliberate friction: the claim "this adapter enforces policy"
  is the one most costly to get wrong, and a table entry is harder to add
  absently than a name in a conditional.
- The Cursor path is unchanged byte-for-byte, which is the intended proof that
  the refactor in decision 1 preserved behaviour rather than merely passing.
- Two shapes of generated configuration exist at once — Cursor's in-workspace
  file and everything else's run-scoped file. That is a wart with a stated
  lifetime rather than a design, and decision 3 names the follow-up.
- Decision 4 mitigates the malformed files this repository produces. It cannot
  mitigate a settings file an operator hand-edits, nor any other case where a
  CLI outside this repository fails open silently. That class of risk is
  inherent to enforcing policy through a third-party tool's extension point, and
  it is the strongest argument available for keeping decision 2's refusal rather
  than softening it to a warning.
- The vocabulary consolidation in decision 1 will surface disagreements that
  already exist between the generator, the intervention table and
  `agents hooks test`. Finding them is the point; ADR 0018's drift work made the
  same trade for the schema and the loader, and found two live disagreements it
  was written to prevent.
- No `spec_version` increment is part of this decision. The `hooks:` block's
  authoring surface — events, matchers, `applies_to`, timeouts — is untouched;
  only what the runtime does with it changes.
- Hook configuration for a role-scoped adapter session cannot express a
  run-level event. That is out of scope here and is decided in ADR 0024, which
  this decision's table must not attempt to work around.

**References:**

- ADR 0006 — the governance layer whose policy bridge runs first on every mapped
  tool event.
- ADR 0008 — env-carried per-role policy enforcement; why the generated file is
  role- and run-invariant and why policy identity does not travel in it.
- ADR 0009 — spec v0.2 `applies_to` event classes, which decision 1's table must
  carry per adapter, and `agents hooks test` as the probe surface.
- ADR 0018 — the precedent for reifying a surface so two descriptions of it
  cannot disagree.
- ADR 0020 — the Cursor approval-flag decision, and the precedent for measuring
  an adapter CLI's behaviour before deciding against it.
- ADR 0024 — run-level lifecycle events, which decision 1 deliberately does not
  map.
- Issue #156 — declared keys that are parsed and never consumed; the reasoning
  behind refusing rather than silently under-enforcing.
- `packages/hooks/src/index.ts`, `packages/cli/src/harness-run-main.ts`,
  `packages/cli/src/policy-eval-main.ts`, `packages/cli/src/hooks-test-main.ts`,
  `packages/policy/src/index.ts`, `packages/execution/src/index.ts`.
- Claude Code CLI `2.1.220`; OpenCode `1.14.39`; Cursor Agent CLI
  `2026.07.23-e383d2b`.

# ADR 0011: CEL role enablement (spec v0.2)

**Status:** Accepted **Context:** #73 Tier 1 requires conditional role
enablement so a config-driven code-review harness can express triage-tier
scheduling (trivial → quality; lite → security/quality/compliance; full → all)
declaratively. This ADR records both the expression language selection and how
it enters the spec.

CEL is the expression language because it is side-effect-free and deterministic,
so an expression is safe to evaluate anywhere in the pipeline and cannot vary
between evaluations of the same input; it has implementations across TypeScript,
Go, Java and Python, so the spec is not bound to a single runtime; it is compact
enough to sit inline as a YAML scalar; and it is established as a
policy-expression language in Google IAM, Kubernetes admission webhooks, and
Envoy, which means its semantics are well understood by anyone who will author
these expressions.

`@marcbachmann/cel-js` is the TypeScript runtime. The original `cel-js`
(ChromeGG) stalled at v0.8.2 in July 2025 and is effectively superseded;
`@marcbachmann/cel-js` is zero-dependency, MIT-licensed, ships full TypeScript
definitions, and covers close to the full CEL spec including macros, custom
functions and types, and optional chaining. Two of its features are load-bearing
for our use: the Environment API's type checking for declared variables, and
strict undeclared-variable handling via `unlistedVariablesAre`, which makes an
expression referencing absent context fail loudly rather than silently
evaluating against nothing. That second property is what the fail-closed
evaluation below depends on.

**Decision:**

1. **Spec field.** Roles may declare `enabled: <CEL expression>` (spec v0.2,
   additive). Expressions are compile-checked at load time — a syntax error
   fails the load naming the role, never surfacing at role start.

2. **Fail-closed evaluation.** `filterEnabledRoles(definition, env)` evaluates
   expressions against a flat scalar environment. An evaluation error (including
   references to bindings the environment does not provide) or a non-boolean
   result throws, naming the role: silently enabling runs a role the author
   meant to gate; silently disabling skips a policy-relevant role. Callers
   convert the throw into a controlled run-abort before any role executes.

3. **Structural consistency.** The filtered definition stays coherent: chain
   `order` drops disabled roles; a validation-loop referencing a disabled
   participant is a configuration error; a harness whose roles are all disabled
   is a configuration error, not a vacuous success.

4. **Evaluation stays out of orchestration.** `RoleDefinition.enabledWhen` is a
   carried string; the orchestrator never evaluates it. The CEL dependency lives
   only in `harness-config`, and enablement is decided once, before
   orchestration, from collected context.

5. **Environment bindings come from collected context.** `agents harness run`
   binds `tier` when the context bundle contains a `triage` artifact whose
   content is a canonical tier (`REVIEW_TRIAGE_TIERS` in core is the single
   source of tier literals; the `git-diff` builtin emits such an artifact via
   `classifyDiff`). No artifact → no binding → expressions referencing `tier`
   abort fail-closed. Additional bindings are future spec surface and must come
   from context, not ambient state, so enablement stays replayable.

**Consequences:**

- #73 Tier 1 gate 2 is expressible; the code-review `harness.yaml` (later in the
  arc) declares tier gating instead of relying on `expectedRolesForTriageTier`
  wiring.
- Replay determinism: because bindings derive from the recorded context bundle,
  enablement decisions replay identically from corpus entries.
- CEL's surface beyond boolean role gating (filter expressions, pass conditions)
  is deliberately not opened yet; each use gets its own spec addition when it
  comes due.

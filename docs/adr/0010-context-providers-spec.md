# ADR 0010: `context.providers` — declarative context collection (spec v0.2)

**Status:** Accepted **Context:** #73 Tier 1 requires `harness.yaml` to express
the code-review harness's context collection declaratively. Until now, providers
were constructed imperatively (`runCodeReview` hard-codes its four providers)
and `agents harness run` synthesized a static workspace artifact.

**Decision:**

1. **Spec section.** `harness.yaml` (spec v0.2, additive) gains an optional
   `context.providers` list of `{use, ...params}` records. The loader validates
   shape only and carries params verbatim; provider-specific validation is owned
   by the context registry, keeping the loader registry-agnostic.

2. **Named builtin registry.** `resolveContextProvider(use, params)` maps
   `git-diff`, `pr-metadata`, `pr-referenced-docs`, `agents-md`, `static-file`,
   `shell-command`, and `file-glob` to provider instances. Params are
   snake_case, strictly validated: unknown keys, wrong types, and unknown `use`
   names throw (fail loud at resolution, before any role runs).

3. **Build-time-only seams are unreachable from YAML.** The registry rejects, by
   name, params that would widen the trust boundary: `allow_outside_workspace` /
   `allowOutsideWorkspace` (StaticFileProvider host-file reads — a disclosure
   vector into LLM-bound context) and `command_runner` / `commandRunner`
   (ShellCommandProvider injection seam). These remain constructor-only for
   build-time TypeScript callers.

4. **Trust model for `shell-command`.** Declared context commands execute at
   collection time, before roles run, and are therefore _outside_ policy-eval
   hook enforcement (which governs agent tool calls). This is accepted:
   `harness.yaml` is build-time trusted configuration in the same trust domain
   as hook commands and `pass_check` (ADR 0005/0007) — an author who can write
   `context.providers` can already write `hooks:` commands. Mitigations that do
   apply: stdout is stream-bounded (`max_bytes`, #67 machinery) and collection
   is wall-clock-bounded (`timeout_ms`, default 60s; timeout is a failure, not
   truncation — partial output from a command that never finished is not
   trustworthy context).

5. **Runner behavior.** `agents harness run` resolves declared providers and
   collects the bundle before any role runs; resolution and collection failures
   share one controlled error surface (exit 1, `harness run:` prefix). The
   bundle is written as `context/bundle.json` (+ `.md`) under the run scratchpad
   — the same layout code-review runs record and the replay corpus consumes.
   Harnesses without a `context:` section keep the static workspace artifact.

**Consequences:**

- #73 Tier 1 gate 1 is expressible; the code-review `harness.yaml` (later PR in
  the arc) declares its four providers instead of relying on imperative wiring.
- Known bound not yet enforced: `git-diff` (RepositoryDiffProvider) loads the
  full diff unbounded — pre-existing behavior, now YAML-reachable, tracked as a
  follow-up issue rather than blocking this section.
- Future provider builtins register in one place; the registry error message
  enumerates available names.

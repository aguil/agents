# @aguil/agents-harness-config

Loads harness definitions from a `.agents/` directory into the orchestration
types.

Phase 1 scope (deliberately minimal):

- Single-file resolution: `harnesses/<id>/harness.yaml` plus a `policy: <id>`
  reference resolved to `policies/<id>.yaml`. No scopes, profiles, user
  overlays, or CLI-flag merging — layered resolution is a feature to justify on
  its own merits if a need appears, not a conformance obligation (ADR 0015).
- `manifest.yaml` is read only for `enabled.harnesses`.
- Policy files are parsed and carried through for the policy-eval layer; this
  package does not enforce them.

## Schema validation

Every document this package reads is validated against a JSON Schema before any
semantic check runs — `harness.yaml`, `manifest.yaml`, and each
`policies/<id>.yaml`. The schemas are hand-authored under `src/` and published
verbatim under `.agents/schemas/`, which ADR 0015 designates the normative
description of the format; a test pins each pair of copies together.

The schemas describe the whole format, but the loader reports only the problems
it could not already detect — unknown keys, and valid keys at the wrong nesting
level. Everything else stays with the existing checks, whose messages name the
offending value rather than only the rule. Net enforcement is unchanged; the
message a reader gets is the better of the two.

Two exceptions to "unchanged", both closing a document that quietly did less
than it appeared to:

- The manifest's `specVersion` is now checked against the accepted set, which
  ADR 0015 §4 called for and nothing implemented.
- `limits.cost_usd` must be a positive finite number. It previously accepted
  anything and dropped what it did not understand, so a mistyped spend ceiling —
  or `NaN`, which compares false against every threshold — read as no ceiling at
  all.

### Keeping the two descriptions in step

Because the schemas and the loader both describe these formats, they can
disagree, and only one direction is loud. A key the loader knows and the schema
does not is rejected at load, so it surfaces immediately. A key the schema knows
and the loader does not is accepted and silently ignored — the bug the schemas
exist to remove.

`src/key-surface.ts` lists every key the loader reads, grouped by level, and the
loader builds its unknown-key allowlists from it.
`tests/harness-schema-drift.test.ts` then asserts three things: each level's
list matches the corresponding schema location, every object level in every
schema is closed to unknown keys, and no document the loader rejects would be
accepted by a strict third-party validator running the published file. That last
one is the constraint-level version of the same problem, and it caught two real
disagreements when it was written.

Nine checks cannot move into a schema at all, because they depend on the
filesystem (a referenced policy or role file existing), on compiling a CEL
expression, or on agreement between separate parts of the document (execution
order naming a declared role, `harness.id` matching its directory). The schema
is a layer in front of those, not a replacement for them.

## Role files

A role may be defined once at `agents/<id>/agent.md` and reused across
harnesses. The frontmatter carries the role fields and the Markdown body is the
prompt:

```markdown
---
description: Audit the change for licensing problems.
timeout_ms: 90000
required_capabilities: [readOnlyMode]
---

Look for incompatible licenses.
```

Because the body is the prompt, `prompt` and `prompt_path` are not accepted in
frontmatter. A harness pulls the role in by reference:

```yaml
roles:
  licensing:
    ref: auditor
    timeout_ms: 120000
```

Two precedence rules, both deliberate:

- **Reference is the only way in.** A role file is never merged implicitly, so a
  file whose id matches a role the harness declares itself contributes nothing.
  There is no shadowing to reason about.
- **The harness wins.** Keys on the referencing entry override the file's
  frontmatter; keys it omits fall through. The referencing key names the role,
  so one file can back several roles under different ids.

Role files are repo-scoped and shared; the per-harness `harnesses/<id>/prompts/`
convention is unchanged and remains the right home for a prompt used by exactly
one harness.

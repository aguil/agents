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

`harness.yaml` is validated against a JSON Schema before any semantic check
runs. The schema is hand-authored at `src/harness.schema.json` and published
verbatim at `.agents/schemas/harness.schema.json`, which ADR 0015 designates the
normative description of the format; a test pins the two copies together.

The schema describes the whole format, but the loader reports only the problems
it could not already detect — unknown keys, and valid keys at the wrong nesting
level. Everything else stays with the existing checks, whose messages name the
offending value rather than only the rule. Net enforcement is unchanged; the
message a reader gets is the better of the two.

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

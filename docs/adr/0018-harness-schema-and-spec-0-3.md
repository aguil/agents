# ADR 0018: the published schema enforces unknown-key rejection; spec increments to 0.3

**Status:** Accepted

**Status history:**

- 2026-07-26 — Proposed.
- 2026-07-26 — Accepted: merged in #146. Discharges ADR 0015 §5 for the role
  `ref:` construct and for the schema.

**Context:** ADR 0015 §2 designated `.agents/schemas/harness.schema.json` the
normative description of the harness document format, and §5 required that any
format change arrive with a `spec_version` increment, an ADR recording it and
its additive status, and a corresponding schema update. Two things are now due
under that rule.

The first is a construct that shipped without it. Role-as-file discovery (#137)
added `roles.<id>.ref`, letting a harness pull a role from
`.agents/agents/<id>/agent.md` and override its frontmatter. That is a format
change, it merged in #143 under `spec_version: "0.2"`, and it carried no
increment and no schema. It was deferred deliberately rather than overlooked: §5
wants the ADR and the schema together, and the schema is this change.

The second is the schema itself (#138). The loader validates heavily — 45
`fail()` sites checking presence and types of keys it knows about — but until
now it rejected unknown keys at only some levels. `roles.<id>`, hook handlers,
`context`, `output.schemas` records, `filtering`, `deduplication` and
`reporting` each carried a hand-written allowlist. The document root, the
`harness` block and `execution` carried none, so a misspelled top-level
`polciy:`, or a valid key at the wrong nesting level, parsed cleanly and
silently did nothing. That is the failure this closes, and it compounds as the
format grows.

Three findings shaped how, rather than whether.

**A schema cannot replace the existing checks.** Of the 45 `fail()` sites, 36
are structural and expressible in JSON Schema. The remaining nine are not: six
compare separate parts of the document — execution order naming a declared role,
`harness.id` matching its directory, `prompt` excluding `prompt_path`, a policy
file's `id` matching its filename, `builtin:finding` being valid only under the
`finding` kind, `applies_to` appearing only on tool-call events — and three
depend on the world outside it, namely a file being readable, a referenced role
file existing, and a CEL expression compiling. A schema is therefore a layer in
front of the loader's checks, not a substitute for them.

**Where both could report a problem, the loader reports it better.** The
existing messages name the offending value: "reporting.template has unknown
template `builtin:unknown` (supported: …)" against the schema's "must be one of:
…". Letting the schema intercept those would have traded specific messages for
generic ones in exchange for architectural tidiness.

**One real document would have been rejected.** `harness.description` is written
in all three harness documents in the repository and read by nothing. Closing
the `harness` block against unknown keys — the entire point of the work — would
have failed every harness here.

**Decision:**

1. **The schema is hand-authored and published.** `harness.schema.json` is
   written as JSON Schema rather than generated from a TypeScript definition, so
   the artifact ADR 0015 §2 made normative is the one an author edits and a
   third party reads. It is validated with `ajv`, which consumes JSON Schema
   rather than producing it. The alternatives considered — zod, TypeBox, valibot
   — are all TypeScript-first, which would have made the published file a
   generated dump and the TypeScript tree the real source of truth.

2. **The schema describes the whole format; the loader enforces the part it
   could not already.** Validation runs before the semantic checks, and only
   `additionalProperties` and `propertyNames` failures are reported from it.
   Every other rule stays with the check that already owned it, keeping the more
   specific message. Net enforcement is unchanged and unknown-key rejection is
   new and uniform. The schema still carries the full description, because its
   readers include people and tools that never run this loader.

3. **Unknown-key errors name the keys that would have been accepted.** Ajv omits
   the offending key from its message, so the runtime formats its own: the
   dotted path, the unknown key, and the supported keys at that level. This
   preserves the quality of the hand-written messages it supersedes at the seven
   levels that already had allowlists, and extends it to the levels that had
   none.

4. **Two constructs are declared invalid rather than left unknown.**
   `applies_to` on a lifecycle hook, and `prompt:` or `http:` as a handler type,
   are declared in the schema and forbidden. Both are things an author would
   plausibly reach for, and both have a loader message explaining _why_ they do
   not exist — event-class scoping applies only to tool-call events; handlers
   are commands only. Declaring them keeps those explanations reachable instead
   of reporting a misspelling.

5. **`harness.description` is part of the format.** It is declared optional and
   documented as human-facing. The loader continues not to read it. Rejecting it
   would have discarded intentional documentation from every harness in the
   repository; leaving it undeclared would have made the schema wrong about
   documents that demonstrably exist.

6. **The spec increments to 0.3, and 0.3 is additive.** `roles.<id>.ref` is the
   only construct 0.3 adds over 0.2. Nothing is removed and no key changes
   meaning, so every 0.1 and 0.2 document remains loadable unchanged and all
   three versions stay in `SUPPORTED_SPEC_VERSIONS`. This satisfies ADR 0015 §5
   for the change #143 landed, and preserves the additive-only precondition ADR
   0015 §4 requires for a `spec_version` that the loader validates and otherwise
   ignores.

7. **The schema covers `harness.yaml` only.** `.agents/policies/*.yaml` and
   `.agents/manifest.yaml` are separate documents with their own unknown-key
   holes, and neither is described here. They are out of scope rather than
   overlooked; extending the approach to them is a later change.

**Consequences:**

- A misspelled or misplaced key now fails at load with a message naming it, at
  every level of the document. This is the outcome the work existed to produce.
- Two descriptions of the format now exist — the schema and the loader — and
  they can drift. The mitigation is partial: a test asserts the schema's
  `spec_version` and reporting-template enums match the constants they mirror,
  and another asserts every harness document in the repository validates. Drift
  in a part not covered by a constant or exercised by a document would not be
  caught, and the honest expectation is that the schema needs updating whenever
  the loader gains a key.
- Because the runtime reports only unknown-key failures, a document can satisfy
  the schema at the loader and still be rejected by a strict third-party
  validator running the same file, since that validator applies every rule. The
  reverse cannot happen. The schema is the stricter document and the loader
  enforces a subset of it, which is the safe direction.
- Publishing the schema in two places — the package source and
  `.agents/schemas/` — is duplication held together by a test. A single copy
  would be better, but the package must be self-contained when published to npm
  and the normative path is fixed by ADR 0015 §2.
- `ajv` is the first validation dependency in the repository: roughly 33 KB
  gzipped and four transitive dependencies. It compiles schemas with
  `new Function`, which is fine for the current `bun build --target=bun` output
  and would need revisiting if compiled-binary distribution is ever attempted.
- Six tests changed their expected message. No document changed validity — each
  still fails, with a message that now also lists the supported keys.
- Clause 7 leaves the policy and manifest documents unguarded. They have the
  same class of hole the harness document had, and anyone relying on "the
  `.agents/` tree is schema-validated" would be wrong today.
- The next author to add a key must update the schema, and nothing enforces that
  beyond review. #147 tracks a check that the two agree. It is deliberately not
  folded into #131, which enforces the ADR authoring rules: that is a
  markdown-convention check over `docs/adr/`, whereas this is agreement between
  a JSON Schema and TypeScript source. The two would share a delivery mechanism
  and no logic.

**References:**

- ADR 0009 — spec v0.2 and the `applies_to` construct clause 4 keeps explicable.
- ADR 0014 — ADRs are standalone; the reason this ADR inlines its rationale.
- ADR 0015 — the harness spec is project-local, the schema is its normative
  description (§2), `spec_version` is advisory while increments stay additive
  (§4), and format changes require an increment, an ADR and a schema update
  (§5). This ADR discharges §5 for `ref:` and for the schema itself.
- Issues #137 and #143 (the `ref:` construct), #138 (this work), #147
  (schema-versus-loader drift detection).

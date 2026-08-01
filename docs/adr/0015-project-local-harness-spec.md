# ADR 0015: the harness spec is project-local; AGENTS-1 convergence is not a goal

**Status:** Partially superseded by ADR 0018 and ADR 0019

**Status history:**

- 2026-07-26 — Proposed.
- 2026-07-26 — Accepted: merged in #140. From here this ADR is immutable except
  for these status fields.
- 2026-07-26 — Partially superseded by ADR 0018: §3's naming of `0.2` as the
  current version, and its instruction that new documents declare `0.2`. ADR
  0018 §6 increments to `0.3`. The rest of §3 stands — `0.1` and `0.2` remain
  accepted — as does every other clause, and §5's increment process is what ADR
  0018 followed rather than overrode.
- 2026-08-01 — Partially superseded by ADR 0019: §4's precondition that the
  loader's version-blindness holds "only while every version increment is
  additive", and its instruction that a non-additive change must branch on the
  declared version or consolidate the accepted set. ADR 0019 §6 increments to
  `0.4` changing what `builtin:actionable` does, and deliberately does neither —
  an older document receives the new behavior — because the old behavior
  silently discarded findings and preserving it for existing documents would
  preserve the defect. §4 still governs _parsing_: no document is parsed
  differently by version, and the loader still does not branch. §5's increment
  process is unaffected and ADR 0019 followed it.

**Context:** The planning that produced the `.agents/` loader assumed this
repository would converge on an external specification referred to as AGENTS-1.
What shipped is a project-local spec. `.agents/manifest.yaml` declares
`specVersion: "0.2"`, harness definitions declare `spec_version`, and ADR 0009
defines what v0.2 means — one additive field, per-handler `applies_to`, over the
v0.1 surface ADR 0006 established. No migration to AGENTS-1 was ever performed
and none is scheduled. Issue #134 asks whether that gap closes, stays, or is
straddled.

The question is live because two other items add spec surface: role-as-file
discovery with `ref:` resolution (#137) and an enforcing JSON Schema for
`harness.yaml` (#138). Both have to be authored against some spec. Building them
against an unsettled one is the expensive failure — the schema in particular is
a written description of the spec, so it cannot be authored before the spec's
identity is decided.

Four facts about the current state bear on the answer, and the first two were
not obvious before looking.

**The declared version is inert.** `loadHarness` reads `spec_version`, checks it
against `SUPPORTED_SPEC_VERSIONS` and then discards it
(`packages/harness-config/src/index.ts:867-872`). The value is not stored on
`LoadedHarness`, and no parsing branch anywhere in the loader tests it. The
practical consequence is that `spec_version: "0.1"` and `spec_version: "0.2"`
produce identical behavior on identical input: a v0.1 document using the v0.2
`applies_to` field loads and works, and a v0.2 document using none of v0.2's
surface is indistinguishable from v0.1. The field is a declaration of intent
that nothing reads. This is sound only because v0.2 is strictly additive, as ADR
0009 §1 requires; it would break the moment a version introduced a non-additive
change. Two smaller symptoms of the same inertness: `HARNESS_SPEC_VERSION`
(`packages/harness-config/src/index.ts:23`) is exported and imported nowhere,
and the manifest's own `specVersion`
(`packages/harness-config/src/index.ts:267`) is read as an optional string and
never checked against the accepted set at all — `.agents/manifest.yaml` could
declare any version, or a version disagreeing with the harness beneath it, and
still load.

**AGENTS-1 is undefined here.** The identifier appears in this repository six
times and never as a specification. ADR 0006 §1 uses it adjectivally to describe
the shape of `policies/*.yaml` — "AGENTS-1-style
`capabilities.filesystem/exec/network` allow/deny lists" — and to name a
deferred resolution algorithm, "scopes, profiles, user overlays (`~/.agents/`),
and CLI-flag merging". `packages/harness-config/src/index.ts:31`,
`packages/harness-config/README.md:10`, `packages/policy/README.md:4` and
`docs/packages/README.md:24` repeat that adjectival use. Nowhere does the repo
state what AGENTS-1 requires, what version of it is meant, or where its text
lives. "Converge on AGENTS-1" therefore has no checkable definition of done
inside this repository — and under ADR 0014 an ADR that pointed outward for one
would not be standalone.

**Two versions are live and the split is arbitrary.** The code-review harness
declares `"0.2"` (`.agents/harnesses/code-review/harness.yaml:1`); the
incident-triage proof harness declares `"0.1"`
(`examples/incident-triage/.agents/harnesses/incident-triage/harness.yaml:1`);
the test fixture under `tests/fixtures/agents-dir/` declares `"0.1"` in both its
manifest and its harness. The split reflects when each file was written, not a
compatibility requirement. Because the version is inert, nothing observable
depends on it.

**Divergence is currently zero-cost and will not stay that way.** The two things
AGENTS-1 was named for — layered resolution and the policy-file shape — are
respectively unbuilt and already AGENTS-1-shaped. The loader is deliberately
single-file (`packages/harness-config/src/index.ts:853`). So there is no
accumulated divergence to pay down today. What changes that is #137, which adds
a role-file discovery convention, and layered resolution whenever it is built:
both are exactly the surface an external spec would dictate, and both are
cheaper to align before they exist than after.

**Decision:**

1. **The harness spec is project-local.** `spec_version` denotes this
   repository's own specification, currently `0.2`. AGENTS-1 convergence is not
   a goal of this project and is struck as a planning assumption. The
   AGENTS-1-shaped policy-file layout described in ADR 0006 §1 is retained on
   its merits — it is a good shape, independently arrived at — but that
   resemblance carries no conformance obligation and no migration commitment.

2. **The specification is written down as the JSON Schema, not as prose.** A
   project-local spec that exists only as loader source is not a spec; it is an
   implementation. `.agents/schemas/harness.schema.json` (#138) is designated
   the normative, machine-checkable description of the harness document format,
   and the ADR series remains the record of why each construct exists. No
   separate prose specification document is created; a second hand-maintained
   description of the same format would drift from both the schema and the
   loader.

3. **`0.2` is the current version; `0.1` remains accepted as a deprecated
   alias.** `SUPPORTED_SPEC_VERSIONS` keeps both. Because v0.2 is additive over
   v0.1 (ADR 0009 §1) and the loader branches on neither, accepting both costs
   nothing and rejecting `0.1` would break the incident-triage example and the
   test fixtures for no behavioral gain. New documents declare `0.2`. The schema
   from clause 2 describes one format and permits either version token, rather
   than describing two formats.

4. **`spec_version` is advisory, and its inertness is now deliberate rather than
   incidental.** The loader validates the token and otherwise ignores it. This
   is permitted only while every version increment is additive. A future
   non-additive change must, in the same change, either make the loader branch
   on the declared version or consolidate the accepted set — it may not rely on
   the current arrangement, under which a document declaring an older version
   silently receives newer parsing.

   The manifest's `specVersion` is weaker still: it is not checked against the
   accepted set, so an unrecognized value loads. Under clause 2 the schema
   validates it against the same set as `spec_version`, closing the gap without
   making either field semantic. The two fields are not required to agree, and
   nothing reads either at run time; the check is a typo guard, not a
   compatibility mechanism.

5. **Version increments are governed.** `spec_version` increments when the
   document format gains, removes, or changes the meaning of a construct. An
   increment requires an ADR recording the change, a corresponding schema update
   under clause 2, and a statement of whether the change is additive. Bug fixes,
   error-message changes, and loader refactors that leave the accepted document
   set unchanged are not increments.

6. **#137 and #138 are unblocked and bind to this decision.** Role-as-file
   discovery designs its directory convention and role frontmatter to suit this
   repository, with no obligation to an external layout. The schema describes
   the format as implemented, per clause 2. Neither carries an AGENTS-1
   compatibility requirement.

**Consequences:**

- The largest deferred item — layered resolution with scopes, profiles and
  `~/.agents/` overlays — loses its external mandate. It becomes a feature to
  justify on its own merits when a concrete need appears, not a conformance
  obligation. If it is built, its merge rules are this project's to choose,
  which also means #137's file-versus-spec role precedence rule and any future
  layer precedence rule must be made consistent deliberately rather than
  inherited.
- Interoperability with any external AGENTS-1 tooling is forgone. That cost is
  presently unmeasurable: no such tooling is used here, and the specification's
  content is not recorded in this repository, so there is nothing to measure
  against. Should interoperability become desirable, it arrives as a new ADR
  proposing an import or export path — a bounded problem — rather than as an
  open-ended migration.
- The four adjectival "AGENTS-1" mentions in source and README files become
  misleading, since they now suggest a conformance target that has been
  disclaimed. They should be reworded to describe the shape directly. That is
  editorial cleanup in the code and docs, not an ADR edit; ADR 0006's text
  stands unaltered as history, and this clause does not authorize any change to
  it.
- #138 gains a second responsibility. It was scoped as validation hardening —
  rejecting unknown and misplaced keys, which the loader's 40 hand-rolled
  `fail()` sites do not do. Under clause 2 it is also the spec document, so its
  schema must describe the whole format rather than only the parts worth
  guarding, and its descriptions and titles carry documentary weight.
- Clause 4 turns a silent invariant into a stated precondition. The current
  arrangement is safe today and would become a correctness bug on the first
  non-additive change, which is precisely the kind of thing discovered late. It
  is now written down where the next author of a version increment will find it,
  alongside clause 5's checklist.
- The incident-triage example keeps declaring `0.1` and keeps working, so the
  proof harness needs no edit to land this decision. Under clause 3 it is
  declaring a deprecated alias, which is a reasonable thing for a
  compatibility-exercising example to do.

**References:**

- ADR 0006 — spec v0.1, single-file resolution, and the AGENTS-1-style policy
  file shape.
- ADR 0009 — spec v0.2 and its additive-only guarantee.
- ADR 0014 — ADRs are standalone; the reason this ADR inlines rather than cites.
- Issues #134 (this decision), #137 (role-as-file), #138 (JSON Schema).

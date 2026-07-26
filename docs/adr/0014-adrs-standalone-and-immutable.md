# ADR 0014: ADRs are standalone and immutable

**Status:** Accepted

**Context:** Several ADRs cited planning and exploration documents maintained
outside this repository. Two problems followed. First, the cited material is not
resolvable from a checkout: ADR 0005 pointed readers at `docs/exploration/`, a
path that was deliberately untracked and no longer exists, so the reference
resolved to nothing. Second, it made this repo's design record depend on
documents with an independent lifecycle, versioning, and audience — an ADR
describing package boundaries should not require an external,
separately-versioned document to be understood.

Separately, no rule stated whether an Accepted ADR could be edited. Practice was
inconsistent, and the question recurs whenever a reference goes stale.

**Decision:**

1. **ADRs are standalone.** An ADR must be fully understandable from this
   repository alone. It may not reference documents outside it — no planning
   docs, exploration notes, or design documents held elsewhere. Where such a
   document supplied reasoning that still matters, that reasoning is inlined
   into the ADR in its own words.

   Permitted references, because they stay inside the repo: other ADRs
   (including supersession), and repo-local files such as source, config, and
   `docs/` material. External identifiers that are stable and self-describing —
   issue numbers, package names and versions, upstream specifications — are not
   documents in this sense and remain citable.

2. **ADRs are immutable.** Once an ADR is Accepted, its decisions and their
   recorded reasoning change only through a new ADR that supersedes it, in whole
   or in part. Do not revise an Accepted ADR to reflect a changed mind; the
   superseding ADR carries the change and the older record stands as history.

3. **Reference hygiene is editorial, not decisional.** Removing an outward
   reference and inlining its substance does not alter what was decided, so it
   does not require supersession. Supersession would in fact misrepresent the
   history by implying a decision changed. Such edits are permitted, must
   preserve the decision exactly, and must be enumerated in an ADR — this one
   authorizes the sweep below. If an outward reference is introduced in future,
   removing it falls under this clause.

**The authorized sweep.** Applied with this ADR:

- **0003** — dropped the `References:` citation of an external plan ("Symphony
  spec fit for agents"). The Symphony-shaped contract constraint it supplied is
  already stated in the ADR's own decision and consequences.
- **0004** — dropped the `References:` citation of an external
  "provider-agnostic execution review plan". The ADR 0003 citation and the
  repo-local `AgentAdapter` link remain.
- **0005** — removed the pointer to `docs/exploration/`, which no longer exists.
  Kept the assertion that the ADR is the durable record of the decisions.
- **0011** — inlined why CEL and `@marcbachmann/cel-js` were selected, which had
  been attributed to an external exploration document by date.
- **0012** — kept the operator's descope decision and its date, dropped the
  pointer to the external plan approval that carried it.

No decision text was altered in any of the five.

**Consequences:**

- New ADRs inline their rationale rather than citing it, which makes them
  longer. That is the intended trade: length in exchange for a record that
  survives independently of any external document's fate.
- Reasoning may now exist in both an ADR and external planning material, and the
  two can drift. Within this repository the ADR is authoritative.
- The rule is one-directional. Documents outside this repo may freely reference
  ADRs; ADRs may not reference them.
- The `docs/exploration/` entry in `.gitignore` is removed as vestigial — the
  directory it guarded is gone and this ADR removes the last reference to it.
- Amending an Accepted ADR for any reason other than clause 3 is now a
  recognizable error rather than a judgment call.

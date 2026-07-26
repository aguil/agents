# ADR 0014: ADRs are standalone and immutable

**Status:** Accepted

**Status history:**

- 2026-07-26 — Proposed.
- 2026-07-26 — Accepted: merged in #130. From here this ADR is immutable except
  for these status fields.

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

Status handling was inconsistent too. Only ADR 0002 carries a `**Date:**`, so
for most ADRs there is no record of when they were accepted. Four different ways
of qualifying `Accepted` are in use: bare (0003–0006), a parenthetical caveat
(0001, "tracking item; work not done yet"), a partial-supersession note in prose
(0007), and a progress note (0013, "stage 4 complete"). ADR 0013's status has
been rewritten as its stages completed, so the dates of the earlier transitions
are lost — a mutable field with no audit trail.

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

2. **ADRs are immutable except for status.** Immutability attaches when an ADR
   merges to `main`. From that point the only editable part is its status — the
   `**Status:**` line and its `**Status history:**` block, per clause 4.
   Everything else is frozen: title, context, decision, consequences,
   references. A changed mind is recorded by a new ADR that supersedes this one,
   in whole or in part; the older record stands as history.

   Before merge an ADR is under review and normal revision applies. An unmerged
   ADR carries `Proposed`, not `Accepted`.

3. **Reference hygiene was a one-time editorial exception, now closed.**
   Removing an outward reference and inlining its substance does not alter what
   was decided, so it did not require supersession — supersession would have
   misrepresented the history by implying a decision changed. This ADR
   authorized exactly one such sweep, enumerated below. That authorization is
   **spent**. Clause 1 prevents new outward references from being introduced;
   should one appear anyway, removing it requires a new ADR authorizing that
   edit in the same enumerated form, not an appeal to this clause.

4. **Status format.** Every ADR carries two adjacent fields directly beneath its
   title:

   ```markdown
   **Status:** <State> [— <short qualifier>]

   **Status history:**

   - <YYYY-MM-DD> — <State>[: <what changed and why>].
   ```

   `**Status:**` holds the current state and may be rewritten. It is the one
   mutable line in an ADR. `**Status history:**` is strictly append-only: never
   edit or delete an existing entry.

   Every change to `**Status:**` appends a dated history entry. The state token
   comes from a fixed vocabulary, so the field stays greppable:

   | State                              | Meaning                                              |
   | ---------------------------------- | ---------------------------------------------------- |
   | `Proposed`                         | Open for review; not yet merged                      |
   | `Accepted`                         | Merged and in force                                  |
   | `Rejected`                         | Considered and declined; kept for the reasoning      |
   | `Deprecated`                       | No longer in force, with nothing replacing it        |
   | `Superseded by ADR NNNN`           | Wholly replaced                                      |
   | `Partially superseded by ADR NNNN` | Some clauses replaced; the history entry names which |

   The optional qualifier after an em dash carries a caveat or progress note
   without changing the state token —
   `Accepted — tracking item, work not started` or
   `Accepted — stage 4 complete`. Progress updates append a history entry and
   may rewrite the qualifier; the state stays `Accepted`.

   Partial supersession is the case worth being explicit about. The state token
   names the superseding ADR and the history entry names the clauses, so a
   reader knows what still stands without opening the other ADR:

   ```markdown
   **Status:** Partially superseded by ADR 0008

   **Status history:**

   - 2026-07-18 — Accepted.
   - 2026-07-19 — Partially superseded by ADR 0008: §3's
     regeneration-as-policy-carrier and §5's non-sequential coarsening rule.
     Regeneration itself remains, demoted from policy carrier to hygiene.
   ```

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
- Amending a merged ADR outside its status fields is now a recognizable error
  rather than a judgment call.
- Status becomes auditable. Because history is append-only, the record of when
  an ADR was accepted and when each clause was superseded survives instead of
  being overwritten, which is what makes a mutable `**Status:**` line safe.
- Existing ADRs predate this format. Retrofitting them touches only status
  fields, so clause 2 permits it; acceptance dates are recoverable from the
  first commit that added each file. ADRs 0001–0013 were retrofitted with this
  ADR, so no ADR models the superseded convention to whoever writes 0015.
- This policy is only as discoverable as its surfaces. It is restated in
  `.agents/rules/adr-authoring.md` (canonical wording, matching the pattern of
  the conventional-commits and pre-commit rules), summarized in
  `docs/adr/README.md` where an author will land, and summarized again in
  `AGENTS.md` because Cursor and similar IDE agents load that file and do not
  auto-discover `.agents/`. An ADR alone would not have been found by a session
  about to write one.
- Enforcement is deferred, so all of the above is upheld in review. Issue #131
  tracks a CI check and the tool selection behind it. The precedent is worth
  heeding: the conventional-commits convention went unenforced until an invalid
  header caused release-please to silently drop a commit, which is why the
  `commit-headers` job exists.

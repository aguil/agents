# ADR 0027: a knowledge provider that admits no note says so in the bundle

**Status:** Proposed

**Status history:**

- 2026-10-11 — Proposed.

**Context:** ADR 0022 gave harnesses two knowledge providers. `knowledge`
injects notes marked `context: auto`, and `knowledge-search` returns notes
matching a tag query. Its clause 4 settled what happens when there is nothing to
read: "An absent or empty store yields no artifacts rather than an error, so
declaring a provider before any note exists is safe."

The second half of that sentence is right and stays. A harness may declare a
provider before the project has written any notes, and the run must not fail
because a directory is missing. ADR 0017 clause 7 makes the same argument about
a store that grows: a run must not start failing because of unrelated
accumulated state.

The first half is the problem #210 records. "Yields no artifacts" makes a run
that asked for knowledge and got none look exactly like a run that never asked.
The bundle the run writes to its scratchpad is the record a person reads
afterwards, and it carries nothing either way. Someone debugging a harness whose
roles behaved as if they had no project knowledge cannot tell from the record
whether the provider was declared, whether the store path was wrong, or whether
the notes existed but none qualified.

The gap is wider than an absent or empty store. A provider can admit no note for
any of these reasons:

- the store root does not exist, perhaps because `path` is misspelled;
- the root exists but is not a directory that can be listed;
- the root resolves outside the workspace;
- the store holds no Markdown notes;
- every note was skipped as malformed under ADR 0022 clause 4;
- usable notes exist but none is eligible: for `knowledge`, none carries
  `context: auto`, and for `knowledge-search`, none matches the tags and
  provenance asked for.

Each of these points the reader at a different fix. Four of them, an absent
root, an unlistable root, a store with no Markdown notes and notes that are not
eligible, leave no trace at all. The other two leave entries in the
`<provider>:_meta:skipped` report ADR 0022 clause 8 defines: a root outside the
workspace is a skip entry for the store path, and each malformed note is a skip
entry of its own. Even then, nothing in the record says the provider admitted no
note. A reader has to infer it from what is missing, and in the other four cases
there is nothing to infer from. ADR 0022 already reports the opposite case. When
eligible notes exceed a bound, clause 8 records what was admitted and what was
omitted, because a bundle that silently held less than the store offered would
be misleading. Admitting nothing is the limit of the same situation and deserves
the same treatment.

As implemented at the time of writing, the store scan also cannot tell these
cases apart. `packages/context/src/knowledge.ts` treats a root it cannot list as
an empty listing, so an absent store, an unreadable one and an empty one all
produce the same empty load.

Nothing admitted usually means nothing eligible, but not always. ADR 0022 clause
7 admits the highest-ranked eligible note even when it must be truncated, and
`max_notes` and `limit` must be at least 1, so neither can leave the bundle
empty. `max_bytes` can: it accepts any positive integer, and a budget too small
to hold even the truncation marker admits no note at all. Clause 8 then records
the eligible notes as omitted. So the report has to tell "nothing qualified"
apart from "notes qualified but the budget admitted none".

It also has to know whether the notes it read were all of them. Two things leave
part of a store unread. The scan stops after a fixed number of Markdown paths
(10,000 by default, `DEFAULT_KNOWLEDGE_MAX_SCANNED` in
`packages/context/src/knowledge.ts`) and records a `scan-truncated` skip. And a
directory inside the store may not be listable, which the scan today passes over
without a word. Either way, a scan that admitted nothing cannot say the store
held nothing eligible.

**Decision:**

1. **This ADR partially supersedes ADR 0022 clause 4**, in its sentence "An
   absent or empty store yields no artifacts rather than an error". The part
   "rather than an error" stands: an absent, empty or unusable store never fails
   resolution, collection or the run, and declaring a provider before any note
   exists stays safe. The part "yields no artifacts" is replaced by clause 2.
   The rest of ADR 0022 clause 4, and every other clause of ADR 0022, stands.

2. **A provider that admits no note adds one report artifact to the bundle.**
   When `knowledge` or `knowledge-search` admits zero notes, for any reason, it
   returns exactly one artifact with the identifier
   `<provider>:_meta:nothing-admitted`, in the namespace ADR 0022 clause 3
   reserves for the providers' own reports. A provider that admits at least one
   note adds no such artifact. A bundle therefore always shows, for every
   declared knowledge provider, either the notes it admitted or a report saying
   why there are none.

3. **The report says what was asked for and why nothing was admitted.** Its
   content is a JSON object with these fields:
   - `provider`: `knowledge` or `knowledge-search`.
   - `path`: the store path as declared, or the default `.agents/knowledge`.
   - `request`: the params that decide eligibility. For `knowledge-search`, that
     is `tags`, `provenance` and `machine_id_prefix`. For `knowledge`, it is the
     fixed rule that only `context: auto` notes are eligible.
   - `store`: exactly one of the states below, the first that applies in this
     order.
     - `outside-workspace`: the path resolves outside the workspace.
     - `absent`: nothing exists at the path.
     - `unreadable`: something exists at the path but cannot be listed as a
       directory.
     - `scan-incomplete`: part of the store was never read, because the scan
       stopped at its path limit or a directory inside the store could not be
       listed, and the part that was read held no eligible note. The
       `<provider>:_meta:skipped` report says which, with a `scan-truncated` or
       `unreadable` entry. The states below would claim more than is known, so
       this one takes precedence over them.
     - `no-notes`: the directory was listed and holds no Markdown file.
     - `all-skipped`: Markdown files exist, but ADR 0022 clause 4 skipped every
       one.
     - `none-eligible`: usable notes exist, but none meets the provider's
       eligibility rule.
     - `over-budget`: eligible notes exist, but `max_bytes` was too small to
       admit any of them. The `<provider>:_meta:admission` report names them as
       omitted, under ADR 0022 clause 8.
   - `counts`: `files` (Markdown files found), `notes` (usable notes), `skipped`
     and `eligible`, all counted over the part of the store that was scanned.
     They let a reader see how far the store got.

   The details of each skipped note stay in `<provider>:_meta:skipped`, as ADR
   0022 clause 8 specifies. This report summarizes; it does not repeat them.

4. **The store's state is determined, not inferred from an empty listing.** An
   implementation must tell `absent`, `unreadable` and `no-notes` apart, which
   means checking the root before scanning it rather than treating a failed
   listing as an empty one. For the same reason, a subdirectory inside the store
   that cannot be listed is reported in `<provider>:_meta:skipped` with the
   reason `unreadable`, as an unreadable note file already is. It is not passed
   over silently, and it makes the scan incomplete under clause 3.

5. **The report is a record, not a verdict.** It does not fail the role or the
   run, does not change run status (which stays gate-owned, per ADR 0021), and
   is not an event. It lives in the bundle for the same reasons ADR 0022 clause
   8 gives for overflow reports. The bundle is written to the run scratchpad and
   is what a reader inspects afterwards, and the exported bundle type does not
   change. Report artifacts do not count against `max_bytes`, which bounds note
   content.

**Consequences:**

- A run that declares a knowledge provider and gets no notes now says so, and
  names which of the eight states applies. The cases a person debugging a
  harness most often hits, a wrong path or notes not marked `context: auto`,
  read differently in the record.
- Bundles from runs in projects without a knowledge store gain one small
  artifact per declared provider. Consumers that list or count artifacts see it;
  the reserved `_meta:` identifier lets them filter it out, as they already can
  for the skip and admission reports.
- The report reaches the roles too, because roles read the bundle. A role then
  sees that no project knowledge was found, rather than nothing at all. That is
  the intended effect, at the cost of a few hundred bytes of context.
- Absence is still never fatal. A harness that must not run without its
  knowledge has no declarative way to say so here. It can test for the store in
  `execution.pass_check`, or a later decision can add a requirement. This ADR
  keeps clause 4's rule that a missing store does not break a run.
- `tests/knowledge-providers.test.ts`, which pins an absent store as an empty
  result, changes with the implementation, as do the providers' tests for an
  unmatched search.
- The store scan must stop treating a listing failure as an empty directory
  (clause 4). That is a small change to `packages/context/src/knowledge.ts`, and
  it is what lets the report be accurate rather than a guess.

**References:**

- ADR 0022 — the knowledge read path. Clause 4 is partially superseded here.
  Clause 3 reserves the `_meta:` namespace this report uses. Clause 7 always
  admits the top-ranked eligible note. Clause 8 is the overflow report this one
  parallels.
- ADR 0017 — knowledge governance. Clause 7 says budget overflow is reported,
  not silent, and is not an error. This ADR extends that principle from a store
  that offers too much to one that offers nothing.
- ADR 0021 — run status is owned by the gate, not by role output, so a report in
  the bundle cannot change it.
- #210 — knowledge providers leave no record when requested knowledge is absent.

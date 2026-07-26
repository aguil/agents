# Authoring architecture decision records

Provider-agnostic policy for this repository. Any automated or human contributor
should follow this when writing or updating an ADR under
[`docs/adr/`](../../docs/adr/). ADR 0014 is the decision behind this policy;
this file is the canonical wording.

## Standalone

An ADR must be fully understandable from this repository alone.

**Do not reference documents outside this repository** — no planning docs,
exploration notes, or design documents held elsewhere. If such a document
supplied reasoning that matters, **inline that reasoning** in the ADR in its own
words. Expect ADRs to be longer as a result; that is the intended trade.

Permitted, because they stay in the repo:

- other ADRs, including supersession
- repo-local files — source, config, `docs/` material

Also permitted, because they are stable identifiers rather than documents: issue
and PR numbers, package names and versions, upstream specifications.

The rule is one-directional. Documents outside this repo may freely reference
ADRs; ADRs may not reference them.

## Immutable except for status

Immutability attaches when an ADR **merges to `main`**. From that point the only
editable part is its status — the `**Status:**` line and the
`**Status history:**` block. Title, context, decision, consequences, and
references are frozen.

- **A changed mind is a new ADR** that supersedes the old one, in whole or in
  part. Do not rewrite the original; it stands as history.
- **Before merge**, an ADR is under review and revises normally. An unmerged ADR
  carries `Proposed`, not `Accepted`.

## Status format

Two adjacent fields directly beneath the title:

```markdown
**Status:** <State> [— <short qualifier>]

**Status history:**

- <YYYY-MM-DD> — <State>[: <what changed and why>].
```

`**Status:**` holds the current state and may be rewritten — it is the one
mutable line in an ADR. `**Status history:**` is **append-only**: never edit or
delete an existing entry. Every change to `**Status:**` appends a dated entry.

That pairing is the point. A mutable status field with no log loses the record
of when an ADR was accepted and when each clause was superseded.

State tokens come from a fixed vocabulary, so the field stays greppable:

| State                              | Meaning                                              |
| ---------------------------------- | ---------------------------------------------------- |
| `Proposed`                         | Open for review; not yet merged                      |
| `Accepted`                         | Merged and in force                                  |
| `Rejected`                         | Considered and declined; kept for the reasoning      |
| `Deprecated`                       | No longer in force, with nothing replacing it        |
| `Superseded by ADR NNNN`           | Wholly replaced                                      |
| `Partially superseded by ADR NNNN` | Some clauses replaced; the history entry names which |

The optional qualifier after an em dash carries a caveat or progress note
without changing the state token — `Accepted — tracking item, work not started`,
or `Accepted — stage 4 complete`. Progress updates append a history entry and
may rewrite the qualifier; the state stays `Accepted`.

**Partial supersession** is the case to get right. The state token names the
superseding ADR; the history entry names the affected clauses, so a reader
learns what still stands without opening the other ADR:

```markdown
**Status:** Partially superseded by ADR 0008

**Status history:**

- 2026-07-18 — Accepted.
- 2026-07-18 — Partially superseded by ADR 0008: §3's
  regeneration-as-policy-carrier and §5's non-sequential coarsening rule.
  Everything else in this ADR stands.
```

## Structure and numbering

Number files `NNNN-short-title.md`, four digits, zero-padded, in creation order.
Record a decision here once it affects multiple harnesses or shared package
boundaries.

Body sections, in order: `**Status:**`, `**Status history:**`, `**Context:**`,
`**Decision:**` (numbered clauses, so later ADRs can supersede one precisely),
`**Consequences:**`, and optionally `**References:**`.

Number the decision clauses. Partial supersession depends on being able to name
`§3` and have it mean something.

Add the new ADR to the index in
[`docs/adr/README.md`](../../docs/adr/README.md).

## Check before committing

None of this is enforced by CI yet (#131 tracks the check and the tool selection
behind it). Until then it is upheld in review, so verify by hand:

1. The ADR references nothing outside this repository.
2. `**Status:**` and `**Status history:**` are both present and agree, and the
   state token is from the vocabulary above.
3. If the ADR supersedes another, the superseded ADR's `**Status:**` is updated
   and its history gains an entry — that edit is permitted, and is the only kind
   permitted on a merged ADR.
4. Decision clauses are numbered.
5. The `docs/adr/README.md` index lists the new file.

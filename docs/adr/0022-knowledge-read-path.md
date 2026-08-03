# ADR 0022: knowledge read path — store layout, note frontmatter, and bounded context admission

**Status:** Proposed

**Status history:**

- 2026-08-02 — Proposed.

**Context:** ADR 0017 governs how a harness run may _write_ knowledge notes. It
answers three questions about staged notes — a required frontmatter schema whose
provenance fields only the runtime may write, a reserved identifier namespace
for machine-authored notes, and an enforced budget on automatic context
injection — and explicitly declines to authorize an implementation, because the
write path runs through a run-level lifecycle hook that never fires
(`docs/design/knowledge-write-back-blockers.md`).

The _read_ path is a different matter. It is not blocked, and nothing in this
repository implements it: `packages/context/src/index.ts` registers seven
providers — `git-diff`, `pr-metadata`, `pr-referenced-docs`, `agents-md`,
`static-file`, `shell-command`, `file-glob` — and none reads a knowledge store.
No knowledge directory exists in either `.agents/` tree, and no note exists
anywhere.

Building the read half first is deliberate. Notes that are written, promoted,
and never read back change nothing about how any run behaves; the entire
argument for accumulating knowledge is that a later run sees what an earlier one
recorded. A store nobody reads is a filing cabinet nobody opens.

Because no note exists yet, this is the moment when the reader's contract is
free. Once notes are on disk, their layout, their frontmatter and the identifier
rules that distinguish machine-authored from human-authored notes are a
compatibility surface — changing them means rewriting files nobody can
retroactively re-derive. ADR 0017 makes that argument for staged notes and it
applies with equal force to the promoted notes a reader consumes.

ADR 0017 constrains this work in three places without specifying it. Automatic
injection must be off by default and bounded in both note count and bytes when
enabled, with runtime defaults so a harness that enables injection without
stating a budget is bounded anyway. Overflow must degrade deterministically and
visibly — a stated admission order, a record of what was admitted and what was
omitted, and not a run failure, since a run must not start failing because the
store grew. And machine-authored notes occupy a reserved identifier namespace,
which a reader should be able to filter on. What it leaves open is everything
concrete: where notes live, which frontmatter fields the reader relies on, what
the admission order actually is, where the budget is declared, and how omissions
are reported.

One of those has a complication worth stating plainly. ADR 0017 describes the
budget as living in a `knowledge:` block in `harness.yaml`. No such block
exists. Adding one means loader parsing, both published copies of the schema,
the loader key surface, the drift test that keeps the two descriptions honest,
and a spec increment — all to configure a reader, while the write policy that
gives the block its reason to exist remains blocked and undesigned. Deciding
that placement is the substantive choice below.

**Decision:**

1. **Two builtin context providers.** `knowledge` injects notes marked for
   automatic context; `knowledge-search` returns notes matching a tag query.
   Both register in the provider registry alongside the existing seven, take
   snake_case params, and validate strictly: unknown params, wrong types and
   unknown provider names throw at resolution, before any role runs. This is the
   contract ADR 0010 §2 set for every builtin, and these two do not vary from
   it. Neither provider requires a schema change — a `context.providers` entry
   constrains only a non-empty `use` string, with params owned by the registry —
   so no spec increment is part of this decision.

2. **The store is repository-local and workspace-confined.** Notes are read from
   a root defaulting to `.agents/knowledge`, overridable by a `path` param, and
   every resolved path is contained within the workspace by the same check the
   other file-reading providers use. Both layouts are accepted: a flat
   `<root>/*.md` and a directory per note, `<root>/<id>/<id>.md`, since the
   latter is what lets note-local assets sit beside a note. Discovery is a
   recursive Markdown scan, and a note's identifier comes from its frontmatter
   rather than its filename, so moving a file never renames a note.

   No layer beyond the workspace is read. Reading a user-global store would
   reintroduce, through a data path, exactly the host-file disclosure that ADR
   0010 §3 closed by making `allow_outside_workspace` reachable only from
   build-time TypeScript. If a cross-repository layer is wanted later, it is a
   new decision, not a param.

3. **The frontmatter the reader relies on.** A note is Markdown with YAML
   frontmatter. The reader uses `id` (required, non-empty), `context` (`auto` or
   `search-only`, defaulting to `search-only`), `tags` (a list of strings,
   optional), `title` (optional, defaulting to the identifier) and `updatedAt`
   (optional). Fields the reader does not know are carried without complaint: a
   note is an authored document rather than a configuration file, and the write
   path will add reserved provenance fields to exactly these documents under ADR
   0017 clause 1. Rejecting unknown fields now would make that later addition a
   breaking change.

4. **Malformed data degrades; malformed configuration fails.** A note that
   cannot be parsed, carries no identifier, duplicates an identifier already
   seen, or gives an unusable value for a field the reader understands is
   skipped and reported — never fatal, and never silent. An absent or empty
   store yields no artifacts rather than an error, so declaring a provider
   before any note exists is safe. This is a deliberate asymmetry with clause 1:
   provider params are configuration written by a harness author and fail loud
   at resolution, while notes are accumulated data whose worst case must not be
   a run that stops working because someone committed a bad file.

5. **Automatic injection needs two independent opt-ins.** A harness opts in by
   declaring the `knowledge` provider at all; a note opts in by carrying
   `context: auto`. A note that says nothing is search-only. A repository full
   of notes therefore injects nothing into a harness that has not asked, and a
   harness that has asked still sees only the notes that volunteered. This is
   what ADR 0017 clause 6's "off by default" means concretely, and no third flag
   is introduced to express it.

6. **The budget is declared on the provider, not in a `knowledge:` block.**
   `max_notes` (default 10) and `max_bytes` (default 50000, applied to the
   aggregate content admitted, with the existing per-artifact truncation
   unchanged) are provider params. Both defaults bind when the author states
   nothing, so injection is bounded unconditionally.

   This qualifies where ADR 0017 clause 6 puts the budget while keeping what
   that clause enforces: a bound applied at context collection rather than left
   to convention, with runtime defaults behind it. The reasoning is that the
   `knowledge:` block's remaining fields — write policy, staging path, approval,
   provenance prefix, deduplication, expiry — all describe writing, and fixing
   the block's shape now would commit it before the work that constrains it
   exists. When a write path lands and brings the block with it, the precedence
   is settled here rather than reinvented: the block supplies defaults for the
   repository, and provider params override it per declaration.

7. **Admission order is recency, then identifier.** When more notes are eligible
   than the budget admits, notes sort by `updatedAt` descending, then by `id`
   ascending, with notes lacking `updatedAt` sorting after those that have it.
   The order is total, reproducible across machines, and independent of
   directory iteration order. Recency is the relevance proxy chosen; the
   identifier tiebreak is what makes the result stable rather than merely
   plausible.

8. **Overflow is recorded in the bundle and is not a failure.** When eligible
   notes exceed a bound, the collected bundle carries an additional artifact
   naming the admitted identifiers, the omitted identifiers, and which bound was
   reached, alongside anything skipped under clause 4. Reporting inside the
   bundle is what makes the record durable — the bundle is written to the run
   scratchpad and is what a reader inspects afterwards — and it leaves the
   exported bundle type unchanged, so every existing consumer is unaffected. The
   run does not fail: per ADR 0017 clause 7, an unrelated success condition must
   not come to depend on how large the store has grown.

9. **Search is tags, bounded, with a provenance filter.** `knowledge-search`
   takes `tags` (matching notes that carry every listed tag, compared
   case-insensitively), `limit` (default 5), `provenance` (`any` by default, or
   `machine` / `human`) and `machine_id_prefix` (default `harness:`). It honors
   the byte bound, because unbounded context is never correct, but not the
   note-count bound or clause 5's opt-in: a search result was explicitly asked
   for, and `limit` is its bound. Free-text and embedding-based search are out
   of scope here.

10. **The reader recognizes the machine namespace; it does not enforce it.** ADR
    0017 clause 3 reserves an identifier prefix for machine-authored notes and
    makes the runtime reject a machine note that lacks it. That enforcement
    belongs to the write path. The reader's obligation is the complement: it
    must treat a prefixed identifier as machine-authored for the purpose of
    clause 9's filter, so the namespace is usable from the read side the moment
    notes carrying it exist.

**Consequences:**

- Retrieval quality now rests on tags. That is the intended emphasis — ADR 0017
  chose to surface an inadequate store as a search problem rather than hide it
  by injecting everything — but tags are a blunt instrument, and if they prove
  insufficient the answer is better retrieval in a later decision, not a wider
  default injection.
- The defaults in clauses 6, 7 and 9 are reasoned guesses, not measurements. No
  store exists to measure. They are cheap to revise while that remains true and
  progressively less so afterwards, which is an argument for revisiting them
  once a real store exists rather than for deferring them now.
- Tolerating unknown frontmatter (clause 3) means a misspelled field is carried
  rather than rejected. Clause 4 limits the damage to fields the reader
  understands — a misspelled `context` value is reported — but a wholly
  unrecognized key is indistinguishable from a field the write path has not
  added yet, and this decision accepts that in exchange for not breaking notes
  when it does.
- Notes are workspace-sourced text entering an agent's context window, which is
  the same trust class as the repository instructions the `agents-md` provider
  already injects. A hostile workspace can shape agent context through them.
  Nothing executable attaches to a note, no path escapes the workspace, and
  clause 2 keeps the store from reaching beyond it; that is the whole of the
  mitigation, and it is the reason no broader capability is granted here.
- Clause 6 leaves the repository without a single declarative place to state a
  knowledge policy until a write path lands. A repository with several harnesses
  restates its budget per harness in the meantime. That is the price of not
  fixing the block's shape early, and clause 6 names the precedence that will
  resolve it.
- Deciding the reader's contract before any note exists leaves it unvalidated by
  use, the same trade ADR 0017 made for the writer's. The mitigation is the
  same: these clauses bind an implementation that conforms or supersedes.

**References:**

- ADR 0010 — the context provider contract these two providers implement: the
  registry, strict param validation at resolution, and the build-time-only seams
  that keep provider reads inside the workspace.
- ADR 0017 — knowledge governance. Clause 3's reserved identifier namespace,
  clause 6's off-by-default bounded injection and clause 7's visible
  deterministic degradation are the constraints this ADR gives concrete form;
  clause 6's placement of the budget is qualified by decision 6 above.
- `docs/design/knowledge-write-back-blockers.md` — the maintained record of what
  exists and why the write path is blocked. Its statement that no knowledge read
  path exists is what this ADR ends.

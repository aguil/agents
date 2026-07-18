# Replay corpus wire format (Tier 2 parity)

Contracts between the replay-parity referee
(`@aguil/agents-code-review/replay-parity`, CLI entry
`scripts/replay-parity.ts`) and a replay corpus checkout (private repo
`agents-replay-corpus`, located via `--corpus` or `AGENTS_REPLAY_CORPUS_DIR`).
Tracking issue: #73 Tier 2.

## Corpus layout

- `manifest.json` — index. The referee reads `entries[]`, using `source` and
  `id` per entry; the entry directory name is `<source>--<id>`.
- `runs/<source>--<id>/` — one recorded run:
  - `context/bundle.json` — frozen input context (fed to `runCodeReview` as
    `contextBundlePath`)
  - `roles/<roleId>/stdout.log` — raw per-role agent output (replayed by
    `ReplayAgentAdapter` through live line normalization)
  - `result.json` — recorded pipeline output; the parity baseline
- `adjudications.json` — written-acceptance ledger (see below).

Entry names must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` and must not contain `..`;
the referee rejects names that resolve outside `runs/`. Manifest content is
treated as data, not trusted config — a corpus cannot point the referee at
arbitrary host paths.

## Compared fields

Per entry, the referee replays through `runCodeReview` and compares:

- **Findings** as identity keys: `id`, `severity`, `file` (nullable), and the
  canonical fingerprint (`findingFingerprint` from `@aguil/agents-reporting`).
  Differences surface as `missingFromReplay` / `extraInReplay`, sorted by
  fingerprint then id.
- **Triage tier** (`metadata.triage`), always.
- **Status**, only when finding-derived and reproducible: recorded status must
  be `passed`/`warnings`/`failed` AND `metadata.timed_out_roles` must be empty.
  Recorded `error` statuses (live process failures) and timeout-derived
  `warnings` are excluded — stdout replay cannot reproduce either condition.
  Findings and tier still compare for those entries.

## Delta hash and adjudication matching

A non-empty delta is serialized canonically (recursive key sort, JSON) and
hashed with sha256. The referee accepts a delta only when `adjudications.json`
contains an entry with `decision: "accepted"` matching **both** the entry
directory name and the exact delta hash. Any change to the delta changes the
hash and re-fails the entry until re-adjudicated. Ledger field semantics live in
the corpus repo (`docs/adjudications.md`); adjudications are append-only.

## Exit contract

`scripts/replay-parity.ts` exits 0 when every entry is a match or an adjudicated
delta; any unadjudicated delta prints the delta JSON + hash to stderr and
exits 1. `--json` emits `{matches, adjudicated, failures, rows}` on stdout for
automation.

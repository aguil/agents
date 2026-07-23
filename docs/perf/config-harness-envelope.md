# Config harness performance envelope

- Date: 2026-07-19
- Machine: linux 6.18.33.2-microsoft-standard-WSL2 x64; 12th Gen Intel(R)
  Core(TM) i5-1240P
- Bun: 1.3.13
- Corpus: agents-replay-corpus checkout (located via --corpus /
  AGENTS_REPLAY_CORPUS_DIR; see
  docs/harnesses/code-review/spec/replay-corpus.md)
- Entries: 74
- Warmup: first corpus entry replayed once
- Pipeline: config-declared harness only (imperative package path removed)

## Summary

| Pipeline |       Total | Per-entry median | Per-entry p90 |
| -------- | ----------: | ---------------: | ------------: |
| Config   | 21989.62 ms |        273.92 ms |     436.73 ms |

Regenerate this file with `bun run scripts/config-harness-envelope.ts --corpus
<dir>` when refreshing timings after harness or runtime changes.

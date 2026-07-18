# Policy-eval hook cost

- Date: 2026-07-18
- Machine: x86_64; 12th Gen Intel(R) Core(TM) i5-1240P
- Bun: 1.3.13
- Benchmark: 2 warmups, then 30 sequential measured invocations
- Recorded runs: 24
- Median mapped tool events per run: 6.5

## Compiled binary

The compiled-binary benchmark was skipped because the variant was unavailable.

Compiled binary size: 97.5 MiB (102,234,432 bytes).

```text
/tmp/agents-bench-bin policy-eval failed with exit code 1
4703 |     const parent = dirname8(dir);
4704 |     if (parent === dir) {
4705 |       break;
4706 |     }
4707 |     dir = parent;
4708 |   throw new Error("Could not locate docs/skills/skills.json (run from aguil/agents checkout or use an installed @aguil/agents layout that ships docs/skills/).");
               ^
error: Could not locate docs/skills/skills.json (run from aguil/agents checkout or use an installed @aguil/agents layout that ships docs/skills/).
      at findDocsSkillsPackRoot (/$bunfs/root/agents-bench-bin:4708:9)
      at <anonymous> (/$bunfs/root/agents-bench-bin:4749:44)
      at <anonymous> (/$bunfs/root/agents-bench-bin:16:48)
      at /$bunfs/root/agents-bench-bin:11227:17

Bun v1.3.13 (Linux x64)
```

## Summary

| Variant   |   N |      Min |      P50 |      P90 |      Max |     Mean | Projected per run |
| --------- | --: | -------: | -------: | -------: | -------: | -------: | ----------------: |
| `bun run` |  30 | 40.96 ms | 48.53 ms | 70.42 ms | 78.00 ms | 52.54 ms |            0.32 s |

## Projection

- `bun run`: 6.5 events × 48.53 ms = 315.46 ms (0.32 s).

Mapped events are started shell, MCP, or file-edit tool calls in each recorded
`events.jsonl`; read and search tool calls are excluded because they do not map
to the three configured hooks.

## Interpretation

- `bun run` measured a 48.53 ms p50 bridge invocation and projects 0.32 s per
  code-review run at the observed median event count.

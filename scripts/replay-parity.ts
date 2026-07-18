#!/usr/bin/env bun
// Thin entry point for the #73 Tier 2 replay-parity referee; the logic
// lives in @aguil/agents-code-review (harnesses/code-review/src/replay-parity.ts).
//
// Usage:
//   bun run scripts/replay-parity.ts --corpus <dir> [--entry <name>] [--json]
//     Recorded-baseline mode: replayed package pipeline vs recorded
//     result.json; deltas require corpus-ledger adjudication.
//   bun run scripts/replay-parity.ts --corpus <dir> --differential [--agents-dir <dir>]
//     Differential mode (#73 Tier 2): package pipeline vs config-declared
//     pipeline on identical replayed inputs; exact match required, no
//     adjudications apply.
import { join, resolve } from "node:path";
import {
  type EntryVerdict,
  judgeEntry,
  judgeEntryDifferential,
  loadAdjudications,
} from "@aguil/agents-code-review/replay-parity";

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
  let corpusDir: string | undefined;
  let entryFilter: string | undefined;
  let jsonOutput = false;
  let differential = false;
  let agentsDir = ".agents";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--corpus") {
      corpusDir = argv[++index];
    } else if (arg === "--entry") {
      entryFilter = argv[++index];
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--differential") {
      differential = true;
    } else if (arg === "--agents-dir") {
      agentsDir = argv[++index] ?? agentsDir;
    } else {
      console.error(`replay-parity: unknown argument "${arg}"`);
      return 1;
    }
  }
  corpusDir ??= Bun.env.AGENTS_REPLAY_CORPUS_DIR;
  if (corpusDir === undefined) {
    console.error(
      "replay-parity: --corpus <dir> or AGENTS_REPLAY_CORPUS_DIR is required",
    );
    return 1;
  }

  const manifest = (await Bun.file(
    join(corpusDir, "manifest.json"),
  ).json()) as {
    entries: ReadonlyArray<{ id: string; source: string }>;
  };
  const adjudications = await loadAdjudications(corpusDir);
  const entryNames = manifest.entries
    .map((entry) => `${entry.source}--${entry.id}`)
    .filter((name) => entryFilter === undefined || name === entryFilter);
  if (entryNames.length === 0) {
    console.error("replay-parity: no matching corpus entries");
    return 1;
  }

  const rows: Array<{ entry: string; verdict: EntryVerdict }> = [];
  let matches = 0;
  let adjudicated = 0;
  let failures = 0;
  for (const entryName of entryNames) {
    const verdict = differential
      ? await judgeEntryDifferential(corpusDir, entryName, resolve(agentsDir))
      : await judgeEntry(corpusDir, entryName, adjudications);
    rows.push({ entry: entryName, verdict });
    if (verdict.kind === "match") {
      matches += 1;
    } else if (verdict.kind === "adjudicated") {
      adjudicated += 1;
    } else {
      failures += 1;
      console.error(
        `DELTA ${entryName} hash=${verdict.deltaHash}\n${JSON.stringify(verdict.delta, null, 2)}`,
      );
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ matches, adjudicated, failures, rows }));
  } else {
    const mode = differential
      ? "differential (package vs config)"
      : "recorded-baseline";
    console.log(
      `replay-parity[${mode}]: ${entryNames.length} entries — ${matches} match, ${adjudicated} adjudicated, ${failures} ${differential ? "deltas" : "unadjudicated deltas"}`,
    );
  }
  return failures === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main());
}

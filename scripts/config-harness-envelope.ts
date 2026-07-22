#!/usr/bin/env bun
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, cpus, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCodeReviewFromConfig } from "@aguil/agents-code-review/config-runner";
import { resolveEntryDir } from "@aguil/agents-code-review/replay-parity";
import { ReplayAgentAdapter } from "@aguil/agents-execution";

interface Manifest {
  readonly entries: ReadonlyArray<{
    readonly id: string;
    readonly source: string;
  }>;
}

const root = resolve(import.meta.dir, "..");
const agentsDir = join(root, ".agents");
const reportPath = join(root, "docs", "perf", "config-harness-envelope.md");

function parseArgs(): { corpusDir: string } {
  const argv = Bun.argv.slice(2);
  let corpusDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--corpus") {
      corpusDir = argv[++index];
    } else if (arg === "--bound") {
      console.warn(
        "config-harness-envelope: --bound is ignored (package baseline removed with imperative orchestration).",
      );
      argv[++index];
    } else {
      throw new Error(`config-harness-envelope: unknown argument "${arg}"`);
    }
  }
  corpusDir ??= Bun.env.AGENTS_REPLAY_CORPUS_DIR;
  if (corpusDir === undefined || corpusDir.length === 0) {
    throw new Error(
      "config-harness-envelope: --corpus <dir> or AGENTS_REPLAY_CORPUS_DIR is required",
    );
  }
  return { corpusDir: resolve(corpusDir) };
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? 0;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function total(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function milliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function machineNote(): string {
  return `${process.platform} ${release()} ${arch()}; ${cpus()[0]?.model.trim() ?? "unknown CPU"}`;
}

async function measureEntry(
  corpusDir: string,
  entryName: string,
): Promise<number> {
  const entryDir = resolveEntryDir(corpusDir, entryName);
  const contextBundlePath = join(entryDir, "context", "bundle.json");
  const workspace = await mkdtemp(join(tmpdir(), "envelope-config-"));
  try {
    const start = performance.now();
    await runCodeReviewFromConfig({
      agentsDir,
      workspacePath: workspace,
      scratchpadRoot: join(workspace, "runs"),
      contextBundlePath,
      adapter: new ReplayAgentAdapter({ runDir: entryDir }),
    });
    return performance.now() - start;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function makeReport(input: {
  readonly corpusDir: string;
  readonly entryCount: number;
  readonly configTotal: number;
  readonly configMedian: number;
  readonly configP90: number;
}): string {
  return `# Config harness performance envelope

- Date: ${new Date().toISOString().slice(0, 10)}
- Machine: ${machineNote()}
- Bun: ${Bun.version}
- Corpus: agents-replay-corpus checkout (located via --corpus /
  AGENTS_REPLAY_CORPUS_DIR; see docs/harnesses/code-review/spec/replay-corpus.md)
- Entries: ${input.entryCount}
- Warmup: first corpus entry replayed once
- Pipeline: config-declared harness only (imperative package path removed)

## Summary

| Pipeline | Total | Per-entry median | Per-entry p90 |
| --- | ---: | ---: | ---: |
| Config | ${milliseconds(input.configTotal)} | ${milliseconds(input.configMedian)} | ${milliseconds(input.configP90)} |
`;
}

async function formatReport(): Promise<void> {
  const subprocess = Bun.spawn(
    ["mise", "exec", "--locked", "--", "prettier", "--write", reportPath],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `prettier failed with exit code ${exitCode}\n${stderr || stdout}`,
    );
  }
}

async function main(): Promise<number> {
  const { corpusDir } = parseArgs();
  const manifest = (await Bun.file(join(corpusDir, "manifest.json")).json()) as
    | Manifest
    | undefined;
  const entryNames =
    manifest?.entries.map((entry) => `${entry.source}--${entry.id}`) ?? [];
  if (entryNames.length === 0) {
    throw new Error("config-harness-envelope: corpus has no entries");
  }

  await measureEntry(corpusDir, entryNames[0] ?? "");
  const configMs: number[] = [];
  for (const entryName of entryNames) {
    configMs.push(await measureEntry(corpusDir, entryName));
  }

  const configTotal = total(configMs);
  const configMedian = median(configMs);
  const configP90 = percentile(configMs, 0.9);

  console.log(
    "| Pipeline | Total | Per-entry median | Per-entry p90 |\n| --- | ---: | ---: | ---: |",
  );
  console.log(
    `| Config | ${milliseconds(configTotal)} | ${milliseconds(configMedian)} | ${milliseconds(configP90)} |`,
  );

  await mkdir(join(root, "docs", "perf"), { recursive: true });
  await writeFile(
    reportPath,
    makeReport({
      corpusDir,
      entryCount: entryNames.length,
      configTotal,
      configMedian,
      configP90,
    }),
    "utf8",
  );
  await formatReport();
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

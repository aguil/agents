#!/usr/bin/env bun
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, cpus, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCodeReview } from "@aguil/agents-code-review";
import { runCodeReviewFromConfig } from "@aguil/agents-code-review/config-runner";
import { resolveEntryDir } from "@aguil/agents-code-review/replay-parity";
import { ReplayAgentAdapter } from "@aguil/agents-execution";

interface Manifest {
  readonly entries: ReadonlyArray<{
    readonly id: string;
    readonly source: string;
  }>;
}

interface Measurements {
  readonly package: number[];
  readonly config: number[];
}

const root = resolve(import.meta.dir, "..");
const agentsDir = join(root, ".agents");
const reportPath = join(root, "docs", "perf", "config-harness-envelope.md");

function parseArgs(): { corpusDir: string; bound: number } {
  const argv = Bun.argv.slice(2);
  let corpusDir: string | undefined;
  let bound = 10;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--corpus") {
      corpusDir = argv[++index];
    } else if (arg === "--bound") {
      const rawBound = argv[++index];
      bound = Number(rawBound);
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
  if (!Number.isFinite(bound) || bound < 0) {
    throw new Error(
      "config-harness-envelope: --bound must be a non-negative number",
    );
  }
  return { corpusDir: resolve(corpusDir), bound };
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
): Promise<{ packageMs: number; configMs: number }> {
  const entryDir = resolveEntryDir(corpusDir, entryName);
  const contextBundlePath = join(entryDir, "context", "bundle.json");
  const packageWorkspace = await mkdtemp(join(tmpdir(), "envelope-package-"));
  const configWorkspace = await mkdtemp(join(tmpdir(), "envelope-config-"));
  try {
    const packageStart = performance.now();
    await runCodeReview({
      workspacePath: packageWorkspace,
      scratchpadRoot: join(packageWorkspace, "runs"),
      contextBundlePath,
      adapter: new ReplayAgentAdapter({ runDir: entryDir }),
    });
    const packageMs = performance.now() - packageStart;

    const configStart = performance.now();
    await runCodeReviewFromConfig({
      agentsDir,
      workspacePath: configWorkspace,
      scratchpadRoot: join(configWorkspace, "runs"),
      contextBundlePath,
      adapter: new ReplayAgentAdapter({ runDir: entryDir }),
    });
    const configMs = performance.now() - configStart;
    return { packageMs, configMs };
  } finally {
    await rm(packageWorkspace, { recursive: true, force: true });
    await rm(configWorkspace, { recursive: true, force: true });
  }
}

function makeReport(input: {
  readonly corpusDir: string;
  readonly entryCount: number;
  readonly bound: number;
  readonly packageTotal: number;
  readonly configTotal: number;
  readonly packageMedian: number;
  readonly configMedian: number;
  readonly packageP90: number;
  readonly configP90: number;
  readonly ratio: number;
  readonly passed: boolean;
}): string {
  return `# Config harness performance envelope

- Date: ${new Date().toISOString().slice(0, 10)}
- Machine: ${machineNote()}
- Bun: ${Bun.version}
- Corpus: agents-replay-corpus checkout (located via --corpus /
  AGENTS_REPLAY_CORPUS_DIR; see docs/harnesses/code-review/spec/replay-corpus.md)
- Entries: ${input.entryCount}
- Warmup: first corpus entry replayed once through both pipelines
- Bound: config total must not exceed package total by more than ${input.bound.toFixed(2)}%

## Summary

| Pipeline | Total | Per-entry median | Per-entry p90 |
| --- | ---: | ---: | ---: |
| Package | ${milliseconds(input.packageTotal)} | ${milliseconds(input.packageMedian)} | ${milliseconds(input.packageP90)} |
| Config | ${milliseconds(input.configTotal)} | ${milliseconds(input.configMedian)} | ${milliseconds(input.configP90)} |

- Config/package total ratio: ${input.ratio.toFixed(4)}x
- Verdict: **${input.passed ? "PASS" : "FAIL"}**
`;
}

async function formatReport(): Promise<void> {
  const subprocess = Bun.spawn(
    ["bunx", "prettier@3.1.0", "--write", reportPath],
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
  const { corpusDir, bound } = parseArgs();
  const manifest = (await Bun.file(join(corpusDir, "manifest.json")).json()) as
    | Manifest
    | undefined;
  const entryNames =
    manifest?.entries.map((entry) => `${entry.source}--${entry.id}`) ?? [];
  if (entryNames.length === 0) {
    throw new Error("config-harness-envelope: corpus has no entries");
  }

  await measureEntry(corpusDir, entryNames[0] ?? "");
  const measurements: Measurements = { package: [], config: [] };
  for (const entryName of entryNames) {
    const measured = await measureEntry(corpusDir, entryName);
    measurements.package.push(measured.packageMs);
    measurements.config.push(measured.configMs);
  }

  const packageTotal = total(measurements.package);
  const configTotal = total(measurements.config);
  const ratio = configTotal / packageTotal;
  const passed = ratio <= 1 + bound / 100;
  const packageMedian = median(measurements.package);
  const configMedian = median(measurements.config);
  const packageP90 = percentile(measurements.package, 0.9);
  const configP90 = percentile(measurements.config, 0.9);

  console.log(
    "| Pipeline | Total | Per-entry median | Per-entry p90 |\n| --- | ---: | ---: | ---: |",
  );
  console.log(
    `| Package | ${milliseconds(packageTotal)} | ${milliseconds(packageMedian)} | ${milliseconds(packageP90)} |`,
  );
  console.log(
    `| Config | ${milliseconds(configTotal)} | ${milliseconds(configMedian)} | ${milliseconds(configP90)} |`,
  );
  console.log(`Config/package total ratio: ${ratio.toFixed(4)}x`);
  console.log(
    `Bound: +${bound.toFixed(2)}%; verdict: ${passed ? "PASS" : "FAIL"}`,
  );

  await mkdir(join(root, "docs", "perf"), { recursive: true });
  await writeFile(
    reportPath,
    makeReport({
      corpusDir,
      entryCount: entryNames.length,
      bound,
      packageTotal,
      configTotal,
      packageMedian,
      configMedian,
      packageP90,
      configP90,
      ratio,
      passed,
    }),
    "utf8",
  );
  await formatReport();
  return passed ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

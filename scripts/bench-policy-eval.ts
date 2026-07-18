import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";

const iterations = 30;
const warmups = 2;
const root = join(import.meta.dir, "..");
const binaryPath = "/tmp/agents-bench-bin";
const payload = JSON.stringify({
  hook_event_name: "beforeShellExecution",
  command: "rg foo",
});
const benchmarkEnv = {
  ...process.env,
  AGENTS_POLICY_ID: "triage-readonly",
  AGENTS_AGENTS_DIR: join(root, "examples/incident-triage/.agents"),
};

interface Stats {
  min: number;
  p50: number;
  p90: number;
  max: number;
  mean: number;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Variant {
  name: string;
  command: string[];
  stats: Stats;
  projectedMs: number;
}

async function runCommand(
  command: string[],
  stdin?: string,
  env = process.env,
): Promise<CommandResult> {
  const subprocess = Bun.spawn(command, {
    cwd: root,
    env,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function measureInvocation(command: string[]): Promise<number> {
  const start = performance.now();
  const result = await runCommand(command, payload, benchmarkEnv);
  const elapsed = performance.now() - start;
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed with exit code ${result.exitCode}\n${result.stderr || result.stdout}`,
    );
  }
  return elapsed;
}

async function benchmark(command: string[]): Promise<Stats> {
  for (let index = 0; index < warmups; index += 1) {
    await measureInvocation(command);
  }
  const timings: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    timings.push(await measureInvocation(command));
  }
  const sorted = [...timings].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.ceil(fraction * sorted.length) - 1] ?? 0;
  return {
    min: sorted[0] ?? 0,
    p50: percentile(0.5),
    p90: percentile(0.9),
    max: sorted.at(-1) ?? 0,
    mean: timings.reduce((sum, timing) => sum + timing, 0) / timings.length,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function isMappedToolEvent(event: unknown): boolean {
  if (typeof event !== "object" || event === null) {
    return false;
  }
  const data = (event as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const toolEvent = data as {
    type?: unknown;
    subtype?: unknown;
    tool_call?: unknown;
  };
  if (
    toolEvent.type !== "tool_call" ||
    toolEvent.subtype !== "started" ||
    typeof toolEvent.tool_call !== "object" ||
    toolEvent.tool_call === null
  ) {
    return false;
  }
  const mappedToolKeys = new Set([
    "shellToolCall",
    "mcpToolCall",
    "editToolCall",
    "writeToolCall",
    "deleteToolCall",
    "applyPatchToolCall",
    "fileEditToolCall",
  ]);
  return Object.keys(toolEvent.tool_call).some((key) =>
    mappedToolKeys.has(key),
  );
}

async function toolEventCounts(): Promise<number[]> {
  const runsDirectory = join(root, ".agents-code-review/runs");
  const runEntries = await readdir(runsDirectory, { withFileTypes: true });
  const counts: number[] = [];
  for (const runEntry of runEntries) {
    if (!runEntry.isDirectory()) {
      continue;
    }
    const eventsPath = join(runsDirectory, runEntry.name, "events.jsonl");
    try {
      const lines = (await readFile(eventsPath, "utf8"))
        .split("\n")
        .filter((line) => line.trim().length > 0);
      let count = 0;
      for (const line of lines) {
        try {
          if (isMappedToolEvent(JSON.parse(line))) {
            count += 1;
          }
        } catch {}
      }
      counts.push(count);
    } catch {}
  }
  if (counts.length === 0) {
    throw new Error(`No events.jsonl files found under ${runsDirectory}`);
  }
  return counts;
}

function milliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function seconds(value: number): string {
  return `${(value / 1000).toFixed(2)} s`;
}

function humanBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function machineNote(): Promise<string> {
  const architectureResult = await runCommand(["uname", "-m"]);
  const architecture =
    architectureResult.exitCode === 0
      ? architectureResult.stdout.trim()
      : process.arch;
  let cpuModel = cpus()[0]?.model.trim() ?? "unknown CPU";
  try {
    const cpuInfo = await readFile("/proc/cpuinfo", "utf8");
    const modelLine = cpuInfo
      .split("\n")
      .find((line) => line.toLowerCase().startsWith("model name"));
    cpuModel = modelLine?.split(":", 2)[1]?.trim() || cpuModel;
  } catch {
    cpuModel = cpuModel || "unavailable";
  }
  return `${architecture}; ${cpuModel}`;
}

function makeReport(input: {
  date: string;
  machine: string;
  bunVersion: string;
  runCounts: number[];
  medianToolEvents: number;
  variants: Variant[];
  compiledVariantFailure?: string;
  binarySize?: number;
}): string {
  const rows = input.variants.map(
    (variant) =>
      `| ${variant.name} | ${iterations} | ${milliseconds(variant.stats.min)} | ${milliseconds(variant.stats.p50)} | ${milliseconds(variant.stats.p90)} | ${milliseconds(variant.stats.max)} | ${milliseconds(variant.stats.mean)} | ${seconds(variant.projectedMs)} |`,
  );
  const projectionLines = input.variants.map(
    (variant) =>
      `- ${variant.name}: ${input.medianToolEvents} events × ${milliseconds(variant.stats.p50)} = ${milliseconds(variant.projectedMs)} (${seconds(variant.projectedMs)}).`,
  );
  const interpretation = input.variants.map(
    (variant) =>
      `- ${variant.name} measured a ${milliseconds(variant.stats.p50)} p50 bridge invocation and projects ${seconds(variant.projectedMs)} per code-review run at the observed median event count.`,
  );
  const binarySizeLine =
    input.binarySize === undefined
      ? ""
      : `\nCompiled binary size: ${humanBytes(input.binarySize)} (${input.binarySize.toLocaleString("en-US")} bytes).\n`;
  const compileSection = input.compiledVariantFailure
    ? `\n## Compiled binary\n\nThe compiled-binary benchmark was skipped because the variant was unavailable.\n${binarySizeLine}\n\`\`\`text\n${input.compiledVariantFailure.trim()}\n\`\`\`\n`
    : input.binarySize === undefined
      ? ""
      : `\n- Compiled binary size: ${humanBytes(input.binarySize)} (${input.binarySize.toLocaleString("en-US")} bytes).\n`;
  return `# Policy-eval hook cost

- Date: ${input.date}
- Machine: ${input.machine}
- Bun: ${input.bunVersion}
- Benchmark: ${warmups} warmups, then ${iterations} sequential measured invocations
- Recorded runs: ${input.runCounts.length}
- Median mapped tool events per run: ${input.medianToolEvents}
${compileSection}
## Summary

| Variant | N | Min | P50 | P90 | Max | Mean | Projected per run |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.join("\n")}

## Projection

${projectionLines.join("\n")}

Mapped events are started shell, MCP, or file-edit tool calls in each recorded \`events.jsonl\`; read and search tool calls are excluded because they do not map to the three configured hooks.

## Interpretation

${interpretation.join("\n")}
`;
}

async function main(): Promise<void> {
  const runCounts = await toolEventCounts();
  const medianToolEvents = median(runCounts);
  const variants: Variant[] = [];
  const bunRunCommand = [
    "bun",
    "run",
    "packages/cli/src/index.ts",
    "policy-eval",
  ];
  const bunRunStats = await benchmark(bunRunCommand);
  variants.push({
    name: "`bun run`",
    command: bunRunCommand,
    stats: bunRunStats,
    projectedMs: medianToolEvents * bunRunStats.p50,
  });

  let compiledVariantFailure: string | undefined;
  let binarySize: number | undefined;
  const compileResult = await runCommand([
    "bun",
    "build",
    "--compile",
    "packages/cli/src/index.ts",
    "--outfile",
    binaryPath,
  ]);
  if (compileResult.exitCode === 0) {
    binarySize = (await stat(binaryPath)).size;
    try {
      const compiledStats = await benchmark([binaryPath, "policy-eval"]);
      variants.push({
        name: "Compiled binary",
        command: [binaryPath, "policy-eval"],
        stats: compiledStats,
        projectedMs: medianToolEvents * compiledStats.p50,
      });
    } catch (error) {
      compiledVariantFailure =
        error instanceof Error ? error.message : String(error);
    }
  } else {
    compiledVariantFailure =
      [compileResult.stdout, compileResult.stderr]
        .filter((output) => output.trim().length > 0)
        .join("\n") || `bun build exited ${compileResult.exitCode}`;
  }

  const report = makeReport({
    date: new Date().toISOString().slice(0, 10),
    machine: await machineNote(),
    bunVersion: Bun.version,
    runCounts,
    medianToolEvents,
    variants,
    compiledVariantFailure,
    binarySize,
  });
  const reportPath = join(root, "docs/perf/policy-eval-hook-cost.md");
  await mkdir(join(root, "docs/perf"), { recursive: true });
  await writeFile(reportPath, report);
  process.stdout.write(report);
}

try {
  await main();
} finally {
  await rm(`${binaryPath}.bun-build`, { recursive: true, force: true });
}

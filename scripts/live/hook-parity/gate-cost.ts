/**
 * Hook-parity live check: what one `agents hook-gate` costs per call (ADR
 * 0028 decision 10), in the form each adapter runs it.
 *
 *   bun scripts/live/hook-parity/gate-cost.ts <agents launcher> [bundle]
 *
 * Claude Code runs the gate as the Bun executable and the bundled entry
 * script (`bundle`, default: dist/index.js beside the launcher); Cursor runs
 * `agents` on PATH, the launcher. Each variant runs 3 untimed warm-ups, then
 * 30 timed runs, interleaved round-robin with the start rotated each round.
 * Percentiles are nearest-rank. Added time is a variant's p50 minus its
 * baseline's: `/bin/true` for a skip, and the handler alone for a run.
 */
import { dirname, join, resolve } from "node:path";

const launcher = resolve(process.argv[2] ?? "dist/agents");
const bundle = resolve(process.argv[3] ?? join(dirname(launcher), "index.js"));
const RUNS = 30;
const WARMUPS = 3;

interface Variant {
  readonly name: string;
  readonly cmd: readonly string[];
  readonly stdin: string;
  readonly baseline?: string;
}

const gate = (cli: readonly string[], adapter: string, event: string) => [
  ...cli,
  "hook-gate",
  "--adapter",
  adapter,
  "--event",
  event,
  "--classes",
  adapter === "claude" ? "shell" : "edit",
  "--",
  "true",
];
const claudeCli = [process.execPath, bundle];
const read = JSON.stringify({ tool_name: "Read", tool_input: {} });
const variants: readonly Variant[] = [
  { name: "bin-true", cmd: ["/bin/true"], stdin: "" },
  { name: "handler-alone", cmd: ["/bin/sh", "-c", "true"], stdin: read },
  {
    name: "claude-skip",
    cmd: gate(claudeCli, "claude", "PreToolUse"),
    stdin: read,
    baseline: "bin-true",
  },
  {
    name: "claude-run",
    cmd: gate(claudeCli, "claude", "PreToolUse"),
    stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "x" } }),
    baseline: "handler-alone",
  },
  {
    name: "cursor-skip",
    cmd: gate([launcher], "cursor", "preToolUse"),
    stdin: read,
    baseline: "bin-true",
  },
  {
    name: "cursor-run",
    cmd: gate([launcher], "cursor", "preToolUse"),
    stdin: JSON.stringify({ tool_name: "Write", tool_input: {} }),
    baseline: "handler-alone",
  },
];

function once(variant: Variant): number {
  const start = performance.now();
  const result = Bun.spawnSync({
    cmd: [...variant.cmd],
    stdin: new TextEncoder().encode(variant.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const ms = performance.now() - start;
  if (
    result.exitCode !== 0 ||
    result.stdout.length + result.stderr.length > 0
  ) {
    throw new Error(
      `${variant.name}: exit ${result.exitCode}, output ${JSON.stringify(
        `${result.stdout}${result.stderr}`,
      )}`,
    );
  }
  return ms;
}

const samples = new Map<string, number[]>(variants.map((v) => [v.name, []]));
for (let round = 0; round < WARMUPS + RUNS; round += 1) {
  for (let i = 0; i < variants.length; i += 1) {
    const variant = variants[(i + round) % variants.length] as Variant;
    const ms = once(variant);
    if (round >= WARMUPS) {
      samples.get(variant.name)?.push(ms);
    }
  }
}

const rank = (sorted: readonly number[], p: number) =>
  sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const stats = Object.fromEntries(
  variants.map((v) => {
    const sorted = [...(samples.get(v.name) ?? [])].sort((a, b) => a - b);
    return [
      v.name,
      {
        p50: rank(sorted, 50),
        p95: rank(sorted, 95),
        min: sorted[0],
        max: sorted.at(-1),
      },
    ];
  }),
);
const added = Object.fromEntries(
  variants
    .filter((v) => v.baseline !== undefined)
    .map((v) => [
      v.name,
      round3(
        (stats[v.name]?.p50 ?? Number.NaN) -
          (stats[v.baseline ?? ""]?.p50 ?? Number.NaN),
      ),
    ]),
);
console.log(
  JSON.stringify(
    {
      date: new Date().toISOString(),
      launcher,
      bundle,
      bun: Bun.version,
      runs: RUNS,
      warmups: WARMUPS,
      ms: Object.fromEntries(
        Object.entries(stats).map(([name, s]) => [
          name,
          Object.fromEntries(
            Object.entries(s).map(([k, v]) => [k, round3(v ?? Number.NaN)]),
          ),
        ]),
      ),
      added_p50_ms: added,
    },
    null,
    2,
  ),
);

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, UnacceptedLineWarning } from "@aguil/agents-core";
import { createAgentEvent } from "@aguil/agents-core";
import type { AgentAdapter } from "@aguil/agents-execution";
import { normalizeAgentOutputLine } from "@aguil/agents-execution";
import { outputSchemaShapes } from "@aguil/agents-harness-config";
import { NativeBunOrchestrator } from "@aguil/agents-orchestration";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// #93: a finding whose id is the prompt's template, echoed back unfilled.
// Built without a literal `${...}` so biome's noTemplateCurlyInString is quiet.
const ECHOED_TEMPLATE_FINDING = JSON.stringify({
  finding: {
    id: `${"$"}{request.roleId}-duplicate-calls`,
    severity: "warning",
    title: "Duplicate calls",
    description: "D",
    evidence: "E",
    sourceRole: "quality",
    validation: { status: "verified", details: "ok" },
  },
});
const INVALID_OUTCOME = JSON.stringify({ outcome: { id: "x", kind: "claim" } });
// #238: a bare outcome data object carrying the declared claim schema's
// data_required keys, emitted without the outcome envelope.
const BARE_CLAIM = JSON.stringify({ number: 1, result: "confirmed" });

/** The line inside an agent stream record's text, as a real CLI emits it. */
function nested(line: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: `Here is my answer:\n${line}` }],
    },
  });
}

const CASES = [
  {
    role: "finding-top",
    emit: ECHOED_TEMPLATE_FINDING,
    reason: "invalid_finding",
    nested: false,
    line: ECHOED_TEMPLATE_FINDING,
  },
  {
    role: "finding-nested",
    emit: nested(ECHOED_TEMPLATE_FINDING),
    reason: "invalid_finding",
    nested: true,
    line: ECHOED_TEMPLATE_FINDING,
  },
  {
    role: "outcome-top",
    emit: INVALID_OUTCOME,
    reason: "invalid_outcome",
    nested: false,
    line: INVALID_OUTCOME,
  },
  {
    role: "outcome-nested",
    emit: nested(INVALID_OUTCOME),
    reason: "invalid_outcome",
    nested: true,
    line: INVALID_OUTCOME,
  },
  {
    role: "schema-top",
    emit: BARE_CLAIM,
    reason: "schema_shaped_json",
    nested: false,
    line: BARE_CLAIM,
  },
  {
    role: "schema-nested",
    emit: nested(BARE_CLAIM),
    reason: "schema_shaped_json",
    nested: true,
    line: BARE_CLAIM,
  },
] as const;

interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly status: string;
  readonly events: readonly AgentEvent[];
}

/**
 * Runs `harness run --adapter opencode` against a stub `opencode` that prints
 * what its role's prompt asks for: `EMIT <base64 line>` prints the line, and
 * `EXIT <code>` exits with that code.
 */
async function runHarness(
  roles: Readonly<Record<string, string>>,
  extraArgs: readonly string[] = [],
): Promise<Run> {
  const root = await mkdtemp(join(tmpdir(), "harness-unaccepted-"));
  try {
    const workspace = join(root, "workspace");
    const agentsDir = join(root, "agents");
    const binDir = join(root, "bin");
    const harnessDir = join(agentsDir, "harnesses", "unaccepted");
    await mkdir(workspace, { recursive: true });
    await mkdir(harnessDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "opencode"),
      [
        `#!${process.execPath}`,
        "const prompt = process.argv.at(-1) ?? '';",
        "const emit = /^EMIT (\\S+)/m.exec(prompt);",
        "if (emit) console.log(Buffer.from(emit[1], 'base64').toString('utf8'));",
        "const exit = /^EXIT (\\d+)/m.exec(prompt);",
        "if (exit) process.exit(Number(exit[1]));",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await writeFile(
      join(harnessDir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness:",
        "  id: unaccepted",
        "output:",
        "  schemas:",
        "    claim:",
        "      data_required: [number, result]",
        "roles:",
        ...Object.entries(roles).flatMap(([role, prompt]) => [
          `  ${role}:`,
          `    description: ${role}`,
          "    prompt: |",
          `      ${prompt}`,
        ]),
        "",
      ].join("\n"),
    );
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "run",
        join(repoRoot, "packages", "cli", "src", "index.ts"),
        "harness",
        "run",
        "unaccepted",
        "--agents-dir",
        agentsDir,
        "--workspace",
        workspace,
        "--adapter",
        "opencode",
        ...extraArgs,
      ],
      cwd: repoRoot,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const artifacts = /^artifacts: (.+)$/m.exec(stdout)?.[1];
    if (artifacts === undefined) {
      throw new Error(`no artifacts line:\n${stdout}\n${stderr}`);
    }
    const events = (await Bun.file(join(artifacts, "events.jsonl")).text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentEvent);
    const status = /^status: (\S+)$/m.exec(stdout)?.[1] ?? "";
    return { stdout, stderr, exitCode, status, events };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function emitPrompt(line: string): string {
  return `EMIT ${Buffer.from(line, "utf8").toString("base64")}`;
}

const UNACCEPTED_ROLES = Object.fromEntries(
  CASES.map((entry) => [entry.role, emitPrompt(entry.emit)]),
);

test("each kind of unaccepted line is a warning in events.jsonl, and the run passes (JC-3, JC-8)", async () => {
  const run = await runHarness(UNACCEPTED_ROLES);
  expect(run.status, run.stdout).toBe("passed");
  expect(run.exitCode).toBe(0);
  expect(run.events.some((event) => event.type === "error")).toBe(false);
  for (const entry of CASES) {
    const warnings = run.events.filter(
      (event) => event.roleId === entry.role && event.type === "warning",
    );
    expect(warnings, entry.role).toHaveLength(1);
    const data = warnings[0]?.data as UnacceptedLineWarning | undefined;
    expect(data?.kind, entry.role).toBe("unaccepted_line");
    expect(data?.reason, entry.role).toBe(entry.reason);
    expect(data?.nested, entry.role).toBe(entry.nested);
    expect(data?.line, entry.role).toBe(entry.line);
  }
  expect(run.stdout).toContain(
    `unaccepted output lines: ${CASES.length} (warnings in events.jsonl)`,
  );
});

test("under --strict each kind of unaccepted line fails its role, with the reason recorded (JC-5)", async () => {
  const run = await runHarness(UNACCEPTED_ROLES, ["--strict"]);
  expect(run.status, run.stdout).toBe("error");
  expect(run.exitCode).toBe(1);
  for (const entry of CASES) {
    const errors = run.events.filter(
      (event) => event.roleId === entry.role && event.type === "error",
    );
    expect(errors, entry.role).toHaveLength(1);
    expect(errors[0]?.message, entry.role).toStartWith(
      "--strict: unaccepted output line: ",
    );
    expect(
      (errors[0]?.data as { reason?: string } | undefined)?.reason,
      entry.role,
    ).toBe("strict_unaccepted_line");
    expect(run.stdout).toContain(
      `- ${entry.role}: ${errors[0]?.message ?? ""}`,
    );
  }
  const failed = /^roles failed: (.+)$/m.exec(run.stdout)?.[1]?.split(",");
  expect(new Set(failed)).toEqual(new Set(CASES.map((entry) => entry.role)));
});

test("a role failing on a process error or a schema violation leaves its reason in events.jsonl and the summary (JC-7)", async () => {
  const run = await runHarness({
    crash: "EXIT 3",
    "schema-violation": emitPrompt(
      JSON.stringify({
        outcome: {
          id: "c1",
          kind: "claim",
          sourceRole: "schema-violation",
          title: "Claim without its result",
          data: { number: 1 },
        },
      }),
    ),
  });
  expect(run.status).toBe("error");
  const firstError = (role: string) =>
    run.events.find((event) => event.roleId === role && event.type === "error")
      ?.message;
  expect(firstError("crash")).toBe("opencode exited with code 3");
  expect(firstError("schema-violation")).toBe(
    "role output violates declared outcome schemas",
  );
  expect(run.stdout).toContain("- crash: opencode exited with code 3");
  expect(run.stdout).toContain(
    "- schema-violation: role output violates declared outcome schemas",
  );
});

test("a line echoed twice by the agent stream is recorded once per role", async () => {
  const events: AgentEvent[] = [];
  const line = nested(INVALID_OUTCOME);
  const adapter: AgentAdapter = {
    name: "echoing",
    capabilities: () => ({
      streaming: true,
      structuredOutput: true,
      readOnlyMode: true,
      mcp: false,
      cancellation: false,
    }),
    async *run(request) {
      // Real CLIs repeat the assistant text in their final result record.
      yield* normalizeAgentOutputLine(request, line);
      yield* normalizeAgentOutputLine(request, line);
      yield createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "completed",
      });
    },
  };
  const scratch = await mkdtemp(join(tmpdir(), "unaccepted-dedupe-"));
  try {
    const orchestrator = new NativeBunOrchestrator({
      definition: {
        id: "dedupe",
        roles: [
          {
            id: "solo",
            description: "solo",
            prompt: "p",
            timeoutMs: 1_000,
            requiredCapabilities: [],
          },
        ],
      },
      adapter,
      eventSink: { write: async (event) => void events.push(event) },
      contextBundlePath: join(scratch, "context.json"),
    });
    const result = await orchestrator.run({
      runId: "run-dedupe",
      harnessId: "dedupe",
      workspacePath: scratch,
      scratchpadPath: scratch,
    });
    expect(result.status).toBe("passed");
    expect(events.filter((event) => event.type === "warning")).toHaveLength(1);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("both --strict help texts say what strict fails on (JC-5, JC-6)", () => {
  const help = (args: readonly string[]) =>
    Bun.spawnSync({
      cmd: [
        "bun",
        "run",
        join(repoRoot, "packages", "cli", "src", "index.ts"),
        ...args,
      ],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    })
      .stdout.toString()
      .replaceAll(/\s+/g, " ");
  const harnessRun = help(["harness", "run", "--help"]);
  expect(harnessRun).toContain(
    "--strict Fail the run on a timed-out role, and fail a role on an unaccepted output line",
  );
  expect(harnessRun).not.toContain("schema / enablement violations");
  const codeReview = help(["code-review", "--help"]);
  expect(codeReview).toContain(
    "--strict Fail on a timed-out reviewer, and fail a reviewer on an unaccepted output line",
  );
  expect(codeReview).not.toContain("Fail fast on reviewer errors/timeouts");
});

test("declared output schemas become the shapes that mark bare JSON (JC-8)", () => {
  expect(
    outputSchemaShapes({
      finding: "builtin:finding",
      claim: { required: ["id", "kind"], dataRequired: ["number", "result"] },
    }),
  ).toEqual([
    {
      kind: "finding",
      keys: [
        "id",
        "severity",
        "title",
        "description",
        "evidence",
        "sourceRole",
        "validation",
      ],
    },
    { kind: "claim", keys: ["id", "kind"] },
    { kind: "claim", keys: ["number", "result"] },
  ]);
});

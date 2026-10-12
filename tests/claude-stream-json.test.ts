import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@aguil/agents-core";
import type { AgentRunRequest } from "@aguil/agents-execution";
import {
  ClaudeCodeAdapter,
  normalizeAgentOutputLine,
} from "@aguil/agents-execution";
import { NativeBunOrchestrator } from "@aguil/agents-orchestration";

// A real Claude Code 2.1.296 capture from `claude -p … --output-format
// stream-json --verbose`, made by `agents harness run --adapter claude` under
// a policy that allows `cat` and denies `tee` (#252). Identifiers, paths,
// timestamps, the thinking signature and the init record's tool lists were
// replaced with placeholders; the record shapes are as captured. The role ran
// `cat decoy.txt`, whose output is an outcome envelope, and a denied `tee`
// heredoc whose input holds another, so both decoys sit in tool I/O: a
// `tool_result`, a `tool_use` input, the assistant record's
// `wire_tool_inputs` and `result.permission_denials`. Its one real envelope,
// `probe-1`, is in the final assistant message and again in `result.result`.
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "claude-stream-json",
  "denied-call.jsonl",
);

async function fixtureLines(): Promise<readonly string[]> {
  const text = await readFile(fixturePath, "utf8");
  return text.split("\n").filter((line) => line.length > 0);
}

function request(scratchpadPath: string): AgentRunRequest {
  return {
    runId: "run-claude-stream",
    roleId: "probe",
    prompt: "Probe.",
    workspacePath: scratchpadPath,
    contextBundlePath: join(scratchpadPath, "context.json"),
    scratchpadPath,
    timeoutMs: 10_000,
    allowedCommands: [],
  };
}

test("the Claude stream fixture holds its decoys where the engine must skip them", async () => {
  const records = (await fixtureLines()).map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  const types = records.map((record) => record.type);
  expect(types).toContain("system");
  expect(types).toContain("user");
  expect(types).toContain("result");

  const blocks = records.flatMap((record) => {
    const message = record.message as { content?: unknown } | undefined;
    return Array.isArray(message?.content)
      ? (message.content as Record<string, unknown>[])
      : [];
  });
  const toolResults = blocks.filter((block) => block.type === "tool_result");
  expect(
    toolResults.some((block) =>
      JSON.stringify(block.content).includes("decoy-tool-result"),
    ),
  ).toBe(true);
  expect(toolResults.some((block) => block.is_error === true)).toBe(true);
  // The engine reads envelopes one text line at a time, so a decoy proves
  // nothing unless it is a line of its own.
  const deniedInput = blocks.find(
    (block) =>
      block.type === "tool_use" &&
      JSON.stringify(block.input).includes("decoy-denied"),
  )?.input as { command?: string } | undefined;
  expect(
    (deniedInput?.command ?? "")
      .split("\n")
      .some((line) => line.startsWith('{"outcome":{"id":"decoy-denied"')),
  ).toBe(true);
  expect(
    records.some(
      (record) =>
        record.type === "assistant" &&
        JSON.stringify(record.wire_tool_inputs).includes("decoy-denied"),
    ),
  ).toBe(true);

  const result = records.find((record) => record.type === "result");
  expect(JSON.stringify(result?.permission_denials)).toContain("decoy-denied");
  expect(result?.result).toContain('"id":"probe-1"');
});

test("a Claude stream run through a role yields one outcome per envelope and nothing from tool I/O", async () => {
  const scratchpadPath = await mkdtemp(join(tmpdir(), "claude-stream-"));
  try {
    // Stand-in for `claude`: whatever argv it gets, print the capture.
    const executable = join(scratchpadPath, "claude-replay.sh");
    await writeFile(executable, `#!/bin/sh\ncat '${fixturePath}'\n`);
    await chmod(executable, 0o755);

    const events: AgentEvent[] = [];
    const orchestrator = new NativeBunOrchestrator({
      definition: {
        id: "claude-stream",
        roles: [
          {
            id: "probe",
            description: "probe role",
            prompt: "Probe.",
            requiredCapabilities: [],
            timeoutMs: 10_000,
          },
        ],
      },
      adapter: new ClaudeCodeAdapter({ executable }),
      contextBundlePath: join(scratchpadPath, "context.json"),
      outputSchemaShapes: [{ kind: "claim", keys: ["number", "result"] }],
      eventSink: {
        write: async (event: AgentEvent) => {
          events.push(event);
        },
      },
    });

    // Strict, so any line the engine could not accept would fail the role.
    const result = await orchestrator.run({
      runId: "run-claude-stream",
      harnessId: "claude-stream",
      workspacePath: scratchpadPath,
      scratchpadPath,
      strictMode: true,
    });

    expect(result.status).toBe("passed");
    expect(result.outcomes?.map((outcome) => outcome.id)).toEqual(["probe-1"]);
    expect(result.findings).toEqual([]);

    // The final-turn envelope arrives twice, in the assistant message and in
    // `result.result`; outcomes are deduplicated after the role (RC-83).
    const outcomeEvents = events.filter((event) => event.type === "outcome");
    expect(outcomeEvents.map((event) => event.message)).toEqual([
      "tee denied",
      "tee denied",
    ]);
    expect(events.filter((event) => event.type === "warning")).toEqual([]);
    expect(events.some((event) => event.type === "finding")).toBe(false);
  } finally {
    await rm(scratchpadPath, { recursive: true, force: true });
  }
});

test("a text-mode argsTemplate still yields its envelopes, as before stream JSON", async () => {
  const scratchpadPath = await mkdtemp(join(tmpdir(), "claude-text-"));
  try {
    // Stand-in for `claude -p` in text mode: record argv, print plain text
    // with an envelope on a line of its own.
    const argvPath = join(scratchpadPath, "argv.txt");
    const executable = join(scratchpadPath, "claude-text.sh");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvPath}'\n` +
        `echo 'Checked the claim.'\n` +
        `echo '{"outcome":{"id":"text-1","kind":"claim","sourceRole":"probe","title":"text mode","data":{"number":1,"result":"ok"}}}'\n`,
    );
    await chmod(executable, 0o755);

    const adapter = new ClaudeCodeAdapter({
      executable,
      argsTemplate: ["-p", "{prompt}"],
    });
    const events: AgentEvent[] = [];
    for await (const event of adapter.run(request(scratchpadPath))) {
      events.push(event);
    }

    const argv = (await readFile(argvPath, "utf8")).split("\n");
    expect(argv[0]).toBe("-p");
    expect(argv).not.toContain("--output-format");
    expect(argv).not.toContain("stream-json");
    const outcomes = events.filter((event) => event.type === "outcome");
    expect(outcomes.map((event) => event.message)).toEqual(["text mode"]);
    expect(
      events.some(
        (event) =>
          event.type === "stdout" && event.message === "Checked the claim.",
      ),
    ).toBe(true);
    expect(events.filter((event) => event.type === "warning")).toEqual([]);
  } finally {
    await rm(scratchpadPath, { recursive: true, force: true });
  }
});

test("an envelope only in result.permission_denials yields nothing", async () => {
  const resultLine = (await fixtureLines()).find(
    (line) => (JSON.parse(line) as { type?: unknown }).type === "result",
  );
  expect(resultLine).toBeDefined();
  const record = JSON.parse(resultLine ?? "{}") as Record<string, unknown>;
  const deniedOnly = JSON.stringify({ ...record, result: "" });
  expect(deniedOnly).toContain("decoy-denied");

  const events = normalizeAgentOutputLine(request("/scratch"), deniedOnly);
  expect(
    events.filter((event) => event.type !== "stdout").map((e) => e.type),
  ).toEqual([]);
});

test("Claude's rate_limit_event record is never matched against an output schema", async () => {
  const rateLimitLine = (await fixtureLines()).find(
    (line) =>
      (JSON.parse(line) as { type?: unknown }).type === "rate_limit_event",
  );
  expect(rateLimitLine).toBeDefined();

  // A schema whose required keys the record happens to carry at top level.
  const events = normalizeAgentOutputLine(
    {
      ...request("/scratch"),
      outputSchemaShapes: [{ kind: "session", keys: ["uuid", "session_id"] }],
    },
    rateLimitLine ?? "",
  );
  expect(events.map((event) => event.type)).toEqual(["stdout"]);
});

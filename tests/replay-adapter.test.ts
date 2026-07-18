import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest } from "@aguil/agents-execution";
import { collectAgentRun, ReplayAgentAdapter } from "@aguil/agents-execution";

function request(scratch: string, roleId: string): AgentRunRequest {
  return {
    runId: "replay-test",
    roleId,
    prompt: "(unused in replay)",
    workspacePath: scratch,
    contextBundlePath: join(scratch, "context.json"),
    scratchpadPath: join(scratch, "scratchpad"),
    timeoutMs: 5_000,
    allowedCommands: [],
  };
}

const FINDING_LINE = JSON.stringify({
  finding: {
    id: "quality-replayed",
    severity: "warning",
    title: "Replayed finding",
    description: "Captured from a recorded run.",
    evidence: "stdout.log line 2",
    sourceRole: "quality",
    validation: { status: "verified", details: "recorded" },
  },
});

const OUTCOME_LINE = JSON.stringify({
  outcome: {
    id: "diagnosis",
    kind: "diagnosis",
    sourceRole: "quality",
    title: "Replayed outcome",
    data: { rootCause: "recorded" },
  },
});

// Real Cursor stream-json wraps envelopes inside assistant message text;
// replay must surface those exactly like the live adapter does.
const NESTED_LINE = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: FINDING_LINE }] },
});

test("replay feeds recorded stdout through live-line normalization", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "replay-"));
  try {
    const roleDir = join(scratch, "run", "roles", "quality");
    await mkdir(roleDir, { recursive: true });
    await writeFile(
      join(roleDir, "stdout.log"),
      ["plain progress text", FINDING_LINE, OUTCOME_LINE, NESTED_LINE, ""].join(
        "\n",
      ),
    );

    const adapter = new ReplayAgentAdapter({ runDir: join(scratch, "run") });
    const { events, result } = await collectAgentRun(
      adapter,
      request(scratch, "quality"),
    );

    expect(result.status).toBe("completed");
    // Standalone + nested finding envelopes both replay as finding events.
    const findingEvents = events.filter((event) => event.type === "finding");
    expect(findingEvents).toHaveLength(2);
    expect(result.findings.map((finding) => finding.id)).toEqual([
      "quality-replayed",
      "quality-replayed",
    ]);
    const outcomeEvents = events.filter((event) => event.type === "outcome");
    expect(outcomeEvents).toHaveLength(1);
    expect(events.at(0)?.type).toBe("started");
    expect(events.at(-1)?.type).toBe("completed");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("replay fails loudly when the role has no recording", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "replay-missing-"));
  try {
    await mkdir(join(scratch, "run", "roles"), { recursive: true });
    const adapter = new ReplayAgentAdapter({ runDir: join(scratch, "run") });
    const { events, result } = await collectAgentRun(
      adapter,
      request(scratch, "security"),
    );

    expect(result.status).toBe("failed");
    const error = events.find((event) => event.type === "error");
    expect(error?.message).toContain('no recording for role "security"');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("replay of a recorded stream-json run is deterministic (committed fixture)", async () => {
  // The fixture mimics the real Cursor stream-json shape (system init,
  // nested envelope inside assistant text, standalone envelopes, terminal
  // result line) so this determinism gate runs everywhere, including CI.
  const runDir = join(import.meta.dir, "fixtures", "replay-run");
  const scratch = await mkdtemp(join(tmpdir(), "replay-fixture-"));
  try {
    const adapter = new ReplayAgentAdapter({ runDir });
    const first = await collectAgentRun(adapter, request(scratch, "quality"));
    const second = await collectAgentRun(adapter, request(scratch, "quality"));

    expect(first.result.status).toBe("completed");
    expect(first.result.findings.map((finding) => finding.id)).toEqual([
      "quality-fixture-nested",
      "quality-fixture-toplevel",
    ]);
    expect(
      first.events.filter((event) => event.type === "outcome"),
    ).toHaveLength(1);

    expect(second.result.findings).toEqual(first.result.findings);
    expect(second.result.status).toBe(first.result.status);
    expect(second.events.map((event) => event.type)).toEqual(
      first.events.map((event) => event.type),
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

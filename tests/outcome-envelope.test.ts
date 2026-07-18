import { expect, test } from "bun:test";
import type { AgentRunRequest } from "@aguil/agents-execution";
import { normalizeAgentOutputLine } from "@aguil/agents-execution";

const request: AgentRunRequest = {
  runId: "run-1",
  roleId: "diagnose",
  prompt: "Diagnose.",
  workspacePath: "/tmp/workspace",
  contextBundlePath: "/tmp/context.json",
  scratchpadPath: "/tmp/scratchpad",
  timeoutMs: 1_000,
  allowedCommands: [],
};

test("parses a valid outcome envelope into an outcome event", () => {
  const outcome = {
    id: "diagnosis",
    kind: "diagnosis",
    sourceRole: "diagnose",
    title: "Off-by-one in page end index",
    data: {
      rootCause: "end index drops final item",
      file: "src/pagination.ts",
    },
  };
  const events = normalizeAgentOutputLine(request, JSON.stringify({ outcome }));
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("outcome");
  expect(events[0]?.data).toEqual(outcome);
});

test("a malformed outcome envelope becomes an error event, not a silent drop", () => {
  const events = normalizeAgentOutputLine(
    request,
    JSON.stringify({ outcome: { id: "x", kind: "diagnosis" } }),
  );
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("error");
  expect(events[0]?.message).toBe("invalid outcome envelope");
});

test("finding and outcome envelopes remain disjoint", () => {
  const findingEvents = normalizeAgentOutputLine(
    request,
    JSON.stringify({
      finding: {
        id: "f1",
        severity: "warning",
        title: "t",
        description: "d",
        evidence: "e",
        sourceRole: "diagnose",
        validation: { status: "verified", details: "ok" },
      },
    }),
  );
  expect(findingEvents[0]?.type).toBe("finding");
});

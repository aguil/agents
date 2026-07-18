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

test("extracts an outcome envelope nested in stream-json assistant text", () => {
  // Mirrors what a real Cursor agent emits: the outcome envelope lives in
  // the assistant message's text, not as a standalone stdout line.
  const streamJson = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'Emitting the remediation outcome:\n\n{"outcome":{"id":"remediation","kind":"remediation","sourceRole":"fix","title":"Fixed off-by-one","data":{"applied":true}}}',
        },
      ],
    },
  };
  const events = normalizeAgentOutputLine(request, JSON.stringify(streamJson));
  const outcomeEvents = events.filter((event) => event.type === "outcome");
  expect(outcomeEvents).toHaveLength(1);
  expect((outcomeEvents[0]?.data as { kind?: string }).kind).toBe(
    "remediation",
  );
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

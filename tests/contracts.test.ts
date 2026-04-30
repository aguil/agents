import { expect, test } from "bun:test";
import type { AgentEvent, Finding } from "@aguil/agents-core";
import { actionableFindings } from "@aguil/agents-reporting";
import { serializeEvent } from "@aguil/agents-telemetry";

test("serializes agent events as JSONL", () => {
  const event: AgentEvent = {
    timestamp: "2026-04-30T00:00:00.000Z",
    runId: "run-1",
    roleId: "security",
    type: "started",
    message: "started security review",
  };

  expect(serializeEvent(event)).toBe(`${JSON.stringify(event)}\n`);
});

test("keeps only verified findings for actionable reports", () => {
  const verified: Finding = {
    id: "finding-1",
    severity: "warning",
    title: "Verified issue",
    description: "A validated review finding.",
    evidence: "The reproduction passed.",
    sourceRole: "quality",
    validation: { status: "verified", details: "Reproduced locally." },
  };
  const unverified: Finding = {
    ...verified,
    id: "finding-2",
    validation: { status: "not_run", details: "No validation was attempted." },
  };

  expect(actionableFindings([verified, unverified])).toEqual([verified]);
});

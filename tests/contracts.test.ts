import { expect, test } from "bun:test";
import type { AgentEvent, Finding } from "@aguil/agents-core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeCodeReviewAdapter,
  definitionForTriage,
  runCodeReview,
} from "@aguil/agents-code-review";
import { changedFilesFromDiff, classifyDiff } from "@aguil/agents-context";
import { collectAgentRun } from "@aguil/agents-execution";
import { actionableFindings, dedupeFindings, statusForFindings } from "@aguil/agents-reporting";
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

test("classifies small diffs as trivial", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
+hello
-hello`;

  expect(classifyDiff(diff)).toBe("trivial");
  expect(changedFilesFromDiff(diff)).toEqual(["src/a.ts"]);
});

test("dedupes findings and derives severity status", () => {
  const finding: Finding = {
    id: "finding-1",
    severity: "critical",
    title: "Duplicate issue",
    description: "A validated review finding.",
    evidence: "The reproduction passed.",
    sourceRole: "security",
    file: "src/a.ts",
    line: 10,
    validation: { status: "verified", details: "Reproduced locally." },
  };

  const deduped = dedupeFindings([{ ...finding, id: "finding-2" }, finding]);

  expect(deduped).toHaveLength(1);
  expect(statusForFindings(deduped)).toBe("failed");
});

test("uses fewer reviewer roles for lower-risk triage tiers", () => {
  expect(definitionForTriage("trivial").roles.map((role) => role.id)).toEqual(["quality"]);
  expect(definitionForTriage("lite").roles.map((role) => role.id)).toEqual([
    "security",
    "quality",
    "compliance",
  ]);
});

test("collects fake agent findings through the adapter contract", async () => {
  const finding: Finding = {
    id: "finding-1",
    severity: "warning",
    title: "Verified issue",
    description: "A validated review finding.",
    evidence: "The reproduction passed.",
    sourceRole: "quality",
    validation: { status: "verified", details: "Reproduced locally." },
  };
  const tempDir = await mkdtemp(join(tmpdir(), "agents-execution-"));
  try {
    const run = await collectAgentRun(createFakeCodeReviewAdapter({ quality: [finding] }), {
      runId: "run-1",
      roleId: "quality",
      prompt: "Review this change.",
      workspacePath: tempDir,
      contextBundlePath: join(tempDir, "context.json"),
      scratchpadPath: tempDir,
      timeoutMs: 1_000,
      allowedCommands: [],
    });

    expect(run.result.findings).toEqual([finding]);
    expect(run.events.map((event) => event.type)).toEqual(["started", "finding", "completed"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runs the code-review harness with a fake adapter", async () => {
  const finding: Finding = {
    id: "finding-1",
    severity: "warning",
    title: "Verified harness issue",
    description: "A validated review finding.",
    evidence: "The reproduction passed.",
    sourceRole: "quality",
    validation: { status: "verified", details: "Reproduced locally." },
  };
  const tempDir = await mkdtemp(join(tmpdir(), "agents-code-review-"));
  try {
    const result = await runCodeReview({
      workspacePath: tempDir,
      scratchpadRoot: join(tempDir, "scratchpad"),
      runId: "test-run",
      adapter: createFakeCodeReviewAdapter({ quality: [finding] }),
    });

    expect(result.status).toBe("warnings");
    expect(result.findings).toEqual([finding]);
    expect(await readFile(result.reportPath, "utf8")).toContain("Verified harness issue");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

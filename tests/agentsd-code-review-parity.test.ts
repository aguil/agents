import { expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRunResult } from "@aguil/agents-core";
import {
  evaluateCodeReviewPublish,
  executeCodeReviewPublish,
} from "@aguil/agents-publish";
import { parseCodeReviewPolicy } from "@aguil/agents-workflow";

const sampleResult: HarnessRunResult = {
  runId: "r1",
  status: "passed",
  findings: [
    {
      id: "f1",
      severity: "warning",
      title: "t",
      description: "d",
      evidence: "e",
      sourceRole: "security",
      validation: { status: "not_run", details: "" },
    },
  ],
  artifacts: [],
};

test("publish_with_findings allows pending when triage has items", () => {
  const policy = parseCodeReviewPolicy({
    policy: { code_review: { publish_with_findings: true } },
  });
  expect(policy.publishWithFindings).toBe(true);
  const decision = evaluateCodeReviewPublish({
    publish: {
      codeReview: {
        mode: "pending",
        reviewSummary: "impact",
        staleHead: "skip",
        replacePending: false,
        requireEmptyTriage: !policy.publishWithFindings,
      },
      prFeedback: {
        mode: "off",
        requireEmptyTriage: true,
        requireResponsesDocument: true,
      },
    },
    result: sampleResult,
    resultPath: "/tmp/result.json",
    triageItemCount: 2,
    isDryRunPath: false,
    prNumber: 42,
  });
  expect(decision.shouldPublish).toBe(true);
  expect(decision.mode).toBe("pending");
});

test("notify mode emits operator hint without posting", async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), "cr-notify-"));
  try {
    const resultPath = join(dir, "result.json");
    await fsp.writeFile(
      resultPath,
      JSON.stringify({
        runId: "run-1",
        status: "passed",
        findings: [{ id: "f1" }],
        artifacts: [],
      }),
      "utf8",
    );
    const outcome = await executeCodeReviewPublish({
      publish: {
        codeReview: {
          mode: "notify",
          reviewSummary: "impact",
          staleHead: "skip",
          replacePending: false,
          requireEmptyTriage: true,
        },
        prFeedback: {
          mode: "off",
          requireEmptyTriage: true,
          requireResponsesDocument: true,
        },
      },
      result: sampleResult,
      resultPath,
      workspacePath: dir,
      triageItemCount: 1,
      prNumber: 7,
      repository: "org/repo",
    });
    expect(outcome.executed).toBe(false);
    expect(outcome.decision.mode).toBe("notify");
    expect(outcome.decision.operatorHint).toContain("agents code-review post");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

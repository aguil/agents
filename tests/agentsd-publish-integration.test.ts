import { expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateCodeReviewPublish,
  evaluatePrFeedbackPublish,
  executeCodeReviewPublish,
  executePrFeedbackSubmit,
} from "@aguil/agents-publish";

const publishOff = {
  codeReview: {
    mode: "off" as const,
    reviewSummary: "impact" as const,
    staleHead: "skip" as const,
    replacePending: false,
    requireEmptyTriage: true,
  },
  prFeedback: {
    mode: "off" as const,
    requireEmptyTriage: true,
    requireResponsesDocument: true,
  },
};

test("evaluateCodeReviewPublish blocks pending when triage has items", () => {
  const decision = evaluateCodeReviewPublish({
    publish: {
      ...publishOff,
      codeReview: { ...publishOff.codeReview, mode: "pending" },
    },
    result: { runId: "r1", status: "passed", findings: [], artifacts: [] },
    resultPath: "/tmp/result.json",
    triageItemCount: 2,
    isDryRunPath: false,
    prNumber: 1,
  });
  expect(decision.shouldPublish).toBe(false);
  expect(decision.skipReason).toBe("triage_items_nonzero");
});

test("evaluatePrFeedbackPublish blocks submit without responses path", () => {
  const decision = evaluatePrFeedbackPublish({
    publish: {
      ...publishOff,
      prFeedback: {
        ...publishOff.prFeedback,
        mode: "submit",
        requireEmptyTriage: false,
      },
    },
    triageItemCount: 0,
    responsesPath: undefined,
    prApprovedForSubmit: true,
    requireApprovalBeforeSubmit: false,
  });
  expect(decision.shouldPublish).toBe(false);
  expect(decision.skipReason).toBe("responses_document_missing");
});

test("evaluatePrFeedbackPublish blocks submit without operator approval", () => {
  const decision = evaluatePrFeedbackPublish({
    publish: {
      ...publishOff,
      prFeedback: { ...publishOff.prFeedback, mode: "submit" },
    },
    triageItemCount: 0,
    responsesPath: "/tmp/responses.json",
    requireApprovalBeforeSubmit: true,
    prApprovedForSubmit: false,
  });
  expect(decision.shouldPublish).toBe(false);
  expect(decision.skipReason).toBe("approval_required");
});

test("executeCodeReviewPublish returns before gh when triage blocks", async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), "agentsd-cr-publish-"));
  try {
    const resultPath = join(dir, "result.json");
    await fsp.writeFile(resultPath, "{}", "utf8");
    const outcome = await executeCodeReviewPublish({
      publish: {
        ...publishOff,
        codeReview: { ...publishOff.codeReview, mode: "pending" },
      },
      result: {
        runId: "run-1",
        status: "passed",
        findings: [],
        artifacts: [],
        metadata: {},
      },
      resultPath,
      workspacePath: dir,
      triageItemCount: 2,
      prNumber: 1,
      repository: "org/repo",
    });
    expect(outcome.executed).toBe(false);
    expect(outcome.decision.skipReason).toBe("triage_items_nonzero");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("executePrFeedbackSubmit returns before gh when responses.json missing", async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), "agentsd-pf-publish-"));
  try {
    await fsp.mkdir(join(dir, "out"), { recursive: true });
    const feedbackPath = join(dir, "out", "feedback.json");
    await fsp.writeFile(feedbackPath, "{}", "utf8");
    const outcome = await executePrFeedbackSubmit({
      publish: {
        ...publishOff,
        prFeedback: {
          ...publishOff.prFeedback,
          mode: "submit",
          requireEmptyTriage: false,
        },
      },
      workspacePath: dir,
      feedbackPath,
      triageItemCount: 0,
      prApprovedForSubmit: true,
      requireApprovalBeforeSubmit: false,
    });
    expect(outcome.executed).toBe(false);
    expect(outcome.decision.skipReason).toBe("responses_document_missing");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

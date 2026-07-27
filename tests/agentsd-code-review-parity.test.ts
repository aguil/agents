import { expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCodeReviewPublishOverrides,
  parseCodeReviewSettings,
} from "@aguil/agents-code-review/workflow-settings";
import type { HarnessRunResult } from "@aguil/agents-core";
import {
  evaluateCodeReviewPublish,
  executeCodeReviewPublish,
} from "@aguil/agents-publish";
import { loadWorkflowFile } from "@aguil/agents-workflow";

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

/**
 * Pins the `publish_with_findings` fold end to end (ADR 0016 §5).
 *
 * The knob used to reach `publish.codeReview.requireEmptyTriage` inside the
 * workflow loader; it now travels from front matter through
 * `applyCodeReviewPublishOverrides` on the code-review path. Nothing about a
 * publish decision announces which knob set it, so the guard has to run the
 * real loader over real front matter rather than construct the publish config
 * by hand — a hand-built config would re-implement the fold instead of
 * checking it.
 */
async function publishDecisionFor(frontMatter: string) {
  const dir = await fsp.mkdtemp(join(tmpdir(), "cr-fold-"));
  try {
    const workflowPath = join(dir, "WORKFLOW.md");
    await fsp.writeFile(
      workflowPath,
      `---\npublish:\n  code_review:\n    mode: pending\n${frontMatter}---\nWork\n`,
      "utf8",
    );
    const loaded = await loadWorkflowFile(workflowPath);
    const definition = loaded.definition;
    if (definition === undefined) {
      throw new Error(loaded.error?.message ?? "missing definition");
    }
    const settings = parseCodeReviewSettings(definition.config);
    return {
      settings,
      decision: evaluateCodeReviewPublish({
        publish: applyCodeReviewPublishOverrides(definition.publish, settings),
        result: sampleResult,
        resultPath: "/tmp/result.json",
        triageItemCount: 2,
        isDryRunPath: false,
        prNumber: 42,
      }),
    };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test("publish_with_findings allows pending when triage has items", async () => {
  const { settings, decision } = await publishDecisionFor(
    "policy:\n  code_review:\n    publish_with_findings: true\n",
  );
  expect(settings.publishWithFindings).toBe(true);
  expect(decision.shouldPublish).toBe(true);
  expect(decision.mode).toBe("pending");
});

test("without publish_with_findings, a non-empty triage still blocks publish", async () => {
  const { settings, decision } = await publishDecisionFor("");
  expect(settings.publishWithFindings).toBe(false);
  expect(decision.shouldPublish).toBe(false);
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

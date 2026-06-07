import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolvePrFeedbackDisposition,
  verifyOneCommitForTriageItem,
} from "@aguil/agents-workers";
import {
  isPrApprovedForWork,
  isPrDeniedForWork,
  loadWorkflowFile,
  parsePrFeedbackPolicy,
  workflowReloadChangedFields,
} from "@aguil/agents-workflow";

test("parsePrFeedbackPolicy parses deny list", () => {
  const policy = parsePrFeedbackPolicy({
    policy: {
      pr_feedback: {
        deny: ["org/repo#99"],
      },
    },
  });
  expect(policy.deny).toEqual(["org/repo#99"]);
  expect(
    isPrDeniedForWork(policy, { repository: "org/repo", pull_number: "99" }),
  ).toBe(true);
  expect(
    isPrApprovedForWork(policy, new Set(["org/repo#99"]), {
      repository: "org/repo",
      pull_number: "99",
    }),
  ).toBe(false);
});

test("resolvePrFeedbackDisposition maps empty queue", () => {
  expect(
    resolvePrFeedbackDisposition({
      triageItemCount: 0,
      feedbackItemCount: 0,
      fixFailed: 0,
    }),
  ).toBe("empty_queue");
  expect(
    resolvePrFeedbackDisposition({
      triageItemCount: 2,
      feedbackItemCount: 1,
      fixFailed: 0,
    }),
  ).toBe("items_remaining");
  expect(
    resolvePrFeedbackDisposition({
      triageItemCount: 0,
      feedbackItemCount: 0,
      fixFailed: 1,
    }),
  ).toBe("fix_failures");
});

test("verifyOneCommitForTriageItem accepts reply-only with no new commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "git-verify-"));
  try {
    await mkdir(join(dir, ".git"), { recursive: true });
    const result = await verifyOneCommitForTriageItem({
      workspacePath: dir,
      baseHeadSha: null,
      triageItemId: "item-1",
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("not_git_repo");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workflowReloadChangedFields lists publish changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wf-reload-"));
  try {
    const workflowPath = join(dir, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
polling:
  interval_ms: 5000
workspace:
  root: ${join(dir, "ws")}
agent:
  max_concurrent_agents: 1
publish:
  code_review: off
  pr_feedback: off
---
Work
`,
      "utf8",
    );
    const loaded = await loadWorkflowFile(workflowPath);
    const base = loaded.definition;
    if (base === undefined) {
      throw new Error("missing definition");
    }
    const next = {
      ...base,
      pollingIntervalMs: 100,
      publish: {
        ...base.publish,
        codeReview: { ...base.publish.codeReview, mode: "notify" as const },
      },
    };
    const changed = workflowReloadChangedFields(base, next);
    expect(changed).toContain("polling.interval_ms");
    expect(changed).toContain("publish");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pr feedback work report schema is written under host workspace", async () => {
  const { writePrFeedbackWorkReport, PR_FEEDBACK_WORK_REPORT_SCHEMA_ID } =
    await import("@aguil/agents-workers");
  const dir = await mkdtemp(join(tmpdir(), "wf-report-"));
  try {
    const path = await writePrFeedbackWorkReport({
      hostWorkspacePath: dir,
      report: {
        schemaId: PR_FEEDBACK_WORK_REPORT_SCHEMA_ID,
        workItemId: "org/repo/pull/1/feedback",
        identifier: "org/repo#1-feedback",
        repository: "org/repo",
        pullNumber: 1,
        feedbackPath: "/tmp/feedback.json",
        triagePath: "/tmp/triage/triage-queue.json",
        feedbackItemCount: 0,
        triageItemCount: 0,
        disposition: "empty_queue",
        itemCommits: {},
        fixStats: {
          attempted: 0,
          succeeded: 0,
          failed: 0,
          commitVerified: 0,
        },
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { readonly disposition: string };
    expect(parsed.disposition).toBe("empty_queue");
    expect(path).toContain(".agentsd/pr-feedback-work-reports");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { join } from "node:path";
import { collectPrFeedback } from "@aguil/agents-pr-feedback";
import {
  executePrFeedbackSubmit,
  writePrFeedbackTriageQueue,
} from "@aguil/agents-publish";
import type { WorkItem } from "@aguil/agents-tracker";
import type { WorkflowDefinition } from "@aguil/agents-workflow";
import {
  isPrApprovedForWork,
  isPrDeniedForWork,
  readSelectionDocument,
} from "@aguil/agents-workflow";
import { runPrFeedbackFixes } from "./pr-feedback-fix";
import {
  logPrFeedbackWorkReport,
  PR_FEEDBACK_WORK_REPORT_SCHEMA_ID,
  type PrFeedbackItemCommitRecord,
  type PrFeedbackWorkReport,
  resolvePrFeedbackDisposition,
  writePrFeedbackWorkReport,
} from "./pr-feedback-work-report";

export async function runPrFeedbackWorker(input: {
  readonly item: WorkItem;
  readonly workspacePath: string;
  readonly hostWorkspacePath: string;
  readonly definition: WorkflowDefinition;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly status: "succeeded" | "failed";
  readonly error?: string;
  readonly closeWorkItem?: boolean;
}> {
  const repo = input.item.metadata.repository;
  const prRaw = input.item.metadata.pull_number;
  const prNumber =
    prRaw !== undefined ? Number.parseInt(prRaw, 10) : Number.NaN;
  if (repo === undefined || !Number.isFinite(prNumber)) {
    return {
      status: "failed",
      error: "missing repository or pull_number metadata",
    };
  }

  if (input.signal?.aborted) {
    return { status: "failed", error: "aborted" };
  }

  const policy = input.definition.prFeedbackPolicy;
  if (isPrDeniedForWork(policy, input.item.metadata)) {
    console.warn(
      JSON.stringify({
        event: "pr_feedback_fix_skipped_denied",
        work_item_id: input.item.id,
        identifier: input.item.identifier,
      }),
    );
    return { status: "succeeded" };
  }

  const selection = await readSelectionDocument(input.hostWorkspacePath);
  const approved = new Set(selection.approved);
  const prApprovedForSubmit = isPrApprovedForWork(
    policy,
    approved,
    input.item.metadata,
  );
  if (!prApprovedForSubmit) {
    console.warn(
      JSON.stringify({
        event: "pr_feedback_fix_skipped_not_approved",
        work_item_id: input.item.id,
        identifier: input.item.identifier,
      }),
    );
    return { status: "succeeded" };
  }

  let { outputDir, document } = await collectPrFeedback({
    workspacePath: input.hostWorkspacePath,
    repository: repo,
    pullNumber: prNumber,
    outputDir: join(input.workspacePath, ".agents-pr-feedback"),
  });

  const feedbackPath = join(outputDir, "feedback.json");
  let triageItemCount = document.items.length;
  let triageDir: string | undefined;
  try {
    const triage = await writePrFeedbackTriageQueue({
      workspacePath: input.hostWorkspacePath,
      feedbackPath,
      outputDir,
    });
    triageDir = triage.triageDir;
    triageItemCount = triage.itemCount;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      JSON.stringify({
        event: "pr_feedback_triage_failed",
        work_item_id: input.item.id,
        error: message,
      }),
    );
  }

  let fixStats: {
    attempted: number;
    succeeded: number;
    failed: number;
    commitVerified: number;
    itemCommits: Readonly<Record<string, PrFeedbackItemCommitRecord>>;
  } = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    commitVerified: 0,
    itemCommits: {},
  };
  if (triageDir !== undefined && triageItemCount > 0) {
    fixStats = await runPrFeedbackFixes({
      item: input.item,
      triageDir,
      hostWorkspacePath: input.hostWorkspacePath,
      scratchpadRoot: join(input.workspacePath, ".agents-pr-feedback-fixes"),
      definition: input.definition,
    });
    if (fixStats.attempted > 0) {
      try {
        const refreshed = await collectPrFeedback({
          workspacePath: input.hostWorkspacePath,
          repository: repo,
          pullNumber: prNumber,
          outputDir,
        });
        document = refreshed.document;
        const retriage = await writePrFeedbackTriageQueue({
          workspacePath: input.hostWorkspacePath,
          feedbackPath,
          outputDir,
        });
        triageDir = retriage.triageDir;
        triageItemCount = retriage.itemCount;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          JSON.stringify({
            event: "pr_feedback_retriage_failed",
            work_item_id: input.item.id,
            error: message,
          }),
        );
      }
    }
  }

  const responsesPath = join(outputDir, "responses.json");
  const submitResult = await executePrFeedbackSubmit({
    publish: input.definition.publish,
    workspacePath: input.hostWorkspacePath,
    feedbackPath,
    triageItemCount,
    responsesPath,
    requireApprovalBeforeSubmit: policy.requireApprovalBeforeSubmit,
    prApprovedForSubmit,
  });

  const disposition = resolvePrFeedbackDisposition({
    triageItemCount,
    feedbackItemCount: document.items.length,
    fixFailed: fixStats.failed,
    publishSkipReason: submitResult.decision.skipReason,
  });
  const triagePath =
    triageDir !== undefined ? join(triageDir, "triage-queue.json") : null;
  const report: PrFeedbackWorkReport = {
    schemaId: PR_FEEDBACK_WORK_REPORT_SCHEMA_ID,
    workItemId: input.item.id,
    identifier: input.item.identifier,
    repository: repo,
    pullNumber: prNumber,
    feedbackPath,
    triagePath,
    feedbackItemCount: document.items.length,
    triageItemCount,
    disposition,
    itemCommits: fixStats.itemCommits,
    fixStats: {
      attempted: fixStats.attempted,
      succeeded: fixStats.succeeded,
      failed: fixStats.failed,
      commitVerified: fixStats.commitVerified,
    },
    generatedAt: new Date().toISOString(),
  };
  const reportPath = await writePrFeedbackWorkReport({
    hostWorkspacePath: input.hostWorkspacePath,
    report,
  });
  logPrFeedbackWorkReport(report, reportPath);

  console.log(
    JSON.stringify({
      event: "pr_feedback_collected",
      work_item_id: input.item.id,
      identifier: input.item.identifier,
      output_dir: outputDir,
      feedback_path: feedbackPath,
      triage_dir: triageDir,
      item_count: document.items.length,
      triage_item_count: triageItemCount,
      fix_attempted: fixStats.attempted,
      fix_succeeded: fixStats.succeeded,
      fix_failed: fixStats.failed,
      commit_verified: fixStats.commitVerified,
      publish_executed: submitResult.executed,
      posted_count: submitResult.postedCount,
      publish_skipped_reason: submitResult.decision.skipReason,
      operator_hint: submitResult.decision.operatorHint,
      work_report_path: reportPath,
      disposition,
    }),
  );

  if (submitResult.error !== undefined) {
    return { status: "failed", error: submitResult.error };
  }
  const closeWorkItem =
    submitResult.decision.skipReason !== "approval_required" &&
    triageItemCount === 0 &&
    document.items.length === 0;
  return { status: "succeeded", closeWorkItem };
}

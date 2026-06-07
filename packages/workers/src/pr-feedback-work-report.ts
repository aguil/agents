import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const PR_FEEDBACK_WORK_REPORT_SCHEMA_ID = "pr-feedback-work-report/v1";

export type PrFeedbackDisposition =
  | "empty_queue"
  | "items_remaining"
  | "approval_required"
  | "submit_blocked"
  | "fix_failures";

export interface PrFeedbackItemCommitRecord {
  readonly sha: string | null;
  readonly verified: boolean;
  readonly replyOnly: boolean;
  readonly reason: string;
}

export interface PrFeedbackWorkReport {
  readonly schemaId: typeof PR_FEEDBACK_WORK_REPORT_SCHEMA_ID;
  readonly workItemId: string;
  readonly identifier: string;
  readonly repository: string;
  readonly pullNumber: number;
  readonly feedbackPath: string;
  readonly triagePath: string | null;
  readonly feedbackItemCount: number;
  readonly triageItemCount: number;
  readonly disposition: PrFeedbackDisposition;
  readonly itemCommits: Readonly<Record<string, PrFeedbackItemCommitRecord>>;
  readonly fixStats: {
    readonly attempted: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly commitVerified: number;
  };
  readonly generatedAt: string;
}

export function resolvePrFeedbackDisposition(input: {
  readonly triageItemCount: number;
  readonly feedbackItemCount: number;
  readonly fixFailed: number;
  readonly publishSkipReason?: string;
}): PrFeedbackDisposition {
  if (input.fixFailed > 0) {
    return "fix_failures";
  }
  if (input.publishSkipReason === "approval_required") {
    return "approval_required";
  }
  if (
    input.publishSkipReason !== undefined &&
    input.publishSkipReason !== "publish_mode_off"
  ) {
    return "submit_blocked";
  }
  if (input.triageItemCount === 0 && input.feedbackItemCount === 0) {
    return "empty_queue";
  }
  return "items_remaining";
}

export async function writePrFeedbackWorkReport(input: {
  readonly hostWorkspacePath: string;
  readonly report: PrFeedbackWorkReport;
}): Promise<string> {
  const path = join(
    input.hostWorkspacePath,
    ".agentsd",
    "pr-feedback-work-reports",
    `${input.report.workItemId.replace(/\//g, "_")}.json`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(input.report, null, 2)}\n`, "utf8");
  return path;
}

export function logPrFeedbackWorkReport(
  report: PrFeedbackWorkReport,
  reportPath: string,
): void {
  console.log(
    JSON.stringify({
      event: "pr_feedback_work_report",
      work_item_id: report.workItemId,
      identifier: report.identifier,
      report_path: reportPath,
      disposition: report.disposition,
      triage_item_count: report.triageItemCount,
      feedback_item_count: report.feedbackItemCount,
      fix_attempted: report.fixStats.attempted,
      fix_succeeded: report.fixStats.succeeded,
      fix_failed: report.fixStats.failed,
      commit_verified: report.fixStats.commitVerified,
    }),
  );
}

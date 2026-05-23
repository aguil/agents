import {
  type PendingReviewPostResult,
  replacePendingPullRequestReview,
} from "@aguil/agents-code-review-post";
import {
  fetchPullRequestHeadSha,
  viewerHasPendingPullRequestReview,
} from "./github-context";
import {
  type CodeReviewPublishInput,
  evaluateCodeReviewPublish,
  type PublishDecision,
} from "./index";
import { isCodeReviewDryRunResultPath } from "./triage-count";

export interface ExecuteCodeReviewPublishInput {
  readonly publish: CodeReviewPublishInput["publish"];
  readonly result: CodeReviewPublishInput["result"];
  readonly resultPath: string;
  readonly workspacePath: string;
  readonly triageItemCount: number;
  readonly prNumber: number;
  readonly repository: string;
  readonly reviewedHeadSha?: string;
}

export interface ExecuteCodeReviewPublishResult {
  readonly decision: PublishDecision;
  readonly executed: boolean;
  readonly postError?: string;
  readonly reviewUrl?: string;
}

export async function executeCodeReviewPublish(
  input: ExecuteCodeReviewPublishInput,
): Promise<ExecuteCodeReviewPublishResult> {
  const currentHeadSha = await fetchPullRequestHeadSha({
    workspacePath: input.workspacePath,
    repository: input.repository,
    pullNumber: input.prNumber,
  });
  const hasPendingReview = await viewerHasPendingPullRequestReview({
    workspacePath: input.workspacePath,
    repository: input.repository,
    pullNumber: input.prNumber,
  });

  const decision = evaluateCodeReviewPublish({
    publish: input.publish,
    result: input.result,
    resultPath: input.resultPath,
    triageItemCount: input.triageItemCount,
    isDryRunPath: isCodeReviewDryRunResultPath(
      input.workspacePath,
      input.resultPath,
    ),
    prNumber: input.prNumber,
    reviewedHeadSha: input.reviewedHeadSha,
    currentHeadSha,
    hasPendingReview,
  });

  if (!decision.shouldPublish || decision.mode !== "pending") {
    return { decision, executed: false };
  }

  const cfg = input.publish.codeReview;
  let posted: PendingReviewPostResult;
  try {
    posted = await replacePendingPullRequestReview({
      findings: input.result.findings,
      prNumber: input.prNumber,
      reviewSummaryStyle: cfg.reviewSummary,
      reviewedHeadSha: input.reviewedHeadSha,
      noConfirm: true,
      replacePendingReview: cfg.replacePending,
      workspacePath: input.workspacePath,
      runMetadata: input.result.metadata,
      runId: input.result.runId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { decision, executed: true, postError: message };
  }

  if (posted.cancelled === true) {
    return {
      decision,
      executed: true,
      postError: "pending review publish cancelled",
    };
  }

  return {
    decision,
    executed: true,
    reviewUrl: posted.url,
  };
}

import type { PublishCodeReviewConfig } from "@aguil/agents-workflow";
import { runAgentsCli } from "./agents-cli";
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
  readonly cliExitCode?: number;
  readonly cliStderr?: string;
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
  const cliArgs = buildCodeReviewPostArgs({
    resultPath: input.resultPath,
    prNumber: input.prNumber,
    cfg,
  });
  const cli = await runAgentsCli(cliArgs, input.workspacePath);
  const reviewUrl = extractReviewUrl(cli.stdout);
  return {
    decision,
    executed: true,
    cliExitCode: cli.exitCode,
    cliStderr: cli.stderr.trim().length > 0 ? cli.stderr : undefined,
    reviewUrl,
  };
}

function buildCodeReviewPostArgs(input: {
  readonly resultPath: string;
  readonly prNumber: number;
  readonly cfg: PublishCodeReviewConfig;
}): string[] {
  const args = [
    "code-review",
    "post",
    "--result",
    input.resultPath,
    "--post-pr",
    String(input.prNumber),
    "--no-confirm",
    "--review-summary",
    input.cfg.reviewSummary,
  ];
  if (input.cfg.replacePending) {
    args.push("--replace-pending-review");
  }
  return args;
}

function extractReviewUrl(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Review URL:")) {
      return trimmed.slice("Review URL:".length).trim();
    }
  }
  return undefined;
}

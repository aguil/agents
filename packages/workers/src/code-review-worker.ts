import { join } from "node:path";
import { runCodeReview } from "@aguil/agents-code-review";
import { agentsCodeReviewRunsRoot } from "@aguil/agents-core";
import type { AgentAdapter } from "@aguil/agents-execution";
import {
  countCodeReviewTriageItems,
  executeCodeReviewPublish,
} from "@aguil/agents-publish";
import type { WorkItem } from "@aguil/agents-tracker";
import type { WorkflowDefinition } from "@aguil/agents-workflow";
import { createDetachedPullRequestWorktree } from "./isolated-pr-worktree";

export async function runCodeReviewWorker(input: {
  readonly item: WorkItem;
  readonly workspacePath: string;
  readonly hostWorkspacePath: string;
  readonly adapter: AgentAdapter;
  readonly definition: WorkflowDefinition;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly status: "succeeded" | "failed";
  readonly error?: string;
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

  const scratchpadRoot = agentsCodeReviewRunsRoot(input.workspacePath);
  let reviewWorkspace = input.hostWorkspacePath;
  let cleanupWorktree: (() => Promise<void>) | undefined;
  if (input.definition.codeReviewPolicy.useWorktree) {
    try {
      const isolated = await createDetachedPullRequestWorktree({
        artifactAnchorWorkspacePath: input.hostWorkspacePath,
        pullNumber: prNumber,
      });
      reviewWorkspace = isolated.worktreePath;
      cleanupWorktree = isolated.cleanup;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        JSON.stringify({
          event: "code_review_worktree_failed",
          work_item_id: input.item.id,
          error: message,
        }),
      );
    }
  }

  const result = await runCodeReview({
    workspacePath: reviewWorkspace,
    scratchpadRoot,
    reviewPrNumber: prNumber,
    adapter: input.adapter,
    metadata: {
      ...input.item.metadata,
      agentsd_prompt: input.prompt.slice(0, 200),
      work_item_id: input.item.id,
    },
  });

  if (cleanupWorktree !== undefined) {
    await cleanupWorktree();
  }

  const resultPath = join(scratchpadRoot, result.runId, "result.json");
  let triageItemCount = 0;
  try {
    triageItemCount = await countCodeReviewTriageItems({
      workspacePath: input.hostWorkspacePath,
      resultPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      JSON.stringify({
        event: "code_review_triage_failed",
        work_item_id: input.item.id,
        error: message,
      }),
    );
  }

  const publishResult = await executeCodeReviewPublish({
    publish: input.definition.publish,
    result,
    resultPath,
    workspacePath: input.hostWorkspacePath,
    triageItemCount,
    prNumber,
    repository: repo,
    reviewedHeadSha: result.metadata?.pr_reviewed_head_sha,
  });

  logPublishOutcome(input.item, publishResult.decision, {
    triage_item_count: triageItemCount,
    publish_executed: publishResult.executed,
    review_url: publishResult.reviewUrl,
    publish_error: publishResult.postError,
  });

  if (result.status === "error") {
    return { status: "failed", error: "code review harness error" };
  }
  if (publishResult.executed && publishResult.postError !== undefined) {
    return {
      status: "failed",
      error: publishResult.postError,
    };
  }
  return { status: "succeeded" };
}

function logPublishOutcome(
  item: WorkItem,
  decision: {
    readonly shouldPublish: boolean;
    readonly mode: string;
    readonly skipReason?: string;
    readonly operatorHint?: string;
  },
  extra: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({
      event: "publish_decision",
      work_item_id: item.id,
      identifier: item.identifier,
      should_publish: decision.shouldPublish,
      mode: decision.mode,
      publish_skipped_reason: decision.skipReason,
      operator_hint: decision.operatorHint,
      ...extra,
    }),
  );
}

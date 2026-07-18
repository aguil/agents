import { join } from "node:path";
import { runCodeReview } from "@aguil/agents-code-review";
import { runCodeReviewFromConfig } from "@aguil/agents-code-review/config-runner";
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
      return {
        status: "failed",
        error: `isolated worktree required but failed: ${message}`,
      };
    }
  }

  // Same opt-in as the CLI (#73 Tier 5 stage 1): the worker has no argv,
  // so the environment carries the implementation selection. An invalid
  // value fails the item rather than silently running the default path —
  // the operator asked for a specific implementation and did not get it.
  const implEnv = process.env.AGENTS_CODE_REVIEW_IMPL?.trim();
  if (
    implEnv !== undefined &&
    implEnv !== "" &&
    implEnv !== "package" &&
    implEnv !== "config"
  ) {
    return {
      status: "failed",
      error: `invalid AGENTS_CODE_REVIEW_IMPL value "${implEnv}" (expected package or config)`,
    };
  }

  try {
    const runInputs = {
      workspacePath: reviewWorkspace,
      scratchpadRoot,
      reviewPrNumber: prNumber,
      adapter: input.adapter,
      metadata: {
        ...input.item.metadata,
        agentsd_prompt: input.prompt.slice(0, 200),
        work_item_id: input.item.id,
      },
    };
    const result =
      implEnv === "config"
        ? await runCodeReviewFromConfig(runInputs)
        : await runCodeReview(runInputs);

    const resultPath = join(scratchpadRoot, result.runId, "result.json");
    const reportPath = join(scratchpadRoot, result.runId, "report.md");
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
      findings_count: result.findings.length,
      publish_executed: publishResult.executed,
      review_url: publishResult.reviewUrl,
      publish_error: publishResult.postError,
      result_path: resultPath,
      report_path: reportPath,
    });

    if (input.definition.publish.codeReview.mode === "notify") {
      console.log(
        JSON.stringify({
          event: "code_review_artifacts_ready",
          work_item_id: input.item.id,
          identifier: input.item.identifier,
          result_path: resultPath,
          report_path: reportPath,
          findings_count: result.findings.length,
          triage_item_count: triageItemCount,
          operator_hint: publishResult.decision.operatorHint,
        }),
      );
    }

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
  } finally {
    if (cleanupWorktree !== undefined) {
      try {
        await cleanupWorktree();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          JSON.stringify({
            event: "code_review_worktree_cleanup_failed",
            work_item_id: input.item.id,
            error: message,
          }),
        );
      }
    }
  }
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

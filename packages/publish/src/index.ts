import type { HarnessRunResult } from "@aguil/agents-core";
import {
  isAgentsdPublishDisabled,
  type WorkflowPublishConfig,
} from "@aguil/agents-workflow";

export type PublishSkipReason =
  | "publish_disabled_env"
  | "publish_mode_off"
  | "status_error"
  | "status_failed"
  | "triage_items_nonzero"
  | "dry_run_artifact"
  | "pr_unresolved"
  | "stale_head"
  | "pending_review_exists"
  | "responses_document_missing"
  | "submit_not_implemented";

export interface CodeReviewPublishInput {
  readonly publish: WorkflowPublishConfig;
  readonly result: HarnessRunResult;
  readonly resultPath: string;
  readonly triageItemCount: number;
  readonly isDryRunPath: boolean;
  readonly prNumber?: number;
  readonly reviewedHeadSha?: string;
  readonly currentHeadSha?: string;
  readonly hasPendingReview?: boolean;
}

export interface PublishDecision {
  readonly shouldPublish: boolean;
  readonly mode: "off" | "notify" | "pending" | "submit";
  readonly skipReason?: PublishSkipReason;
  readonly operatorHint?: string;
}

export function evaluateCodeReviewPublish(
  input: CodeReviewPublishInput,
  env: NodeJS.ProcessEnv = process.env,
): PublishDecision {
  if (isAgentsdPublishDisabled(env)) {
    return off("publish_disabled_env", input.resultPath, "code-review post");
  }
  const cfg = input.publish.codeReview;
  if (cfg.mode === "off") {
    return off("publish_mode_off", input.resultPath, "code-review post");
  }
  if (cfg.mode === "notify") {
    return {
      shouldPublish: false,
      mode: "notify",
      operatorHint: notifyHint(input.resultPath, "agents code-review post"),
    };
  }
  if (input.isDryRunPath) {
    return off("dry_run_artifact", input.resultPath, "code-review post");
  }
  if (input.result.status === "error" || input.result.status === "failed") {
    return off(
      input.result.status === "error" ? "status_error" : "status_failed",
      input.resultPath,
      "code-review post",
    );
  }
  if (cfg.requireEmptyTriage && input.triageItemCount > 0) {
    return off("triage_items_nonzero", input.resultPath, "code-review post");
  }
  if (input.prNumber === undefined) {
    return off(
      "pr_unresolved",
      input.resultPath,
      "code-review post --post-pr <n>",
    );
  }
  if (
    cfg.staleHead === "skip" &&
    input.reviewedHeadSha !== undefined &&
    input.currentHeadSha !== undefined &&
    input.reviewedHeadSha !== input.currentHeadSha
  ) {
    return off("stale_head", input.resultPath, "code-review post");
  }
  if (input.hasPendingReview === true && !cfg.replacePending) {
    return off(
      "pending_review_exists",
      input.resultPath,
      "code-review post --replace-pending-review",
    );
  }
  return { shouldPublish: true, mode: "pending" };
}

export interface PrFeedbackPublishInput {
  readonly publish: WorkflowPublishConfig;
  readonly triageItemCount: number;
  readonly responsesPath?: string;
}

export function evaluatePrFeedbackPublish(
  input: PrFeedbackPublishInput,
  env: NodeJS.ProcessEnv = process.env,
): PublishDecision {
  if (isAgentsdPublishDisabled(env)) {
    return off("publish_disabled_env", undefined, "pr-feedback submit");
  }
  const cfg = input.publish.prFeedback;
  if (cfg.mode === "off" || cfg.mode === "notify") {
    return {
      shouldPublish: false,
      mode: cfg.mode,
      skipReason: cfg.mode === "off" ? "publish_mode_off" : undefined,
      operatorHint:
        cfg.mode === "notify"
          ? "artifacts ready for manual submit"
          : notifyHint(undefined, "agents pr-feedback submit"),
    };
  }
  if (cfg.requireEmptyTriage && input.triageItemCount > 0) {
    return off("triage_items_nonzero", undefined, "pr-feedback submit");
  }
  if (cfg.requireResponsesDocument && input.responsesPath === undefined) {
    return off(
      "responses_document_missing",
      undefined,
      "pr-feedback submit --draft …",
    );
  }
  return { shouldPublish: true, mode: "submit" };
}

function off(
  reason: PublishSkipReason,
  resultPath: string | undefined,
  command: string,
): PublishDecision {
  return {
    shouldPublish: false,
    mode: "off",
    skipReason: reason,
    operatorHint: notifyHint(resultPath, command),
  };
}

function notifyHint(resultPath: string | undefined, command: string): string {
  if (resultPath !== undefined) {
    return `artifacts at ${resultPath}; run: ${command}`;
  }
  return `run: ${command}`;
}

export { resolveAgentsCliArgv, runAgentsCli } from "./agents-cli";
export {
  type ExecuteCodeReviewPublishInput,
  type ExecuteCodeReviewPublishResult,
  executeCodeReviewPublish,
} from "./execute-code-review";
export {
  type ExecutePrFeedbackSubmitInput,
  type ExecutePrFeedbackSubmitResult,
  executePrFeedbackSubmit,
} from "./execute-pr-feedback";
export {
  fetchPullRequestHeadSha,
  viewerHasPendingPullRequestReview,
} from "./github-context";
export {
  buildSelectCommand,
  createSelectionNotifyChannels,
  dispatchSelectionNotifications,
  type SelectionNotificationPayload,
  type SelectionNotifyChannel,
} from "./selection-notify";
export {
  countCodeReviewTriageItems,
  countPrFeedbackTriageItems,
  isCodeReviewDryRunResultPath,
  writePrFeedbackTriageQueue,
} from "./triage-count";

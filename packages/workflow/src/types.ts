import type { CodeReviewPolicyConfig } from "./code-review-policy";
import type { PrFeedbackPolicyConfig } from "./pr-feedback-policy";

export type WorkflowLoadErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map";

export type PublishCodeReviewMode = "off" | "notify" | "pending";
export type PublishPrFeedbackMode = "off" | "notify" | "submit";
export type StaleHeadPolicy = "skip" | "post";

export interface WorkflowFeedConfig {
  readonly kind: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface PublishCodeReviewConfig {
  readonly mode: PublishCodeReviewMode;
  readonly reviewSummary: "triage" | "impact" | "evidence";
  readonly staleHead: StaleHeadPolicy;
  readonly replacePending: boolean;
  readonly requireEmptyTriage: boolean;
}

export interface PublishPrFeedbackConfig {
  readonly mode: PublishPrFeedbackMode;
  readonly requireEmptyTriage: boolean;
  readonly requireResponsesDocument: boolean;
}

export interface WorkflowPublishConfig {
  readonly codeReview: PublishCodeReviewConfig;
  readonly prFeedback: PublishPrFeedbackConfig;
}

export type AgentRuntimeMode = "subprocess" | "app_server";

export type ImplementationSubprocessAdapter =
  | "fake"
  | "opencode"
  | "claude"
  | "cursor";

export interface ImplementationExecutionConfig {
  readonly mode: AgentRuntimeMode;
  readonly adapter: ImplementationSubprocessAdapter;
  readonly command: string | null;
  readonly protocol: string | null;
  readonly turnTimeoutMs: number | null;
  readonly stallTimeoutMs: number;
}

export interface WorkflowDefinition {
  readonly config: Readonly<Record<string, unknown>>;
  readonly promptTemplate: string;
  readonly workflowPath: string;
  readonly workflowDir: string;
  readonly feeds: readonly WorkflowFeedConfig[];
  readonly workers: Readonly<Record<string, string>>;
  readonly publish: WorkflowPublishConfig;
  readonly prFeedbackPolicy: PrFeedbackPolicyConfig;
  readonly codeReviewPolicy: CodeReviewPolicyConfig;
  readonly perFeedMaxConcurrent: Readonly<Record<string, number>>;
  readonly pollingIntervalMs: number;
  readonly workspaceRoot: string;
  readonly maxConcurrentAgents: number;
  readonly maxTurns: number;
  readonly maxRetryBackoffMs: number;
  readonly hookTimeoutMs: number;
  readonly implementation: ImplementationExecutionConfig;
}

export interface WorkflowDefinitionResult {
  readonly definition?: WorkflowDefinition;
  readonly error?: {
    readonly code: WorkflowLoadErrorCode;
    readonly message: string;
  };
}

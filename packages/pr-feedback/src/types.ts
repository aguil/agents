import type { FindingSeverity } from "@aguil/agents-core";

export const AGENTS_PR_FEEDBACK_DIR = ".agents-pr-feedback" as const;

export const PR_FEEDBACK_SCHEMA_ID =
  "https://aguil.dev/schemas/agents/pr-feedback/v1" as const;

export const PR_FEEDBACK_RESPONSES_SCHEMA_ID =
  "https://aguil.dev/schemas/agents/pr-feedback-responses/v1" as const;

export interface PrFeedbackItemAnchor {
  readonly path: string;
  readonly line?: number;
}

export interface PrFeedbackItemV1 {
  readonly id: string;
  readonly kind: "pr_review_thread";
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly detail: string;
  readonly anchors: readonly PrFeedbackItemAnchor[];
  readonly source: Readonly<{
    readonly producer: "pr-feedback";
    readonly threadId: string;
    readonly authorLogin: string;
  }>;
}

export interface PrFeedbackDocumentV1 {
  readonly schemaId: typeof PR_FEEDBACK_SCHEMA_ID;
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly repository: string;
  readonly pullNumber: number;
  readonly items: readonly PrFeedbackItemV1[];
}

export interface PrFeedbackReplyV1 {
  readonly itemId: string;
  readonly body: string;
}

export interface PrFeedbackResponsesDocumentV1 {
  readonly schemaId: typeof PR_FEEDBACK_RESPONSES_SCHEMA_ID;
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly pullNumber: number;
  readonly replies: readonly PrFeedbackReplyV1[];
}

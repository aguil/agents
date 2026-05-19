/** PRs (or equivalent) where the operator has been asked to review. */
export type ReviewAssignmentKind = "direct" | "team";

export interface ReviewAssignment {
  readonly id: string;
  readonly url: string;
  readonly repository: string;
  readonly pullNumber: number;
  readonly title: string;
  readonly authorLogin: string;
  readonly updatedAt: string;
  readonly assignmentKind: ReviewAssignmentKind;
  /** Present when `assignmentKind` is `team`. */
  readonly teamSlug?: string;
}

export type ReviewSubmitEvent = "comment" | "approve" | "request_changes";

/** Normalized draft consumed by `submit` (typically read from disk). */
export interface ReviewDraftV1 {
  readonly schemaId: typeof CODE_REVIEW_INBOX_DRAFT_SCHEMA_ID;
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly pullNumber: number;
  readonly event: ReviewSubmitEvent;
  readonly body: string;
}

export const CODE_REVIEW_INBOX_DRAFT_SCHEMA_ID =
  "https://aguil.dev/schemas/agents/code-review-inbox-draft/v1" as const;

export interface ReviewInboxListOptions {
  readonly workspacePath: string;
  /** When true, merge team-requested PRs (GitHub: `team-review-requested:`). */
  readonly includeTeam: boolean;
}

export interface ReviewInboxSource {
  listAssignments(
    options: ReviewInboxListOptions,
  ): Promise<readonly ReviewAssignment[]>;
  submitReview(input: {
    readonly workspacePath: string;
    readonly draft: ReviewDraftV1;
  }): Promise<{ readonly reviewUrl: string }>;
}

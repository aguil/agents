export interface CodeReviewPolicyConfig {
  readonly useWorktree: boolean;
  readonly publishWithFindings: boolean;
}

export function parseCodeReviewPolicy(
  config: Readonly<Record<string, unknown>>,
): CodeReviewPolicyConfig {
  const policy = asRecord(config.policy);
  const codeReview = asRecord(policy.code_review);
  return {
    useWorktree: codeReview.use_worktree === true,
    publishWithFindings: codeReview.publish_with_findings === true,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

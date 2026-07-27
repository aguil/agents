/**
 * Code-review behavioral configuration, read from `WORKFLOW.md` front matter
 * under `policy.code_review`.
 *
 * The front-matter key keeps the word "policy" for compatibility, but these
 * types deliberately do not: "policy" is reserved for capability governance —
 * `PolicySpec`, `.agents/policies/`, allow and deny lists evaluated against
 * tool calls. What lives here is how the code-review harness behaves, with no
 * evaluator and no verdicts (ADR 0016 §6).
 */

export interface CodeReviewSettings {
  /** Review the pull request in a detached worktree rather than in place. */
  readonly useWorktree: boolean;
  /**
   * Publish a review even when triage still has items (#39). Consumed as an
   * override of `publish.code_review.require_empty_triage`; see
   * {@link applyCodeReviewPublishOverrides}.
   */
  readonly publishWithFindings: boolean;
}

/**
 * Parse from raw `WORKFLOW.md` front matter. Total: an absent or malformed
 * block yields both flags off rather than failing, so this never throws.
 */
export function parseCodeReviewSettings(
  config: Readonly<Record<string, unknown>>,
): CodeReviewSettings {
  const policy = asRecord(config.policy);
  const codeReview = asRecord(policy.code_review);
  return {
    useWorktree: codeReview.use_worktree === true,
    publishWithFindings: codeReview.publish_with_findings === true,
  };
}

/**
 * Apply the one code-review setting that reaches outside its own harness.
 *
 * `publish_with_findings` is an operator opt-in to posting a review when
 * triage still has items, which it expresses by clearing
 * `publish.code_review.require_empty_triage`. That inversion used to happen in
 * the workflow loader, which meant a generic package knew a code-review key;
 * it now happens here, on the code-review path, immediately before the publish
 * config is handed over.
 *
 * The parameter is structurally typed rather than imported from
 * `@aguil/agents-workflow` so that the code-review harness keeps no dependency
 * on the daemon's workflow package.
 */
export function applyCodeReviewPublishOverrides<
  T extends { readonly codeReview: { readonly requireEmptyTriage: boolean } },
>(publish: T, settings: CodeReviewSettings): T {
  if (!settings.publishWithFindings) {
    return publish;
  }
  return {
    ...publish,
    codeReview: { ...publish.codeReview, requireEmptyTriage: false },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

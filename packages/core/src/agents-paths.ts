import { join } from "node:path";

/** Workspace-relative root for `agents code-review` artifacts (runs, dry-run, config, pr-cache). */
export const AGENTS_CODE_REVIEW_DIR = ".agents-code-review" as const;

/**
 * Legacy workspace root before `.agents-code-review/`.
 * Used only for backward-compatible discovery and harness-path classification.
 */
export const LEGACY_AGENTS_CODE_REVIEW_DIR = ".review-agent" as const;

export function agentsCodeReviewRunsRoot(workspacePath: string): string {
  return join(workspacePath, AGENTS_CODE_REVIEW_DIR, "runs");
}

export function agentsCodeReviewDryRunRoot(workspacePath: string): string {
  return join(workspacePath, AGENTS_CODE_REVIEW_DIR, "dry-run");
}

export function legacyAgentsCodeReviewRunsRoot(workspacePath: string): string {
  return join(workspacePath, LEGACY_AGENTS_CODE_REVIEW_DIR, "runs");
}

export function legacyAgentsCodeReviewDryRunRoot(
  workspacePath: string,
): string {
  return join(workspacePath, LEGACY_AGENTS_CODE_REVIEW_DIR, "dry-run");
}

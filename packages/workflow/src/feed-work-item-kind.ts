/** Maps WORKFLOW.md feed `kind` to work-item `kind` emitted by that feed. */
const FEED_TO_WORK_ITEM_KIND: Readonly<Record<string, string>> = {
  github_issues: "github_issue",
  github_pr_review: "github_pr_review",
  github_pr_feedback: "github_pr_feedback",
  mcp: "mcp_tracker",
};

export function workItemKindForFeedKind(feedKind: string): string {
  return FEED_TO_WORK_ITEM_KIND[feedKind] ?? feedKind;
}

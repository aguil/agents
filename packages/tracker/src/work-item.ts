export type WorkItemKind =
  | "github_issue"
  | "github_pr_review"
  | "github_pr_feedback"
  | "mcp_tracker";

export interface BlockerRef {
  readonly id: string | null;
  readonly identifier: string | null;
  readonly state: string | null;
}

export interface WorkItem {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: string;
  readonly kind: WorkItemKind;
  readonly priority: number | null;
  readonly url: string | null;
  readonly labels: readonly string[];
  readonly blockedBy: readonly BlockerRef[];
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly branchName: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export function workItemTemplateVars(
  item: WorkItem,
  attempt: number | null,
): Readonly<Record<string, unknown>> {
  return {
    issue: {
      id: item.id,
      identifier: item.identifier,
      title: item.title,
      description: item.description,
      state: item.state,
      priority: item.priority,
      url: item.url,
      labels: item.labels,
      blocked_by: item.blockedBy,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
      branch_name: item.branchName,
      kind: item.kind,
      metadata: item.metadata,
    },
    work_item: {
      id: item.id,
      identifier: item.identifier,
      title: item.title,
      kind: item.kind,
      metadata: item.metadata,
    },
    attempt,
  };
}

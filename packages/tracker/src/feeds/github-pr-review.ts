import { GitHubReviewInboxSource } from "@aguil/agents-code-review-inbox";
import type { WorkFeedClient, WorkFeedTerminalContext } from "../feed-client";
import type { WorkItem } from "../work-item";

export interface GitHubPrReviewFeedOptions {
  readonly workspacePath: string;
  readonly includeTeam?: boolean;
  readonly maxOpen?: number;
}

export class GitHubPrReviewFeed implements WorkFeedClient {
  readonly feedKind = "github_pr_review";
  private readonly inbox = new GitHubReviewInboxSource();

  constructor(private readonly options: GitHubPrReviewFeedOptions) {}

  async fetchCandidates(): Promise<readonly WorkItem[]> {
    const assignments = await this.inbox.listAssignments({
      workspacePath: this.options.workspacePath,
      includeTeam: this.options.includeTeam === true,
    });
    const limit = this.options.maxOpen ?? 100;
    return assignments.slice(0, limit).map((a) => ({
      id: `${a.repository}/pull/${a.pullNumber}/review-request`,
      identifier: `${a.repository}#${a.pullNumber}-review`,
      title: a.title,
      description: null,
      state: "review_requested",
      kind: "github_pr_review" as const,
      priority: 2,
      url: a.url,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: a.updatedAt,
      branchName: null,
      metadata: {
        repository: a.repository,
        pull_number: String(a.pullNumber),
        author_login: a.authorLogin,
        assignment_kind: a.assignmentKind,
        ...(a.teamSlug !== undefined ? { team_slug: a.teamSlug } : {}),
      },
    }));
  }

  async fetchStates(ids: readonly string[]): Promise<readonly WorkItem[]> {
    const all = await this.fetchCandidates();
    const wanted = new Set(ids);
    return all.filter((item) => wanted.has(item.id));
  }

  async fetchTerminal(
    _context?: WorkFeedTerminalContext,
  ): Promise<readonly WorkItem[]> {
    return [];
  }
}

import { GitHubReviewInboxSource } from "@aguil/agents-code-review-inbox";
import { collectUnresolvedReviewThreads } from "@aguil/agents-pr-feedback";
import type { WorkFeedClient } from "../feed-client";
import type { WorkItem } from "../work-item";

export interface GitHubPrFeedbackFeedOptions {
  readonly workspacePath: string;
  readonly repository?: string;
}

export class GitHubPrFeedbackFeed implements WorkFeedClient {
  readonly feedKind = "github_pr_feedback";
  private readonly inbox = new GitHubReviewInboxSource();

  constructor(private readonly options: GitHubPrFeedbackFeedOptions) {}

  async fetchCandidates(): Promise<readonly WorkItem[]> {
    const workspacePath = this.options.workspacePath;
    const pulls = await this.inbox.listAuthoredOpen({ workspacePath });
    const items: WorkItem[] = [];

    for (const pull of pulls) {
      if (
        this.options.repository !== undefined &&
        pull.repository !== this.options.repository
      ) {
        continue;
      }
      const threads = await collectUnresolvedReviewThreads({
        workspacePath,
        repository: pull.repository,
        pullNumber: pull.pullNumber,
      });
      if (threads.length === 0) {
        continue;
      }
      items.push({
        id: `${pull.repository}/pull/${pull.pullNumber}/feedback`,
        identifier: `${pull.repository}#${pull.pullNumber}-feedback`,
        title: pull.title,
        description: `${threads.length} unresolved review thread(s)`,
        state: "feedback_pending",
        kind: "github_pr_feedback",
        priority: 2,
        url: pull.url,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: pull.updatedAt,
        branchName: null,
        metadata: {
          repository: pull.repository,
          pull_number: String(pull.pullNumber),
          unresolved_thread_count: String(threads.length),
        },
      });
    }
    return items;
  }

  async fetchStates(ids: readonly string[]): Promise<readonly WorkItem[]> {
    const all = await this.fetchCandidates();
    const wanted = new Set(ids);
    return all.filter((item) => wanted.has(item.id));
  }

  async fetchTerminal(): Promise<readonly WorkItem[]> {
    return [];
  }
}

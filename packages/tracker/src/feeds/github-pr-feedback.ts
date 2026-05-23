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
    const scoped =
      this.options.repository === undefined
        ? pulls
        : pulls.filter((pull) => pull.repository === this.options.repository);

    const withThreads = await Promise.all(
      scoped.map(async (pull) => ({
        pull,
        threads: await collectUnresolvedReviewThreads({
          workspacePath,
          repository: pull.repository,
          pullNumber: pull.pullNumber,
        }),
      })),
    );

    const items: WorkItem[] = [];
    for (const { pull, threads } of withThreads) {
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
    if (ids.length === 0) {
      return [];
    }
    const workspacePath = this.options.workspacePath;
    const items: WorkItem[] = [];
    for (const id of ids) {
      const parsed = parsePrFeedbackWorkItemId(id);
      if (parsed === null) {
        continue;
      }
      if (
        this.options.repository !== undefined &&
        parsed.repository !== this.options.repository
      ) {
        continue;
      }
      const threads = await collectUnresolvedReviewThreads({
        workspacePath,
        repository: parsed.repository,
        pullNumber: parsed.pullNumber,
      });
      if (threads.length === 0) {
        continue;
      }
      items.push({
        id,
        identifier: `${parsed.repository}#${parsed.pullNumber}-feedback`,
        title: `${parsed.repository}#${parsed.pullNumber}`,
        description: `${threads.length} unresolved review thread(s)`,
        state: "feedback_pending",
        kind: "github_pr_feedback",
        priority: 2,
        url: `https://github.com/${parsed.repository}/pull/${parsed.pullNumber}`,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
        branchName: null,
        metadata: {
          repository: parsed.repository,
          pull_number: String(parsed.pullNumber),
          unresolved_thread_count: String(threads.length),
        },
      });
    }
    return items;
  }

  async fetchTerminal(): Promise<readonly WorkItem[]> {
    return [];
  }
}

function parsePrFeedbackWorkItemId(
  id: string,
): { readonly repository: string; readonly pullNumber: number } | null {
  const match = /^(.+)\/pull\/(\d+)\/feedback$/.exec(id);
  if (match === null) {
    return null;
  }
  const pullNumber = Number(match[2]);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    return null;
  }
  return { repository: match[1], pullNumber };
}

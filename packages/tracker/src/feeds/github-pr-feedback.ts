import { GitHubReviewInboxSource } from "@aguil/agents-code-review-inbox";
import { collectUnresolvedReviewThreads } from "@aguil/agents-pr-feedback";
import type { WorkFeedClient } from "../feed-client";
import type { WorkItem } from "../work-item";

export interface GitHubPrFeedbackFeedOptions {
  readonly workspacePath: string;
  readonly repository?: string;
  /** Cap authored open PRs scanned per poll (default 20). */
  readonly maxOpen?: number;
  /** Max concurrent `collectUnresolvedReviewThreads` calls (default 3). */
  readonly threadConcurrency?: number;
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
    const limit = this.options.maxOpen ?? 20;
    const limited = scoped.slice(0, limit);
    const concurrency = Math.max(
      1,
      Math.min(this.options.threadConcurrency ?? 3, limited.length),
    );

    const withThreads = await mapWithConcurrency(
      limited,
      concurrency,
      async (pull) => ({
        pull,
        threads: await collectUnresolvedReviewThreads({
          workspacePath,
          repository: pull.repository,
          pullNumber: pull.pullNumber,
        }),
      }),
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
    const scoped = ids
      .map((id) => ({ id, parsed: parsePrFeedbackWorkItemId(id) }))
      .filter(
        (
          row,
        ): row is {
          readonly id: string;
          readonly parsed: {
            readonly repository: string;
            readonly pullNumber: number;
          };
        } => {
          if (row.parsed === null) {
            return false;
          }
          if (
            this.options.repository !== undefined &&
            row.parsed.repository !== this.options.repository
          ) {
            return false;
          }
          return true;
        },
      );
    const concurrency = Math.max(
      1,
      Math.min(this.options.threadConcurrency ?? 3, scoped.length),
    );
    const withThreads = await mapWithConcurrency(
      scoped,
      concurrency,
      async ({ id, parsed }) => ({
        id,
        parsed,
        threads: await collectUnresolvedReviewThreads({
          workspacePath,
          repository: parsed.repository,
          pullNumber: parsed.pullNumber,
        }),
      }),
    );
    const items: WorkItem[] = [];
    for (const { id, parsed, threads } of withThreads) {
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

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
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

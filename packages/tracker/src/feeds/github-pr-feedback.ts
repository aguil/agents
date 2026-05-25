import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GitHubReviewInboxSource } from "@aguil/agents-code-review-inbox";
import { collectUnresolvedReviewThreads } from "@aguil/agents-pr-feedback";
import { readSelectionDocument } from "@aguil/agents-workflow";
import {
  WORK_ITEM_MARKER_FILENAME,
  type WorkItemMarker,
} from "@aguil/agents-workspace";
import type { WorkFeedClient, WorkFeedTerminalContext } from "../feed-client";
import type { WorkItem } from "../work-item";
import {
  ingestReasonForPull,
  prFeedbackOfferAfterIngest,
  readIngestDocument,
  threadActivityFingerprint,
  writeIngestDocument,
} from "./pr-feedback-ingest-state";

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

    const ingestDoc = await readIngestDocument(workspacePath);
    const selection = await readSelectionDocument(workspacePath);
    const pendingPrIds = new Set(
      selection.pending.map((entry) => entry.identifier),
    );
    const approvedPrIds = new Set(selection.approved);
    const nextPulls = { ...ingestDoc.pulls };
    const items: WorkItem[] = [];
    const now = new Date().toISOString();
    for (const { pull, threads } of withThreads) {
      const prId = `${pull.repository}#${pull.pullNumber}`;
      const identifier = `${prId}-feedback`;
      const fingerprint = threadActivityFingerprint(threads);
      const { enqueue, reason } = ingestReasonForPull({
        identifier,
        fingerprint,
        threadCount: threads.length,
        prior: ingestDoc,
      });
      const { offer, reason: offerReason } = prFeedbackOfferAfterIngest({
        ingest: { enqueue, reason },
        threadCount: threads.length,
        prId,
        pendingPrIds,
        approvedPrIds,
      });
      nextPulls[identifier] = {
        threadFingerprint: fingerprint,
        threadCount: threads.length,
        updatedAt: now,
      };
      if (!offer) {
        continue;
      }
      items.push({
        id: `${pull.repository}/pull/${pull.pullNumber}/feedback`,
        identifier,
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
          ingest_reason: offerReason,
        },
      });
    }
    await writeIngestDocument(workspacePath, {
      schemaId: ingestDoc.schemaId,
      pulls: nextPulls,
    });
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

  async fetchTerminal(
    context?: WorkFeedTerminalContext,
  ): Promise<readonly WorkItem[]> {
    const workspacePath = this.options.workspacePath;
    const workspaceRoot = context?.workspaceRoot;
    if (workspaceRoot === undefined) {
      return [];
    }

    const maxProbes = context?.maxTerminalProbes;
    const fromMarkers = await listPrFeedbackPullsFromWorkspaces(
      workspaceRoot,
      maxProbes,
    );
    const scoped =
      this.options.repository === undefined
        ? fromMarkers
        : fromMarkers.filter(
            (pull) => pull.repository === this.options.repository,
          );
    if (scoped.length === 0) {
      return [];
    }

    const toProbe = scoped;

    const concurrency = Math.max(
      1,
      Math.min(this.options.threadConcurrency ?? 3, toProbe.length),
    );
    const withThreads = await mapWithConcurrency(
      toProbe,
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
    const terminal: WorkItem[] = [];
    for (const { pull, threads } of withThreads) {
      if (threads.length > 0) {
        continue;
      }
      terminal.push({
        id: `${pull.repository}/pull/${pull.pullNumber}/feedback`,
        identifier: `${pull.repository}#${pull.pullNumber}-feedback`,
        title: pull.identifier,
        description: "no unresolved review threads",
        state: "feedback_done",
        kind: "github_pr_feedback",
        priority: 2,
        url: `https://github.com/${pull.repository}/pull/${pull.pullNumber}`,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
        branchName: null,
        metadata: {
          repository: pull.repository,
          pull_number: String(pull.pullNumber),
          unresolved_thread_count: "0",
        },
      });
    }
    return terminal;
  }
}

async function listPrFeedbackPullsFromWorkspaces(
  workspaceRoot: string,
  maxPulls?: number,
): Promise<
  readonly {
    readonly repository: string;
    readonly pullNumber: number;
    readonly identifier: string;
  }[]
> {
  const root = resolve(workspaceRoot);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const pulls: {
    readonly repository: string;
    readonly pullNumber: number;
    readonly identifier: string;
  }[] = [];
  let probes = 0;
  for (const entry of entries) {
    if (maxPulls !== undefined && probes >= maxPulls) {
      break;
    }
    probes += 1;
    const path = resolve(root, entry);
    if (path !== root && !path.startsWith(`${root}/`)) {
      continue;
    }
    let marker: WorkItemMarker;
    try {
      const raw = await readFile(join(path, WORK_ITEM_MARKER_FILENAME), "utf8");
      marker = JSON.parse(raw) as WorkItemMarker;
    } catch {
      continue;
    }
    if (marker.kind !== "github_pr_feedback") {
      continue;
    }
    const parsed = parsePrFeedbackIdentifier(marker.identifier);
    if (parsed === null) {
      continue;
    }
    pulls.push({ ...parsed, identifier: marker.identifier });
  }
  return pulls;
}

export function parsePrFeedbackIdentifier(
  identifier: string,
): { readonly repository: string; readonly pullNumber: number } | null {
  const match = /^(.+)#(\d+)-feedback$/.exec(identifier);
  if (match === null) {
    return null;
  }
  const pullNumber = Number(match[2]);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    return null;
  }
  return { repository: match[1], pullNumber };
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

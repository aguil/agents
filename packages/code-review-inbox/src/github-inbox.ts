import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGhJson, runGhText } from "./gh-runner";
import {
  type AuthoredPull,
  CODE_REVIEW_INBOX_DRAFT_SCHEMA_ID,
  type ReviewAssignment,
  type ReviewAssignmentKind,
  type ReviewDraftV1,
  type ReviewInboxListMineOptions,
  type ReviewInboxListOptions,
  type ReviewInboxSource,
  type ReviewSubmitEvent,
} from "./types";

interface GhSearchPrRow {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly repository: { readonly nameWithOwner: string };
  readonly author?: { readonly login?: string };
  readonly updatedAt?: string;
}

interface GhTeamRow {
  readonly organization: { readonly login: string };
  readonly slug: string;
}

function assignmentId(
  repo: string,
  num: number,
  kind: ReviewAssignmentKind,
  team?: string,
): string {
  const t = team !== undefined && team.length > 0 ? `-${team}` : "";
  return `${repo}#${num}-${kind}${t}`;
}

async function searchReviewRequested(
  workspacePath: string,
  query: string,
  kind: ReviewAssignmentKind,
  teamSlug?: string,
): Promise<readonly ReviewAssignment[]> {
  const q = `${query} sort:updated-desc`;
  const rows = await runGhJson<readonly GhSearchPrRow[]>(
    [
      "search",
      "prs",
      q,
      "--json",
      "repository,number,title,url,author,updatedAt",
      "--limit",
      "100",
    ],
    workspacePath,
  );
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((row) => {
    const repository = row.repository?.nameWithOwner ?? "";
    const authorLogin = row.author?.login ?? "";
    const updatedAt = row.updatedAt ?? "";
    return {
      id: assignmentId(repository, row.number, kind, teamSlug),
      url: row.url,
      repository,
      pullNumber: row.number,
      title: row.title,
      authorLogin,
      updatedAt,
      assignmentKind: kind,
      ...(teamSlug !== undefined ? { teamSlug } : {}),
    } satisfies ReviewAssignment;
  });
}

async function listTeamRows(
  workspacePath: string,
): Promise<readonly GhTeamRow[]> {
  const page = await runGhJson<readonly GhTeamRow[]>(
    ["api", "/user/teams?per_page=100"],
    workspacePath,
  );
  return Array.isArray(page) ? page : [];
}

function dedupeByRepoNumber(
  items: readonly ReviewAssignment[],
): ReviewAssignment[] {
  const seen = new Set<string>();
  const out: ReviewAssignment[] = [];
  for (const item of items) {
    const key = `${item.repository}#${item.pullNumber}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Bounded parallelism for many gh subprocess calls (avoids search API burst). */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const cap =
    concurrency > 0 ? Math.min(concurrency, items.length) : items.length;
  if (cap === 0) {
    return [];
  }
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      results[i] = await mapper(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}

export class GitHubReviewInboxSource implements ReviewInboxSource {
  async resolveDefaultRepository(options: {
    readonly workspacePath: string;
  }): Promise<string> {
    const row = await runGhJson<{ readonly nameWithOwner?: string }>(
      ["repo", "view", "--json", "nameWithOwner"],
      options.workspacePath,
    );
    const nwo = row?.nameWithOwner?.trim() ?? "";
    if (nwo.length === 0 || !nwo.includes("/")) {
      throw new Error("Could not resolve owner/repo (gh repo view).");
    }
    return nwo;
  }

  async viewPullRequestMetadata(options: {
    readonly workspacePath: string;
    readonly repository: string;
    readonly pullNumber: number;
  }): Promise<Record<string, unknown>> {
    const row = await runGhJson<Record<string, unknown>>(
      [
        "pr",
        "view",
        String(options.pullNumber),
        "--repo",
        options.repository,
        "--json",
        "title,url,author,state,additions,deletions,changedFiles,updatedAt,reviewRequests",
      ],
      options.workspacePath,
    );
    return row ?? {};
  }

  async listAssignments(
    options: ReviewInboxListOptions,
  ): Promise<readonly ReviewAssignment[]> {
    if (!options.includeTeam) {
      const direct = await searchReviewRequested(
        options.workspacePath,
        "is:pr is:open review-requested:@me",
        "direct",
      );
      return dedupeByRepoNumber([...direct]);
    }
    const [direct, teams] = await Promise.all([
      searchReviewRequested(
        options.workspacePath,
        "is:pr is:open review-requested:@me",
        "direct",
      ),
      listTeamRows(options.workspacePath),
    ]);
    const teamSlices = await mapWithConcurrency(teams, 5, async (team) => {
      const org = team.organization.login;
      const slug = team.slug;
      const tr = `${org}/${slug}`;
      return searchReviewRequested(
        options.workspacePath,
        `is:pr is:open team-review-requested:${tr}`,
        "team",
        tr,
      );
    });
    const teamResults = teamSlices.flat();
    return dedupeByRepoNumber([...direct, ...teamResults]);
  }

  async listAuthoredOpen(
    options: ReviewInboxListMineOptions,
  ): Promise<readonly AuthoredPull[]> {
    const rows = await searchReviewRequested(
      options.workspacePath,
      "is:pr is:open author:@me",
      "direct",
    );
    return rows.map((row) => ({
      id: `${row.repository}#${row.pullNumber}`,
      url: row.url,
      repository: row.repository,
      pullNumber: row.pullNumber,
      title: row.title,
      updatedAt: row.updatedAt,
    }));
  }

  async submitReview(input: {
    readonly workspacePath: string;
    readonly draft: ReviewDraftV1;
  }): Promise<{ readonly reviewUrl: string }> {
    const { draft, workspacePath } = input;
    const flag = ghPrReviewFlag(draft.event);
    const bodyPath = join(
      tmpdir(),
      `agents-code-review-inbox-${crypto.randomUUID()}.md`,
    );
    try {
      await writeFile(bodyPath, `${draft.body}\n`, "utf8");
      const args: string[] = [
        "pr",
        "review",
        String(draft.pullNumber),
        flag,
        "--repo",
        draft.repository,
        "--body-file",
        bodyPath,
      ];
      await runGhText(args, workspacePath);
      return {
        reviewUrl: `https://github.com/${draft.repository}/pull/${draft.pullNumber}`,
      };
    } finally {
      await rm(bodyPath, { force: true });
    }
  }
}

function ghPrReviewFlag(event: ReviewSubmitEvent): string {
  switch (event) {
    case "approve":
      return "--approve";
    case "request_changes":
      return "--request-changes";
    case "comment":
      return "--comment";
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export function parseReviewDraftV1(raw: unknown): ReviewDraftV1 {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Draft must be a JSON object.");
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaId !== CODE_REVIEW_INBOX_DRAFT_SCHEMA_ID) {
    throw new Error(
      `Invalid draft schemaId (expected ${CODE_REVIEW_INBOX_DRAFT_SCHEMA_ID}).`,
    );
  }
  if (o.schemaVersion !== 1) {
    throw new Error("Invalid draft schemaVersion (expected 1).");
  }
  const repository =
    typeof o.repository === "string" ? o.repository.trim() : "";
  if (repository.length === 0 || !repository.includes("/")) {
    throw new Error("draft.repository must be owner/name.");
  }
  const pullNumber = typeof o.pullNumber === "number" ? o.pullNumber : NaN;
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    throw new Error("draft.pullNumber must be a positive integer.");
  }
  const event = o.event;
  if (
    event !== "comment" &&
    event !== "approve" &&
    event !== "request_changes"
  ) {
    throw new Error(
      "draft.event must be one of: comment, approve, request_changes.",
    );
  }
  const body = typeof o.body === "string" ? o.body : "";
  if (body.trim().length === 0 && event !== "approve") {
    throw new Error("draft.body is required unless event is approve.");
  }
  return {
    schemaId: CODE_REVIEW_INBOX_DRAFT_SCHEMA_ID,
    schemaVersion: 1,
    repository,
    pullNumber,
    event,
    body,
  };
}

export function templateReviewDraftV1(input: {
  readonly repository: string;
  readonly pullNumber: number;
}): ReviewDraftV1 {
  return {
    schemaId: CODE_REVIEW_INBOX_DRAFT_SCHEMA_ID,
    schemaVersion: 1,
    repository: input.repository,
    pullNumber: input.pullNumber,
    event: "comment",
    body: "Replace with your review summary before submit.",
  };
}

import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FindingSeverity } from "@aguil/agents-core";
import { runGhJson } from "@aguil/agents-github";
import type { PrFeedbackItemV1 } from "./types";

const THREAD_PAGE_CAP = 10;
const COMMENT_PAGE_SIZE = 100;
const COMMENT_PAGE_CAP = 10;
const PRIVATE_FILE_MODE = 0o600;

interface CommentPage {
  readonly nodes: readonly ThreadCommentNode[];
  readonly hasNextPage: boolean;
  readonly endCursor?: string;
}

interface ThreadCommentNode {
  readonly body?: string;
  readonly author?: { readonly login?: string };
  readonly createdAt?: string;
}

interface ReviewThreadNode {
  readonly id: string;
  readonly isResolved?: boolean;
  readonly path?: string;
  readonly line?: number | null;
  readonly comments?: {
    readonly nodes?: ReadonlyArray<ThreadCommentNode>;
  };
}

export interface CollectThreadsOptions {
  readonly workspacePath: string;
  readonly repository: string;
  readonly pullNumber: number;
  /** When true, warn if pagination cap may have dropped threads. */
  readonly warnOnPageCap?: boolean;
}

function threadTitle(firstBody: string): string {
  const line = firstBody.split("\n").find((l) => l.trim().length > 0) ?? "";
  const t = line.trim();
  if (t.length <= 120) {
    return t.length > 0 ? t : "(review thread)";
  }
  return `${t.slice(0, 117)}…`;
}

function threadDetail(comments: readonly ThreadCommentNode[]): string {
  const parts: string[] = [];
  for (const c of comments) {
    const login = c.author?.login ?? "unknown";
    const body = typeof c.body === "string" ? c.body.trim() : "";
    if (body.length === 0) {
      continue;
    }
    parts.push(`@${login}:\n${body}`);
  }
  return parts.join("\n\n---\n\n");
}

function inferSeverity(
  latestReviewState:
    | "CHANGES_REQUESTED"
    | "APPROVED"
    | "COMMENTED"
    | "PENDING"
    | undefined,
): FindingSeverity {
  return latestReviewState === "CHANGES_REQUESTED" ? "critical" : "warning";
}

async function fetchLatestHumanReviewState(
  workspacePath: string,
  owner: string,
  name: string,
  pullNumber: number,
): Promise<
  "CHANGES_REQUESTED" | "APPROVED" | "COMMENTED" | "PENDING" | undefined
> {
  const query = [
    "query($o:String!,$r:String!,$n:Int!){",
    "repository(owner:$o,name:$r){",
    "pullRequest(number:$n){",
    "latestReviews(first:20){nodes{state author{login}}}",
    "}",
    "}",
    "}",
  ].join("");
  const resp = await runGhJson<{
    readonly data?: {
      readonly repository?: {
        readonly pullRequest?: {
          readonly latestReviews?: {
            readonly nodes?: ReadonlyArray<{
              readonly state?: string;
              readonly author?: { readonly login?: string };
            }>;
          };
        };
      };
    };
  }>(
    [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `o=${owner}`,
      "-f",
      `r=${name}`,
      "-F",
      `n=${pullNumber}`,
    ],
    workspacePath,
  );
  const nodes = resp?.data?.repository?.pullRequest?.latestReviews?.nodes ?? [];
  for (const node of nodes) {
    const login = node.author?.login;
    if (
      login === undefined ||
      login === "github-actions" ||
      login.endsWith("[bot]")
    ) {
      continue;
    }
    const state = node.state;
    if (
      state === "CHANGES_REQUESTED" ||
      state === "APPROVED" ||
      state === "COMMENTED" ||
      state === "PENDING"
    ) {
      return state;
    }
  }
  return undefined;
}

async function runGhGraphqlInput<T>(
  workspacePath: string,
  body: {
    readonly query: string;
    readonly variables?: Record<string, unknown>;
  },
): Promise<T | undefined> {
  const inputPath = join(
    tmpdir(),
    `agents-pr-feedback-graphql-${crypto.randomUUID()}.json`,
  );
  try {
    await writeFile(inputPath, JSON.stringify(body), {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
    });
    return await runGhJson<T>(
      ["api", "graphql", "--input", inputPath],
      workspacePath,
    );
  } finally {
    await rm(inputPath, { force: true });
  }
}

async function fetchThreadCommentPage(
  workspacePath: string,
  threadId: string,
  after?: string,
): Promise<CommentPage> {
  const query = [
    "query($id:ID!,$after:String){",
    "node(id:$id){",
    "... on PullRequestReviewThread{",
    `comments(first:${COMMENT_PAGE_SIZE},after:$after){`,
    "pageInfo{hasNextPage endCursor}",
    "nodes{body author{login} createdAt}",
    "}",
    "}",
    "}",
    "}",
  ].join("");
  const resp = await runGhGraphqlInput<{
    readonly data?: {
      readonly node?: {
        readonly comments?: {
          readonly pageInfo?: {
            readonly hasNextPage?: boolean;
            readonly endCursor?: string | null;
          };
          readonly nodes?: ReadonlyArray<ThreadCommentNode>;
        };
      };
    };
  }>(workspacePath, {
    query,
    variables: {
      id: threadId,
      ...(after !== undefined ? { after } : {}),
    },
  });
  const block = resp?.data?.node?.comments;
  const pageInfo = block?.pageInfo;
  const endCursor = pageInfo?.endCursor ?? undefined;
  return {
    nodes: block?.nodes ?? [],
    hasNextPage: pageInfo?.hasNextPage === true,
    endCursor:
      endCursor !== undefined && endCursor.length > 0 ? endCursor : undefined,
  };
}

async function fetchAllThreadComments(
  workspacePath: string,
  threadId: string,
  firstPage: CommentPage,
): Promise<readonly ThreadCommentNode[]> {
  const all = [...firstPage.nodes];
  let after = firstPage.endCursor;
  if (!firstPage.hasNextPage || after === undefined) {
    return all;
  }
  for (let page = 0; page < COMMENT_PAGE_CAP; page++) {
    const next = await fetchThreadCommentPage(workspacePath, threadId, after);
    all.push(...next.nodes);
    if (!next.hasNextPage || next.endCursor === undefined) {
      break;
    }
    after = next.endCursor;
  }
  return all;
}

/** One GraphQL round-trip for the first comment page on many unresolved threads. */
async function fetchThreadCommentsBatch(
  workspacePath: string,
  threadIds: readonly string[],
): Promise<Map<string, readonly ThreadCommentNode[]>> {
  const out = new Map<string, readonly ThreadCommentNode[]>();
  if (threadIds.length === 0) {
    return out;
  }
  const query = [
    "query($ids:[ID!]!){",
    "nodes(ids:$ids){",
    "... on PullRequestReviewThread{",
    `id comments(first:${COMMENT_PAGE_SIZE}){`,
    "pageInfo{hasNextPage endCursor}",
    "nodes{body author{login} createdAt}",
    "}",
    "}",
    "}",
    "}",
  ].join("");
  const resp = await runGhGraphqlInput<{
    readonly data?: {
      readonly nodes?: ReadonlyArray<{
        readonly id?: string;
        readonly comments?: {
          readonly pageInfo?: {
            readonly hasNextPage?: boolean;
            readonly endCursor?: string | null;
          };
          readonly nodes?: ReadonlyArray<ThreadCommentNode>;
        };
      } | null>;
    };
  }>(workspacePath, { query, variables: { ids: [...threadIds] } });
  for (const node of resp?.data?.nodes ?? []) {
    if (node?.id === undefined) {
      continue;
    }
    const block = node.comments;
    const pageInfo = block?.pageInfo;
    const endCursor = pageInfo?.endCursor ?? undefined;
    const firstPage: CommentPage = {
      nodes: block?.nodes ?? [],
      hasNextPage: pageInfo?.hasNextPage === true,
      endCursor:
        endCursor !== undefined && endCursor.length > 0 ? endCursor : undefined,
    };
    out.set(
      node.id,
      await fetchAllThreadComments(workspacePath, node.id, firstPage),
    );
  }
  return out;
}

/**
 * Fetch unresolved pull request review threads (scope A).
 */
export async function collectUnresolvedReviewThreads(
  options: CollectThreadsOptions,
): Promise<readonly PrFeedbackItemV1[]> {
  const [owner, name] = options.repository.split("/");
  if (!owner || !name) {
    throw new Error(
      `Invalid repository '${options.repository}' (expected owner/name).`,
    );
  }

  const reviewState = await fetchLatestHumanReviewState(
    options.workspacePath,
    owner,
    name,
    options.pullNumber,
  );
  const defaultSeverity = inferSeverity(reviewState);

  const listQuery = [
    "query($o:String!,$r:String!,$n:Int!,$after:String){",
    "repository(owner:$o,name:$r){",
    "pullRequest(number:$n){",
    "reviewThreads(first:100,after:$after){",
    "pageInfo{hasNextPage endCursor}",
    "nodes{id isResolved path line}",
    "}",
    "}",
    "}",
    "}",
  ].join("");

  const items: PrFeedbackItemV1[] = [];
  let after: string | undefined;
  let cappedWithMore = false;

  for (let page = 0; page < THREAD_PAGE_CAP; page++) {
    const resp = await runGhJson<{
      readonly data?: {
        readonly repository?: {
          readonly pullRequest?: {
            readonly reviewThreads?: {
              readonly pageInfo?: {
                readonly hasNextPage?: boolean;
                readonly endCursor?: string | null;
              };
              readonly nodes?: ReadonlyArray<ReviewThreadNode>;
            };
          };
        };
      };
    }>(
      [
        "api",
        "graphql",
        "-f",
        `query=${listQuery}`,
        "-f",
        `o=${owner}`,
        "-f",
        `r=${name}`,
        "-F",
        `n=${options.pullNumber}`,
        ...(after !== undefined ? ["-f", `after=${after}`] : []),
      ],
      options.workspacePath,
    );

    const block = resp?.data?.repository?.pullRequest?.reviewThreads;
    const unresolved = (block?.nodes ?? []).filter(
      (thread) => thread.isResolved !== true,
    );
    const commentsByThreadId = await fetchThreadCommentsBatch(
      options.workspacePath,
      unresolved.map((thread) => thread.id),
    );
    for (const thread of unresolved) {
      const comments = commentsByThreadId.get(thread.id) ?? [];
      const humanComments = comments.filter((c) => {
        const login = c.author?.login ?? "";
        return (
          login.length > 0 &&
          !login.endsWith("[bot]") &&
          login !== "github-actions"
        );
      });
      if (humanComments.length === 0) {
        continue;
      }
      const detail = threadDetail(humanComments);
      const firstBody =
        typeof humanComments[0]?.body === "string" ? humanComments[0].body : "";
      const authorLogin = humanComments[0]?.author?.login ?? "unknown";
      const path =
        typeof thread.path === "string" && thread.path.length > 0
          ? thread.path
          : undefined;
      const line =
        typeof thread.line === "number" && thread.line > 0
          ? thread.line
          : undefined;

      items.push({
        id: `thread-${thread.id}`,
        kind: "pr_review_thread",
        severity: defaultSeverity,
        title: threadTitle(firstBody),
        detail,
        anchors: path !== undefined ? [{ path, line }] : [],
        source: {
          producer: "pr-feedback",
          threadId: thread.id,
          authorLogin,
        },
      });
    }

    const pageInfo = block?.pageInfo;
    if (pageInfo?.hasNextPage !== true) {
      break;
    }
    const endCursor = pageInfo.endCursor ?? undefined;
    if (endCursor === undefined || endCursor.length === 0) {
      break;
    }
    after = endCursor;
    if (page === THREAD_PAGE_CAP - 1) {
      cappedWithMore = true;
    }
  }

  if (cappedWithMore && options.warnOnPageCap !== false) {
    console.warn(
      "Warning: unresolved review-thread collect hit its pagination limit; some threads may be missing.",
    );
  }

  items.sort((a, b) => a.id.localeCompare(b.id));
  return items;
}

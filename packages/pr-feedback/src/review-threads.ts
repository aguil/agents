import { runGhJson } from "@aguil/agents-code-review-inbox";
import type { FindingSeverity } from "@aguil/agents-core";
import type { PrFeedbackItemV1 } from "./types";

const THREAD_PAGE_CAP = 10;

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

async function fetchThreadComments(
  workspacePath: string,
  threadId: string,
): Promise<readonly ThreadCommentNode[]> {
  const query = [
    "query($id:ID!){",
    "node(id:$id){",
    "... on PullRequestReviewThread{",
    "comments(first:50){nodes{body author{login} createdAt}}",
    "}",
    "}",
    "}",
  ].join("");
  const resp = await runGhJson<{
    readonly data?: {
      readonly node?: {
        readonly comments?: {
          readonly nodes?: ReadonlyArray<ThreadCommentNode>;
        };
      };
    };
  }>(
    ["api", "graphql", "-f", `query=${query}`, "-f", `id=${threadId}`],
    workspacePath,
  );
  return resp?.data?.node?.comments?.nodes ?? [];
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
    for (const thread of block?.nodes ?? []) {
      if (thread.isResolved === true) {
        continue;
      }
      const comments = await fetchThreadComments(
        options.workspacePath,
        thread.id,
      );
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

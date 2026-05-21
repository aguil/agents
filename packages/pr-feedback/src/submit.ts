import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGhJson } from "@aguil/agents-code-review-inbox";
import type {
  PrFeedbackDocumentV1,
  PrFeedbackResponsesDocumentV1,
} from "./types";

export interface SubmitPrFeedbackRepliesOptions {
  readonly workspacePath: string;
  readonly responses: PrFeedbackResponsesDocumentV1;
  readonly feedback: PrFeedbackDocumentV1;
  readonly dryRun?: boolean;
}

function threadIdForItem(
  feedback: PrFeedbackDocumentV1,
  itemId: string,
): string | undefined {
  for (const item of feedback.items) {
    if (item.id === itemId) {
      return item.source.threadId;
    }
  }
  return undefined;
}

export async function submitPrFeedbackReplies(
  options: SubmitPrFeedbackRepliesOptions,
): Promise<{ readonly posted: number }> {
  const { responses, feedback } = options;
  if (responses.repository !== feedback.repository) {
    throw new Error("Responses draft repository does not match feedback.json.");
  }
  if (responses.pullNumber !== feedback.pullNumber) {
    throw new Error("Responses draft pullNumber does not match feedback.json.");
  }

  const feedbackIds = new Set(feedback.items.map((i) => i.id));
  for (const reply of responses.replies) {
    if (!feedbackIds.has(reply.itemId)) {
      throw new Error(
        `Stale responses draft: itemId '${reply.itemId}' is not in feedback.json (re-run collect).`,
      );
    }
  }

  if (options.dryRun === true) {
    for (const reply of responses.replies) {
      console.log(`[dry-run] ${reply.itemId}:\n${reply.body}\n`);
    }
    return { posted: 0 };
  }

  const mutation = [
    "mutation($threadId: ID!, $body: String!) {",
    "addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {",
    "comment { id }",
    "}",
    "}",
  ].join(" ");

  let posted = 0;
  for (const reply of responses.replies) {
    const threadId = threadIdForItem(feedback, reply.itemId);
    if (threadId === undefined) {
      throw new Error(`No threadId for itemId '${reply.itemId}'.`);
    }
    const inputPath = join(
      tmpdir(),
      `agents-pr-feedback-submit-${crypto.randomUUID()}.json`,
    );
    try {
      await writeFile(
        inputPath,
        JSON.stringify({
          query: mutation,
          variables: { threadId, body: reply.body },
        }),
        "utf8",
      );
      await runGhJson(
        ["api", "graphql", "--input", inputPath],
        options.workspacePath,
      );
      posted += 1;
    } finally {
      await rm(inputPath, { force: true });
    }
  }

  return { posted };
}

export async function loadFeedbackDocument(
  path: string,
): Promise<PrFeedbackDocumentV1> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null) {
    throw new Error("feedback.json must be an object.");
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaId !== "https://aguil.dev/schemas/agents/pr-feedback/v1") {
    throw new Error("Invalid feedback.json schemaId.");
  }
  if (!Array.isArray(o.items)) {
    throw new Error("Invalid feedback.json items.");
  }
  return raw as PrFeedbackDocumentV1;
}

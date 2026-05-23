import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  loadFeedbackDocument,
  parsePrFeedbackResponsesV1,
  submitPrFeedbackReplies,
} from "@aguil/agents-pr-feedback";
import { evaluatePrFeedbackPublish, type PublishDecision } from "./index";

export interface ExecutePrFeedbackSubmitInput {
  readonly publish: Parameters<typeof evaluatePrFeedbackPublish>[0]["publish"];
  readonly workspacePath: string;
  readonly feedbackPath: string;
  readonly triageItemCount: number;
  readonly responsesPath?: string;
}

export interface ExecutePrFeedbackSubmitResult {
  readonly decision: PublishDecision;
  readonly executed: boolean;
  readonly postedCount?: number;
  readonly error?: string;
}

export async function executePrFeedbackSubmit(
  input: ExecutePrFeedbackSubmitInput,
): Promise<ExecutePrFeedbackSubmitResult> {
  const responsesPath =
    input.responsesPath ?? join(dirname(input.feedbackPath), "responses.json");
  const responsesExists = await pathExists(responsesPath);

  const decision = evaluatePrFeedbackPublish({
    publish: input.publish,
    triageItemCount: input.triageItemCount,
    responsesPath: responsesExists ? responsesPath : undefined,
  });

  if (!decision.shouldPublish || decision.mode !== "submit") {
    return { decision, executed: false };
  }

  try {
    const feedback = await loadFeedbackDocument(input.feedbackPath);
    const raw = await readFile(responsesPath, "utf8");
    const responses = parsePrFeedbackResponsesV1(JSON.parse(raw) as unknown);
    const { posted } = await submitPrFeedbackReplies({
      workspacePath: input.workspacePath,
      feedback,
      responses,
    });
    return { decision, executed: true, postedCount: posted };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { decision, executed: true, error: message };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

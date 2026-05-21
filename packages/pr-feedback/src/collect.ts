import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nowIso } from "@aguil/agents-core";
import { collectUnresolvedReviewThreads } from "./review-threads";
import {
  AGENTS_PR_FEEDBACK_DIR,
  PR_FEEDBACK_SCHEMA_ID,
  type PrFeedbackDocumentV1,
} from "./types";

export interface CollectPrFeedbackOptions {
  readonly workspacePath: string;
  readonly repository: string;
  readonly pullNumber: number;
  readonly outputDir?: string;
}

export function defaultFeedbackOutputDir(
  workspacePath: string,
  repository: string,
  pullNumber: number,
): string {
  const slug = repository.replace("/", "-");
  return join(workspacePath, AGENTS_PR_FEEDBACK_DIR, `${slug}-${pullNumber}`);
}

export async function collectPrFeedback(
  options: CollectPrFeedbackOptions,
): Promise<{
  readonly outputDir: string;
  readonly document: PrFeedbackDocumentV1;
}> {
  const workspacePath = resolve(options.workspacePath);
  const items = await collectUnresolvedReviewThreads({
    workspacePath,
    repository: options.repository,
    pullNumber: options.pullNumber,
  });

  const document: PrFeedbackDocumentV1 = {
    schemaId: PR_FEEDBACK_SCHEMA_ID,
    schemaVersion: 1,
    generatedAt: nowIso(),
    repository: options.repository,
    pullNumber: options.pullNumber,
    items,
  };

  const outputDir =
    options.outputDir !== undefined
      ? resolve(workspacePath, options.outputDir)
      : defaultFeedbackOutputDir(
          workspacePath,
          options.repository,
          options.pullNumber,
        );

  await mkdir(outputDir, { recursive: true });
  const feedbackPath = join(outputDir, "feedback.json");
  await writeFile(
    feedbackPath,
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );

  return { outputDir, document };
}

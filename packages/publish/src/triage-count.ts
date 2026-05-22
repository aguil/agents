import { join, resolve } from "node:path";
import {
  agentsCodeReviewDryRunRoot,
  legacyAgentsCodeReviewDryRunRoot,
} from "@aguil/agents-core";
import {
  buildEnvelopeFromCodeReviewResult,
  buildEnvelopeFromPrFeedbackResult,
} from "@aguil/agents-triage";

export function isCodeReviewDryRunResultPath(
  workspacePath: string,
  resultPath: string,
): boolean {
  const dryRoots = [
    agentsCodeReviewDryRunRoot(workspacePath),
    legacyAgentsCodeReviewDryRunRoot(workspacePath),
  ];
  const normalized = resultPath.replaceAll("\\", "/");
  return dryRoots.some((root) => {
    const prefix = root.replaceAll("\\", "/");
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

export async function countCodeReviewTriageItems(input: {
  readonly workspacePath: string;
  readonly resultPath: string;
}): Promise<number> {
  const envelope = await buildEnvelopeFromCodeReviewResult({
    workspacePath: input.workspacePath,
    resultAbsolutePath: input.resultPath,
  });
  return envelope.items.length;
}

export async function countPrFeedbackTriageItems(input: {
  readonly workspacePath: string;
  readonly feedbackPath: string;
}): Promise<number> {
  const envelope = await buildEnvelopeFromPrFeedbackResult({
    workspacePath: input.workspacePath,
    resultAbsolutePath: input.feedbackPath,
  });
  return envelope.items.length;
}

export async function writePrFeedbackTriageQueue(input: {
  readonly workspacePath: string;
  readonly feedbackPath: string;
  readonly outputDir: string;
}): Promise<{ readonly triageDir: string; readonly itemCount: number }> {
  const envelope = await buildEnvelopeFromPrFeedbackResult({
    workspacePath: input.workspacePath,
    resultAbsolutePath: input.feedbackPath,
  });
  const { writeTriageOutputs, defaultTriageQueueDir } = await import(
    "@aguil/agents-triage"
  );
  const triageDir =
    input.outputDir.trim().length > 0
      ? join(
          resolve(input.workspacePath, input.outputDir),
          ".agents-triage-queue",
        )
      : defaultTriageQueueDir(input.workspacePath, envelope.outputSlug);
  await writeTriageOutputs({
    envelope,
    outputDir: triageDir,
    format: "json",
  });
  return { triageDir, itemCount: envelope.items.length };
}

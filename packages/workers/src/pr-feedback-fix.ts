import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRunId, ensureDirectory } from "@aguil/agents-core";
import { collectAgentRun } from "@aguil/agents-execution";
import type { WorkItem } from "@aguil/agents-tracker";
import type { TriageEnvelopeV1, TriageItemV1 } from "@aguil/agents-triage";
import { TRIAGE_ENVELOPE_SCHEMA_ID } from "@aguil/agents-triage";
import type { WorkflowDefinition } from "@aguil/agents-workflow";
import { createSubprocessAdapter } from "./implementation-runtime";

const TRIAGE_QUEUE_JSON = "triage-queue.json";

export async function readTriageQueueFile(
  triageDir: string,
): Promise<TriageEnvelopeV1 | null> {
  const path = join(triageDir, TRIAGE_QUEUE_JSON);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const envelope = parsed as TriageEnvelopeV1;
    if (envelope.schemaId !== TRIAGE_ENVELOPE_SCHEMA_ID) {
      return null;
    }
    if (!Array.isArray(envelope.items)) {
      return null;
    }
    return envelope;
  } catch {
    return null;
  }
}

function buildFixPrompt(input: {
  readonly item: TriageItemV1;
  readonly repository: string;
  readonly pullNumber: number;
  readonly workItemId: string;
}): string {
  const anchorLines = input.item.anchors
    .map((a) => (a.line !== undefined ? `${a.path}:${a.line}` : a.path))
    .join(", ");
  return [
    `Address PR review feedback item ${input.item.id} on ${input.repository}#${input.pullNumber}.`,
    `Work item: ${input.workItemId}`,
    "",
    `Title: ${input.item.title}`,
    `Severity: ${input.item.severity}`,
    `Kind: ${input.item.kind}`,
    "",
    input.item.detail,
    "",
    anchorLines.length > 0 ? `Anchors: ${anchorLines}` : "",
    "",
    "Make the minimal code or test change required.",
    `When you commit, use exactly one commit and cite ${input.item.id} in the commit message body.`,
    "Do not draft or post GitHub review replies.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export async function runPrFeedbackFixes(input: {
  readonly item: WorkItem;
  readonly triageDir: string;
  readonly hostWorkspacePath: string;
  readonly scratchpadRoot: string;
  readonly definition: WorkflowDefinition;
}): Promise<{
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
}> {
  const envelope = await readTriageQueueFile(input.triageDir);
  if (envelope === null || envelope.items.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0 };
  }

  const repository =
    envelope.upstream?.metadataSubset?.repository ??
    input.item.metadata.repository;
  const pullRaw =
    envelope.upstream?.metadataSubset?.pullNumber ??
    input.item.metadata.pull_number;
  const pullNumber =
    pullRaw !== undefined ? Number.parseInt(pullRaw, 10) : Number.NaN;
  if (repository === undefined || !Number.isFinite(pullNumber)) {
    console.warn(
      JSON.stringify({
        event: "pr_feedback_fix_skipped",
        work_item_id: input.item.id,
        reason: "missing_repository_or_pull_number",
      }),
    );
    return { attempted: 0, succeeded: 0, failed: 0 };
  }

  const impl = input.definition.implementation;
  const adapter = createSubprocessAdapter(impl);
  const timeoutMs = impl.turnTimeoutMs ?? 3_600_000;
  const maxItems = Math.max(1, input.definition.maxTurns);
  const items = envelope.items.slice(0, maxItems);

  let succeeded = 0;
  let failed = 0;
  for (const triageItem of items) {
    const runId = createRunId("pr-feedback-fix");
    const scratchpadPath = join(input.scratchpadRoot, runId);
    await ensureDirectory(scratchpadPath);
    const prompt = buildFixPrompt({
      item: triageItem,
      repository,
      pullNumber,
      workItemId: input.item.id,
    });

    console.log(
      JSON.stringify({
        event: "pr_feedback_fix_started",
        work_item_id: input.item.id,
        triage_item_id: triageItem.id,
        run_id: runId,
        adapter: impl.adapter,
      }),
    );

    const result = await collectAgentRun(adapter, {
      runId,
      roleId: "pr_feedback_fix",
      prompt,
      workspacePath: input.hostWorkspacePath,
      contextBundlePath: join(scratchpadPath, "context.json"),
      scratchpadPath,
      timeoutMs,
      allowedCommands: [],
      metadata: {
        work_item_id: input.item.id,
        triage_item_id: triageItem.id,
        repository,
        pull_number: String(pullNumber),
      },
    });

    const runStatus = result.result.status;
    if (runStatus === "failed" || runStatus === "timed_out") {
      failed += 1;
      console.log(
        JSON.stringify({
          event: "pr_feedback_fix_failed",
          work_item_id: input.item.id,
          triage_item_id: triageItem.id,
          run_id: runId,
          status: runStatus,
        }),
      );
    } else {
      succeeded += 1;
      console.log(
        JSON.stringify({
          event: "pr_feedback_fix_succeeded",
          work_item_id: input.item.id,
          triage_item_id: triageItem.id,
          run_id: runId,
        }),
      );
    }
  }

  return { attempted: items.length, succeeded, failed };
}

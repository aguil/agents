import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildSelectCommand } from "@aguil/agents-publish";
import {
  expandPathValue,
  type PrFeedbackSelectionDocument,
} from "@aguil/agents-workflow";
import { assertWorkspaceInsideRoot } from "@aguil/agents-workspace";

export const AGENTSD_MONITOR_SCHEMA_ID = "agentsd-monitor/v1";

export async function writeMonitorContext(input: {
  readonly monitorWorkspace: string;
  readonly contextPath: string;
  readonly hostWorkspacePath: string;
  readonly workflowDir: string;
  readonly doc: PrFeedbackSelectionDocument;
}): Promise<void> {
  const root = expandPathValue(input.monitorWorkspace, {
    workflowDir: input.workflowDir,
  });
  const relative = input.contextPath.trim();
  if (
    relative.length === 0 ||
    relative.startsWith("/") ||
    relative.includes("..")
  ) {
    throw new Error(
      "monitor context_path must be a non-empty relative path without ..",
    );
  }
  const path = resolve(root, relative);
  assertWorkspaceInsideRoot(root, path);
  const selectCommand = buildSelectCommand({
    selectionId: input.doc.selectionId,
    workspacePath: input.hostWorkspacePath,
    identifiers: input.doc.pending.map((p) => p.identifier),
  });
  const body = {
    schemaId: AGENTSD_MONITOR_SCHEMA_ID,
    updatedAt: new Date().toISOString(),
    selections: [
      {
        hostWorkspace: input.hostWorkspacePath,
        selectionId: input.doc.selectionId,
        pending: input.doc.pending.map((p) => ({
          identifier: p.identifier,
          title: p.title,
          url: p.url,
          unresolvedThreads: p.unresolvedThreads,
          reason: p.reason,
        })),
        approved: [...input.doc.approved],
        selectCommand,
      },
    ],
  };
  const payloadFingerprint = JSON.stringify({
    schemaId: body.schemaId,
    selections: body.selections,
  });
  try {
    const existing = await readFile(path, "utf8");
    const parsed = JSON.parse(existing) as {
      readonly schemaId?: string;
      readonly selections?: unknown;
    };
    if (
      JSON.stringify({
        schemaId: parsed.schemaId,
        selections: parsed.selections,
      }) === payloadFingerprint
    ) {
      return;
    }
  } catch {
    // missing or invalid file — write fresh payload
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

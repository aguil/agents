import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildSelectCommand } from "@aguil/agents-publish";
import type { PrFeedbackSelectionDocument } from "@aguil/agents-workflow";

export const AGENTSD_MONITOR_SCHEMA_ID = "agentsd-monitor/v1";

export async function writeMonitorContext(input: {
  readonly monitorWorkspace: string;
  readonly contextPath: string;
  readonly hostWorkspacePath: string;
  readonly doc: PrFeedbackSelectionDocument;
}): Promise<void> {
  const path = resolve(input.monitorWorkspace, input.contextPath);
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

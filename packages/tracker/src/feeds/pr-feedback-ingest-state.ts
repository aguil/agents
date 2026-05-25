import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const PR_FEEDBACK_INGEST_SCHEMA_ID = "pr-feedback-ingest/v1";

export interface PrFeedbackIngestPullState {
  readonly threadFingerprint: string;
  readonly threadCount: number;
  readonly updatedAt: string;
}

export interface PrFeedbackIngestDocument {
  readonly schemaId: typeof PR_FEEDBACK_INGEST_SCHEMA_ID;
  readonly pulls: Readonly<Record<string, PrFeedbackIngestPullState>>;
}

export function ingestStatePath(hostWorkspacePath: string): string {
  return join(hostWorkspacePath, ".agentsd", "pr-feedback-ingest.json");
}

export function threadActivityFingerprint(
  threads: readonly { readonly id: string }[],
): string {
  return threads
    .map((t) => t.id)
    .sort()
    .join(",");
}

export function emptyIngestDocument(): PrFeedbackIngestDocument {
  return { schemaId: PR_FEEDBACK_INGEST_SCHEMA_ID, pulls: {} };
}

export async function readIngestDocument(
  hostWorkspacePath: string,
): Promise<PrFeedbackIngestDocument> {
  const path = ingestStatePath(hostWorkspacePath);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isIngestDocument(parsed)) {
      return emptyIngestDocument();
    }
    return parsed;
  } catch {
    return emptyIngestDocument();
  }
}

export async function writeIngestDocument(
  hostWorkspacePath: string,
  doc: PrFeedbackIngestDocument,
): Promise<void> {
  const path = ingestStatePath(hostWorkspacePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

export function ingestReasonForPull(input: {
  readonly identifier: string;
  readonly fingerprint: string;
  readonly threadCount: number;
  readonly prior: PrFeedbackIngestDocument;
}): { readonly enqueue: boolean; readonly reason: string } {
  if (input.threadCount === 0) {
    return { enqueue: false, reason: "no_threads" };
  }
  const prev = input.prior.pulls[input.identifier];
  if (prev === undefined) {
    return { enqueue: true, reason: "new_review_activity" };
  }
  if (prev.threadFingerprint !== input.fingerprint) {
    return { enqueue: true, reason: "new_review_activity" };
  }
  return { enqueue: true, reason: "unresolved_threads" };
}

function isIngestDocument(value: unknown): value is PrFeedbackIngestDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const doc = value as PrFeedbackIngestDocument;
  return (
    doc.schemaId === PR_FEEDBACK_INGEST_SCHEMA_ID &&
    typeof doc.pulls === "object" &&
    doc.pulls !== null &&
    !Array.isArray(doc.pulls)
  );
}

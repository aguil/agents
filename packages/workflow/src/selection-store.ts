import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const PR_FEEDBACK_SELECTION_SCHEMA_ID = "pr-feedback-selection/v1";

export interface PrFeedbackPendingEntry {
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly unresolvedThreads: number;
  readonly reason: string;
}

export interface PrFeedbackSelectionDocument {
  readonly schemaId: typeof PR_FEEDBACK_SELECTION_SCHEMA_ID;
  readonly selectionId: string;
  readonly pending: readonly PrFeedbackPendingEntry[];
  readonly approved: readonly string[];
  readonly dismissed: readonly string[];
  readonly notifiedAt: string | null;
  readonly notifyFingerprint: string | null;
}

export function selectionStorePath(hostWorkspacePath: string): string {
  return join(hostWorkspacePath, ".agentsd", "pr-feedback-selection.json");
}

export function emptySelectionDocument(): PrFeedbackSelectionDocument {
  return {
    schemaId: PR_FEEDBACK_SELECTION_SCHEMA_ID,
    selectionId: newSelectionId(),
    pending: [],
    approved: [],
    dismissed: [],
    notifiedAt: null,
    notifyFingerprint: null,
  };
}

export async function readSelectionDocument(
  hostWorkspacePath: string,
): Promise<PrFeedbackSelectionDocument> {
  const path = selectionStorePath(hostWorkspacePath);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isSelectionDocument(parsed)) {
      return emptySelectionDocument();
    }
    return parsed;
  } catch {
    return emptySelectionDocument();
  }
}

export async function writeSelectionDocument(
  hostWorkspacePath: string,
  doc: PrFeedbackSelectionDocument,
): Promise<void> {
  const path = selectionStorePath(hostWorkspacePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

export function pendingFingerprint(
  pending: readonly PrFeedbackPendingEntry[],
): string {
  return pending
    .map((p) => `${p.identifier}:${p.unresolvedThreads}`)
    .sort()
    .join("|");
}

export function upsertPendingFromWorkItems(input: {
  readonly existing: PrFeedbackSelectionDocument;
  readonly entries: readonly PrFeedbackPendingEntry[];
}): PrFeedbackSelectionDocument {
  const dismissed = new Set(input.existing.dismissed);
  const approved = new Set(input.existing.approved);
  const byId = new Map<string, PrFeedbackPendingEntry>();
  for (const entry of input.existing.pending) {
    if (!dismissed.has(entry.identifier) && !approved.has(entry.identifier)) {
      byId.set(entry.identifier, entry);
    }
  }
  for (const entry of input.entries) {
    if (dismissed.has(entry.identifier) || approved.has(entry.identifier)) {
      continue;
    }
    byId.set(entry.identifier, entry);
  }
  const pending = [...byId.values()].sort((a, b) =>
    a.identifier.localeCompare(b.identifier),
  );
  const fingerprint = pendingFingerprint(pending);
  const selectionId =
    pending.length === 0
      ? input.existing.selectionId
      : fingerprint !== input.existing.notifyFingerprint
        ? newSelectionId()
        : input.existing.selectionId;
  return {
    ...input.existing,
    selectionId,
    pending,
    notifyFingerprint: fingerprint,
  };
}

export function applySelectionCommand(input: {
  readonly doc: PrFeedbackSelectionDocument;
  readonly selectionId?: string;
  readonly approve?: readonly string[];
  readonly dismiss?: readonly string[];
  readonly revoke?: readonly string[];
}): PrFeedbackSelectionDocument {
  if (
    input.selectionId !== undefined &&
    input.selectionId !== input.doc.selectionId
  ) {
    throw new Error(
      `selection_id_mismatch: expected ${input.doc.selectionId}, got ${input.selectionId}`,
    );
  }
  const approved = new Set(input.doc.approved);
  const dismissed = new Set(input.doc.dismissed);
  for (const id of input.revoke ?? []) {
    approved.delete(id);
  }
  for (const id of input.dismiss ?? []) {
    dismissed.add(id);
    approved.delete(id);
  }
  for (const id of input.approve ?? []) {
    approved.add(id);
    dismissed.delete(id);
  }
  const pending = input.doc.pending.filter(
    (p) => !approved.has(p.identifier) && !dismissed.has(p.identifier),
  );
  return {
    ...input.doc,
    approved: [...approved].sort(),
    dismissed: [...dismissed].sort(),
    pending,
  };
}

function newSelectionId(): string {
  return `sel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isSelectionDocument(
  value: unknown,
): value is PrFeedbackSelectionDocument {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as PrFeedbackSelectionDocument;
  return (
    v.schemaId === PR_FEEDBACK_SELECTION_SCHEMA_ID &&
    typeof v.selectionId === "string" &&
    Array.isArray(v.pending) &&
    Array.isArray(v.approved) &&
    Array.isArray(v.dismissed)
  );
}

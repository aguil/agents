import type { PrFeedbackSelectionDocument } from "@aguil/agents-workflow";
import { readSelectionDocument } from "@aguil/agents-workflow";
import {
  type PrFeedbackIngestDocument,
  readIngestDocument,
} from "./pr-feedback-ingest-state";

export interface PrFeedbackTickCache {
  readIngest(hostWorkspacePath: string): Promise<PrFeedbackIngestDocument>;
  readSelection(
    hostWorkspacePath: string,
  ): Promise<PrFeedbackSelectionDocument>;
  noteIngestWrite(
    hostWorkspacePath: string,
    doc: PrFeedbackIngestDocument,
  ): void;
  noteSelectionWrite(
    hostWorkspacePath: string,
    doc: PrFeedbackSelectionDocument,
  ): void;
}

export function createPrFeedbackTickCache(): PrFeedbackTickCache {
  const ingest = new Map<string, PrFeedbackIngestDocument>();
  const selection = new Map<string, PrFeedbackSelectionDocument>();
  return {
    async readIngest(hostWorkspacePath) {
      const cached = ingest.get(hostWorkspacePath);
      if (cached !== undefined) {
        return cached;
      }
      const doc = await readIngestDocument(hostWorkspacePath);
      ingest.set(hostWorkspacePath, doc);
      return doc;
    },
    async readSelection(hostWorkspacePath) {
      const cached = selection.get(hostWorkspacePath);
      if (cached !== undefined) {
        return cached;
      }
      const doc = await readSelectionDocument(hostWorkspacePath);
      selection.set(hostWorkspacePath, doc);
      return doc;
    },
    noteIngestWrite(hostWorkspacePath, doc) {
      ingest.set(hostWorkspacePath, doc);
    },
    noteSelectionWrite(hostWorkspacePath, doc) {
      selection.set(hostWorkspacePath, doc);
    },
  };
}

export interface WorkFeedTickContext {
  readonly prFeedbackCache: PrFeedbackTickCache;
}

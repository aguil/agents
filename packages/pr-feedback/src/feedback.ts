import type { FindingSeverity } from "@aguil/agents-core";
import {
  PR_FEEDBACK_SCHEMA_ID,
  type PrFeedbackDocumentV1,
  type PrFeedbackItemV1,
} from "./types";

const SEVERITIES = new Set<FindingSeverity>(["critical", "warning"]);

function parseRepository(raw: unknown): string {
  const repository = typeof raw === "string" ? raw.trim() : "";
  if (repository.length === 0 || !repository.includes("/")) {
    throw new Error("repository must be owner/name.");
  }
  return repository;
}

function parsePullNumber(raw: unknown): number {
  const pullNumber = typeof raw === "number" ? raw : NaN;
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    throw new Error("pullNumber must be a positive integer.");
  }
  return pullNumber;
}

function parseItem(entry: unknown, index: number): PrFeedbackItemV1 {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`items[${index}] must be an object.`);
  }
  const o = entry as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (id.length === 0) {
    throw new Error(`items[${index}].id is required.`);
  }
  if (o.kind !== "pr_review_thread") {
    throw new Error(`items[${index}].kind must be pr_review_thread.`);
  }
  const severity = o.severity;
  if (
    typeof severity !== "string" ||
    !SEVERITIES.has(severity as FindingSeverity)
  ) {
    throw new Error(`items[${index}].severity must be critical or warning.`);
  }
  const title = typeof o.title === "string" ? o.title.trim() : "";
  if (title.length === 0) {
    throw new Error(`items[${index}].title is required.`);
  }
  const detail = typeof o.detail === "string" ? o.detail : "";
  if (detail.trim().length === 0) {
    throw new Error(`items[${index}].detail is required.`);
  }
  if (!Array.isArray(o.anchors)) {
    throw new Error(`items[${index}].anchors must be an array.`);
  }
  const anchors = o.anchors.map((anchor, j) => {
    if (typeof anchor !== "object" || anchor === null) {
      throw new Error(`items[${index}].anchors[${j}] must be an object.`);
    }
    const a = anchor as Record<string, unknown>;
    const path = typeof a.path === "string" ? a.path.trim() : "";
    if (path.length === 0) {
      throw new Error(`items[${index}].anchors[${j}].path is required.`);
    }
    const line = a.line;
    if (line !== undefined) {
      if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
        throw new Error(
          `items[${index}].anchors[${j}].line must be a positive integer.`,
        );
      }
      return { path, line };
    }
    return { path };
  });
  if (typeof o.source !== "object" || o.source === null) {
    throw new Error(`items[${index}].source must be an object.`);
  }
  const source = o.source as Record<string, unknown>;
  if (source.producer !== "pr-feedback") {
    throw new Error(`items[${index}].source.producer must be pr-feedback.`);
  }
  const threadId =
    typeof source.threadId === "string" ? source.threadId.trim() : "";
  if (threadId.length === 0) {
    throw new Error(`items[${index}].source.threadId is required.`);
  }
  const authorLogin =
    typeof source.authorLogin === "string" ? source.authorLogin.trim() : "";
  if (authorLogin.length === 0) {
    throw new Error(`items[${index}].source.authorLogin is required.`);
  }
  const expectedId = `thread-${threadId}`;
  if (id !== expectedId) {
    throw new Error(
      `items[${index}].id must be thread-<threadId> (expected '${expectedId}').`,
    );
  }
  return {
    id,
    kind: "pr_review_thread",
    severity: severity as FindingSeverity,
    title,
    detail,
    anchors,
    source: { producer: "pr-feedback", threadId, authorLogin },
  };
}

export function parsePrFeedbackV1(raw: unknown): PrFeedbackDocumentV1 {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("feedback.json must be an object.");
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaId !== PR_FEEDBACK_SCHEMA_ID) {
    throw new Error(
      `Invalid feedback.json schemaId (expected ${PR_FEEDBACK_SCHEMA_ID}).`,
    );
  }
  if (o.schemaVersion !== 1) {
    throw new Error("Invalid feedback.json schemaVersion (expected 1).");
  }
  const generatedAt =
    typeof o.generatedAt === "string" ? o.generatedAt.trim() : "";
  if (generatedAt.length === 0) {
    throw new Error("generatedAt is required.");
  }
  const repository = parseRepository(o.repository);
  const pullNumber = parsePullNumber(o.pullNumber);
  if (!Array.isArray(o.items)) {
    throw new Error("items must be an array.");
  }
  const items = o.items.map((entry, i) => parseItem(entry, i));
  return {
    schemaId: PR_FEEDBACK_SCHEMA_ID,
    schemaVersion: 1,
    generatedAt,
    repository,
    pullNumber,
    items,
  };
}

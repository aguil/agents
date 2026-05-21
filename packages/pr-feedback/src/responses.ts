import {
  PR_FEEDBACK_RESPONSES_SCHEMA_ID,
  type PrFeedbackResponsesDocumentV1,
} from "./types";

export function parsePrFeedbackResponsesV1(
  raw: unknown,
): PrFeedbackResponsesDocumentV1 {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Responses draft must be a JSON object.");
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaId !== PR_FEEDBACK_RESPONSES_SCHEMA_ID) {
    throw new Error(
      `Invalid responses schemaId (expected ${PR_FEEDBACK_RESPONSES_SCHEMA_ID}).`,
    );
  }
  if (o.schemaVersion !== 1) {
    throw new Error("Invalid responses schemaVersion (expected 1).");
  }
  const repository =
    typeof o.repository === "string" ? o.repository.trim() : "";
  if (repository.length === 0 || !repository.includes("/")) {
    throw new Error("repository must be owner/name.");
  }
  const pullNumber = typeof o.pullNumber === "number" ? o.pullNumber : NaN;
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    throw new Error("pullNumber must be a positive integer.");
  }
  if (!Array.isArray(o.replies)) {
    throw new Error("replies must be an array.");
  }
  const replies = o.replies.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`replies[${i}] must be an object.`);
    }
    const r = entry as Record<string, unknown>;
    const itemId = typeof r.itemId === "string" ? r.itemId.trim() : "";
    if (itemId.length === 0) {
      throw new Error(`replies[${i}].itemId is required.`);
    }
    const body = typeof r.body === "string" ? r.body : "";
    if (body.trim().length === 0) {
      throw new Error(`replies[${i}].body is required.`);
    }
    return { itemId, body };
  });
  return {
    schemaId: PR_FEEDBACK_RESPONSES_SCHEMA_ID,
    schemaVersion: 1,
    repository,
    pullNumber,
    replies,
  };
}

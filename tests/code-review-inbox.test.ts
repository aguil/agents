import { describe, expect, test } from "bun:test";
import {
  CODE_REVIEW_INBOX_DRAFT_SCHEMA_ID,
  parseReviewDraftV1,
  templateReviewDraftV1,
} from "@aguil/agents-code-review-inbox";

describe("parseReviewDraftV1", () => {
  test("accepts a valid draft", () => {
    const d = parseReviewDraftV1({
      schemaId: CODE_REVIEW_INBOX_DRAFT_SCHEMA_ID,
      schemaVersion: 1,
      repository: "acme/widget",
      pullNumber: 9,
      event: "comment",
      body: "Looks good.",
    });
    expect(d.repository).toBe("acme/widget");
    expect(d.pullNumber).toBe(9);
    expect(d.event).toBe("comment");
  });

  test("allows empty body for approve", () => {
    const d = parseReviewDraftV1({
      schemaId: CODE_REVIEW_INBOX_DRAFT_SCHEMA_ID,
      schemaVersion: 1,
      repository: "acme/widget",
      pullNumber: 2,
      event: "approve",
      body: "",
    });
    expect(d.event).toBe("approve");
  });

  test("rejects wrong schema", () => {
    expect(() =>
      parseReviewDraftV1({
        schemaId: "wrong",
        schemaVersion: 1,
        repository: "a/b",
        pullNumber: 1,
        event: "comment",
        body: "x",
      }),
    ).toThrow(/schemaId/);
  });

  test("rejects empty body for comment", () => {
    expect(() =>
      parseReviewDraftV1({
        schemaId: CODE_REVIEW_INBOX_DRAFT_SCHEMA_ID,
        schemaVersion: 1,
        repository: "a/b",
        pullNumber: 1,
        event: "comment",
        body: "   ",
      }),
    ).toThrow(/body/);
  });
});

describe("templateReviewDraftV1", () => {
  test("fills repository and pull number", () => {
    const t = templateReviewDraftV1({
      repository: "o/r",
      pullNumber: 3,
    });
    expect(t.schemaVersion).toBe(1);
    expect(t.repository).toBe("o/r");
    expect(t.pullNumber).toBe(3);
    expect(t.event).toBe("comment");
  });
});

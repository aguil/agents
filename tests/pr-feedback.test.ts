import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PR_FEEDBACK_RESPONSES_SCHEMA_ID,
  PR_FEEDBACK_SCHEMA_ID,
  parsePrFeedbackResponsesV1,
  parsePrFeedbackV1,
} from "@aguil/agents-pr-feedback";
import {
  buildEnvelopeFromPrFeedbackResult,
  computeOutputSlug,
} from "@aguil/agents-triage";

describe("parsePrFeedbackV1", () => {
  test("accepts valid feedback document", () => {
    const d = parsePrFeedbackV1({
      schemaId: PR_FEEDBACK_SCHEMA_ID,
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      repository: "acme/widget",
      pullNumber: 7,
      items: [
        {
          id: "thread-PRRT_1",
          kind: "pr_review_thread",
          severity: "warning",
          title: "nit",
          detail: "please fix",
          anchors: [{ path: "src/a.ts", line: 1 }],
          source: {
            producer: "pr-feedback",
            threadId: "PRRT_1",
            authorLogin: "rev",
          },
        },
      ],
    });
    expect(d.items[0]?.source.threadId).toBe("PRRT_1");
  });

  test("rejects threadId that does not match item id", () => {
    expect(() =>
      parsePrFeedbackV1({
        schemaId: PR_FEEDBACK_SCHEMA_ID,
        schemaVersion: 1,
        generatedAt: "2026-01-01T00:00:00.000Z",
        repository: "a/b",
        pullNumber: 1,
        items: [
          {
            id: "thread-PRRT_1",
            kind: "pr_review_thread",
            severity: "warning",
            title: "t",
            detail: "d",
            anchors: [],
            source: {
              producer: "pr-feedback",
              threadId: "PRRT_OTHER",
              authorLogin: "rev",
            },
          },
        ],
      }),
    ).toThrow(/thread-<threadId>/);
  });
});

describe("parsePrFeedbackResponsesV1", () => {
  test("accepts valid responses draft", () => {
    const d = parsePrFeedbackResponsesV1({
      schemaId: PR_FEEDBACK_RESPONSES_SCHEMA_ID,
      schemaVersion: 1,
      repository: "acme/widget",
      pullNumber: 7,
      replies: [{ itemId: "thread-PRRT_1", body: "Fixed in abc." }],
    });
    expect(d.replies).toHaveLength(1);
    expect(d.replies[0]?.itemId).toBe("thread-PRRT_1");
  });

  test("rejects empty reply body", () => {
    expect(() =>
      parsePrFeedbackResponsesV1({
        schemaId: PR_FEEDBACK_RESPONSES_SCHEMA_ID,
        schemaVersion: 1,
        repository: "a/b",
        pullNumber: 1,
        replies: [{ itemId: "thread-x", body: "  " }],
      }),
    ).toThrow(/body/);
  });
});

describe("buildEnvelopeFromPrFeedbackResult", () => {
  test("maps feedback items to triage envelope", async () => {
    const base = await mkdtemp(join(tmpdir(), "agents-pr-feedback-triage-"));
    const feedbackPath = join(base, "feedback.json");
    await writeFile(
      feedbackPath,
      JSON.stringify({
        schemaId: PR_FEEDBACK_SCHEMA_ID,
        schemaVersion: 1,
        generatedAt: "2026-01-01T00:00:00.000Z",
        repository: "o/r",
        pullNumber: 3,
        items: [
          {
            id: "thread-T1",
            kind: "pr_review_thread",
            severity: "warning",
            title: "nit",
            detail: "please fix",
            anchors: [{ path: "src/a.ts", line: 1 }],
            source: {
              producer: "pr-feedback",
              threadId: "T1",
              authorLogin: "rev",
            },
          },
        ],
      }),
      "utf8",
    );

    const envelope = await buildEnvelopeFromPrFeedbackResult({
      workspacePath: base,
      resultAbsolutePath: feedbackPath,
    });
    expect(envelope.items).toHaveLength(1);
    expect(envelope.items[0]?.id).toBe("thread-T1");
    expect(envelope.items[0]?.kind).toBe("pr_review_thread");
    expect(envelope.upstream?.producer).toBe("pr-feedback");
    expect(envelope.outputSlug).toBe(
      computeOutputSlug("pr-feedback", feedbackPath),
    );
  });
});

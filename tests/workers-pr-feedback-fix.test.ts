import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeCodeReviewAdapter } from "@aguil/agents-code-review";
import { TRIAGE_ENVELOPE_SCHEMA_ID } from "@aguil/agents-triage";
import {
  createWorkflowAgentAdapter,
  readTriageQueueFile,
} from "@aguil/agents-workers";

const FAKE_IMPL = {
  mode: "subprocess" as const,
  adapter: "fake" as const,
  command: null,
  protocol: null,
  turnTimeoutMs: null,
  stallTimeoutMs: 300_000,
};

test("createWorkflowAgentAdapter uses harness fake for fake adapter", () => {
  const adapter = createWorkflowAgentAdapter(FAKE_IMPL);
  const harnessFake = createFakeCodeReviewAdapter();
  expect(adapter.constructor).toBe(harnessFake.constructor);
});

test("readTriageQueueFile reads valid triage-queue.json", async () => {
  const dir = join(tmpdir(), `triage-read-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "triage-queue.json"),
    JSON.stringify({
      schemaId: TRIAGE_ENVELOPE_SCHEMA_ID,
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      workspacePath: dir,
      outputSlug: "pr-feedback-test",
      items: [
        {
          id: "item-1",
          kind: "pr_review_thread",
          severity: "warning",
          title: "Fix me",
          detail: "detail",
          anchors: [{ path: "a.ts", line: 2 }],
          source: { producer: "pr-feedback", threadId: "t1" },
        },
      ],
    }),
    "utf8",
  );
  const envelope = await readTriageQueueFile(dir);
  expect(envelope?.items).toHaveLength(1);
  expect(envelope?.items[0]?.id).toBe("item-1");
  await rm(dir, { recursive: true, force: true });
});

test("readTriageQueueFile returns null when missing", async () => {
  const dir = join(tmpdir(), `triage-miss-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  expect(await readTriageQueueFile(dir)).toBeNull();
  await rm(dir, { recursive: true, force: true });
});

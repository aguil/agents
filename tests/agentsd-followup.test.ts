import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "@aguil/agents-tracker";
import { FakeWorkFeed, parsePrFeedbackIdentifier } from "@aguil/agents-tracker";
import { WorkQueueOrchestrator } from "@aguil/agents-work-queue";
import {
  applyCodexAlias,
  applySelectionCommand,
  isPrApprovedForWork,
  parsePrFeedbackPolicy,
  readSelectionDocument,
  upsertPendingFromWorkItems,
  writeSelectionDocument,
} from "@aguil/agents-workflow";

test("parsePrFeedbackIdentifier parses owner/repo pull suffix", () => {
  expect(parsePrFeedbackIdentifier("aguil/agents#43-feedback")).toEqual({
    repository: "aguil/agents",
    pullNumber: 43,
  });
  expect(parsePrFeedbackIdentifier("not-feedback")).toBeNull();
});

test("applyCodexAlias ignores codex.protocol", () => {
  const agent = applyCodexAlias({}, { protocol: "codex_app_server_v2" });
  expect(agent.protocol).toBeUndefined();
});

test("parsePrFeedbackPolicy defaults to interactive", () => {
  const policy = parsePrFeedbackPolicy({});
  expect(policy.profile).toBe("interactive");
  expect(policy.notifyChannels.some((c) => c.kind === "jsonl")).toBe(true);
});

test("selection store approve and isPrApprovedForWork", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sel-"));
  try {
    let doc = await readSelectionDocument(dir);
    doc = upsertPendingFromWorkItems({
      existing: doc,
      entries: [
        {
          identifier: "org/repo#1",
          title: "t",
          url: "https://example.com",
          unresolvedThreads: 2,
          reason: "test",
        },
      ],
    });
    doc = applySelectionCommand({
      doc,
      approve: ["org/repo#1"],
    });
    await writeSelectionDocument(dir, doc);
    const approved = new Set(doc.approved);
    expect(
      isPrApprovedForWork(policyInteractive(), approved, {
        repository: "org/repo",
        pull_number: "1",
      }),
    ).toBe(true);
    expect(
      isPrApprovedForWork(policyInteractive(), approved, {
        repository: "org/repo",
        pull_number: "2",
      }),
    ).toBe(false);
    expect(() =>
      applySelectionCommand({
        doc,
        approve: ["org/repo#99"],
      }),
    ).toThrow(/approval_not_pending/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WorkQueueOrchestrator skips completed items on tick", async () => {
  const item: WorkItem = {
    id: "test/issue/1",
    identifier: "org/repo#1",
    title: "Issue",
    description: null,
    state: "open",
    kind: "github_issue",
    priority: 1,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    branchName: null,
    metadata: {},
  };
  const feed = new FakeWorkFeed([item]);
  let runs = 0;
  const dir = await mkdtemp(join(tmpdir(), "wq-term-"));
  const workflowPath = join(dir, "WORKFLOW.md");
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await writeFile(
    workflowPath,
    `---
polling:
  interval_ms: 50
workspace:
  root: ${join(dir, "ws")}
agent:
  max_concurrent_agents: 2
---
Work
`,
    "utf8",
  );
  const { loadWorkflowFile } = await import("@aguil/agents-workflow");
  const loaded = await loadWorkflowFile(workflowPath);
  const definition = loaded.definition;
  if (definition === undefined) {
    throw new Error("missing definition");
  }

  const orchestrator = new WorkQueueOrchestrator({
    definition,
    feeds: [feed],
    renderPrompt: () => ({ ok: true, prompt: "p" }),
    worker: async () => {
      runs += 1;
      return { status: "succeeded" };
    },
  });

  await orchestrator.tick();
  await orchestrator.flush();
  expect(runs).toBe(1);
  await orchestrator.tick();
  await orchestrator.flush();
  expect(runs).toBe(1);
  await rm(dir, { recursive: true, force: true });
});

test("JsonRpcAgentSessionClient parses fake server output", async () => {
  const serverPath = join(
    import.meta.dir,
    "fixtures",
    "fake-json-rpc-server.ts",
  );
  const { JsonRpcAgentSessionClient } = await import("@aguil/agents-execution");
  const client = new JsonRpcAgentSessionClient({
    command: `bun ${serverPath}`,
    protocol: "json_rpc_session_v1",
  });
  const events = [];
  for await (const event of client.startSession({
    runId: "run-1",
    workspacePath: "/tmp",
    scratchpadPath: "/tmp/scratch",
    prompt: "hello",
  })) {
    events.push(event.type);
  }
  expect(events).toContain("session_started");
  expect(events).toContain("turn_completed");
});

function policyInteractive() {
  return parsePrFeedbackPolicy({
    policy: { pr_feedback: { profile: "interactive" } },
  });
}

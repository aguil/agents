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

test("ingestReasonForPull flags fingerprint delta as new_review_activity", async () => {
  const {
    emptyIngestDocument,
    ingestReasonForPull,
    threadActivityFingerprint,
  } = await import("@aguil/agents-tracker");
  const prior = emptyIngestDocument();
  const fp1 = threadActivityFingerprint([{ id: "t1" }]);
  expect(
    ingestReasonForPull({
      identifier: "org/repo#1-feedback",
      fingerprint: fp1,
      threadCount: 1,
      prior,
    }).reason,
  ).toBe("new_review_activity");
  const doc = {
    ...prior,
    pulls: {
      "org/repo#1-feedback": {
        threadFingerprint: fp1,
        threadCount: 1,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    },
  };
  const fp2 = threadActivityFingerprint([{ id: "t1" }, { id: "t2" }]);
  expect(
    ingestReasonForPull({
      identifier: "org/repo#1-feedback",
      fingerprint: fp2,
      threadCount: 2,
      prior: doc,
    }).reason,
  ).toBe("new_review_activity");
  expect(
    ingestReasonForPull({
      identifier: "org/repo#1-feedback",
      fingerprint: fp1,
      threadCount: 1,
      prior: doc,
    }),
  ).toEqual({ enqueue: false, reason: "unchanged_threads" });
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

async function prFeedbackOrchestratorHarness(input: {
  readonly closeWorkItem: boolean;
}): Promise<{
  runs: number;
  feed: FakeWorkFeed;
  cleanup: () => Promise<void>;
}> {
  const item: WorkItem = {
    id: "org/repo/pull/1/feedback",
    identifier: "org/repo#1-feedback",
    title: "PR feedback",
    description: "1 unresolved review thread(s)",
    state: "feedback_pending",
    kind: "github_pr_feedback",
    priority: 2,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    branchName: null,
    metadata: {
      repository: "org/repo",
      pull_number: "1",
      unresolved_thread_count: "1",
    },
  };
  const feed = new FakeWorkFeed([item], [], "github_pr_feedback");
  let runs = 0;
  const dir = await mkdtemp(join(tmpdir(), "wq-prfb-"));
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

  let now = 0;
  const orchestrator = new WorkQueueOrchestrator({
    definition,
    feeds: [feed],
    renderPrompt: () => ({ ok: true, prompt: "p" }),
    now: () => now,
    worker: async () => {
      runs += 1;
      return { status: "succeeded", closeWorkItem: input.closeWorkItem };
    },
  });

  await orchestrator.tick();
  await orchestrator.flush();
  now += definition.pollingIntervalMs + 1;
  await orchestrator.tick();
  await orchestrator.flush();

  return {
    runs,
    feed,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("WorkQueueOrchestrator re-dispatches github_pr_feedback while threads stay open", async () => {
  const { runs, feed, cleanup } = await prFeedbackOrchestratorHarness({
    closeWorkItem: false,
  });
  try {
    expect(runs).toBe(2);
    expect(feed.fetchStatesCalls).toBe(0);
  } finally {
    await cleanup();
  }
});

test("WorkQueueOrchestrator closes github_pr_feedback after closeWorkItem success", async () => {
  const { runs, cleanup } = await prFeedbackOrchestratorHarness({
    closeWorkItem: true,
  });
  try {
    expect(runs).toBe(1);
  } finally {
    await cleanup();
  }
});

test("loadWorkflowFile maps github_issues max_concurrent to github_issue cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wf-cap-"));
  try {
    const workflowPath = join(dir, "WORKFLOW.md");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      workflowPath,
      `---
feeds:
  - kind: github_issues
    repository: org/repo
    max_concurrent: 1
---
Work
`,
      "utf8",
    );
    const { loadWorkflowFile } = await import("@aguil/agents-workflow");
    const loaded = await loadWorkflowFile(workflowPath);
    expect(loaded.definition?.perFeedMaxConcurrent.github_issue).toBe(1);
    expect(
      loaded.definition?.perFeedMaxConcurrent.github_issues,
    ).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("per-feed max_concurrent limits concurrent github_issue dispatches", async () => {
  const item = (n: number): WorkItem => ({
    id: `test/issue/${n}`,
    identifier: `org/repo#${n}`,
    title: `Issue ${n}`,
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
  });
  const feed = new FakeWorkFeed([item(1), item(2)], [], "github_issues");
  const dir = await mkdtemp(join(tmpdir(), "wq-cap-"));
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
  max_concurrent_agents: 5
feeds:
  - kind: github_issues
    repository: org/repo
    max_concurrent: 1
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
  let inFlight = 0;
  let maxInFlight = 0;
  const orchestrator = new WorkQueueOrchestrator({
    definition,
    feeds: [feed],
    perFeedMaxConcurrent: definition.perFeedMaxConcurrent,
    renderPrompt: () => ({ ok: true, prompt: "p" }),
    worker: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return { status: "succeeded" };
    },
  });
  await orchestrator.tick();
  await orchestrator.flush();
  expect(maxInFlight).toBe(1);
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

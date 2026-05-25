import { expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeWorkFeed, type WorkItem } from "@aguil/agents-tracker";
import { WorkQueueOrchestrator } from "@aguil/agents-work-queue";
import { loadWorkflowFile } from "@aguil/agents-workflow";

async function workflowDir(prefix: string): Promise<{
  readonly dir: string;
  readonly workflowPath: string;
  readonly workspaceRoot: string;
}> {
  const dir = await fsp.mkdtemp(join(tmpdir(), prefix));
  const workflowPath = join(dir, "WORKFLOW.md");
  const workspaceRoot = join(dir, "ws");
  await fsp.mkdir(workspaceRoot, { recursive: true });
  return { dir, workflowPath, workspaceRoot };
}

test("updateDefinition applies new polling interval on next schedule", async () => {
  const { dir, workflowPath, workspaceRoot } = await workflowDir("wq-reload-");
  const item: WorkItem = {
    id: "test/1",
    identifier: "PROJ-1",
    title: "Test",
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
  await fsp.writeFile(
    workflowPath,
    `---
polling:
  interval_ms: 5000
workspace:
  root: ${workspaceRoot}
agent:
  max_concurrent_agents: 1
---
Work
`,
    "utf8",
  );
  const loaded = await loadWorkflowFile(workflowPath);
  const definition = loaded.definition;
  if (definition === undefined) {
    throw new Error("missing definition");
  }
  const orchestrator = new WorkQueueOrchestrator({
    definition,
    feeds: [new FakeWorkFeed([item])],
    renderPrompt: () => ({ ok: true, prompt: "p" }),
    worker: async () => ({ status: "succeeded" }),
  });
  orchestrator.updateDefinition({
    ...definition,
    pollingIntervalMs: 100,
    publish: {
      ...definition.publish,
      codeReview: { ...definition.publish.codeReview, mode: "notify" },
    },
  });
  await orchestrator.tick();
  await orchestrator.flush();
  await fsp.rm(dir, { recursive: true, force: true });
});

test("stopAndDrain waits for in-flight worker", async () => {
  const { dir, workflowPath, workspaceRoot } = await workflowDir("wq-drain-");
  const item: WorkItem = {
    id: "test/1",
    identifier: "PROJ-1",
    title: "Test",
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
  await fsp.writeFile(
    workflowPath,
    `---
polling:
  interval_ms: 50
workspace:
  root: ${workspaceRoot}
agent:
  max_concurrent_agents: 1
---
Work
`,
    "utf8",
  );
  const loaded = await loadWorkflowFile(workflowPath);
  const definition = loaded.definition;
  if (definition === undefined) {
    throw new Error("missing definition");
  }
  let finished = false;
  const orchestrator = new WorkQueueOrchestrator({
    definition,
    feeds: [new FakeWorkFeed([item])],
    renderPrompt: () => ({ ok: true, prompt: "p" }),
    worker: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      finished = true;
      return { status: "succeeded" };
    },
  });
  const tickPromise = orchestrator.tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const drainPromise = orchestrator.stopAndDrain({ timeoutMs: 2000 });
  await Promise.all([tickPromise, drainPromise]);
  expect(finished).toBe(true);
  await fsp.rm(dir, { recursive: true, force: true });
});

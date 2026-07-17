import { expect, test } from "bun:test";
import type { AgentAdapter } from "@aguil/agents-execution";
import type { WorkItem } from "@aguil/agents-tracker";
import type { WorkerContext } from "@aguil/agents-workers";
import {
  builtinWorkerHandlers,
  createWorkerRouter,
} from "@aguil/agents-workers";
import type { WorkflowDefinition } from "@aguil/agents-workflow";

const stubAdapter: AgentAdapter = {
  name: "stub",
  capabilities: () => ({
    streaming: false,
    structuredOutput: false,
    readOnlyMode: false,
    mcp: false,
    cancellation: false,
  }),
  // biome-ignore lint/correctness/useYield: intentionally inert stub
  async *run() {
    throw new Error("stub adapter must not run in registry tests");
  },
};

function makeDefinition(
  workers: Readonly<Record<string, string>>,
): WorkflowDefinition {
  return {
    workers,
    implementation: {},
  } as unknown as WorkflowDefinition;
}

function makeItem(kind: string): WorkItem {
  return {
    id: "item-1",
    kind,
    identifier: "test/item-1",
    title: "test item",
    state: "open",
  } as unknown as WorkItem;
}

test("custom worker kind dispatches via options.workers without router edits", async () => {
  const seen: WorkerContext[] = [];
  const router = createWorkerRouter({
    definition: makeDefinition({ incident_alert: "incident_triage" }),
    adapter: stubAdapter,
    hostWorkspacePath: "/host",
    workers: {
      incident_triage: async (context) => {
        seen.push(context);
        return { status: "succeeded" };
      },
    },
  });

  const result = await router({
    item: makeItem("incident_alert"),
    workspacePath: "/ws",
    attempt: 1,
    prompt: "triage it",
  });

  expect(result.status).toBe("succeeded");
  expect(seen).toHaveLength(1);
  expect(seen[0].hostWorkspacePath).toBe("/host");
  expect(seen[0].prompt).toBe("triage it");
  expect(seen[0].adapter.name).toBe("stub");
});

test("custom handlers can override builtins", async () => {
  const router = createWorkerRouter({
    definition: makeDefinition({}),
    adapter: stubAdapter,
    hostWorkspacePath: "/host",
    workers: {
      code_review: async () => ({ status: "succeeded" }),
    },
  });

  const result = await router({
    item: makeItem("github_pr_review"),
    workspacePath: "/ws",
    attempt: 1,
    prompt: "",
  });
  expect(result.status).toBe("succeeded");
});

test("unmapped worker kind fails cleanly instead of falling through", async () => {
  const router = createWorkerRouter({
    definition: makeDefinition({ webhook_alert: "nonexistent_kind" }),
    adapter: stubAdapter,
    hostWorkspacePath: "/host",
  });

  const result = await router({
    item: makeItem("webhook_alert"),
    workspacePath: "/ws",
    attempt: 1,
    prompt: "",
  });
  expect(result.status).toBe("failed");
  expect(result.error).toContain(
    "no worker registered for kind nonexistent_kind",
  );
});

test("handler exceptions become failed results", async () => {
  const router = createWorkerRouter({
    definition: makeDefinition({ boom_item: "boom" }),
    adapter: stubAdapter,
    hostWorkspacePath: "/host",
    workers: {
      boom: async () => {
        throw new Error("handler exploded");
      },
    },
  });

  const result = await router({
    item: makeItem("boom_item"),
    workspacePath: "/ws",
    attempt: 1,
    prompt: "",
  });
  expect(result.status).toBe("failed");
  expect(result.error).toContain("handler exploded");
});

test("builtin handlers cover the three legacy kinds", () => {
  const builtins = builtinWorkerHandlers();
  expect([...Object.keys(builtins)].sort()).toEqual([
    "code_review",
    "implementation",
    "pr_feedback",
  ]);
});

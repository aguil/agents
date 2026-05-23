import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppServerAgentAdapter,
  FakeAgentSessionClient,
  SessionAgentAdapter,
} from "@aguil/agents-execution";
import {
  evaluateCodeReviewPublish,
  evaluatePrFeedbackPublish,
  isCodeReviewDryRunResultPath,
} from "@aguil/agents-publish";
import { FakeWorkFeed, type WorkItem } from "@aguil/agents-tracker";
import { WorkQueueOrchestrator } from "@aguil/agents-work-queue";
import {
  applyCodexAlias,
  loadWorkflowFile,
  renderStrictTemplate,
  validateImplementationRuntime,
  validateWorkflowDefinition,
} from "@aguil/agents-workflow";
import {
  assertWorkspaceInsideRoot,
  sanitizeWorkspaceKey,
} from "@aguil/agents-workspace";
import { parseYamlFrontMatter } from "../packages/workflow/src/yaml-front-matter";

test("parseYamlFrontMatter reads nested feed config", () => {
  const parsed = parseYamlFrontMatter(`
feeds:
  - kind: github_pr_review
    max_open: 3
publish:
  code_review: off
  pr_feedback: off
`);
  expect(parsed.feeds).toBeDefined();
});

test("parseYamlFrontMatter parses feed active_states and terminal_states lists", () => {
  const parsed = parseYamlFrontMatter(`
feeds:
  - kind: github_issues
    repository: org/repo
    active_states:
      - open
    terminal_states:
      - closed
`);
  const feeds = parsed.feeds as Array<Record<string, unknown>>;
  expect(feeds[0]?.active_states).toEqual(["open"]);
  expect(feeds[0]?.terminal_states).toEqual(["closed"]);
});

test("loadWorkflowFile defaults publish to off", async () => {
  const dir = join(tmpdir(), `wf-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "WORKFLOW.md");
  await writeFile(
    path,
    `---
feeds:
  - kind: fake
publish:
  code_review: off
---
Review {{ issue.identifier }}
`,
    "utf8",
  );
  const result = await loadWorkflowFile(path);
  expect(result.error).toBeUndefined();
  expect(result.definition?.publish.codeReview.mode).toBe("off");
  expect(result.definition?.publish.prFeedback.mode).toBe("off");
  await rm(dir, { recursive: true, force: true });
});

test("renderStrictTemplate fails on unknown variable", () => {
  const rendered = renderStrictTemplate("Hello {{ missing }}", {
    issue: { id: "1" },
  });
  expect("ok" in rendered && rendered.ok).toBe(false);
});

test("evaluateCodeReviewPublish stays off by default", () => {
  const decision = evaluateCodeReviewPublish({
    publish: {
      codeReview: {
        mode: "off",
        reviewSummary: "impact",
        staleHead: "skip",
        replacePending: false,
        requireEmptyTriage: true,
      },
      prFeedback: {
        mode: "off",
        requireEmptyTriage: true,
        requireResponsesDocument: true,
      },
    },
    result: { runId: "r1", status: "passed", findings: [], artifacts: [] },
    resultPath: "/tmp/result.json",
    triageItemCount: 0,
    isDryRunPath: false,
  });
  expect(decision.shouldPublish).toBe(false);
  expect(decision.skipReason).toBe("publish_mode_off");
});

test("WorkQueueOrchestrator dispatches fake feed item", async () => {
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
  const feed = new FakeWorkFeed([item]);
  const dir = join(tmpdir(), `wq-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const workflowPath = join(dir, "WORKFLOW.md");
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
Do work on {{ issue.identifier }}
`,
    "utf8",
  );
  const loaded = await loadWorkflowFile(workflowPath);
  const definition = loaded.definition;
  expect(definition).toBeDefined();
  if (definition === undefined) {
    return;
  }

  let ran = false;
  const orchestrator = new WorkQueueOrchestrator({
    definition,
    feeds: [feed],
    renderPrompt: () => ({ ok: true, prompt: "test prompt" }),
    worker: async () => {
      ran = true;
      return { status: "succeeded" };
    },
    now: () => Date.now(),
  });

  await orchestrator.tick();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(ran).toBe(true);
  await rm(dir, { recursive: true, force: true });
});

test("sanitizeWorkspaceKey replaces unsafe characters", () => {
  expect(sanitizeWorkspaceKey("org/repo#1-review")).toBe("org_repo_1-review");
});

test("assertWorkspaceInsideRoot rejects escape", () => {
  expect(() => assertWorkspaceInsideRoot("/tmp/root", "/tmp/other")).toThrow();
});

test("codex front matter aliases into agent runtime", () => {
  const agent = applyCodexAlias(
    {},
    { command: "codex app-server", stall_timeout_ms: 120000 },
  );
  expect(agent.command).toBe("codex app-server");
  expect(agent.runtime).toBe("app_server");
});

test("validateImplementationRuntime requires command for app_server", () => {
  const err = validateImplementationRuntime({
    mode: "app_server",
    adapter: "fake",
    command: null,
    protocol: null,
    turnTimeoutMs: null,
    stallTimeoutMs: 300_000,
  });
  expect(err).toContain("agent.command");
});

test("loadWorkflowFile parses execution.implementation", async () => {
  const dir = join(tmpdir(), `wf-impl-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "WORKFLOW.md");
  await writeFile(
    path,
    `---
agent:
  runtime: subprocess
execution:
  implementation:
    mode: subprocess
    adapter: fake
---
`,
    "utf8",
  );
  const result = await loadWorkflowFile(path);
  expect(result.definition?.implementation.mode).toBe("subprocess");
  expect(result.definition?.implementation.adapter).toBe("fake");
  if (result.definition !== undefined) {
    expect(validateWorkflowDefinition(result.definition)).toBeUndefined();
  }
  await rm(dir, { recursive: true, force: true });
});

test("SessionAgentAdapter uses neutral usage telemetry fields", async () => {
  const adapter = new SessionAgentAdapter({ command: "my-agent serve" });
  let completedData: Record<string, unknown> | undefined;
  for await (const event of adapter.run({
    runId: "run-1",
    roleId: "implementation",
    prompt: "implement",
    workspacePath: "/tmp/ws",
    contextBundlePath: "/tmp/ctx.json",
    scratchpadPath: join(tmpdir(), `sess-${Date.now()}`),
    timeoutMs: 1000,
    allowedCommands: [],
  })) {
    if (event.type === "completed" && typeof event.data === "object") {
      completedData = event.data as Record<string, unknown>;
    }
  }
  expect(completedData?.usage_total_tokens).toBe(0);
  expect(completedData?.codex_total_tokens).toBeUndefined();
});

test("AppServerAgentAdapter is alias for SessionAgentAdapter", () => {
  expect(AppServerAgentAdapter).toBe(SessionAgentAdapter);
});

test("FakeAgentSessionClient runs multi-turn loop", async () => {
  const client = new FakeAgentSessionClient({ turnsBeforeComplete: 2 });
  const events: string[] = [];
  for await (const e of client.startSession({
    runId: "r1",
    workspacePath: "/tmp",
    scratchpadPath: "/tmp/s",
    prompt: "do work",
  })) {
    events.push(e.type);
  }
  for await (const e of client.continueTurn({
    runId: "r1",
    guidance: "continue",
    turnIndex: 1,
  })) {
    events.push(e.type);
  }
  expect(events.filter((t) => t === "turn_completed").length).toBeGreaterThan(
    0,
  );
});

test("isCodeReviewDryRunResultPath detects dry-run roots", () => {
  const ws = "/tmp/agents-ws";
  expect(
    isCodeReviewDryRunResultPath(
      ws,
      `${ws}/.agents-code-review/dry-run/run-1/result.json`,
    ),
  ).toBe(true);
  expect(
    isCodeReviewDryRunResultPath(
      ws,
      `${ws}/.agents-code-review/runs/run-1/result.json`,
    ),
  ).toBe(false);
});

test("evaluatePrFeedbackPublish requires responses for submit", () => {
  const decision = evaluatePrFeedbackPublish({
    publish: {
      codeReview: {
        mode: "off",
        reviewSummary: "impact",
        staleHead: "skip",
        replacePending: false,
        requireEmptyTriage: true,
      },
      prFeedback: {
        mode: "submit",
        requireEmptyTriage: true,
        requireResponsesDocument: true,
      },
    },
    triageItemCount: 0,
    responsesPath: undefined,
  });
  expect(decision.shouldPublish).toBe(false);
  expect(decision.skipReason).toBe("responses_document_missing");
});

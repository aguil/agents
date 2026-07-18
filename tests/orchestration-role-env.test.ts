import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRunRequest } from "@aguil/agents-core";
import { createAgentEvent } from "@aguil/agents-core";
import type { AgentAdapter, AgentRunRequest } from "@aguil/agents-execution";
import {
  collectAgentRun,
  SubprocessAgentAdapter,
} from "@aguil/agents-execution";
import type {
  HarnessDefinition,
  RoleDefinition,
} from "@aguil/agents-orchestration";
import { NativeBunOrchestrator } from "@aguil/agents-orchestration";

function makeRole(id: string): RoleDefinition {
  return {
    id,
    description: `${id} role`,
    prompt: `${id} prompt`,
    requiredCapabilities: [],
    timeoutMs: 1000,
  };
}

function createCapturingAdapter(): {
  readonly adapter: AgentAdapter;
  readonly requests: AgentRunRequest[];
} {
  const requests: AgentRunRequest[] = [];
  const adapter: AgentAdapter = {
    name: "capturing",
    capabilities: () => ({
      streaming: true,
      structuredOutput: true,
      readOnlyMode: true,
      mcp: false,
      cancellation: true,
    }),
    async *run(request) {
      requests.push(request);
      yield createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "started",
        message: `${request.roleId} started`,
      });
      yield createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "completed",
        message: `${request.roleId} completed`,
      });
    },
  };
  return { adapter, requests };
}

async function withTempDir<T>(
  fn: (tempPath: string) => Promise<T>,
): Promise<T> {
  const tempPath = await mkdtemp(join(tmpdir(), "orchestration-role-env-"));
  try {
    return await fn(tempPath);
  } finally {
    await rm(tempPath, { recursive: true, force: true });
  }
}

function makeRequest(tempPath: string): HarnessRunRequest {
  return {
    runId: "role-env-run",
    harnessId: "role-env-harness",
    workspacePath: tempPath,
    scratchpadPath: tempPath,
  };
}

function makeDefinition(
  execution?: HarnessDefinition["execution"],
): HarnessDefinition {
  return {
    id: "role-env-harness",
    roles: [makeRole("scout"), makeRole("fix")],
    ...(execution === undefined ? {} : { execution }),
  };
}

function expectDistinctRoleEnv(requests: readonly AgentRunRequest[]): void {
  expect(requests).toHaveLength(2);
  expect(
    Object.fromEntries(
      requests.map((request) => [
        request.roleId,
        request.env?.AGENTS_POLICY_ID,
      ]),
    ),
  ).toEqual({
    scout: "policy-for-scout",
    fix: "policy-for-fix",
  });
}

test("chain mode attaches distinct environment to each role request", async () => {
  await withTempDir(async (tempPath) => {
    const { adapter, requests } = createCapturingAdapter();
    const orchestrator = new NativeBunOrchestrator({
      definition: makeDefinition({ mode: "chain" }),
      adapter,
      contextBundlePath: join(tempPath, "context.json"),
      roleEnv: (roleId) => ({
        AGENTS_POLICY_ID: `policy-for-${roleId}`,
      }),
    });

    await orchestrator.run(makeRequest(tempPath));

    expectDistinctRoleEnv(requests);
  });
});

test("parallel mode attaches distinct environment to each role request", async () => {
  await withTempDir(async (tempPath) => {
    const { adapter, requests } = createCapturingAdapter();
    const orchestrator = new NativeBunOrchestrator({
      definition: makeDefinition(),
      adapter,
      contextBundlePath: join(tempPath, "context.json"),
      roleEnv: (roleId) => ({
        AGENTS_POLICY_ID: `policy-for-${roleId}`,
      }),
    });

    await orchestrator.run(makeRequest(tempPath));

    expectDistinctRoleEnv(requests);
  });
});

test("role requests omit env when roleEnv is not provided", async () => {
  await withTempDir(async (tempPath) => {
    const { adapter, requests } = createCapturingAdapter();
    const orchestrator = new NativeBunOrchestrator({
      definition: makeDefinition(),
      adapter,
      contextBundlePath: join(tempPath, "context.json"),
    });

    await orchestrator.run(makeRequest(tempPath));

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.env === undefined)).toBe(true);
  });
});

test("SubprocessAgentAdapter merges request env into subprocess environment", async () => {
  await withTempDir(async (tempPath) => {
    const adapter = new SubprocessAgentAdapter({
      name: "request-env",
      capabilities: {
        streaming: true,
        structuredOutput: false,
        readOnlyMode: true,
        mcp: false,
        cancellation: true,
      },
      buildCommand: () => ({
        cmd: ["sh", "-c", "echo sentinel=$AGENTS_TEST_SENTINEL"],
      }),
    });
    const request: AgentRunRequest = {
      runId: "subprocess-env-run",
      roleId: "test-role",
      prompt: "test prompt",
      workspacePath: tempPath,
      contextBundlePath: join(tempPath, "context.json"),
      scratchpadPath: join(tempPath, "scratchpad"),
      timeoutMs: 1000,
      allowedCommands: [],
      env: { AGENTS_TEST_SENTINEL: "from-request-env" },
    };

    const { events, result } = await collectAgentRun(adapter, request);

    expect(result.status).toBe("completed");
    expect(
      events.some(
        (event) =>
          event.type === "stdout" &&
          event.message?.includes("sentinel=from-request-env") === true,
      ),
    ).toBe(true);
  });
});

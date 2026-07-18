import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Finding,
  HarnessOutcome,
  HarnessRunRequest,
} from "@aguil/agents-core";
import { createAgentEvent } from "@aguil/agents-core";
import type { AgentAdapter, AgentRunRequest } from "@aguil/agents-execution";
import type {
  HarnessDefinition,
  RoleDefinition,
} from "@aguil/agents-orchestration";
import {
  NativeBunOrchestrator,
  truncateRoleOutput,
} from "@aguil/agents-orchestration";

function makeFinding(roleId: string, id: string): Finding {
  return {
    id,
    severity: "warning",
    title: `${roleId} finding`,
    description: `emitted by ${roleId}`,
    evidence: "test evidence",
    sourceRole: roleId,
    validation: { status: "not_run", details: "not validated in test" },
  };
}

interface RoleScript {
  readonly findings?: readonly Finding[];
  readonly outcomes?: readonly HarnessOutcome[];
  readonly fail?: boolean;
  /** Findings per invocation; overrides `findings` when set. */
  readonly perInvocation?: readonly (readonly Finding[])[];
}

/** Fake adapter that records prompts and plays back scripted events. */
function createScriptedAdapter(scripts: Readonly<Record<string, RoleScript>>): {
  readonly adapter: AgentAdapter;
  readonly promptsByRole: Map<string, string[]>;
  readonly invocationOrder: string[];
} {
  const promptsByRole = new Map<string, string[]>();
  const invocationCounts = new Map<string, number>();
  const invocationOrder: string[] = [];
  const adapter: AgentAdapter = {
    name: "scripted",
    capabilities: () => ({
      streaming: false,
      structuredOutput: true,
      readOnlyMode: true,
      mcp: false,
      cancellation: false,
    }),
    async *run(request: AgentRunRequest) {
      invocationOrder.push(request.roleId);
      const prompts = promptsByRole.get(request.roleId) ?? [];
      prompts.push(request.prompt);
      promptsByRole.set(request.roleId, prompts);

      const invocation = invocationCounts.get(request.roleId) ?? 0;
      invocationCounts.set(request.roleId, invocation + 1);

      const script = scripts[request.roleId] ?? {};
      const findings =
        script.perInvocation?.[invocation] ?? script.findings ?? [];
      for (const finding of findings) {
        yield createAgentEvent({
          runId: request.runId,
          roleId: request.roleId,
          type: "finding",
          data: finding,
        });
      }
      for (const outcome of script.outcomes ?? []) {
        yield createAgentEvent({
          runId: request.runId,
          roleId: request.roleId,
          type: "outcome",
          data: outcome,
        });
      }
      if (script.fail === true) {
        yield createAgentEvent({
          runId: request.runId,
          roleId: request.roleId,
          type: "error",
          data: { reason: "boom" },
        });
      }
    },
  };
  return { adapter, promptsByRole, invocationOrder };
}

function makeRole(id: string, prompt: string): RoleDefinition {
  return {
    id,
    description: `${id} role`,
    prompt,
    requiredCapabilities: [],
    timeoutMs: 1000,
  };
}

async function withScratchpad<T>(
  fn: (scratchpadPath: string) => Promise<T>,
): Promise<T> {
  const scratchpadPath = await mkdtemp(join(tmpdir(), "exec-modes-"));
  try {
    return await fn(scratchpadPath);
  } finally {
    await rm(scratchpadPath, { recursive: true, force: true });
  }
}

function makeRequest(scratchpadPath: string): HarnessRunRequest {
  return {
    runId: "run-test",
    harnessId: "test-harness",
    workspacePath: scratchpadPath,
    scratchpadPath,
  };
}

test("chain mode runs roles sequentially and interpolates {previous} and {outputs.X}", async () => {
  await withScratchpad(async (scratchpadPath) => {
    const scoutFinding = makeFinding("scout", "scout-1");
    const { adapter, promptsByRole, invocationOrder } = createScriptedAdapter({
      scout: { findings: [scoutFinding] },
      diagnose: { findings: [makeFinding("diagnose", "diag-1")] },
      fix: {},
    });
    const definition: HarnessDefinition = {
      id: "triage",
      roles: [
        makeRole("scout", "Investigate."),
        makeRole("diagnose", "Diagnose using:\n{previous}"),
        makeRole("fix", "Fix per scout findings:\n{outputs.scout}"),
      ],
      execution: { mode: "chain" },
    };
    const orchestrator = new NativeBunOrchestrator({
      definition,
      adapter,
      contextBundlePath: join(scratchpadPath, "context.json"),
    });

    const result = await orchestrator.run(makeRequest(scratchpadPath));

    expect(invocationOrder).toEqual(["scout", "diagnose", "fix"]);
    const diagnosePrompt = promptsByRole.get("diagnose")?.[0] ?? "";
    expect(diagnosePrompt).toContain("scout-1");
    expect(diagnosePrompt).not.toContain("{previous}");
    const fixPrompt = promptsByRole.get("fix")?.[0] ?? "";
    expect(fixPrompt).toContain("scout-1");
    expect(fixPrompt).not.toContain("{outputs.scout}");
    expect(result.metadata?.execution_mode).toBe("chain");
    expect(result.metadata?.completed_roles).toBe("scout,diagnose,fix");
    expect(result.outcomes?.length).toBe(2);
  });
});

test("chain mode aborts at first failed step", async () => {
  await withScratchpad(async (scratchpadPath) => {
    const { adapter, invocationOrder } = createScriptedAdapter({
      scout: {},
      diagnose: { fail: true },
      fix: {},
    });
    const definition: HarnessDefinition = {
      id: "triage",
      roles: [
        makeRole("scout", "Investigate."),
        makeRole("diagnose", "Diagnose."),
        makeRole("fix", "Fix."),
      ],
      execution: { mode: "chain" },
    };
    const orchestrator = new NativeBunOrchestrator({
      definition,
      adapter,
      contextBundlePath: join(scratchpadPath, "context.json"),
    });

    const result = await orchestrator.run(makeRequest(scratchpadPath));

    expect(invocationOrder).toEqual(["scout", "diagnose"]);
    expect(result.status).toBe("error");
    expect(result.metadata?.failed_roles).toBe("diagnose");
  });
});

test("chain mode honors explicit order and rejects unknown roles", async () => {
  await withScratchpad(async (scratchpadPath) => {
    const { adapter, invocationOrder } = createScriptedAdapter({});
    const definition: HarnessDefinition = {
      id: "triage",
      roles: [makeRole("b", "B."), makeRole("a", "A.")],
      execution: { mode: "chain", order: ["a", "b"] },
    };
    const orchestrator = new NativeBunOrchestrator({
      definition,
      adapter,
      contextBundlePath: join(scratchpadPath, "context.json"),
    });
    await orchestrator.run(makeRequest(scratchpadPath));
    expect(invocationOrder).toEqual(["a", "b"]);

    const badDefinition: HarnessDefinition = {
      ...definition,
      execution: { mode: "chain", order: ["a", "missing"] },
    };
    const badOrchestrator = new NativeBunOrchestrator({
      definition: badDefinition,
      adapter,
      contextBundlePath: join(scratchpadPath, "context.json"),
    });
    await expect(
      badOrchestrator.run(makeRequest(scratchpadPath)),
    ).rejects.toThrow('unknown role "missing"');
  });
});

test("validation-loop passes on first round when validator emits nothing", async () => {
  await withScratchpad(async (scratchpadPath) => {
    const { adapter, invocationOrder } = createScriptedAdapter({
      worker: { findings: [makeFinding("worker", "w-1")] },
      validator: {},
    });
    const definition: HarnessDefinition = {
      id: "loop",
      roles: [
        makeRole("worker", "Implement. Prior validation:\n{validation}"),
        makeRole("validator", "Validate:\n{previous}"),
      ],
      execution: {
        mode: "validation-loop",
        implementationRoles: ["worker"],
        validationRoles: ["validator"],
        maxRounds: 3,
      },
    };
    const orchestrator = new NativeBunOrchestrator({
      definition,
      adapter,
      contextBundlePath: join(scratchpadPath, "context.json"),
    });

    const result = await orchestrator.run(makeRequest(scratchpadPath));

    expect(invocationOrder).toEqual(["worker", "validator"]);
    expect(result.metadata?.validation_rounds).toBe("1");
    expect(result.metadata?.validation_passed).toBe("true");
  });
});

test("validation-loop retries with {validation} feedback until pass, capped at maxRounds", async () => {
  await withScratchpad(async (scratchpadPath) => {
    const validatorComplaint = makeFinding("validator", "unverified-1");
    const { adapter, promptsByRole } = createScriptedAdapter({
      worker: {},
      // Round 1: validator complains; round 2: clean.
      validator: { perInvocation: [[validatorComplaint], []] },
    });
    const definition: HarnessDefinition = {
      id: "loop",
      roles: [
        makeRole("worker", "Implement. Prior validation:\n{validation}"),
        makeRole("validator", "Validate:\n{previous}"),
      ],
      execution: {
        mode: "validation-loop",
        implementationRoles: ["worker"],
        validationRoles: ["validator"],
        maxRounds: 3,
      },
    };
    const orchestrator = new NativeBunOrchestrator({
      definition,
      adapter,
      contextBundlePath: join(scratchpadPath, "context.json"),
    });

    const result = await orchestrator.run(makeRequest(scratchpadPath));

    expect(result.metadata?.validation_rounds).toBe("2");
    expect(result.metadata?.validation_passed).toBe("true");
    const workerPrompts = promptsByRole.get("worker") ?? [];
    expect(workerPrompts).toHaveLength(2);
    expect(workerPrompts[0]).not.toContain("unverified-1");
    expect(workerPrompts[1]).toContain("unverified-1");
  });
});

test("validation-loop stops at maxRounds without passing", async () => {
  await withScratchpad(async (scratchpadPath) => {
    const { adapter } = createScriptedAdapter({
      worker: {},
      validator: { findings: [makeFinding("validator", "always-failing")] },
    });
    const definition: HarnessDefinition = {
      id: "loop",
      roles: [
        makeRole("worker", "Implement."),
        makeRole("validator", "Validate."),
      ],
      execution: {
        mode: "validation-loop",
        implementationRoles: ["worker"],
        validationRoles: ["validator"],
        maxRounds: 2,
      },
    };
    const orchestrator = new NativeBunOrchestrator({
      definition,
      adapter,
      contextBundlePath: join(scratchpadPath, "context.json"),
    });

    const result = await orchestrator.run(makeRequest(scratchpadPath));

    expect(result.metadata?.validation_rounds).toBe("2");
    expect(result.metadata?.validation_passed).toBe("false");
  });
});

test("default parallel behavior is unchanged and reports execution_mode", async () => {
  await withScratchpad(async (scratchpadPath) => {
    const { adapter, invocationOrder } = createScriptedAdapter({
      a: { findings: [makeFinding("a", "a-1")] },
      b: { findings: [makeFinding("b", "b-1")] },
    });
    const definition: HarnessDefinition = {
      id: "parallel-harness",
      roles: [makeRole("a", "A."), makeRole("b", "B.")],
    };
    const orchestrator = new NativeBunOrchestrator({
      definition,
      adapter,
      contextBundlePath: join(scratchpadPath, "context.json"),
    });

    const result = await orchestrator.run(makeRequest(scratchpadPath));

    expect([...invocationOrder].sort()).toEqual(["a", "b"]);
    expect(result.metadata?.execution_mode).toBe("parallel");
    expect(result.findings).toHaveLength(2);
    // Legacy definitions (no execution config) keep the pre-generalization
    // result shape: no duplicated outcomes payload.
    expect(result.outcomes).toBeUndefined();
  });
});

test("explicit execution config opts in to generic outcomes", async () => {
  await withScratchpad(async (scratchpadPath) => {
    const { adapter } = createScriptedAdapter({
      a: { findings: [makeFinding("a", "a-1")] },
    });
    const definition: HarnessDefinition = {
      id: "opt-in",
      roles: [makeRole("a", "A.")],
      execution: { mode: "parallel" },
    };
    const orchestrator = new NativeBunOrchestrator({
      definition,
      adapter,
      contextBundlePath: join(scratchpadPath, "context.json"),
    });
    const result = await orchestrator.run(makeRequest(scratchpadPath));
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes?.[0].kind).toBe("finding");
  });
});

test("generic outcome events are collected and flow through {previous}", async () => {
  await withScratchpad(async (scratchpadPath) => {
    const diagnosis: HarnessOutcome = {
      id: "diagnosis-1",
      kind: "diagnosis",
      sourceRole: "diagnose",
      title: "Root cause: off-by-one in pagination",
      data: { rootCause: "end index drops final item" },
    };
    const { adapter, promptsByRole } = createScriptedAdapter({
      diagnose: { outcomes: [diagnosis] },
      fix: {},
    });
    const definition: HarnessDefinition = {
      id: "triage",
      roles: [
        makeRole("diagnose", "Diagnose."),
        makeRole("fix", "Fix using:\n{previous}"),
      ],
      execution: { mode: "chain" },
    };
    const orchestrator = new NativeBunOrchestrator({
      definition,
      adapter,
      contextBundlePath: join(scratchpadPath, "context.json"),
    });

    const result = await orchestrator.run(makeRequest(scratchpadPath));

    // The generic outcome reaches the result without masquerading as a
    // Finding, and the next chain step sees it via {previous}.
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes?.[0].kind).toBe("diagnosis");
    expect(result.findings).toHaveLength(0);
    const fixPrompt = promptsByRole.get("fix")?.[0] ?? "";
    expect(fixPrompt).toContain("off-by-one in pagination");
  });
});

test("generalized-harness status ignores finding severity (diagnostic findings do not fail the run)", async () => {
  await withScratchpad(async (scratchpadPath) => {
    // A role emits a critical finding describing the problem it worked on;
    // for a generalized harness that must NOT fail the run.
    const critical: Finding = {
      ...makeFinding("scout", "scout-crit"),
      severity: "critical",
    };
    const { adapter } = createScriptedAdapter({
      scout: { findings: [critical] },
      fix: {},
    });
    const definition: HarnessDefinition = {
      id: "triage",
      roles: [makeRole("scout", "Investigate."), makeRole("fix", "Fix.")],
      execution: { mode: "chain" },
    };
    const orchestrator = new NativeBunOrchestrator({
      definition,
      adapter,
      contextBundlePath: join(scratchpadPath, "context.json"),
    });
    const result = await orchestrator.run(makeRequest(scratchpadPath));
    expect(result.status).toBe("passed");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("critical");
  });
});

test("passGate false fails a generalized run; true passes it", async () => {
  await withScratchpad(async (scratchpadPath) => {
    const definition: HarnessDefinition = {
      id: "triage",
      roles: [makeRole("fix", "Fix.")],
      execution: { mode: "chain" },
    };
    const { adapter } = createScriptedAdapter({ fix: {} });
    const failing = new NativeBunOrchestrator({
      definition,
      adapter,
      contextBundlePath: join(scratchpadPath, "context.json"),
      passGate: () => false,
    });
    expect((await failing.run(makeRequest(scratchpadPath))).status).toBe(
      "failed",
    );
    const passing = new NativeBunOrchestrator({
      definition,
      adapter,
      contextBundlePath: join(scratchpadPath, "context.json"),
      passGate: () => true,
    });
    expect((await passing.run(makeRequest(scratchpadPath))).status).toBe(
      "passed",
    );
  });
});

test("legacy harness (no execution) keeps finding-severity status", async () => {
  await withScratchpad(async (scratchpadPath) => {
    const critical: Finding = {
      ...makeFinding("a", "a-crit"),
      severity: "critical",
    };
    const { adapter } = createScriptedAdapter({ a: { findings: [critical] } });
    const definition: HarnessDefinition = {
      id: "legacy",
      roles: [makeRole("a", "A.")],
    };
    const orchestrator = new NativeBunOrchestrator({
      definition,
      adapter,
      contextBundlePath: join(scratchpadPath, "context.json"),
    });
    // No execution config → code-review semantics: critical finding fails.
    expect((await orchestrator.run(makeRequest(scratchpadPath))).status).toBe(
      "failed",
    );
  });
});

test("onRoleStart fires before each role in chain order", async () => {
  await withScratchpad(async (scratchpadPath) => {
    const { adapter } = createScriptedAdapter({ a: {}, b: {}, c: {} });
    const started: string[] = [];
    const definition: HarnessDefinition = {
      id: "hooked",
      roles: [makeRole("a", "A."), makeRole("b", "B."), makeRole("c", "C.")],
      execution: { mode: "chain", order: ["a", "b", "c"] },
    };
    const orchestrator = new NativeBunOrchestrator({
      definition,
      adapter,
      contextBundlePath: join(scratchpadPath, "context.json"),
      onRoleStart: (roleId) => {
        started.push(roleId);
      },
    });
    await orchestrator.run(makeRequest(scratchpadPath));
    expect(started).toEqual(["a", "b", "c"]);
  });
});

test("truncateRoleOutput enforces line and byte limits", () => {
  const manyLines = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join(
    "\n",
  );
  const lineTruncated = truncateRoleOutput(manyLines);
  expect(lineTruncated.split("\n").length).toBeLessThanOrEqual(2001);
  expect(lineTruncated).toContain("[truncated: 500 more lines]");

  const bigBlob = "x".repeat(60_000);
  const byteTruncated = truncateRoleOutput(bigBlob);
  expect(Buffer.byteLength(byteTruncated, "utf8")).toBeLessThanOrEqual(
    50_000 + 100,
  );
  expect(byteTruncated).toContain("[truncated at 50000 bytes]");
});

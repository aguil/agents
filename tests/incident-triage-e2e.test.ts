import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, HarnessOutcome } from "@aguil/agents-core";
import {
  createAgentEvent,
  harnessOutcomeToFinding,
  isFindingOutcome,
} from "@aguil/agents-core";
import type { AgentAdapter, AgentRunRequest } from "@aguil/agents-execution";
import { normalizeAgentOutputLine } from "@aguil/agents-execution";
import { loadHarness } from "@aguil/agents-harness-config";
import { NativeBunOrchestrator } from "@aguil/agents-orchestration";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const exampleAgentsDir = join(
  repoRoot,
  "examples",
  "incident-triage",
  ".agents",
);
const fixtureDir = join(repoRoot, "examples", "incident-triage", "fixture");

const BUGGY_EXPRESSION = "cursor + pageSize - 1";
const FIXED_EXPRESSION = "cursor + pageSize";

async function runHealthCheck(
  workspacePath: string,
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", "check.ts"],
    cwd: workspacePath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

// Emit the outcome the way a real agent does — as a `{"outcome":{...}}`
// JSON line through the subprocess line parser — so the test exercises the
// actual envelope path, not a hand-built event.
function outcomeEvents(
  request: AgentRunRequest,
  outcome: HarnessOutcome,
): readonly AgentEvent[] {
  return normalizeAgentOutputLine(request, JSON.stringify({ outcome }));
}

/**
 * Deterministic stand-in for a competent live agent: performs the real
 * side effects a triage agent would (read alert, run the health check,
 * patch the bug, re-verify) without an LLM. `applyFix: false` simulates an
 * agent whose remediation does nothing.
 */
function createIncidentAgent(options: { readonly applyFix: boolean }): {
  readonly adapter: AgentAdapter;
  readonly invocationOrder: string[];
  readonly promptsByRole: Map<string, string>;
} {
  const invocationOrder: string[] = [];
  const promptsByRole = new Map<string, string>();
  const adapter: AgentAdapter = {
    name: "scripted-incident-agent",
    capabilities: () => ({
      streaming: true,
      structuredOutput: true,
      readOnlyMode: false,
      mcp: false,
      cancellation: false,
    }),
    async *run(request: AgentRunRequest) {
      invocationOrder.push(request.roleId);
      promptsByRole.set(request.roleId, request.prompt);
      const workspace = request.workspacePath;

      switch (request.roleId) {
        case "scout": {
          const alert = await readFile(join(workspace, "alert.log"), "utf8");
          const check = await runHealthCheck(workspace);
          yield* outcomeEvents(request, {
            id: "scout-evidence",
            kind: "evidence",
            sourceRole: "scout",
            title: "Pagination drops the last item of every page",
            data: {
              alertExcerpt: alert.split("\n")[3] ?? "",
              checkExitCode: check.exitCode,
              checkOutput: check.output.trim(),
              suspectFile: "src/pagination.ts",
            },
          });
          break;
        }
        case "diagnose": {
          const source = await readFile(
            join(workspace, "src", "pagination.ts"),
            "utf8",
          );
          const hasBug = source.includes(BUGGY_EXPRESSION);
          yield* outcomeEvents(request, {
            id: "diagnosis",
            kind: "diagnosis",
            sourceRole: "diagnose",
            title: "Off-by-one in page end index",
            data: {
              rootCause: hasBug
                ? `end index uses \`${BUGGY_EXPRESSION}\`, dropping the final item`
                : "bug expression not found",
              file: "src/pagination.ts",
              remediation: `replace with \`${FIXED_EXPRESSION}\``,
            },
          });
          break;
        }
        case "fix": {
          if (options.applyFix) {
            const path = join(workspace, "src", "pagination.ts");
            const source = await readFile(path, "utf8");
            await writeFile(
              path,
              source.replace(BUGGY_EXPRESSION, FIXED_EXPRESSION),
            );
          }
          const check = await runHealthCheck(workspace);
          yield* outcomeEvents(request, {
            id: "remediation",
            kind: "remediation",
            sourceRole: "fix",
            title: options.applyFix
              ? "Corrected page end index"
              : "No change applied",
            data: {
              applied: options.applyFix,
              checkExitCodeAfterFix: check.exitCode,
            },
          });
          break;
        }
        case "verify": {
          const check = await runHealthCheck(workspace);
          if (check.exitCode !== 0) {
            yield createAgentEvent({
              runId: request.runId,
              roleId: request.roleId,
              type: "finding",
              data: {
                id: "verification-failed",
                severity: "critical",
                title: "Health signal still failing after remediation",
                description:
                  "bun run check.ts exited nonzero after the fix role.",
                evidence: check.output.trim().slice(0, 500),
                sourceRole: "verify",
                validation: {
                  status: "verified",
                  details: `exit code ${check.exitCode} from bun run check.ts`,
                },
              },
            });
          }
          break;
        }
        default:
          throw new Error(`unexpected role ${request.roleId}`);
      }
    },
  };
  return { adapter, invocationOrder, promptsByRole };
}

async function runIncidentTriage(applyFix: boolean) {
  const workspace = await mkdtemp(join(tmpdir(), "incident-e2e-"));
  await cp(fixtureDir, workspace, { recursive: true });
  const loaded = await loadHarness({
    agentsDir: exampleAgentsDir,
    harnessId: "incident-triage",
  });
  const agent = createIncidentAgent({ applyFix });
  const scratchpadPath = join(workspace, ".agents-harness", "runs", "e2e");
  const orchestrator = new NativeBunOrchestrator({
    definition: loaded.definition,
    adapter: agent.adapter,
    contextBundlePath: join(scratchpadPath, "context.json"),
  });
  const result = await orchestrator.run({
    runId: "e2e-incident-triage",
    harnessId: "incident-triage",
    workspacePath: workspace,
    scratchpadPath,
    strictMode: true,
  });
  return { workspace, loaded, agent, result };
}

test("incident-triage chain heals the fixture end to end (happy path)", async () => {
  const { workspace, agent, result } = await runIncidentTriage(true);
  try {
    // Chain order is the configured one.
    expect(agent.invocationOrder).toEqual([
      "scout",
      "diagnose",
      "fix",
      "verify",
    ]);

    // The workspace is actually healed: the health signal flips to 0.
    const finalCheck = await runHealthCheck(workspace);
    expect(finalCheck.exitCode).toBe(0);

    // Verify stayed silent, so the run passes with zero findings.
    expect(result.status).toBe("passed");
    expect(result.findings).toHaveLength(0);

    // Falsification core: outcomes are generic kinds, not findings.
    const kinds = (result.outcomes ?? []).map((outcome) => outcome.kind);
    expect(kinds).toEqual(["evidence", "diagnosis", "remediation"]);
    for (const outcome of result.outcomes ?? []) {
      expect(isFindingOutcome(outcome)).toBe(false);
      expect(harnessOutcomeToFinding(outcome)).toBeUndefined();
    }

    // Chain data flow: each step consumed the previous step's outcome via
    // {previous} interpolation in the real prompt files.
    const diagnosePrompt = agent.promptsByRole.get("diagnose") ?? "";
    expect(diagnosePrompt).toContain("scout-evidence");
    expect(diagnosePrompt).not.toContain("{previous}");
    const fixPrompt = agent.promptsByRole.get("fix") ?? "";
    expect(fixPrompt).toContain("Off-by-one in page end index");

    expect(result.metadata?.execution_mode).toBe("chain");
    expect(result.metadata?.completed_roles).toBe("scout,diagnose,fix,verify");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("incident-triage fails loudly when remediation does not heal the fixture", async () => {
  const { workspace, result } = await runIncidentTriage(false);
  try {
    const finalCheck = await runHealthCheck(workspace);
    expect(finalCheck.exitCode).toBe(1);

    // Verify emitted a critical finding; the run fails rather than passing.
    expect(result.status).toBe("failed");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].id).toBe("verification-failed");
    expect(result.findings[0].severity).toBe("critical");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the example harness configuration resolves per-role policies", async () => {
  const loaded = await loadHarness({
    agentsDir: exampleAgentsDir,
    harnessId: "incident-triage",
  });
  expect(loaded.rolePolicies.scout?.id).toBe("triage-readonly");
  expect(loaded.rolePolicies.fix?.id).toBe("triage-fix");
  expect(loaded.rolePolicies.fix?.confirmations?.requiredFor).toEqual([
    "exec.unknown",
  ]);
  // The fix policy protects the health signal, the incident record, and
  // the governance surfaces that enforce the policy itself.
  const fixDeny = loaded.rolePolicies.fix?.capabilities?.filesystem?.deny ?? [];
  expect(fixDeny).toContain("check.ts");
  expect(fixDeny).toContain("alert.log");
  expect(fixDeny).toContain(".cursor/**");
  expect(fixDeny).toContain(".agents/**");
});

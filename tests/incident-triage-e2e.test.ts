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
          // A real agent also emits a diagnostic (often critical) finding
          // describing the bug, even when prompted for outcomes. That must
          // NOT fail a healed run — this is the regression guard for the
          // false-failure the manual run surfaced.
          yield createAgentEvent({
            runId: request.runId,
            roleId: request.roleId,
            type: "finding",
            data: {
              id: "scout-pagination-off-by-one",
              severity: "critical",
              title: "Page end index excludes the last item of each page",
              description:
                "paginate() slices one short, dropping the final item.",
              evidence: "src/pagination.ts:21 uses cursor + pageSize - 1",
              sourceRole: "scout",
              validation: {
                status: "verified",
                details: "Reproduced via bun run check.ts (2 failing checks).",
              },
            },
          });
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
    // Mirror the CLI: the authoritative pass gate runs the health check in
    // the workspace. Status derives from this, not from emitted findings.
    passGate: async () => (await runHealthCheck(workspace)).exitCode === 0,
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

    // Regression guard: the run PASSES even though a role emitted a critical
    // diagnostic finding — status is driven by the pass_check gate (healed),
    // not by finding severity. This is the false-failure the manual run
    // caught; the pre-fix code returned "failed" here.
    expect(result.status).toBe("passed");
    expect(
      result.findings.some((f) => f.id === "scout-pagination-off-by-one"),
    ).toBe(true);

    // Falsification core: the roles' native outcomes are generic kinds, not
    // findings. (result.outcomes also carries findings-converted-to-outcomes;
    // scope the claim to the non-finding outcomes the roles genuinely emit.)
    const genericOutcomes = (result.outcomes ?? []).filter(
      (outcome) => outcome.kind !== "finding",
    );
    expect(genericOutcomes.map((outcome) => outcome.kind)).toEqual([
      "evidence",
      "diagnosis",
      "remediation",
    ]);
    for (const outcome of genericOutcomes) {
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

    // The incident is not healed, so the pass_check gate fails the run —
    // deterministically, regardless of what the agents emitted.
    expect(result.status).toBe("failed");
    // verify still emits its diagnostic finding, but it is not what decides
    // status now.
    expect(result.findings.some((f) => f.id === "verification-failed")).toBe(
      true,
    );
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
  // Read-only roles must not be able to weaken enforcement surfaces, nor
  // tamper with the authoritative pass_check target or incident record.
  const scoutDeny =
    loaded.rolePolicies.scout?.capabilities?.filesystem?.deny ?? [];
  expect(scoutDeny).toContain(".cursor/**");
  expect(scoutDeny).toContain(".agents/**");
  expect(scoutDeny).toContain("check.ts");
  expect(scoutDeny).toContain("alert.log");
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

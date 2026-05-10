import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Finding,
  HarnessRunRequest,
  HarnessRunResult,
} from "@aguil/agents-core";
import { ensureDirectory, writeJsonFile } from "@aguil/agents-core";
import type { AgentAdapter, AgentRunRequest } from "@aguil/agents-execution";
import { isFinding } from "@aguil/agents-execution";
import type { EventSink } from "@aguil/agents-telemetry";

export interface RoleDefinition {
  readonly id: string;
  readonly description: string;
  readonly prompt?: string;
  readonly promptPath?: string;
  readonly requiredCapabilities: readonly string[];
  readonly timeoutMs: number;
  readonly allowedCommands?: readonly string[];
}

export interface HarnessDefinition {
  readonly id: string;
  readonly roles: readonly RoleDefinition[];
  readonly defaultAllowedCommands?: readonly string[];
}

export interface Orchestrator {
  run(request: HarnessRunRequest): Promise<HarnessRunResult>;
}

export interface NativeBunOrchestratorOptions {
  readonly definition: HarnessDefinition;
  readonly adapter: AgentAdapter;
  readonly eventSink?: EventSink;
  readonly contextBundlePath: string;
  readonly embeddedPrompts?: Readonly<Record<string, string>>;
}

export class NativeBunOrchestrator implements Orchestrator {
  constructor(private readonly options: NativeBunOrchestratorOptions) {}

  async run(request: HarnessRunRequest): Promise<HarnessRunResult> {
    await ensureDirectory(request.scratchpadPath);
    assertAdapterCapabilities(this.options.adapter, this.options.definition);

    const outcomes = await Promise.all(
      this.options.definition.roles.map((role) => this.runRole(request, role)),
    );
    const findings = outcomes.flatMap((outcome) => outcome.findings);
    const artifacts = outcomes.flatMap((outcome) => outcome.artifacts);
    const timedOutRoles = outcomes
      .filter((outcome) => outcome.outcome === "timed_out")
      .map((outcome) => outcome.roleId);
    const failedRoles = outcomes
      .filter((outcome) => outcome.outcome === "failed")
      .map((outcome) => outcome.roleId);
    const completedRoles = outcomes
      .filter((outcome) => outcome.outcome === "completed")
      .map((outcome) => outcome.roleId);

    const metadata: Record<string, string> = {
      ...(request.metadata ?? {}),
      strict_mode: request.strictMode === true ? "true" : "false",
      timed_out_roles: timedOutRoles.join(","),
      failed_roles: failedRoles.join(","),
      completed_roles: completedRoles.join(","),
    };

    const result: HarnessRunResult = {
      runId: request.runId,
      status: statusFromOutcomes(findings, {
        strictMode: request.strictMode === true,
        timedOutRoles,
        failedRoles,
      }),
      findings,
      artifacts,
      metadata,
    };

    await writeJsonFile(
      join(request.scratchpadPath, "result.raw.json"),
      result,
    );
    return result;
  }

  private async runRole(
    request: HarnessRunRequest,
    role: RoleDefinition,
  ): Promise<{
    readonly roleId: string;
    readonly findings: readonly Finding[];
    readonly artifacts: readonly string[];
    readonly outcome: "completed" | "timed_out" | "failed";
  }> {
    const roleScratchpadPath = join(request.scratchpadPath, "roles", role.id);
    await ensureDirectory(roleScratchpadPath);
    const prompt = await readPrompt(role, this.options.embeddedPrompts);
    const findings: Finding[] = [];
    let outcome: "completed" | "timed_out" | "failed" = "completed";

    const agentRequest: AgentRunRequest = {
      runId: request.runId,
      roleId: role.id,
      prompt,
      workspacePath: request.workspacePath,
      contextBundlePath:
        request.contextBundlePath ?? this.options.contextBundlePath,
      scratchpadPath: roleScratchpadPath,
      timeoutMs: role.timeoutMs,
      allowedCommands:
        role.allowedCommands ??
        this.options.definition.defaultAllowedCommands ??
        [],
      metadata: request.metadata,
    };

    for await (const event of this.options.adapter.run(agentRequest)) {
      await this.options.eventSink?.write(event);
      if (event.type === "finding" && isFinding(event.data)) {
        findings.push(event.data);
      }
      if (event.type === "error") {
        outcome = hasTimedOut(event.data) ? "timed_out" : "failed";
      }
    }

    return {
      roleId: role.id,
      findings,
      artifacts: [roleScratchpadPath],
      outcome,
    };
  }
}

async function readPrompt(
  role: RoleDefinition,
  embeddedPrompts?: Readonly<Record<string, string>>,
): Promise<string> {
  if (role.prompt !== undefined) {
    return role.prompt;
  }
  const embeddedPrompt = embeddedPrompts?.[role.id];
  if (typeof embeddedPrompt === "string") {
    return embeddedPrompt;
  }
  if (role.promptPath !== undefined) {
    return readFile(role.promptPath, "utf8");
  }
  return role.description;
}

function statusFromFindings(
  findings: readonly Finding[],
): HarnessRunResult["status"] {
  if (findings.some((finding) => finding.severity === "critical")) {
    return "failed";
  }
  if (findings.length > 0) {
    return "warnings";
  }
  return "passed";
}

function statusFromOutcomes(
  findings: readonly Finding[],
  outcomes: {
    readonly strictMode: boolean;
    readonly timedOutRoles: readonly string[];
    readonly failedRoles: readonly string[];
  },
): HarnessRunResult["status"] {
  if (outcomes.failedRoles.length > 0) {
    return "error";
  }
  if (outcomes.strictMode && outcomes.timedOutRoles.length > 0) {
    return "error";
  }
  const findingStatus = statusFromFindings(findings);
  if (findingStatus === "failed") {
    return "failed";
  }
  if (findingStatus === "warnings" || outcomes.timedOutRoles.length > 0) {
    return "warnings";
  }
  return "passed";
}

function hasTimedOut(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { readonly reason?: unknown }).reason === "timed_out"
  );
}

function assertAdapterCapabilities(
  adapter: AgentAdapter,
  definition: HarnessDefinition,
): void {
  const capabilities = adapter.capabilities() as unknown as Readonly<
    Record<string, boolean>
  >;
  const missing = definition.roles.flatMap((role) =>
    role.requiredCapabilities
      .filter((capability) => capabilities[capability] !== true)
      .map((capability) => `${role.id}:${capability}`),
  );

  if (missing.length > 0) {
    throw new Error(
      `${adapter.name} adapter does not satisfy required capabilities: ${missing.join(", ")}`,
    );
  }
}

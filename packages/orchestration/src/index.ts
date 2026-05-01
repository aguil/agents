import { ensureDirectory, writeJsonFile } from "@aguil/agents-core";
import type { Finding, HarnessRunRequest, HarnessRunResult } from "@aguil/agents-core";
import type { AgentAdapter, AgentRunRequest } from "@aguil/agents-execution";
import { isFinding } from "@aguil/agents-execution";
import type { EventSink } from "@aguil/agents-telemetry";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
    const hasErrors = outcomes.some((outcome) => outcome.failed);

    const result: HarnessRunResult = {
      runId: request.runId,
      status: hasErrors ? "error" : statusFromFindings(findings),
      findings,
      artifacts,
      metadata: request.metadata,
    };

    await writeJsonFile(join(request.scratchpadPath, "result.raw.json"), result);
    return result;
  }

  private async runRole(
    request: HarnessRunRequest,
    role: RoleDefinition,
  ): Promise<{
    readonly findings: readonly Finding[];
    readonly artifacts: readonly string[];
    readonly failed: boolean;
  }> {
    const roleScratchpadPath = join(request.scratchpadPath, "roles", role.id);
    await ensureDirectory(roleScratchpadPath);
    const prompt = await readPrompt(role);
    const findings: Finding[] = [];
    let failed = false;

    const agentRequest: AgentRunRequest = {
      runId: request.runId,
      roleId: role.id,
      prompt,
      workspacePath: request.workspacePath,
      contextBundlePath: request.contextBundlePath ?? this.options.contextBundlePath,
      scratchpadPath: roleScratchpadPath,
      timeoutMs: role.timeoutMs,
      allowedCommands:
        role.allowedCommands ?? this.options.definition.defaultAllowedCommands ?? [],
      metadata: request.metadata,
    };

    for await (const event of this.options.adapter.run(agentRequest)) {
      await this.options.eventSink?.write(event);
      if (event.type === "finding" && isFinding(event.data)) {
        findings.push(event.data);
      }
      if (event.type === "error") {
        failed = true;
      }
    }

    return {
      findings,
      artifacts: [roleScratchpadPath],
      failed,
    };
  }
}

async function readPrompt(role: RoleDefinition): Promise<string> {
  if (role.prompt !== undefined) {
    return role.prompt;
  }
  if (role.promptPath !== undefined) {
    return readFile(role.promptPath, "utf8");
  }
  return role.description;
}

function statusFromFindings(findings: readonly Finding[]): HarnessRunResult["status"] {
  if (findings.some((finding) => finding.severity === "critical")) {
    return "failed";
  }
  if (findings.length > 0) {
    return "warnings";
  }
  return "passed";
}

function assertAdapterCapabilities(adapter: AgentAdapter, definition: HarnessDefinition): void {
  const capabilities = adapter.capabilities() as unknown as Readonly<Record<string, boolean>>;
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

import type { HarnessRunRequest, HarnessRunResult } from "@aguil/agents-core";

export interface RoleDefinition {
  readonly id: string;
  readonly description: string;
  readonly promptPath: string;
  readonly requiredCapabilities: readonly string[];
  readonly timeoutMs: number;
}

export interface HarnessDefinition {
  readonly id: string;
  readonly roles: readonly RoleDefinition[];
}

export interface Orchestrator {
  run(request: HarnessRunRequest): Promise<HarnessRunResult>;
}

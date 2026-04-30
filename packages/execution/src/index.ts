import type { AgentEvent, Finding } from "@aguil/agents-core";

export interface AdapterCapabilities {
  readonly streaming: boolean;
  readonly structuredOutput: boolean;
  readonly readOnlyMode: boolean;
  readonly mcp: boolean;
  readonly cancellation: boolean;
}

export interface AgentRunRequest {
  readonly runId: string;
  readonly roleId: string;
  readonly prompt: string;
  readonly workspacePath: string;
  readonly contextBundlePath: string;
  readonly scratchpadPath: string;
  readonly timeoutMs: number;
  readonly allowedCommands: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface AgentRunResult {
  readonly status: "completed" | "failed" | "timed_out" | "cancelled";
  readonly findings: readonly Finding[];
  readonly artifacts: readonly string[];
}

export interface AgentAdapter {
  readonly name: string;
  capabilities(): AdapterCapabilities;
  run(request: AgentRunRequest): AsyncIterable<AgentEvent>;
}

export type HarnessStatus = "passed" | "warnings" | "failed" | "error";
export type FindingSeverity = "critical" | "warning";
export type ValidationStatus = "verified" | "not_reproduced" | "not_run";

export interface HarnessRunRequest {
  readonly runId: string;
  readonly harnessId: string;
  readonly workspacePath: string;
  readonly scratchpadPath: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ValidationState {
  readonly status: ValidationStatus;
  readonly details: string;
}

export interface Finding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly description: string;
  readonly evidence: string;
  readonly sourceRole: string;
  readonly validation: ValidationState;
  readonly file?: string;
  readonly line?: number;
}

export interface HarnessRunResult {
  readonly runId: string;
  readonly status: HarnessStatus;
  readonly findings: readonly Finding[];
  readonly artifacts: readonly string[];
}

export type AgentEventType =
  | "started"
  | "stdout"
  | "stderr"
  | "tool"
  | "finding"
  | "completed"
  | "error";

export interface AgentEvent {
  readonly timestamp: string;
  readonly runId: string;
  readonly roleId: string;
  readonly type: AgentEventType;
  readonly message?: string;
  readonly data?: unknown;
}

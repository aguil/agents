import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type HarnessStatus = "passed" | "warnings" | "failed" | "error";
export type FindingSeverity = "critical" | "warning";
export type ValidationStatus = "verified" | "not_reproduced" | "not_run";
export type ReviewTriageTier = "trivial" | "lite" | "full";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonRecord = Readonly<Record<string, JsonValue>>;

export interface HarnessRunRequest {
  readonly runId: string;
  readonly harnessId: string;
  readonly workspacePath: string;
  readonly scratchpadPath: string;
  readonly contextBundlePath?: string;
  readonly strictMode?: boolean;
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
  readonly metadata?: Readonly<Record<string, string>>;
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

export function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}

export function createRunId(prefix = "run", date: Date = new Date()): string {
  const timestamp = date.toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${prefix}-${timestamp}-${suffix}`;
}

export function createAgentEvent(
  input: Omit<AgentEvent, "timestamp"> & { readonly timestamp?: string },
): AgentEvent {
  return {
    timestamp: input.timestamp ?? nowIso(),
    runId: input.runId,
    roleId: input.roleId,
    type: input.type,
    message: input.message,
    data: input.data,
  };
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeTextFile(path: string, content: string): Promise<string> {
  await ensureDirectory(dirname(path));
  await writeFile(path, content, "utf8");
  return path;
}

export async function writeJsonFile(path: string, value: unknown): Promise<string> {
  return writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

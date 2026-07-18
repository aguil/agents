import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export {
  AGENTS_CODE_REVIEW_DIR,
  agentsCodeReviewDryRunRoot,
  agentsCodeReviewRunsRoot,
  LEGACY_AGENTS_CODE_REVIEW_DIR,
  legacyAgentsCodeReviewDryRunRoot,
  legacyAgentsCodeReviewRunsRoot,
} from "./agents-paths";

export type HarnessStatus = "passed" | "warnings" | "failed" | "error";
export type FindingSeverity = "critical" | "warning";
export type ValidationStatus = "verified" | "not_reproduced" | "not_run";
export const REVIEW_TRIAGE_TIERS = ["trivial", "lite", "full"] as const;

export type ReviewTriageTier = (typeof REVIEW_TRIAGE_TIERS)[number];

export function isReviewTriageTier(value: string): value is ReviewTriageTier {
  return (REVIEW_TRIAGE_TIERS as readonly string[]).includes(value);
}

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

/**
 * Generic per-role outcome. Harnesses define their own `kind` values and
 * carry domain fields in `data`, validated against the harness spec's
 * outcome schema. `Finding` is the code-review specialization; use
 * `findingToHarnessOutcome` / `harnessOutcomeToFinding` at the boundary.
 */
export interface HarnessOutcome {
  readonly id: string;
  readonly kind: string;
  readonly sourceRole: string;
  readonly title: string;
  readonly data: JsonRecord;
}

/** `kind` used for code-review findings represented as generic outcomes. */
export const FINDING_OUTCOME_KIND = "finding";

export function findingToHarnessOutcome(finding: Finding): HarnessOutcome {
  const { id, title, sourceRole, ...rest } = finding;
  return {
    id,
    kind: FINDING_OUTCOME_KIND,
    sourceRole,
    title,
    data: rest as unknown as JsonRecord,
  };
}

export function isFindingOutcome(outcome: HarnessOutcome): boolean {
  return (
    outcome.kind === FINDING_OUTCOME_KIND &&
    typeof outcome.data.severity === "string" &&
    typeof outcome.data.description === "string" &&
    typeof outcome.data.evidence === "string" &&
    typeof outcome.data.validation === "object" &&
    outcome.data.validation !== null
  );
}

export function harnessOutcomeToFinding(
  outcome: HarnessOutcome,
): Finding | undefined {
  if (!isFindingOutcome(outcome)) {
    return undefined;
  }
  return {
    id: outcome.id,
    title: outcome.title,
    sourceRole: outcome.sourceRole,
    ...(outcome.data as unknown as Omit<
      Finding,
      "id" | "title" | "sourceRole"
    >),
  };
}

export interface HarnessRunResult {
  readonly runId: string;
  readonly status: HarnessStatus;
  readonly findings: readonly Finding[];
  /**
   * Generic outcomes for non-code-review harnesses. Optional during the
   * migration window; code-review continues to populate `findings`.
   */
  readonly outcomes?: readonly HarnessOutcome[];
  readonly artifacts: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
}

export type AgentEventType =
  | "started"
  | "stdout"
  | "stderr"
  | "tool"
  | "finding"
  | "outcome"
  | "completed"
  | "error";

/** Structural guard for generic outcomes arriving as event data. */
export function isHarnessOutcome(value: unknown): value is HarnessOutcome {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<HarnessOutcome>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.kind === "string" &&
    candidate.kind.length > 0 &&
    typeof candidate.sourceRole === "string" &&
    candidate.sourceRole.length > 0 &&
    typeof candidate.title === "string" &&
    candidate.title.length > 0 &&
    typeof candidate.data === "object" &&
    candidate.data !== null &&
    !Array.isArray(candidate.data)
  );
}

export interface AgentEvent {
  readonly timestamp: string;
  readonly runId: string;
  readonly roleId: string;
  readonly type: AgentEventType;
  readonly message?: string;
  readonly data?: unknown;
}

export interface GitAwarePathResult {
  readonly gitAwarePath: string;
  readonly isJjWorkspace: boolean;
  readonly resolvedFromPointer: boolean;
  readonly warning?: string;
}

export function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}

export function createRunId(prefix = "run", date: Date = new Date()): string {
  const timestamp = date
    .toISOString()
    .replaceAll(/[-:.TZ]/g, "")
    .slice(0, 14);
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

export async function writeTextFile(
  path: string,
  content: string,
): Promise<string> {
  await ensureDirectory(dirname(path));
  await writeFile(path, content, "utf8");
  return path;
}

export async function writeJsonFile(
  path: string,
  value: unknown,
): Promise<string> {
  return writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function resolveGitAwarePath(
  workspacePath: string,
): Promise<GitAwarePathResult> {
  const resolvedWorkspacePath = resolve(workspacePath);
  const gitPath = join(resolvedWorkspacePath, ".git");
  try {
    await access(gitPath);
    return {
      gitAwarePath: resolvedWorkspacePath,
      isJjWorkspace: false,
      resolvedFromPointer: false,
    };
  } catch {
    // Continue and check for a jj workspace pointer.
  }

  const jjRepoPointerPath = join(resolvedWorkspacePath, ".jj", "repo");
  let pointer: string;
  try {
    pointer = (await readFile(jjRepoPointerPath, "utf8")).trim();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { readonly code?: unknown }).code)
        : undefined;
    if (code === "ENOENT") {
      return {
        gitAwarePath: resolvedWorkspacePath,
        isJjWorkspace: false,
        resolvedFromPointer: false,
      };
    }
    return {
      gitAwarePath: resolvedWorkspacePath,
      isJjWorkspace: false,
      resolvedFromPointer: false,
      warning: `Warning: failed to read jj workspace pointer at ${jjRepoPointerPath}; using workspace path for git/gh commands.`,
    };
  }

  if (pointer.length === 0) {
    return {
      gitAwarePath: resolvedWorkspacePath,
      isJjWorkspace: true,
      resolvedFromPointer: false,
      warning: `Warning: jj workspace pointer at ${jjRepoPointerPath} is empty; using workspace path for git/gh commands.`,
    };
  }

  const canonicalJjRepoPath = resolve(dirname(jjRepoPointerPath), pointer);
  const canonicalRepoPath = dirname(dirname(canonicalJjRepoPath));
  const canonicalGitPath = join(canonicalRepoPath, ".git");
  try {
    await access(canonicalGitPath);
    return {
      gitAwarePath: canonicalRepoPath,
      isJjWorkspace: true,
      resolvedFromPointer: true,
    };
  } catch {
    return {
      gitAwarePath: resolvedWorkspacePath,
      isJjWorkspace: true,
      resolvedFromPointer: false,
      warning: `Warning: jj workspace pointer resolved to ${canonicalRepoPath}, but ${canonicalGitPath} was not found; using workspace path for git/gh commands.`,
    };
  }
}

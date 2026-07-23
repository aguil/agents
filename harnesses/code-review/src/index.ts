import { access, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextBundle } from "@aguil/agents-context";
import type {
  Finding,
  HarnessRunResult,
  ReviewTriageTier,
} from "@aguil/agents-core";
import {
  agentsCodeReviewDryRunRoot,
  agentsCodeReviewRunsRoot,
} from "@aguil/agents-core";
import type {
  AgentAdapter,
  ClaudeCodeAdapterOptions,
  CursorAdapterOptions,
  OpenCodeAdapterOptions,
} from "@aguil/agents-execution";
import {
  ClaudeCodeAdapter,
  CursorAdapter,
  FakeAgentAdapter,
  OpenCodeAdapter,
} from "@aguil/agents-execution";
import type { HarnessDefinition } from "@aguil/agents-orchestration";
import {
  type CodeReviewRoleId,
  expectedRolesForTriageTier,
} from "./review-contract";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const promptDir = resolve(sourceDir, "../prompts");

/** Written next to `code-review-*` run dirs for O(1) discovery (see triage discover). */
const CODE_REVIEW_LATEST_RESULT_POINTER = ".code-review-latest-result";

export interface CodeReviewRunOptions {
  readonly workspacePath?: string;
  readonly scratchpadRoot?: string;
  readonly runId?: string;
  readonly strict?: boolean;
  readonly contextBundlePath?: string;
  readonly reviewPrNumber?: number;
  readonly adapter?: AgentAdapter;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly onEvent?: (
    event: import("@aguil/agents-core").AgentEvent,
  ) => void | Promise<void>;
}

export type CodeReviewAdapterName = "fake" | "opencode" | "claude" | "cursor";

export interface CodeReviewAdapterOptions {
  readonly opencode?: OpenCodeAdapterOptions;
  readonly claude?: ClaudeCodeAdapterOptions;
  readonly cursor?: CursorAdapterOptions;
}

export interface CodeReviewRunResult extends HarnessRunResult {
  readonly reportPath: string;
  readonly contextBundlePath: string;
}

export const codeReviewHarnessDefinition: HarnessDefinition = {
  id: "code-review",
  defaultAllowedCommands: [
    "rg",
    "grep",
    "bun test",
    "npm test",
    "jj diff",
    "git diff",
  ],
  roles: [
    {
      id: "security",
      description: "Find exploitable security risks introduced by the change.",
      promptPath: join(promptDir, "security.md"),
      requiredCapabilities: ["readOnlyMode", "structuredOutput"],
      timeoutMs: 1_200_000,
    },
    {
      id: "performance",
      description:
        "Find meaningful performance regressions introduced by the change.",
      promptPath: join(promptDir, "performance.md"),
      requiredCapabilities: ["readOnlyMode", "structuredOutput"],
      timeoutMs: 1_200_000,
    },
    {
      id: "quality",
      description:
        "Find correctness and maintainability issues with clear behavioral impact.",
      promptPath: join(promptDir, "quality.md"),
      requiredCapabilities: ["readOnlyMode", "structuredOutput"],
      timeoutMs: 1_200_000,
    },
    {
      id: "compliance",
      description:
        "Check project conventions, RFCs, and AGENTS.md requirements.",
      promptPath: join(promptDir, "compliance.md"),
      requiredCapabilities: ["readOnlyMode", "structuredOutput"],
      timeoutMs: 1_200_000,
    },
  ],
};

/**
 * Shared with the declarative runner so both paths publish discovery pointers
 * under the same scratchpad-root rules.
 */
export async function writeLatestCodeReviewDiscoveryPointer(options: {
  readonly workspacePath: string;
  readonly scratchpadRoot: string;
  readonly resultPath: string;
}): Promise<void> {
  const ws = resolve(options.workspacePath);
  const root = resolve(options.scratchpadRoot);
  const expectedRuns = resolve(agentsCodeReviewRunsRoot(ws));
  const expectedDry = resolve(agentsCodeReviewDryRunRoot(ws));
  let pointerParent: string | undefined;
  if (root === expectedRuns) {
    pointerParent = expectedRuns;
  } else if (root === expectedDry) {
    pointerParent = expectedDry;
  }
  if (pointerParent === undefined) {
    return;
  }
  const pointerPath = join(pointerParent, CODE_REVIEW_LATEST_RESULT_POINTER);
  const line = `${resolve(options.resultPath)}\n`;
  const tmp = `${pointerPath}.${process.pid}.tmp`;
  // ADR 0002: temp write + rename by pathname; openat deferred (accepted risk).
  await writeFile(tmp, line, "utf8");
  await rename(tmp, pointerPath);
}

export function createFakeCodeReviewAdapter(
  findingsByRole: Readonly<Record<string, readonly Finding[]>> = {},
): AgentAdapter {
  return new FakeAgentAdapter(findingsByRole);
}

export function createCodeReviewAdapter(
  name: CodeReviewAdapterName,
  options: CodeReviewAdapterOptions = {},
): AgentAdapter {
  if (name === "opencode") {
    return new OpenCodeAdapter(options.opencode);
  }
  if (name === "claude") {
    return new ClaudeCodeAdapter(options.claude);
  }
  if (name === "cursor") {
    return new CursorAdapter(options.cursor);
  }
  return new FakeAgentAdapter();
}

export function definitionForTriage(
  triage: ReviewTriageTier,
): HarnessDefinition {
  return definitionForTriageWithCommands(
    triage,
    codeReviewHarnessDefinition.defaultAllowedCommands ?? [],
  );
}

function definitionForTriageWithCommands(
  triage: ReviewTriageTier,
  defaultAllowedCommands: readonly string[],
): HarnessDefinition {
  const roleIds = new Set(expectedRolesForTriageTier(triage));
  return {
    ...codeReviewHarnessDefinition,
    defaultAllowedCommands,
    roles: codeReviewHarnessDefinition.roles.filter((role) =>
      roleIds.has(role.id as CodeReviewRoleId),
    ),
  };
}

/** Shared with the declarative runner to keep unknown-tier fallback identical. */
export function parseTriageTier(value: string | undefined): ReviewTriageTier {
  if (value === "trivial" || value === "lite" || value === "full") {
    return value;
  }
  return "lite";
}

/**
 * Shared with the declarative runner because PR metadata is a deterministic
 * part of the code-review result contract.
 */
export function parseReviewPrMetadataFromContext(value: string | undefined):
  | {
      readonly number: number;
      readonly headSha?: string;
      readonly reviewedAt: string;
    }
  | undefined {
  if (value === undefined) {
    return undefined;
  }
  const number = extractTaggedValue(value, "PR Number:");
  const reviewedAt = extractTaggedValue(value, "Reviewed At:");
  if (number === undefined || reviewedAt === undefined) {
    return undefined;
  }
  const parsedNumber = Number.parseInt(number, 10);
  if (!Number.isInteger(parsedNumber) || parsedNumber < 1) {
    return undefined;
  }
  const headShaValue = extractTaggedValue(value, "PR Head SHA:");
  const headSha =
    headShaValue === undefined ||
    headShaValue === "(unavailable)" ||
    headShaValue.length === 0
      ? undefined
      : headShaValue;
  return {
    number: parsedNumber,
    headSha,
    reviewedAt,
  };
}

function extractTaggedValue(value: string, tag: string): string | undefined {
  const line = value.split(/\r?\n/).find((entry) => entry.startsWith(tag));
  return line?.slice(tag.length).trim();
}

/**
 * Exported for the config-runner (subpath module): status composition is
 * part of the parity contract and must not be reimplemented there.
 */
export function combineStatuses(
  rawStatus: HarnessRunResult["status"],
  findingStatus: HarnessRunResult["status"],
): HarnessRunResult["status"] {
  if (rawStatus === "error") {
    return "error";
  }
  if (rawStatus === "failed" || findingStatus === "failed") {
    return "failed";
  }
  if (rawStatus === "warnings" || findingStatus === "warnings") {
    return "warnings";
  }
  return "passed";
}

export async function loadContextBundleFromPath(
  path: string,
): Promise<ContextBundle> {
  const raw = await readFile(resolve(path), "utf8");
  const parsed = JSON.parse(raw) as {
    readonly id?: unknown;
    readonly artifacts?: unknown;
  };
  if (typeof parsed.id !== "string" || !Array.isArray(parsed.artifacts)) {
    throw new Error(`Invalid context bundle JSON at ${path}`);
  }
  return parsed as ContextBundle;
}

/** Shared with the declarative runner so command grants remain VCS-aware. */
export async function detectWorkspaceVcsMode(
  workspacePath: string,
): Promise<"jj" | "git" | "unknown"> {
  const hasJj = await pathExists(join(workspacePath, ".jj"));
  const hasGit = await pathExists(join(workspacePath, ".git"));
  if (hasJj) {
    return "jj";
  }
  if (hasGit) {
    return "git";
  }
  return "unknown";
}

/** Shared with the declarative runner so role command grants cannot drift. */
export function defaultCommandsForVcsMode(
  vcsMode: "jj" | "git" | "unknown",
): readonly string[] {
  if (vcsMode === "jj") {
    return ["rg", "grep", "bun test", "npm test", "jj diff", "jj log"];
  }
  if (vcsMode === "git") {
    return ["rg", "grep", "bun test", "npm test", "git diff", "git log"];
  }
  return ["rg", "grep", "bun test", "npm test"];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export {
  CODE_REVIEW_HARNESS_PACKAGE_ADAPTER_DEFAULT,
  codeReviewHarnessPackageCliDefaults,
} from "./harness-package-defaults";
export type {
  CodeReviewRoleId,
  CodeReviewRunMetadata,
  RunMetadataSchema,
} from "./review-contract";
export {
  CODE_REVIEW_ROLE_IDS,
  CODE_REVIEW_RUN_METADATA_KEYS,
  expectedRolesForTriageTier,
  parseCodeReviewRunMetadata,
  parseMetadataRolesList,
  parseTriageTierFromRunMetadata,
  roleReviewSectionLabel,
} from "./review-contract";

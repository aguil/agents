import {
  AgentsInstructionsProvider,
  type ContextBundle,
  PullRequestMetadataProvider,
  PullRequestReferencedDocsProvider,
  RepositoryDiffProvider,
  collectContextBundle,
  writeContextBundle,
} from "@aguil/agents-context";
import {
  createRunId,
  ensureDirectory,
  writeJsonFile,
  writeTextFile,
} from "@aguil/agents-core";
import type { Finding, HarnessRunResult, ReviewTriageTier } from "@aguil/agents-core";
import { ClaudeCodeAdapter, FakeAgentAdapter, OpenCodeAdapter } from "@aguil/agents-execution";
import type {
  AgentAdapter,
  ClaudeCodeAdapterOptions,
  OpenCodeAdapterOptions,
} from "@aguil/agents-execution";
import { NativeBunOrchestrator } from "@aguil/agents-orchestration";
import type { HarnessDefinition } from "@aguil/agents-orchestration";
import {
  actionableFindings,
  dedupeFindings,
  findingFingerprint,
  renderMarkdownReport,
  statusForFindings,
} from "@aguil/agents-reporting";
import { JsonlFileEventSink } from "@aguil/agents-telemetry";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const promptDir = resolve(sourceDir, "../prompts");

export interface CodeReviewRunOptions {
  readonly workspacePath?: string;
  readonly scratchpadRoot?: string;
  readonly runId?: string;
  readonly strict?: boolean;
  readonly contextBundlePath?: string;
  readonly reviewPrNumber?: number;
  readonly consensusRuns?: number;
  readonly adapter?: AgentAdapter;
  readonly metadata?: Readonly<Record<string, string>>;
}

export type CodeReviewAdapterName = "fake" | "opencode" | "claude";

export interface CodeReviewAdapterOptions {
  readonly opencode?: OpenCodeAdapterOptions;
  readonly claude?: ClaudeCodeAdapterOptions;
}

export interface CodeReviewRunResult extends HarnessRunResult {
  readonly reportPath: string;
  readonly contextBundlePath: string;
}

export const codeReviewHarnessDefinition: HarnessDefinition = {
  id: "code-review",
  defaultAllowedCommands: ["rg", "grep", "bun test", "npm test", "jj diff", "git diff"],
  roles: [
    {
      id: "security",
      description: "Find exploitable security risks introduced by the change.",
      promptPath: join(promptDir, "security.md"),
      requiredCapabilities: ["readOnlyMode", "structuredOutput"],
      timeoutMs: 420_000,
    },
    {
      id: "performance",
      description: "Find meaningful performance regressions introduced by the change.",
      promptPath: join(promptDir, "performance.md"),
      requiredCapabilities: ["readOnlyMode", "structuredOutput"],
      timeoutMs: 300_000,
    },
    {
      id: "quality",
      description: "Find correctness and maintainability issues with clear behavioral impact.",
      promptPath: join(promptDir, "quality.md"),
      requiredCapabilities: ["readOnlyMode", "structuredOutput"],
      timeoutMs: 300_000,
    },
    {
      id: "compliance",
      description: "Check project conventions, RFCs, and AGENTS.md requirements.",
      promptPath: join(promptDir, "compliance.md"),
      requiredCapabilities: ["readOnlyMode", "structuredOutput"],
      timeoutMs: 240_000,
    },
  ],
};

export async function runCodeReview(
  options: CodeReviewRunOptions = {},
): Promise<CodeReviewRunResult> {
  const workspacePath = resolve(options.workspacePath ?? process.cwd());
  const runId = options.runId ?? createRunId("code-review");
  const scratchpadRoot = resolve(
    options.scratchpadRoot ?? join(workspacePath, ".review-agent", "runs"),
  );
  const scratchpadPath = join(scratchpadRoot, runId);
  await ensureDirectory(scratchpadPath);
  const consensusRuns = normalizeConsensusRuns(options.consensusRuns);

  const context = options.contextBundlePath === undefined
    ? await collectContextBundle(
      `${runId}-context`,
      { workspacePath, scratchpadPath, pullRequestNumber: options.reviewPrNumber },
      [
        new PullRequestMetadataProvider(),
        new PullRequestReferencedDocsProvider(),
        new RepositoryDiffProvider(),
        new AgentsInstructionsProvider(),
      ],
    )
    : await loadContextBundleFromPath(options.contextBundlePath);
  const writtenContext = await writeContextBundle(context, scratchpadPath);
  const triage = parseTriageTier(
    context.artifacts.find((artifact) => artifact.id === "triage")?.content,
  );
  const reviewPrMetadata = parseReviewPrMetadataFromContext(
    context.artifacts.find((artifact) => artifact.id === "diff-strategy")?.content,
  );
  const vcsMode = await detectWorkspaceVcsMode(workspacePath);
  const defaultAllowedCommands = defaultCommandsForVcsMode(vcsMode);
  const contextFingerprint = createHash("sha256")
    .update(JSON.stringify(context))
    .digest("hex")
    .slice(0, 12);
  await writeJsonFile(join(scratchpadPath, "triage.json"), { tier: triage });

  const adapter = options.adapter ?? new FakeAgentAdapter();
  const perPassResults: HarnessRunResult[] = [];
  const passFindingSets: Array<readonly Finding[]> = [];
  const baseMetadata = {
    adapter: adapter.name,
    triage,
    strict_mode: options.strict === true ? "true" : "false",
    vcs_mode: vcsMode,
    context_source: options.contextBundlePath === undefined ? "live" : "replay",
    context_fingerprint: contextFingerprint,
    ...(reviewPrMetadata === undefined
      ? {}
      : {
          pr_number: String(reviewPrMetadata.number),
          pr_reviewed_head_sha: reviewPrMetadata.headSha ?? "",
          pr_reviewed_at: reviewPrMetadata.reviewedAt,
        }),
    ...options.metadata,
  };

  for (let index = 0; index < consensusRuns; index += 1) {
    const passNumber = index + 1;
    const passScratchpadPath = consensusRuns === 1
      ? scratchpadPath
      : join(scratchpadPath, "passes", `pass-${passNumber}`);
    await ensureDirectory(passScratchpadPath);
    const passRunId = consensusRuns === 1 ? runId : `${runId}-pass${passNumber}`;

    const orchestrator = new NativeBunOrchestrator({
      definition: definitionForTriageWithCommands(triage, defaultAllowedCommands),
      adapter,
      eventSink: new JsonlFileEventSink(join(passScratchpadPath, "events.jsonl")),
      contextBundlePath: writtenContext.jsonPath,
    });

    const rawResult = await orchestrator.run({
      runId: passRunId,
      harnessId: codeReviewHarnessDefinition.id,
      workspacePath,
      scratchpadPath: passScratchpadPath,
      contextBundlePath: writtenContext.jsonPath,
      strictMode: options.strict === true,
      metadata: {
        ...baseMetadata,
        consensus_runs: String(consensusRuns),
        consensus_pass: String(passNumber),
      },
    });
    perPassResults.push(rawResult);
    passFindingSets.push(dedupeFindings(actionableFindings(rawResult.findings)));
  }

  const rawResult = combinePassResults(runId, perPassResults, baseMetadata);
  const findings = consensusRuns > 1
    ? intersectFindingsByFingerprint(passFindingSets)
    : passFindingSets[0] ?? [];
  const consensusDropped = countConsensusDroppedFindings(passFindingSets, findings);

  const rawMetadata = {
    ...(rawResult.metadata ?? {}),
    consensus_runs: String(consensusRuns),
    consensus_mode: consensusRuns > 1 ? "intersection" : "off",
    consensus_dropped_findings: String(consensusDropped),
  };

  const findingStatus = statusForFindings(findings);
  const result: HarnessRunResult = {
    ...rawResult,
    status: combineStatuses(rawResult.status, findingStatus),
    findings,
    metadata: rawMetadata,
    artifacts: [...rawResult.artifacts, writtenContext.jsonPath, writtenContext.markdownPath],
  };

  const reportPath = await writeTextFile(
    join(scratchpadPath, "report.md"),
    renderMarkdownReport(result),
  );
  const resultPath = await writeJsonFile(join(scratchpadPath, "result.json"), {
    ...result,
    reportPath,
    contextBundlePath: writtenContext.jsonPath,
  });

  return {
    ...result,
    reportPath,
    contextBundlePath: writtenContext.jsonPath,
    artifacts: [...result.artifacts, reportPath, resultPath],
  };
}

function combinePassResults(
  runId: string,
  passResults: readonly HarnessRunResult[],
  metadata: Readonly<Record<string, string>>,
): HarnessRunResult {
  const findings = passResults.flatMap((result) => result.findings);
  const artifacts = passResults.flatMap((result) => result.artifacts);
  const hasError = passResults.some((result) => result.status === "error");
  const hasFailed = passResults.some((result) => result.status === "failed");
  const timedOutRoles = joinUniqueMetadataRoleList(passResults, "timed_out_roles");
  const failedRoles = joinUniqueMetadataRoleList(passResults, "failed_roles");
  const completedRoles = joinUniqueMetadataRoleList(passResults, "completed_roles");
  const hasTimedOut = timedOutRoles.length > 0;

  return {
    runId,
    status: hasError ? "error" : hasFailed ? "failed" : hasTimedOut ? "warnings" : "passed",
    findings,
    artifacts,
    metadata: {
      ...metadata,
      timed_out_roles: timedOutRoles,
      failed_roles: failedRoles,
      completed_roles: completedRoles,
    },
  };
}

function joinUniqueMetadataRoleList(
  passResults: readonly HarnessRunResult[],
  key: "timed_out_roles" | "failed_roles" | "completed_roles",
): string {
  const values = new Set<string>();
  for (const result of passResults) {
    const raw = result.metadata?.[key] ?? "";
    for (const role of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
      values.add(role);
    }
  }
  return [...values].join(",");
}

function intersectFindingsByFingerprint(perPassFindings: readonly (readonly Finding[])[]): readonly Finding[] {
  if (perPassFindings.length === 0) {
    return [];
  }
  const requiredCount = perPassFindings.length;
  const counts = new Map<string, { count: number; finding: Finding }>();

  for (const set of perPassFindings) {
    const seenInPass = new Set<string>();
    for (const finding of set) {
      const key = findingFingerprint(finding);
      if (seenInPass.has(key)) {
        continue;
      }
      seenInPass.add(key);
      const entry = counts.get(key);
      if (entry === undefined) {
        counts.set(key, { count: 1, finding });
      } else {
        entry.count += 1;
      }
    }
  }

  return [...counts.values()]
    .filter((entry) => entry.count === requiredCount)
    .map((entry) => entry.finding);
}

function countConsensusDroppedFindings(
  perPassFindings: readonly (readonly Finding[])[],
  keptFindings: readonly Finding[],
): number {
  const observed = new Set<string>();
  for (const passFindings of perPassFindings) {
    for (const finding of passFindings) {
      observed.add(findingFingerprint(finding));
    }
  }

  const kept = new Set(keptFindings.map((finding) => findingFingerprint(finding)));
  return [...observed].filter((fingerprint) => !kept.has(fingerprint)).length;
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
  return new FakeAgentAdapter();
}

export function definitionForTriage(triage: ReviewTriageTier): HarnessDefinition {
  return definitionForTriageWithCommands(triage, codeReviewHarnessDefinition.defaultAllowedCommands ?? []);
}

function definitionForTriageWithCommands(
  triage: ReviewTriageTier,
  defaultAllowedCommands: readonly string[],
): HarnessDefinition {
  const roleIdsByTriage: Record<ReviewTriageTier, readonly string[]> = {
    trivial: ["quality"],
    lite: ["security", "quality", "compliance"],
    full: codeReviewHarnessDefinition.roles.map((role) => role.id),
  };
  const roleIds = new Set(roleIdsByTriage[triage]);
  return {
    ...codeReviewHarnessDefinition,
    defaultAllowedCommands,
    roles: codeReviewHarnessDefinition.roles.filter((role) => roleIds.has(role.id)),
  };
}

function parseTriageTier(value: string | undefined): ReviewTriageTier {
  if (value === "trivial" || value === "lite" || value === "full") {
    return value;
  }
  return "lite";
}

function parseReviewPrMetadataFromContext(value: string | undefined): {
  readonly number: number;
  readonly headSha?: string;
  readonly reviewedAt: string;
} | undefined {
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
  const headSha = headShaValue === undefined || headShaValue === "(unavailable)" || headShaValue.length === 0
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

function combineStatuses(
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

async function loadContextBundleFromPath(path: string): Promise<ContextBundle> {
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

async function detectWorkspaceVcsMode(workspacePath: string): Promise<"jj" | "git" | "unknown"> {
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

function defaultCommandsForVcsMode(vcsMode: "jj" | "git" | "unknown"): readonly string[] {
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

function normalizeConsensusRuns(value: number | undefined): number {
  if (value === undefined) {
    return 1;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid consensusRuns value: ${value}. Expected a positive integer.`);
  }
  return value;
}

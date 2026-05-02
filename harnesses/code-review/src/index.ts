import {
  AgentsInstructionsProvider,
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
  renderMarkdownReport,
  statusForFindings,
} from "@aguil/agents-reporting";
import { JsonlFileEventSink } from "@aguil/agents-telemetry";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const promptDir = resolve(sourceDir, "../prompts");

export interface CodeReviewRunOptions {
  readonly workspacePath?: string;
  readonly scratchpadRoot?: string;
  readonly runId?: string;
  readonly strict?: boolean;
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

  const context = await collectContextBundle(
    `${runId}-context`,
    { workspacePath, scratchpadPath },
    [
      new PullRequestMetadataProvider(),
      new PullRequestReferencedDocsProvider(),
      new RepositoryDiffProvider(),
      new AgentsInstructionsProvider(),
    ],
  );
  const writtenContext = await writeContextBundle(context, scratchpadPath);
  const triage = parseTriageTier(
    context.artifacts.find((artifact) => artifact.id === "triage")?.content,
  );
  await writeJsonFile(join(scratchpadPath, "triage.json"), { tier: triage });

  const adapter = options.adapter ?? new FakeAgentAdapter();
  const orchestrator = new NativeBunOrchestrator({
    definition: definitionForTriage(triage),
    adapter,
    eventSink: new JsonlFileEventSink(join(scratchpadPath, "events.jsonl")),
    contextBundlePath: writtenContext.jsonPath,
  });

  const rawResult = await orchestrator.run({
    runId,
    harnessId: codeReviewHarnessDefinition.id,
    workspacePath,
    scratchpadPath,
    contextBundlePath: writtenContext.jsonPath,
    strictMode: options.strict === true,
    metadata: {
      adapter: adapter.name,
      triage,
      strict_mode: options.strict === true ? "true" : "false",
      ...options.metadata,
    },
  });

  const findings = dedupeFindings(actionableFindings(rawResult.findings));
  const findingStatus = statusForFindings(findings);
  const result: HarnessRunResult = {
    ...rawResult,
    status: combineStatuses(rawResult.status, findingStatus),
    findings,
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
  const roleIdsByTriage: Record<ReviewTriageTier, readonly string[]> = {
    trivial: ["quality"],
    lite: ["security", "quality", "compliance"],
    full: codeReviewHarnessDefinition.roles.map((role) => role.id),
  };
  const roleIds = new Set(roleIdsByTriage[triage]);
  return {
    ...codeReviewHarnessDefinition,
    roles: codeReviewHarnessDefinition.roles.filter((role) => roleIds.has(role.id)),
  };
}

function parseTriageTier(value: string | undefined): ReviewTriageTier {
  if (value === "trivial" || value === "lite" || value === "full") {
    return value;
  }
  return "lite";
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

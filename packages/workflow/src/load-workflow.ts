import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  parseImplementationExecution,
  validateImplementationRuntime,
} from "./implementation-runtime";
import { resolveConfigString } from "./resolve-vars";
import type {
  PublishCodeReviewConfig,
  PublishPrFeedbackConfig,
  WorkflowDefinition,
  WorkflowDefinitionResult,
  WorkflowFeedConfig,
  WorkflowPublishConfig,
} from "./types";
import { parseYamlFrontMatter } from "./yaml-front-matter";

export async function loadWorkflowFile(
  workflowPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkflowDefinitionResult> {
  let raw: string;
  try {
    raw = await readFile(workflowPath, "utf8");
  } catch {
    return {
      error: {
        code: "missing_workflow_file",
        message: `Could not read workflow file: ${workflowPath}`,
      },
    };
  }

  const workflowDir = dirname(resolve(workflowPath));
  let config: Record<string, unknown> = {};
  let promptTemplate = raw.trim();

  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end === -1) {
      return {
        error: {
          code: "workflow_parse_error",
          message: "Unclosed YAML front matter in WORKFLOW.md",
        },
      };
    }
    const yamlBlock = raw.slice(3, end).trim();
    promptTemplate = raw.slice(end + 4).trim();
    try {
      const parsed = parseYamlFrontMatter(yamlBlock);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return {
          error: {
            code: "workflow_front_matter_not_a_map",
            message: "YAML front matter must decode to a map",
          },
        };
      }
      config = parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: { code: "workflow_parse_error", message } };
    }
  }

  const definition = buildWorkflowDefinition({
    config,
    promptTemplate,
    workflowPath: resolve(workflowPath),
    workflowDir,
    env,
  });
  return { definition };
}

function buildWorkflowDefinition(input: {
  readonly config: Readonly<Record<string, unknown>>;
  readonly promptTemplate: string;
  readonly workflowPath: string;
  readonly workflowDir: string;
  readonly env: NodeJS.ProcessEnv;
}): WorkflowDefinition {
  const polling = asRecord(input.config.polling);
  const workspace = asRecord(input.config.workspace);
  const agent = asRecord(input.config.agent);
  const hooks = asRecord(input.config.hooks);
  const publishRaw = asRecord(input.config.publish);

  const workspaceRoot =
    resolveConfigString(workspace.root, {
      workflowDir: input.workflowDir,
      env: input.env,
    }) ?? resolve(tmpdir(), "agentsd_workspaces");

  const feeds = parseFeeds(input.config.feeds);
  const workers = parseWorkers(input.config.workers);
  const implementation = parseImplementationExecution({
    config: input.config,
    workflowDir: input.workflowDir,
    env: input.env,
  });

  return {
    config: input.config,
    promptTemplate: input.promptTemplate,
    workflowPath: input.workflowPath,
    workflowDir: input.workflowDir,
    feeds,
    workers,
    publish: parsePublishConfig(publishRaw),
    pollingIntervalMs: positiveInt(polling.interval_ms, 30_000),
    workspaceRoot,
    maxConcurrentAgents: positiveInt(agent.max_concurrent_agents, 10),
    maxTurns: positiveInt(agent.max_turns, 20),
    maxRetryBackoffMs: positiveInt(agent.max_retry_backoff_ms, 300_000),
    hookTimeoutMs: positiveInt(hooks.timeout_ms, 60_000),
    implementation,
  };
}

export function validateWorkflowDefinition(
  definition: WorkflowDefinition,
): string | undefined {
  return validateImplementationRuntime(definition.implementation);
}

function parseFeeds(value: unknown): readonly WorkflowFeedConfig[] {
  if (Array.isArray(value)) {
    const feeds: WorkflowFeedConfig[] = [];
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        continue;
      }
      const raw = entry as Record<string, unknown>;
      const kind = typeof raw.kind === "string" ? raw.kind : "";
      if (kind.length === 0) {
        continue;
      }
      feeds.push({ kind, raw });
    }
    return feeds;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).map(
      ([kind, raw]) => ({
        kind,
        raw:
          typeof raw === "object" && raw !== null && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {},
      }),
    );
  }
  return [];
}

function parseWorkers(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, worker] of Object.entries(value)) {
    if (typeof worker === "string" && worker.length > 0) {
      out[key] = worker;
    }
  }
  return out;
}

function parsePublishConfig(
  raw: Record<string, unknown>,
): WorkflowPublishConfig {
  const codeReviewRaw = asRecord(raw.code_review);
  const prFeedbackRaw = asRecord(raw.pr_feedback);

  const codeReviewMode = parsePublishMode(
    codeReviewRaw.mode ?? raw.code_review,
    ["off", "notify", "pending"] as const,
    "off",
  );
  const prFeedbackMode = parsePublishMode(
    prFeedbackRaw.mode ?? raw.pr_feedback,
    ["off", "notify", "submit"] as const,
    "off",
  );

  const codeReview: PublishCodeReviewConfig = {
    mode: codeReviewMode,
    reviewSummary: parseReviewSummary(codeReviewRaw.review_summary),
    staleHead: codeReviewRaw.stale_head === "post" ? "post" : "skip",
    replacePending: codeReviewRaw.replace_pending === true,
    requireEmptyTriage: codeReviewRaw.require_empty_triage !== false,
  };

  const prFeedback: PublishPrFeedbackConfig = {
    mode: prFeedbackMode,
    requireEmptyTriage: prFeedbackRaw.require_empty_triage !== false,
    requireResponsesDocument:
      prFeedbackRaw.require_responses_document !== false,
  };

  return { codeReview, prFeedback };
}

function parsePublishMode<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (
    typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
  ) {
    return value as T;
  }
  return fallback;
}

function parseReviewSummary(
  value: unknown,
): PublishCodeReviewConfig["reviewSummary"] {
  if (value === "triage" || value === "impact" || value === "evidence") {
    return value;
  }
  return "impact";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

export function isAgentsdPublishDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = env.AGENTSD_PUBLISH?.trim().toLowerCase();
  return v === "disabled" || v === "off" || v === "false";
}

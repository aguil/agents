import type { AgentAdapter } from "@aguil/agents-execution";
import type { WorkItem } from "@aguil/agents-tracker";
import type { WorkQueueWorker } from "@aguil/agents-work-queue";
import type { WorkflowDefinition } from "@aguil/agents-workflow";
import { runCodeReviewWorker } from "./code-review-worker";
import {
  runImplementationAppServer,
  runImplementationSubprocess,
} from "./implementation-runtime";
import { runPrFeedbackWorker } from "./pr-feedback-worker";
import { createWorkflowAgentAdapter } from "./workflow-adapter";

export interface WorkerRouterOptions {
  readonly definition: WorkflowDefinition;
  readonly getDefinition?: () => WorkflowDefinition;
  readonly adapter?: AgentAdapter;
  readonly hostWorkspacePath: string;
  /**
   * Additional worker-kind handlers, merged over the builtin
   * code_review/pr_feedback/implementation registrations. New harnesses
   * register here instead of editing this router.
   */
  readonly workers?: Readonly<Record<string, WorkerHandler>>;
}

export interface WorkerContext {
  readonly item: WorkItem;
  readonly workspacePath: string;
  readonly hostWorkspacePath: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  readonly definition: WorkflowDefinition;
  readonly adapter: AgentAdapter;
}

export interface WorkerResult {
  readonly status: "succeeded" | "failed";
  readonly error?: string;
  readonly closeWorkItem?: boolean;
}

export type WorkerHandler = (context: WorkerContext) => Promise<WorkerResult>;

/** Builtin worker-kind handlers; extended via {@link WorkerRouterOptions.workers}. */
export function builtinWorkerHandlers(): Readonly<
  Record<string, WorkerHandler>
> {
  return {
    code_review: (context) =>
      runCodeReviewWorker({
        item: context.item,
        workspacePath: context.workspacePath,
        hostWorkspacePath: context.hostWorkspacePath,
        adapter: context.adapter,
        definition: context.definition,
        prompt: context.prompt,
        signal: context.signal,
      }),
    pr_feedback: (context) =>
      runPrFeedbackWorker({
        item: context.item,
        workspacePath: context.workspacePath,
        hostWorkspacePath: context.hostWorkspacePath,
        definition: context.definition,
        signal: context.signal,
      }),
    implementation: (context) =>
      runImplementationWorker({
        item: context.item,
        workspacePath: context.workspacePath,
        prompt: context.prompt,
        definition: context.definition,
        signal: context.signal,
      }),
  };
}

export { readTriageQueueFile, runPrFeedbackFixes } from "./pr-feedback-fix";
export {
  resolveHeadSha,
  verifyOneCommitForTriageItem,
} from "./pr-feedback-git-verify";
export {
  PR_FEEDBACK_WORK_REPORT_SCHEMA_ID,
  resolvePrFeedbackDisposition,
  writePrFeedbackWorkReport,
} from "./pr-feedback-work-report";
export { createWorkflowAgentAdapter } from "./workflow-adapter";

export function createWorkerRouter(
  options: WorkerRouterOptions,
): WorkQueueWorker {
  const handlers: Readonly<Record<string, WorkerHandler>> = {
    ...builtinWorkerHandlers(),
    ...(options.workers ?? {}),
  };
  return async ({ item, workspacePath, prompt, signal }) => {
    const definition = options.getDefinition?.() ?? options.definition;
    const adapter =
      options.adapter ?? createWorkflowAgentAdapter(definition.implementation);
    const workerKind = resolveWorkerKind(item, definition.workers);
    const handler = handlers[workerKind];
    if (handler === undefined) {
      return {
        status: "failed",
        error: `no worker registered for kind ${workerKind} (item kind ${item.kind})`,
      };
    }
    try {
      return await handler({
        item,
        workspacePath,
        hostWorkspacePath: options.hostWorkspacePath,
        prompt,
        signal,
        definition,
        adapter,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "failed", error: message };
    }
  };
}

function resolveWorkerKind(
  item: WorkItem,
  workers: Readonly<Record<string, string>>,
): string {
  const mapped = workers[item.kind];
  if (mapped !== undefined) {
    return mapped;
  }
  switch (item.kind) {
    case "github_pr_review":
      return "code_review";
    case "github_pr_feedback":
      return "pr_feedback";
    case "github_issue":
    case "mcp_tracker":
      return "implementation";
    default:
      return "implementation";
  }
}

async function runImplementationWorker(input: {
  readonly item: WorkItem;
  readonly workspacePath: string;
  readonly prompt: string;
  readonly definition: WorkflowDefinition;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly status: "succeeded" | "failed";
  readonly error?: string;
}> {
  const impl = input.definition.implementation;
  console.log(
    JSON.stringify({
      event: "implementation_worker",
      work_item_id: input.item.id,
      identifier: input.item.identifier,
      workspace_path: input.workspacePath,
      runtime_mode: impl.mode,
      runtime_adapter: impl.adapter,
      runtime_protocol: impl.protocol,
      prompt_bytes: input.prompt.length,
    }),
  );

  const timeoutMs = impl.turnTimeoutMs ?? 3_600_000;
  if (input.signal?.aborted) {
    return { status: "failed", error: "aborted" };
  }

  if (impl.mode === "app_server") {
    return runImplementationAppServer({
      item: input.item,
      workspacePath: input.workspacePath,
      prompt: input.prompt,
      definition: input.definition,
      signal: input.signal,
    });
  }

  return runImplementationSubprocess({
    item: input.item,
    workspacePath: input.workspacePath,
    prompt: input.prompt,
    impl,
    timeoutMs,
    signal: input.signal,
  });
}

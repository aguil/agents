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
}

export { readTriageQueueFile, runPrFeedbackFixes } from "./pr-feedback-fix";
export { createWorkflowAgentAdapter } from "./workflow-adapter";

export function createWorkerRouter(
  options: WorkerRouterOptions,
): WorkQueueWorker {
  const adapter =
    options.adapter ??
    createWorkflowAgentAdapter(options.definition.implementation);

  return async ({ item, workspacePath, prompt, signal }) => {
    const definition = options.getDefinition?.() ?? options.definition;
    const workerKind = resolveWorkerKind(item, definition.workers);
    try {
      switch (workerKind) {
        case "code_review":
          return await runCodeReviewWorker({
            item,
            workspacePath,
            hostWorkspacePath: options.hostWorkspacePath,
            adapter,
            definition,
            prompt,
            signal,
          });
        case "pr_feedback":
          return await runPrFeedbackWorker({
            item,
            workspacePath,
            hostWorkspacePath: options.hostWorkspacePath,
            definition,
            signal,
          });
        case "implementation":
          return await runImplementationWorker({
            item,
            workspacePath,
            prompt,
            definition,
            signal,
          });
        default:
          return {
            status: "failed",
            error: `no worker mapping for kind ${item.kind}`,
          };
      }
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

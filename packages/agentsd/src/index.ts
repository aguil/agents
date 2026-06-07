import { resolve } from "node:path";
import { createWorkFeeds, workItemTemplateVars } from "@aguil/agents-tracker";
import { WorkQueueOrchestrator } from "@aguil/agents-work-queue";
import { createWorkerRouter } from "@aguil/agents-workers";
import type { WorkflowDefinition } from "@aguil/agents-workflow";
import {
  loadWorkflowFile,
  renderStrictTemplate,
  validateWorkflowDefinition,
  watchWorkflowFile,
  workflowReloadChangedFields,
} from "@aguil/agents-workflow";
import type { WorkspaceHooks } from "@aguil/agents-workspace";
import { installAgentsdLogSink } from "./log-sink";
import { resolveMcpInvoke } from "./mcp-invoke";
import { syncPrFeedbackSelection } from "./pr-feedback-selection";

export interface AgentsdOptions {
  readonly workflowPath?: string;
  readonly workspacePath?: string;
  readonly mcpInvoke?: (
    server: string,
    tool: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
}

export async function runAgentsd(
  argv: readonly string[],
  options: AgentsdOptions = {},
): Promise<number> {
  const workflowPath = resolve(
    options.workflowPath ?? argv[0] ?? joinCwd("WORKFLOW.md"),
  );
  const hostWorkspace = resolve(
    options.workspacePath?.trim() ||
      process.env.AGENTSD_WORKSPACE?.trim() ||
      process.cwd(),
  );

  const loaded = await loadWorkflowFile(workflowPath);
  if (loaded.error !== undefined) {
    console.error(`${loaded.error.code}: ${loaded.error.message}`);
    return 1;
  }
  const definition = loaded.definition;
  if (definition === undefined) {
    console.error("missing_workflow_file: no definition loaded");
    return 1;
  }

  const validationError = validateWorkflowDefinition(definition);
  if (validationError !== undefined) {
    console.error(`workflow_validation_error: ${validationError}`);
    return 1;
  }

  let activeDefinition = definition;
  const mcpInvoke = await resolveMcpInvoke({
    argv,
    explicit: options.mcpInvoke,
  });
  const feeds = () =>
    createWorkFeeds({
      workflowDir: activeDefinition.workflowDir,
      workspacePath: hostWorkspace,
      feeds: activeDefinition.feeds,
      prFeedbackDeny: activeDefinition.prFeedbackPolicy.deny,
      mcpInvoke,
    });

  if (feeds().length === 0) {
    console.warn(
      "[agentsd] no work feeds configured; polling will idle until WORKFLOW.md defines feeds",
    );
  }

  const hooks = () => workflowHooks(activeDefinition);

  const orchestrator = new WorkQueueOrchestrator({
    definition: activeDefinition,
    feeds: feeds(),
    hooks: hooks(),
    implementationStallTimeoutMs:
      activeDefinition.implementation.stallTimeoutMs,
    perFeedMaxConcurrent: activeDefinition.perFeedMaxConcurrent,
    worker: createWorkerRouter({
      definition: activeDefinition,
      getDefinition: () => activeDefinition,
      hostWorkspacePath: hostWorkspace,
    }),
    renderPrompt: (item, attempt) => {
      const rendered = renderStrictTemplate(activeDefinition.promptTemplate, {
        ...workItemTemplateVars(item, attempt),
      });
      if (!rendered.ok) {
        return { ok: false, error: rendered.error.message };
      }
      const body =
        rendered.output.trim().length > 0
          ? rendered.output
          : "You are working on a tracked work item.";
      return { ok: true, prompt: body };
    },
    filterCandidates: async (items, tick) =>
      syncPrFeedbackSelection({
        definition: activeDefinition,
        hostWorkspacePath: hostWorkspace,
        candidates: items,
        tick,
      }),
  });

  const restoreLogSink = installAgentsdLogSink();

  const watcher = watchWorkflowFile(workflowPath, (next, error) => {
    if (error !== undefined) {
      console.error(`[agentsd] workflow reload failed: ${error}`);
      return;
    }
    if (next !== undefined) {
      const changedFields = workflowReloadChangedFields(activeDefinition, next);
      activeDefinition = next;
      orchestrator.updateDefinition(next, {
        feeds: feeds(),
        perFeedMaxConcurrent: next.perFeedMaxConcurrent,
        hooks: hooks(),
      });
      console.log(
        JSON.stringify({
          event: "workflow_reloaded",
          path: workflowPath,
          changed_fields: changedFields,
          polling_interval_ms: next.pollingIntervalMs,
          publish_code_review: next.publish.codeReview.mode,
          publish_pr_feedback: next.publish.prFeedback.mode,
          implementation_adapter: next.implementation.adapter,
          implementation_protocol: next.implementation.protocol,
        }),
      );
    }
  });

  void orchestrator.startupTerminalCleanup().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      JSON.stringify({
        event: "startup_terminal_cleanup_failed",
        error: message,
      }),
    );
  });
  orchestrator.start();

  console.log(
    JSON.stringify({
      event: "agentsd_started",
      workflow_path: workflowPath,
      workspace_root: activeDefinition.workspaceRoot,
      feeds: feeds().map((f) => f.feedKind),
      publish_code_review: activeDefinition.publish.codeReview.mode,
      publish_pr_feedback: activeDefinition.publish.prFeedback.mode,
      pr_feedback_profile: activeDefinition.prFeedbackPolicy.profile,
      implementation_runtime: activeDefinition.implementation.mode,
      implementation_adapter: activeDefinition.implementation.adapter,
      implementation_protocol: activeDefinition.implementation.protocol,
    }),
  );

  await new Promise<void>((resolvePromise) => {
    const onSignal = () => {
      void orchestrator.stopAndDrain({ timeoutMs: 60_000 }).finally(() => {
        watcher.close();
        restoreLogSink();
        resolvePromise();
      });
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });

  return 0;
}

function workflowHooks(
  definition: WorkflowDefinition,
): WorkspaceHooks | undefined {
  const hooks = definition.config.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return { timeoutMs: definition.hookTimeoutMs };
  }
  const h = hooks as Record<string, unknown>;
  return {
    afterCreate:
      typeof h.after_create === "string" ? h.after_create : undefined,
    beforeRun: typeof h.before_run === "string" ? h.before_run : undefined,
    afterRun: typeof h.after_run === "string" ? h.after_run : undefined,
    beforeRemove:
      typeof h.before_remove === "string" ? h.before_remove : undefined,
    timeoutMs: definition.hookTimeoutMs,
  };
}

function joinCwd(file: string): string {
  return resolve(process.cwd(), file);
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  return runAgentsd(argv);
}

if (import.meta.main) {
  process.exitCode = await main();
}

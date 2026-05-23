import {
  type CodeReviewAdapterName,
  createCodeReviewAdapter,
  createFakeCodeReviewAdapter,
} from "@aguil/agents-code-review";
import type { AgentAdapter } from "@aguil/agents-execution";
import type { ImplementationExecutionConfig } from "@aguil/agents-workflow";

/** Subprocess adapter for harness workers (code review, pr-feedback fixes). */
export function createWorkflowAgentAdapter(
  impl: ImplementationExecutionConfig,
): AgentAdapter {
  const name = impl.adapter as CodeReviewAdapterName;
  if (name === "fake") {
    return createFakeCodeReviewAdapter();
  }
  return createCodeReviewAdapter(name);
}

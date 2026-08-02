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
  // Deliberate (issue #159 / ADR 0020): no Cursor force opt-in. Passing no
  // options adopts the safe adapter default (force off, sandbox enabled).
  // Do not restore `{ force: true }` here without an explicit operator surface.
  return createCodeReviewAdapter(name);
}

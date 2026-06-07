import type { WorkflowDefinition } from "./types";

export function workflowReloadChangedFields(
  previous: WorkflowDefinition,
  next: WorkflowDefinition,
): readonly string[] {
  const changed: string[] = [];
  if (previous.pollingIntervalMs !== next.pollingIntervalMs) {
    changed.push("polling.interval_ms");
  }
  if (previous.maxConcurrentAgents !== next.maxConcurrentAgents) {
    changed.push("agent.max_concurrent_agents");
  }
  if (previous.maxTurns !== next.maxTurns) {
    changed.push("agent.max_turns");
  }
  if (previous.workspaceRoot !== next.workspaceRoot) {
    changed.push("workspace.root");
  }
  if (previous.hookTimeoutMs !== next.hookTimeoutMs) {
    changed.push("hooks.timeout_ms");
  }
  if (
    JSON.stringify(previous.perFeedMaxConcurrent) !==
    JSON.stringify(next.perFeedMaxConcurrent)
  ) {
    changed.push("feeds.max_concurrent");
  }
  if (JSON.stringify(previous.publish) !== JSON.stringify(next.publish)) {
    changed.push("publish");
  }
  if (
    JSON.stringify(previous.implementation) !==
    JSON.stringify(next.implementation)
  ) {
    changed.push("execution.implementation");
  }
  if (
    JSON.stringify(previous.prFeedbackPolicy) !==
    JSON.stringify(next.prFeedbackPolicy)
  ) {
    changed.push("policy.pr_feedback");
  }
  if (
    JSON.stringify(previous.codeReviewPolicy) !==
    JSON.stringify(next.codeReviewPolicy)
  ) {
    changed.push("policy.code_review");
  }
  if (JSON.stringify(previous.feeds) !== JSON.stringify(next.feeds)) {
    changed.push("feeds");
  }
  if (JSON.stringify(previous.workers) !== JSON.stringify(next.workers)) {
    changed.push("workers");
  }
  return changed;
}

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
  changed.push(...changedPolicyFields(previous, next));
  if (JSON.stringify(previous.feeds) !== JSON.stringify(next.feeds)) {
    changed.push("feeds");
  }
  if (JSON.stringify(previous.workers) !== JSON.stringify(next.workers)) {
    changed.push("workers");
  }
  return changed;
}

/**
 * Labels for changes under the `policy.` front-matter block, one per harness
 * that declares a section there — `policy.pr_feedback`, `policy.code_review`,
 * and whatever a future harness adds without this file learning its name.
 *
 * These used to be two hardcoded comparisons of parsed objects on the
 * definition. Comparing the raw subtrees instead reports a little more: a key
 * no harness parses now counts as a change, where before it did not. That is
 * the better direction for an operator signal — the operator edited it, so
 * being told is right — and it is the only reading available once the parsed
 * forms live in the harnesses rather than here.
 */
function changedPolicyFields(
  previous: WorkflowDefinition,
  next: WorkflowDefinition,
): readonly string[] {
  const before = asRecord(previous.config.policy);
  const after = asRecord(next.config.policy);
  const sections = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const section of sections) {
    if (JSON.stringify(before[section]) !== JSON.stringify(after[section])) {
      changed.push(`policy.${section}`);
    }
  }
  return changed.sort();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

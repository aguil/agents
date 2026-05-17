import { join } from "node:path";

/** `{workspace}/.agents-triage/{outputSlug}` */
export function defaultTriageQueueDir(
  workspacePath: string,
  outputSlug: string,
): string {
  return join(workspacePath, ".agents-triage", outputSlug);
}

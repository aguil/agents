import type { ExecutionConfig } from "@aguil/agents-orchestration";

/**
 * Build the orchestrator pass gate from `execution.pass_check`: run the command
 * in the workspace after roles complete; exit 0 => passed. Runtime-evaluated so
 * agent output cannot decide status. Undefined when the harness declares no
 * pass_check.
 *
 * Shared by every entry point that runs a loaded harness. `pass_check` is a
 * property of the document, not of the runner that happens to read it, so a
 * harness must not pass under `harness run` and fail — or, worse, skip the
 * check — under another driver (issue #156).
 */
export function makePassGate(
  execution: ExecutionConfig | undefined,
  workspacePath: string,
): (() => Promise<boolean>) | undefined {
  if (
    execution === undefined ||
    execution.mode !== "chain" ||
    execution.passCheck === undefined
  ) {
    return undefined;
  }
  const command = execution.passCheck;
  return async () => {
    // Output is unused for the pass/fail decision. Piping without draining
    // stalls both sides once the OS pipe buffer fills (realistic gates print
    // a lot), so ignore rather than pipe.
    const proc = Bun.spawn({
      cmd: [...command],
      cwd: workspacePath,
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.warn(
        `pass_check "${command.join(" ")}" exited ${exitCode}; run FAILED`,
      );
    }
    return exitCode === 0;
  };
}

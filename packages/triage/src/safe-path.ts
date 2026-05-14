import { realpath } from "node:fs/promises";
import { normalize, sep } from "node:path";

/** True when `targetReal` is exactly `dirReal` or a path under it (after realpath resolution). */
export function pathIsInsideDirectory(
  dirReal: string,
  targetReal: string,
): boolean {
  const dirN = normalize(dirReal);
  const tgtN = normalize(targetReal);
  if (tgtN === dirN) {
    return true;
  }
  const prefix = dirN.endsWith(sep) ? dirN : `${dirN}${sep}`;
  return tgtN.startsWith(prefix);
}

/**
 * Ensure `candidateAbsolutePath` resolves within `workspacePath` (symlink-safe).
 * Call after the path exists on disk (e.g. after `mkdir` for output dirs).
 */
export async function assertResolvedPathInsideWorkspace(
  workspacePath: string,
  candidateAbsolutePath: string,
): Promise<{ readonly workspaceReal: string; readonly candidateReal: string }> {
  let workspaceReal: string;
  let candidateReal: string;
  try {
    workspaceReal = await realpath(workspacePath);
    candidateReal = await realpath(candidateAbsolutePath);
  } catch {
    throw new Error(
      `Cannot resolve workspace or path: ${candidateAbsolutePath}`,
    );
  }
  if (!pathIsInsideDirectory(workspaceReal, candidateReal)) {
    throw new Error(
      `Path resolves outside workspace: ${candidateAbsolutePath}`,
    );
  }
  return { workspaceReal, candidateReal };
}

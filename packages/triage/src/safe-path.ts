import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, normalize, resolve, sep } from "node:path";

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

function isEnoent(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Ensure an output directory path will resolve inside the workspace before it is
 * created. Walks up until an existing directory is found, then applies the same
 * realpath prefix check as {@link assertResolvedPathInsideWorkspace}.
 *
 * Uses `lstat` so a **dangling symlink** in the ancestor chain is rejected
 * instead of being skipped like a missing directory (which could otherwise
 * anchor the check too high and miss an escape).
 */
export async function assertOutputDirectoryWillResolveInsideWorkspace(
  workspacePath: string,
  outputDirAbsolute: string,
): Promise<void> {
  const workspaceReal = await realpath(workspacePath);
  let candidate = normalize(resolve(outputDirAbsolute));

  for (;;) {
    try {
      const st = await lstat(candidate);
      if (st.isSymbolicLink()) {
        let candidateReal: string;
        try {
          candidateReal = await realpath(candidate);
        } catch {
          throw new Error(`Broken symlink in output path: ${candidate}`);
        }
        const followed = await stat(candidate);
        if (!followed.isDirectory()) {
          throw new Error(`Output path is not a directory: ${candidate}`);
        }
        if (!pathIsInsideDirectory(workspaceReal, candidateReal)) {
          throw new Error(
            `Path resolves outside workspace: ${outputDirAbsolute}`,
          );
        }
        return;
      }
      if (st.isDirectory()) {
        const candidateReal = await realpath(candidate);
        if (!pathIsInsideDirectory(workspaceReal, candidateReal)) {
          throw new Error(
            `Path resolves outside workspace: ${outputDirAbsolute}`,
          );
        }
        return;
      }
      throw new Error(`Output path is not a directory: ${candidate}`);
    } catch (e: unknown) {
      if (isEnoent(e)) {
        const parent = dirname(candidate);
        if (parent === candidate) {
          throw new Error(
            `Cannot anchor output directory under workspace: ${outputDirAbsolute}`,
          );
        }
        candidate = parent;
        continue;
      }
      throw e;
    }
  }
}

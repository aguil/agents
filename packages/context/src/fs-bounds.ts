import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const DEFAULT_ARTIFACT_MAX_BYTES = 50_000;

/**
 * Resolve a candidate path and enforce workspace containment. Returns
 * undefined when the resolved path escapes the workspace root and escaping
 * was not explicitly allowed. Symlinks are resolved via realpath before the
 * containment check, so a link inside the workspace pointing outside the root
 * is rejected.
 */
export async function resolveWorkspacePath(
  workspacePath: string,
  candidate: string,
  allowOutsideWorkspace: boolean,
): Promise<string | undefined> {
  const resolved = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(workspacePath, candidate);
  if (allowOutsideWorkspace) {
    return resolved;
  }
  const root = await realpath(resolve(workspacePath));
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    // Leaf does not exist yet; contain via its closest existing ancestor so
    // symlinked parent directories still cannot smuggle reads outside root.
    try {
      real = join(await realpath(dirname(resolved)), basename(resolved));
    } catch {
      // Nothing on disk to disclose; downstream reads fail with ENOENT.
      return resolved;
    }
  }
  return real === root || real.startsWith(root + sep) ? real : undefined;
}

export function truncateArtifactContent(
  content: string,
  maxBytes: number = DEFAULT_ARTIFACT_MAX_BYTES,
): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return content;
  }
  return `${Buffer.from(content, "utf8").subarray(0, maxBytes).toString("utf8")}\n[truncated at ${maxBytes} bytes]`;
}

/**
 * Read at most maxBytes+1 bytes so oversized files never load fully into
 * memory; the extra byte lets truncateArtifactContent detect overflow and
 * append its truncation marker.
 */
export async function readBoundedFile(
  path: string,
  maxBytes: number = DEFAULT_ARTIFACT_MAX_BYTES,
): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

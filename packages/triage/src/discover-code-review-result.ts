import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Latest `result.json` under `{workspace}/.review-agent/runs/code-review-*` (basename sort). */
export async function discoverLatestCodeReviewResultPath(
  workspacePath: string,
): Promise<string | undefined> {
  const runsRoot = join(workspacePath, ".review-agent", "runs");
  let entries: readonly (string | Uint8Array)[];
  try {
    entries = await readdir(runsRoot);
  } catch {
    return undefined;
  }
  const runDirectories = entries
    .map((entry) =>
      typeof entry === "string" ? entry : Buffer.from(entry).toString("utf8"),
    )
    .filter((entry) => entry.startsWith("code-review-"))
    .sort()
    .reverse();
  for (const runDirectory of runDirectories) {
    const candidate = join(runsRoot, runDirectory, "result.json");
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return undefined;
}

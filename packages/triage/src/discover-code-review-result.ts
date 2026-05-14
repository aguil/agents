import { access, lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Latest `result.json` under `.review-agent/runs/code-review-*` only (basename
 * lexicographic descending). Used for `agents code-review post` auto-discovery
 * so disposable dry-run artifacts are never selected for GitHub publish.
 */
export async function discoverLatestRunsCodeReviewResultPath(
  workspacePath: string,
): Promise<string | undefined> {
  const runsRoot = join(workspacePath, ".review-agent", "runs");
  const dirs: string[] = [];
  await appendCodeReviewRunDirs(runsRoot, dirs);
  return pickLatestAccessibleResult(dirs);
}

/**
 * Latest `result.json` among `.review-agent/{dry-run,runs}/code-review-*`
 * (basename lexicographic descending; try in that order).
 *
 * `dry-run` runs are included so `agents triage` without `--result` matches the
 * newest code-review artifact from local dry-runs as well as persisted runs.
 */
export async function discoverLatestCodeReviewResultPath(
  workspacePath: string,
): Promise<string | undefined> {
  const reviewAgent = join(workspacePath, ".review-agent");
  const dryRunRoot = join(reviewAgent, "dry-run");
  const runsRoot = join(reviewAgent, "runs");

  const dirs: string[] = [];
  await appendCodeReviewRunDirs(dryRunRoot, dirs);
  await appendCodeReviewRunDirs(runsRoot, dirs);
  return pickLatestAccessibleResult(dirs);
}

async function pickLatestAccessibleResult(
  dirs: readonly string[],
): Promise<string | undefined> {
  if (dirs.length === 0) {
    return undefined;
  }
  const sorted = [...dirs].sort((a, b) =>
    basename(b).localeCompare(basename(a)),
  );
  for (const dir of sorted) {
    const candidate = join(dir, "result.json");
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return undefined;
}

async function appendCodeReviewRunDirs(
  parent: string,
  acc: string[],
): Promise<void> {
  let entries: readonly (string | Uint8Array)[];
  try {
    entries = await readdir(parent);
  } catch {
    return;
  }
  const names = entries
    .map((entry) =>
      typeof entry === "string" ? entry : Buffer.from(entry).toString("utf8"),
    )
    .filter((entry) => entry.startsWith("code-review-"));
  for (const name of names) {
    const dirPath = join(parent, name);
    try {
      const st = await lstat(dirPath);
      if (st.isSymbolicLink()) {
        continue;
      }
      if (!st.isDirectory()) {
        continue;
      }
      acc.push(dirPath);
    } catch {}
  }
}

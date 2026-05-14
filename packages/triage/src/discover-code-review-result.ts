import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Latest `result.json` under `.review-agent/runs/code-review-*` only. Picks the
 * newest accessible `result.json` by **file mtime** (descending), then
 * `code-review-*` basename lexicographic descending as a stable tie-breaker.
 * Used for `agents code-review post` auto-discovery so disposable dry-run
 * artifacts are never selected for GitHub publish.
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
 * Latest `result.json` among `.review-agent/{dry-run,runs}/code-review-*`.
 * Selection uses **file mtime** on each `result.json` (descending), then
 * basename lexicographic descending as a stable tie-breaker so same-second run
 * ids do not pick arbitrarily by random suffix alone.
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
  const scored: {
    readonly path: string;
    readonly mtimeMs: number;
    readonly tie: string;
  }[] = [];
  for (const dir of dirs) {
    const candidate = join(dir, "result.json");
    try {
      const st = await lstat(candidate);
      if (st.isSymbolicLink()) {
        continue;
      }
      if (!st.isFile()) {
        continue;
      }
      scored.push({
        path: candidate,
        mtimeMs: st.mtimeMs,
        tie: basename(dir),
      });
    } catch {}
  }
  if (scored.length === 0) {
    return undefined;
  }
  scored.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) {
      return b.mtimeMs - a.mtimeMs;
    }
    return b.tie.localeCompare(a.tie);
  });
  return scored[0].path;
}

async function appendCodeReviewRunDirs(
  parent: string,
  acc: string[],
): Promise<void> {
  try {
    const rootSt = await lstat(parent);
    if (rootSt.isSymbolicLink()) {
      return;
    }
    if (!rootSt.isDirectory()) {
      return;
    }
  } catch {
    return;
  }
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

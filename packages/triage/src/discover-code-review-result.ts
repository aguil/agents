import { access, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Latest `result.json` among `.review-agent/{dry-run,runs}/code-review-*`
 * (basename lexicographic descending; try in that order).
 *
 * Implementation picks the newest-looking `code-review-*` directory first in
 * O(pool) per probe (no eager full sort; typical case resolves in one pass once
 * newest run has a `result.json`).
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

  let pool = dirs;
  while (pool.length > 0) {
    const head = pool[0];
    if (head === undefined) {
      break;
    }
    let bestIdx = 0;
    let bestBase = basename(head);
    for (let i = 1; i < pool.length; i++) {
      const dirEntry = pool[i];
      if (dirEntry === undefined) {
        continue;
      }
      const candidateBase = basename(dirEntry);
      if (candidateBase > bestBase) {
        bestBase = candidateBase;
        bestIdx = i;
      }
    }
    const chosen = pool[bestIdx];
    if (chosen === undefined) {
      break;
    }
    pool = pool.filter((_, i) => i !== bestIdx);
    const candidate = join(chosen, "result.json");
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
    acc.push(join(parent, name));
  }
}

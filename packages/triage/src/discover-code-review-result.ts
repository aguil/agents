import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** Must match harness constant (one line: absolute path to result.json). */
const CODE_REVIEW_LATEST_RESULT_POINTER = ".code-review-latest-result";

function discoverFullScanEnv(): boolean {
  const v = process.env.AGENTS_CODE_REVIEW_DISCOVER_FULL_SCAN?.trim();
  return v === "1" || /^true$/iu.test(v ?? "");
}

/**
 * Latest result.json under ".review-agent/runs/code-review-*" only. Picks the
 * newest accessible result.json by file mtime (descending), then
 * code-review-* basename lexicographic descending as a stable tie-breaker.
 * After a harness run, ".review-agent/runs/.code-review-latest-result" holds an
 * absolute path so this call is usually O(1). Set
 * AGENTS_CODE_REVIEW_DISCOVER_FULL_SCAN=1 to ignore the pointer (for example
 * after manual edits under runs/). Without a valid pointer, each run's
 * result.json is lstat'd concurrently.
 * Used for agents code-review post auto-discovery so disposable dry-run
 * artifacts are never selected for GitHub publish.
 */
export async function discoverLatestRunsCodeReviewResultPath(
  workspacePath: string,
): Promise<string | undefined> {
  const runsRoot = join(workspacePath, ".review-agent", "runs");
  if (!discoverFullScanEnv()) {
    const fromPointer = await tryReadLatestPointerScored(runsRoot);
    if (fromPointer !== undefined) {
      return fromPointer.path;
    }
  }
  const dirs: string[] = [];
  await appendCodeReviewRunDirs(runsRoot, dirs);
  return (await pickLatestScoredFromDirs(dirs))?.path;
}

/**
 * Latest result.json among ".review-agent/dry-run" and ".review-agent/runs"
 * code-review-* trees. Selection uses file mtime (descending), then basename
 * lexicographic descending as a stable tie-breaker so same-second run ids do
 * not pick arbitrarily by random suffix alone. Uses per-tree
 * ".code-review-latest-result" pointers when present (see
 * discoverLatestRunsCodeReviewResultPath); otherwise scans that tree.
 */
export async function discoverLatestCodeReviewResultPath(
  workspacePath: string,
): Promise<string | undefined> {
  const reviewAgent = join(workspacePath, ".review-agent");
  const dryRunRoot = join(reviewAgent, "dry-run");
  const runsRoot = join(reviewAgent, "runs");

  const scoredDry = await bestScoredInCodeReviewTree(dryRunRoot);
  const scoredRuns = await bestScoredInCodeReviewTree(runsRoot);
  return pickBetterOf(scoredDry, scoredRuns)?.path;
}

type ScoredResult = {
  readonly path: string;
  readonly mtimeMs: number;
  readonly tie: string;
};

function compareScored(a: ScoredResult, b: ScoredResult): number {
  if (b.mtimeMs !== a.mtimeMs) {
    return b.mtimeMs - a.mtimeMs;
  }
  return b.tie.localeCompare(a.tie);
}

function pickBetterOf(
  a: ScoredResult | undefined,
  b: ScoredResult | undefined,
): ScoredResult | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  return compareScored(a, b) < 0 ? a : b;
}

async function bestScoredInCodeReviewTree(
  root: string,
): Promise<ScoredResult | undefined> {
  if (!discoverFullScanEnv()) {
    const fromPointer = await tryReadLatestPointerScored(root);
    if (fromPointer !== undefined) {
      return fromPointer;
    }
  }
  const dirs: string[] = [];
  await appendCodeReviewRunDirs(root, dirs);
  return await pickLatestScoredFromDirs(dirs);
}

async function tryReadLatestPointerScored(
  root: string,
): Promise<ScoredResult | undefined> {
  const pointerPath = join(root, CODE_REVIEW_LATEST_RESULT_POINTER);
  let text: string;
  try {
    text = (await readFile(pointerPath, "utf8")).trim();
  } catch {
    return undefined;
  }
  if (text.length === 0) {
    return undefined;
  }
  const abs = resolve(text);
  const resolvedRoot = resolve(root);
  const rel = relative(resolvedRoot, abs);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    return undefined;
  }
  const parentDir = basename(dirname(abs));
  if (!parentDir.startsWith("code-review-")) {
    return undefined;
  }
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      return undefined;
    }
    if (!st.isFile()) {
      return undefined;
    }
    return {
      path: abs,
      mtimeMs: st.mtimeMs,
      tie: parentDir,
    };
  } catch {
    return undefined;
  }
}

async function pickLatestScoredFromDirs(
  dirs: readonly string[],
): Promise<ScoredResult | undefined> {
  if (dirs.length === 0) {
    return undefined;
  }
  const scored = (
    await Promise.all(
      dirs.map(async (dir): Promise<ScoredResult | undefined> => {
        const candidate = join(dir, "result.json");
        try {
          const st = await lstat(candidate);
          if (st.isSymbolicLink()) {
            return undefined;
          }
          if (!st.isFile()) {
            return undefined;
          }
          return {
            path: candidate,
            mtimeMs: st.mtimeMs,
            tie: basename(dir),
          };
        } catch {
          return undefined;
        }
      }),
    )
  ).filter((x): x is ScoredResult => x !== undefined);
  if (scored.length === 0) {
    return undefined;
  }
  let best = scored[0];
  for (let i = 1; i < scored.length; i += 1) {
    if (compareScored(scored[i], best) < 0) {
      best = scored[i];
    }
  }
  return best;
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

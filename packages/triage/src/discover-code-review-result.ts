import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  agentsCodeReviewDryRunRoot,
  agentsCodeReviewRunsRoot,
  legacyAgentsCodeReviewDryRunRoot,
  legacyAgentsCodeReviewRunsRoot,
} from "@aguil/agents-core";

/** Must match harness constant (one line: absolute path to result.json). */
const CODE_REVIEW_LATEST_RESULT_POINTER = ".code-review-latest-result";

function discoverFullScanEnv(): boolean {
  const v = process.env.AGENTS_CODE_REVIEW_DISCOVER_FULL_SCAN?.trim();
  return v === "1" || /^true$/iu.test(v ?? "");
}

/**
 * Latest result.json under `.agents-code-review/runs/code-review-*` only
 * (also considers legacy `.review-agent/runs/`). Picks the newest accessible
 * result.json by file mtime (descending), then code-review-* basename
 * lexicographic descending as a stable tie-breaker.
 * When ".code-review-latest-result" exists, its path is merged with a scan of
 * run directories so a stale pointer cannot beat a newer on-disk run.
 * Set AGENTS_CODE_REVIEW_DISCOVER_FULL_SCAN=1 to ignore the pointer entirely.
 * Used for agents code-review post auto-discovery so disposable dry-run
 * artifacts are never selected for GitHub publish.
 */
export async function discoverLatestRunsCodeReviewResultPath(
  workspacePath: string,
): Promise<string | undefined> {
  const [newRuns, legacyRuns] = await Promise.all([
    bestScoredMergingPointer(agentsCodeReviewRunsRoot(workspacePath)),
    bestScoredMergingPointer(legacyAgentsCodeReviewRunsRoot(workspacePath)),
  ]);
  return pickBetterOf(newRuns, legacyRuns)?.path;
}

/**
 * Latest result.json among `.agents-code-review/{dry-run,runs}` and legacy
 * `.review-agent/{dry-run,runs}` code-review-* trees. Selection uses file
 * mtime (descending), then basename lexicographic descending as a stable
 * tie-breaker so same-second run ids do not pick arbitrarily by random suffix
 * alone. Per-tree pointers are merged with directory scans (see
 * discoverLatestRunsCodeReviewResultPath).
 */
export async function discoverLatestCodeReviewResultPath(
  workspacePath: string,
): Promise<string | undefined> {
  const [dryNew, runsNew, dryLegacy, runsLegacy] = await Promise.all([
    bestScoredMergingPointer(agentsCodeReviewDryRunRoot(workspacePath)),
    bestScoredMergingPointer(agentsCodeReviewRunsRoot(workspacePath)),
    bestScoredMergingPointer(legacyAgentsCodeReviewDryRunRoot(workspacePath)),
    bestScoredMergingPointer(legacyAgentsCodeReviewRunsRoot(workspacePath)),
  ]);
  return pickBetterOf(
    pickBetterOf(dryNew, runsNew),
    pickBetterOf(dryLegacy, runsLegacy),
  )?.path;
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

async function bestScoredMergingPointer(
  root: string,
): Promise<ScoredResult | undefined> {
  const dirs: string[] = [];
  await appendCodeReviewRunDirs(root, dirs);
  const scoredDirs = await pickLatestScoredFromDirs(dirs);
  if (discoverFullScanEnv()) {
    return scoredDirs;
  }
  const fromPointer = await tryReadLatestPointerScored(root);
  if (fromPointer === undefined) {
    return scoredDirs;
  }
  if (scoredDirs === undefined) {
    return fromPointer;
  }
  return pickBetterOf(fromPointer, scoredDirs);
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

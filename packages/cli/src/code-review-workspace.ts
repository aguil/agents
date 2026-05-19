import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Slug-shaped GitHub-style `owner/repo` (no slashes inside segments). */
const NAME_WITH_OWNER_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

function expandTildePath(userPath: string): string {
  const t = userPath.trim();
  if (t === "~") {
    return homedir();
  }
  if (t.startsWith("~/")) {
    return join(homedir(), t.slice(2));
  }
  return resolve(t);
}

/**
 * Root directory used to resolve bare `owner/repo` workspace strings and inbox
 * `--repo` shortcuts. Precedence: explicit override → `AGENTS_CODE_REVIEW_REPOS_ROOT`
 * → `~/dev/repos`.
 */
export function expandReposRoot(override?: string): string {
  const fromArg = override?.trim() ?? "";
  const fromEnv = process.env.AGENTS_CODE_REVIEW_REPOS_ROOT?.trim() ?? "";
  const raw = fromArg.length > 0 ? fromArg : fromEnv;
  if (raw.length === 0) {
    return resolve(join(homedir(), "dev", "repos"));
  }
  return resolve(expandTildePath(raw));
}

async function isVcsWorkspaceRoot(dir: string): Promise<boolean> {
  const base = resolve(dir);
  try {
    await access(join(base, ".git"));
    return true;
  } catch {
    /* continue */
  }
  try {
    await access(join(base, ".jj"));
    return true;
  } catch {
    return false;
  }
}

async function findCloneUnderReposRoot(
  nameWithOwner: string,
  reposRoot: string,
): Promise<string | undefined> {
  const parts = nameWithOwner.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (
    parts.length !== 2 ||
    owner === undefined ||
    repo === undefined ||
    owner.length === 0 ||
    repo.length === 0 ||
    owner.includes("..") ||
    repo.includes("..")
  ) {
    return undefined;
  }
  const candidates = [
    join(reposRoot, "github.com", owner, repo),
    join(reposRoot, owner, repo),
  ];
  for (const candidate of candidates) {
    if (await isVcsWorkspaceRoot(candidate)) {
      return resolve(candidate);
    }
  }
  return undefined;
}

export async function findClonePath(
  nameWithOwner: string,
  reposRootAbs: string,
): Promise<string | undefined> {
  return findCloneUnderReposRoot(nameWithOwner, reposRootAbs);
}

/**
 * Resolve the filesystem workspace used for config discovery, harness runs, and `gh`.
 *
 * - Missing workspace → current working directory.
 * - If the operand is already a checkout (`.git` or `.jj`), use it.
 * - Else if it matches `owner/repo`, try `${reposRoot}/github.com/owner/repo` then
 *   `${reposRoot}/owner/repo`.
 * - Otherwise treat as a normal relative/absolute path (may not exist yet).
 */
export async function resolveEffectiveWorkspace(
  workspaceOpt: string | undefined,
  reposRootAbs: string,
): Promise<string> {
  const cwd = process.cwd();
  if (workspaceOpt === undefined || workspaceOpt.trim() === "") {
    return resolve(cwd);
  }
  const trimmed = workspaceOpt.trim();
  const asPath = resolve(cwd, trimmed);
  if (await isVcsWorkspaceRoot(asPath)) {
    return asPath;
  }
  if (NAME_WITH_OWNER_PATTERN.test(trimmed)) {
    const hit = await findCloneUnderReposRoot(trimmed, reposRootAbs);
    if (hit !== undefined) {
      return hit;
    }
  }
  return asPath;
}

import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AGENTS_CODE_REVIEW_DIR,
  resolveGitAwarePath,
} from "@aguil/agents-core";

async function readProcessText(
  stream: ReadableStream<Uint8Array> | number | undefined,
): Promise<string> {
  if (!(stream instanceof ReadableStream)) {
    return "";
  }
  return new Response(stream).text();
}

async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<{ readonly ok: boolean; readonly stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stderr, exitCode] = await Promise.all([
    readProcessText(proc.stdout),
    readProcessText(proc.stderr),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stderr: stderr.trim() };
}

/**
 * Create a detached git worktree at `FETCH_HEAD` after `git fetch origin pull/<n>/head`.
 * Used for PR-backed harness runs so the primary checkout is not switched.
 * Review artifacts should stay on {@link artifactAnchorWorkspacePath}; only harness file reads use the worktree path.
 */
export async function createDetachedPullRequestWorktree(input: {
  readonly artifactAnchorWorkspacePath: string;
  readonly pullNumber: number;
}): Promise<{
  readonly worktreePath: string;
  readonly cleanup: () => Promise<void>;
}> {
  const anchor = resolve(input.artifactAnchorWorkspacePath);
  const { gitAwarePath } = await resolveGitAwarePath(anchor);
  const gitCheck = await runGit(gitAwarePath, ["rev-parse", "--git-dir"]);
  if (!gitCheck.ok) {
    throw new Error(
      `Isolated PR review requires a git checkout with a usable .git directory (${gitCheck.stderr || "git rev-parse failed"}).`,
    );
  }

  const worktreesRoot = join(anchor, AGENTS_CODE_REVIEW_DIR, "worktrees");
  await mkdir(worktreesRoot, { recursive: true });
  const worktreePath = join(worktreesRoot, randomUUID());

  const pullRef = `pull/${input.pullNumber}/head`;
  const fetch = await runGit(gitAwarePath, ["fetch", "origin", pullRef]);
  if (!fetch.ok) {
    throw new Error(
      `Failed to fetch ${pullRef} for isolated review: ${fetch.stderr || "git fetch failed"}`,
    );
  }

  const add = await runGit(gitAwarePath, [
    "worktree",
    "add",
    "--detach",
    worktreePath,
    "FETCH_HEAD",
  ]);
  if (!add.ok) {
    await rm(worktreePath, { recursive: true, force: true });
    throw new Error(
      `Failed to create isolated review worktree: ${add.stderr || "git worktree add failed"}`,
    );
  }

  const cleanup = async (): Promise<void> => {
    await runGit(gitAwarePath, ["worktree", "remove", "--force", worktreePath]);
    await rm(worktreePath, { recursive: true, force: true });
  };

  return { worktreePath, cleanup };
}

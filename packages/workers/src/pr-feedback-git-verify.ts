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
): Promise<{
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readProcessText(proc.stdout),
    readProcessText(proc.stderr),
    proc.exited,
  ]);
  return {
    ok: exitCode === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

export async function resolveHeadSha(
  workspacePath: string,
): Promise<string | null> {
  const result = await runGit(workspacePath, ["rev-parse", "HEAD"]);
  if (!result.ok || result.stdout.length === 0) {
    return null;
  }
  return result.stdout;
}

export interface CommitVerificationResult {
  readonly verified: boolean;
  readonly replyOnly: boolean;
  readonly sha: string | null;
  readonly reason: string;
}

export async function verifyOneCommitForTriageItem(input: {
  readonly workspacePath: string;
  readonly baseHeadSha: string | null;
  readonly triageItemId: string;
}): Promise<CommitVerificationResult> {
  if (input.baseHeadSha === null) {
    return {
      verified: false,
      replyOnly: false,
      sha: null,
      reason: "not_git_repo",
    };
  }
  const head = await resolveHeadSha(input.workspacePath);
  if (head === null) {
    return {
      verified: false,
      replyOnly: false,
      sha: null,
      reason: "head_unavailable",
    };
  }
  if (head === input.baseHeadSha) {
    return {
      verified: true,
      replyOnly: true,
      sha: null,
      reason: "no_new_commit",
    };
  }
  const log = await runGit(input.workspacePath, [
    "log",
    "--format=%H %s",
    `${input.baseHeadSha}..HEAD`,
  ]);
  if (!log.ok) {
    return {
      verified: false,
      replyOnly: false,
      sha: null,
      reason: "git_log_failed",
    };
  }
  const lines = log.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return {
      verified: true,
      replyOnly: true,
      sha: null,
      reason: "no_new_commit",
    };
  }
  if (lines.length !== 1) {
    return {
      verified: false,
      replyOnly: false,
      sha: null,
      reason: `expected_one_commit_got_${lines.length}`,
    };
  }
  const [sha, ...messageParts] = lines[0].split(" ");
  const message = messageParts.join(" ");
  if (!message.includes(input.triageItemId)) {
    return {
      verified: false,
      replyOnly: false,
      sha: sha ?? null,
      reason: "commit_message_missing_item_id",
    };
  }
  return {
    verified: true,
    replyOnly: false,
    sha: sha ?? null,
    reason: "verified",
  };
}

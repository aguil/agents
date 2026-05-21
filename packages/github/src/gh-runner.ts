import { resolve } from "node:path";
import { resolveGitAwarePath } from "@aguil/agents-core";

async function readProcessText(
  stream: ReadableStream<Uint8Array> | number | undefined,
): Promise<string> {
  if (!(stream instanceof ReadableStream)) {
    return "";
  }
  return new Response(stream).text();
}

function resolveWorkspaceCwd(workspacePath: string): string {
  return resolve(workspacePath);
}

async function resolveGitAwareCwd(workspacePath: string): Promise<string> {
  const cwd = resolveWorkspaceCwd(workspacePath);
  const resolved = await resolveGitAwarePath(cwd);
  return resolved.gitAwarePath;
}

/**
 * Runs `gh` with JSON stdout parsing and transient network retries.
 */
export async function runGhJson<T = unknown>(
  args: readonly string[],
  workspacePath: string,
): Promise<T | undefined> {
  const gitAware = await resolveGitAwareCwd(workspacePath);
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const proc = Bun.spawn({
      cmd: ["gh", ...args],
      cwd: gitAware,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      readProcessText(proc.stdout),
      readProcessText(proc.stderr),
      proc.exited,
    ]);
    if (exitCode === 0) {
      if (stdout.trim().length === 0) {
        return undefined;
      }
      return JSON.parse(stdout) as T;
    }

    const message = stderr.trim() || `exit code ${exitCode}`;
    const isTransientNetwork =
      /error connecting to api\.github\.com/i.test(message) ||
      /\bTLS handshake timeout\b/i.test(message) ||
      /\btimeout\b/i.test(message) ||
      /\btemporarily unavailable\b/i.test(message) ||
      /\bconnection reset\b/i.test(message) ||
      /\bconnection refused\b/i.test(message) ||
      /\bEOF\b/i.test(message) ||
      /\bno such host\b/i.test(message) ||
      /\bnetwork is unreachable\b/i.test(message);
    if (!isTransientNetwork || attempt === maxAttempts) {
      throw new Error(`gh ${args.join(" ")} failed: ${message}`);
    }

    const backoffMs =
      250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
    await Bun.sleep(backoffMs);
  }

  throw new Error(`gh ${args.join(" ")} failed: exhausted retries`);
}

export async function runGhText(
  args: readonly string[],
  workspacePath: string,
): Promise<string> {
  const gitAware = await resolveGitAwareCwd(workspacePath);
  const proc = Bun.spawn({
    cmd: ["gh", ...args],
    cwd: gitAware,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readProcessText(proc.stdout),
    readProcessText(proc.stderr),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed: ${stderr.trim() || exitCode}`,
    );
  }
  return stdout;
}

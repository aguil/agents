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

/** Resolve argv prefix for `agents` (override with AGENTS_CLI, e.g. `bun run agents`). */
export function resolveAgentsCliArgv(): readonly string[] {
  const raw = process.env.AGENTS_CLI?.trim();
  if (raw !== undefined && raw.length > 0) {
    return raw.split(/\s+/u);
  }
  return ["agents"];
}

export interface AgentsCliRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runAgentsCli(
  args: readonly string[],
  workspacePath: string,
): Promise<AgentsCliRunResult> {
  const cwd = resolve(workspacePath);
  const { gitAwarePath } = await resolveGitAwarePath(cwd);
  const prefix = resolveAgentsCliArgv();
  const proc = Bun.spawn({
    cmd: [...prefix, ...args],
    cwd: gitAwarePath,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readProcessText(proc.stdout),
    readProcessText(proc.stderr),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

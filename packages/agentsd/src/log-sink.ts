import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export function resolveAgentsdLogSinkPath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.AGENTSD_LOG_FILE?.trim();
  return raw !== undefined && raw.length > 0 ? raw : null;
}

const dirReadyByPath = new Map<string, Promise<void>>();

function ensureLogDir(path: string): Promise<void> {
  const existing = dirReadyByPath.get(path);
  if (existing !== undefined) {
    return existing;
  }
  const ready = mkdir(dirname(path), { recursive: true }).then(() => {});
  dirReadyByPath.set(path, ready);
  return ready;
}

export async function appendAgentsdLogLine(
  line: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = resolveAgentsdLogSinkPath(env);
  if (path === null) {
    return;
  }
  await ensureLogDir(path);
  await appendFile(path, `${line}\n`, "utf8");
}

export function installAgentsdLogSink(
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const path = resolveAgentsdLogSinkPath(env);
  if (path === null) {
    return () => {};
  }
  const originalLog = console.log.bind(console);
  let appendChain: Promise<void> = Promise.resolve();
  console.log = (...args: unknown[]) => {
    originalLog(...args);
    const line = args
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" ");
    appendChain = appendChain
      .then(() => appendAgentsdLogLine(line, env))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        originalLog(
          JSON.stringify({
            event: "agentsd_log_sink_failed",
            path,
            error: message,
          }),
        );
      });
  };
  return () => {
    console.log = originalLog;
  };
}

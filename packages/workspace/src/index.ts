import { spawn } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const WORKSPACE_KEY_RE = /[^A-Za-z0-9._-]/g;

export interface WorkspaceRecord {
  readonly path: string;
  readonly workspaceKey: string;
  readonly createdNow: boolean;
}

export interface WorkspaceHooks {
  readonly afterCreate?: string;
  readonly beforeRun?: string;
  readonly afterRun?: string;
  readonly beforeRemove?: string;
  readonly timeoutMs: number;
}

export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(WORKSPACE_KEY_RE, "_");
}

export function assertWorkspaceInsideRoot(
  workspaceRoot: string,
  workspacePath: string,
): void {
  const root = resolve(workspaceRoot);
  const path = resolve(workspacePath);
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new Error(`workspace path ${path} is outside workspace root ${root}`);
  }
}

export async function ensureIssueWorkspace(input: {
  readonly workspaceRoot: string;
  readonly identifier: string;
  readonly hooks?: WorkspaceHooks;
}): Promise<WorkspaceRecord> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const workspaceKey = sanitizeWorkspaceKey(input.identifier);
  const path = resolve(workspaceRoot, workspaceKey);
  assertWorkspaceInsideRoot(workspaceRoot, path);

  let createdNow = false;
  try {
    await access(path);
  } catch {
    await mkdir(path, { recursive: true });
    createdNow = true;
  }

  const record: WorkspaceRecord = { path, workspaceKey, createdNow };
  if (createdNow && input.hooks?.afterCreate !== undefined) {
    await runHook(
      "after_create",
      input.hooks.afterCreate,
      path,
      input.hooks.timeoutMs,
    );
  }
  return record;
}

export async function runWorkspaceHook(
  name: keyof WorkspaceHooks,
  script: string | undefined,
  workspacePath: string,
  hooks: WorkspaceHooks | undefined,
): Promise<void> {
  if (script === undefined || hooks === undefined) {
    return;
  }
  const fatal = name === "afterCreate" || name === "beforeRun";
  try {
    await runHook(name, script, workspacePath, hooks.timeoutMs);
  } catch (error) {
    if (fatal) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[workspace] hook ${name} failed (ignored): ${message}`);
  }
}

export async function removeIssueWorkspace(input: {
  readonly workspaceRoot: string;
  readonly identifier: string;
  readonly hooks?: WorkspaceHooks;
}): Promise<void> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const workspaceKey = sanitizeWorkspaceKey(input.identifier);
  const path = resolve(workspaceRoot, workspaceKey);
  assertWorkspaceInsideRoot(workspaceRoot, path);

  if (input.hooks?.beforeRemove !== undefined) {
    await runWorkspaceHook(
      "beforeRemove",
      input.hooks.beforeRemove,
      path,
      input.hooks,
    );
  }
  await rm(path, { recursive: true, force: true });
}

async function runHook(
  name: string,
  script: string,
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("sh", ["-lc", script], {
      cwd,
      stdio: "inherit",
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`hook ${name} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`hook ${name} exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

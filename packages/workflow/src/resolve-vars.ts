import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const VAR_PATTERN = /^\$([A-Z_][A-Z0-9_]*)$/i;

export function resolveEnvVarReference(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const match = VAR_PATTERN.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const resolved = env[match[1] ?? ""];
  if (resolved === undefined || resolved.length === 0) {
    return undefined;
  }
  return resolved;
}

export function expandPathValue(
  value: string,
  options: {
    readonly workflowDir: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): string {
  let out = value.trim();
  if (out.startsWith("~/")) {
    out = resolve(homedir(), out.slice(2));
  } else if (out === "~") {
    out = homedir();
  }
  const envRef = resolveEnvVarReference(out, options.env);
  if (envRef !== undefined) {
    out = envRef;
  }
  if (!isAbsolute(out)) {
    out = resolve(options.workflowDir, out);
  }
  return out;
}

export function resolveConfigString(
  value: unknown,
  options: {
    readonly workflowDir: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const envOnly = resolveEnvVarReference(value, options.env);
  if (envOnly !== undefined) {
    return envOnly;
  }
  if (value.startsWith("$")) {
    return undefined;
  }
  return expandPathValue(value, options);
}

/** Shell argv strings: expand `$VAR` only, not workflow-relative paths. */
export function resolveShellCommand(
  value: unknown,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const envOnly = resolveEnvVarReference(value, options.env);
  if (envOnly !== undefined) {
    return envOnly;
  }
  if (value.startsWith("$")) {
    return undefined;
  }
  return value.trim();
}

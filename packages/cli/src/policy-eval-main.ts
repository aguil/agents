import { lstatSync, realpathSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import type { PolicySpec } from "@aguil/agents-harness-config";
import { loadPolicy } from "@aguil/agents-harness-config";
import type {
  PolicyHookInput,
  PolicyVerdictDecision,
} from "@aguil/agents-policy";
import {
  createPolicyEvalHandler,
  POLICY_NONE_TOKEN,
} from "@aguil/agents-policy";

export type PolicyEvalFormat = "cursor" | "claude";

interface PolicyEvalArgs {
  readonly policyId?: string;
  readonly agentsDir?: string;
  /** Response encoding (ADR 0023 decision 6). Defaults to cursor. */
  readonly format: PolicyEvalFormat;
  /** Run's workspace root, from the generated argv; never from stdin. */
  readonly workspace?: string;
}

function parsePolicyEvalArgv(argv: readonly string[]): PolicyEvalArgs | string {
  let policyId: string | undefined;
  let agentsDir: string | undefined;
  let format: PolicyEvalFormat = "cursor";
  let workspace: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--policy") {
      policyId = argv[index + 1];
      index += 1;
    } else if (arg === "--agents-dir") {
      agentsDir = argv[index + 1] ?? agentsDir;
      index += 1;
    } else if (arg === "--format") {
      const value = argv[index + 1];
      index += 1;
      if (value !== "cursor" && value !== "claude") {
        return 'policy-eval: --format must be "cursor" or "claude"';
      }
      format = value;
    } else if (arg === "--workspace") {
      workspace = argv[index + 1] ?? workspace;
      index += 1;
    } else {
      return `policy-eval: unknown argument "${arg}"`;
    }
  }
  return {
    ...(policyId === undefined ? {} : { policyId }),
    ...(agentsDir === undefined ? {} : { agentsDir }),
    format,
    ...(workspace === undefined ? {} : { workspace }),
  };
}

/**
 * Rewrite absolute `file_path` / `path` / `notebook_path` values inside
 * `workspace` as workspace-relative, so filesystem rules written against
 * relative globs can classify them (#219). Claude Code sends absolute paths
 * for every file tool. Paths outside the root, and the root itself, stay
 * absolute and so stay denied under a filesystem-ruled policy. The root comes
 * from the generated argv, never the payload: hook stdin is not trusted.
 *
 * Containment is decided on the path with its symlinks resolved, and the
 * rewritten path is that resolved one, because the tool follows the link: a
 * link inside the root to a file outside it stays absolute, and a link to
 * `.env` is classified as `.env`.
 */
export function relativizeContainedPaths(
  input: PolicyHookInput,
  workspace: string,
): PolicyHookInput {
  const root = resolveThroughSymlinks(workspace) ?? resolve(workspace);
  const toolInput: Record<string, unknown> = { ...input.tool_input };
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = toolInput[key];
    if (typeof value !== "string" || !isAbsolute(value)) {
      continue;
    }
    const target = resolveThroughSymlinks(value);
    if (target === undefined) {
      continue;
    }
    const rel = relative(root, target);
    if (
      rel !== "" &&
      rel !== ".." &&
      !rel.startsWith("../") &&
      !isAbsolute(rel)
    ) {
      toolInput[key] = rel;
    }
  }
  return { ...input, tool_input: toolInput };
}

/**
 * `path` with every symlink resolved, walked one component at a time so that
 * `..` steps out of where a link actually leads rather than where the path
 * text says. A path that doesn't exist yet, such as a file about to be
 * written, keeps its missing components as written. Undefined when an entry
 * exists but can't be resolved, such as a dangling link: what a write through
 * it reaches is unknown, so it stays uncontained.
 */
function resolveThroughSymlinks(path: string): string | undefined {
  const absolute = isAbsolute(path) ? path : join(process.cwd(), path);
  let current = parse(absolute).root;
  let missing = false;
  for (const part of absolute.slice(current.length).split(sep)) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      // `current` is already resolved, so its parent is the physical one.
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    if (missing) {
      current = next;
      continue;
    }
    try {
      lstatSync(next);
    } catch {
      missing = true;
      current = next;
      continue;
    }
    try {
      current = realpathSync(next);
    } catch {
      return undefined;
    }
  }
  return current;
}

/**
 * Cursor-or-Claude-or-canonical hook payload → canonical PolicyHookInput.
 * Fail-closed on unrecognized events remains the handler's job (ADR 0023
 * decision 7); this only normalizes known native names.
 */
export function normalizeHookPayload(payload: unknown): PolicyHookInput {
  const record =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const eventRaw =
    typeof record.hook_event === "string"
      ? record.hook_event
      : typeof record.hook_event_name === "string"
        ? record.hook_event_name
        : "";
  const event =
    eventRaw === "beforeShellExecution" ||
    eventRaw === "beforeMCPExecution" ||
    eventRaw === "PreToolUse"
      ? "pre_tool_call"
      : eventRaw === "afterFileEdit" || eventRaw === "PostToolUse"
        ? "post_tool_call"
        : eventRaw === "stop" || eventRaw === "Stop"
          ? "role_stop"
          : eventRaw === "SessionStart"
            ? "role_start"
            : eventRaw;

  const toolInputRaw =
    typeof record.tool_input === "object" && record.tool_input !== null
      ? (record.tool_input as Record<string, unknown>)
      : {};
  // Cursor's beforeShellExecution puts `command` at top level; afterFileEdit
  // puts `file_path` at top level; MCP payloads nest values under an
  // `arguments` record (top-level or inside tool_input). Merge all of them
  // into the canonical tool_input, explicit canonical fields winning.
  const argumentsRecord = (source: Record<string, unknown>) =>
    typeof source.arguments === "object" && source.arguments !== null
      ? (source.arguments as Record<string, unknown>)
      : {};
  const nestedArguments = {
    ...argumentsRecord(record),
    ...argumentsRecord(toolInputRaw),
  };
  const toolInput: Record<string, unknown> = { ...toolInputRaw };
  for (const key of ["command", "file_path", "path", "url"]) {
    if (toolInput[key] !== undefined) {
      continue;
    }
    if (typeof record[key] === "string") {
      toolInput[key] = record[key];
    } else if (typeof nestedArguments[key] === "string") {
      toolInput[key] = nestedArguments[key];
    }
  }

  // Note: any `state` in the payload is intentionally dropped — hook stdin
  // is not a trustworthy accounting source (see PolicyHookInput docs).
  return {
    hook_event: event,
    ...(typeof record.tool_name === "string"
      ? { tool_name: record.tool_name }
      : eventRaw === "beforeShellExecution"
        ? { tool_name: "Execute" }
        : {}),
    tool_input: toolInput,
  };
}

const DECISION_TO_PERMISSION: Readonly<
  Record<PolicyVerdictDecision, "allow" | "deny" | "ask">
> = {
  allow: "allow",
  warn: "allow",
  transform: "allow",
  deny: "deny",
  escalate: "ask",
};

/** Encode a verdict for Cursor's hook response shape. */
export function encodeCursorPolicyResponse(input: {
  readonly permission: "allow" | "deny" | "ask";
  readonly agentMessage?: string;
  readonly updated_input?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const response: Record<string, unknown> = { permission: input.permission };
  if (input.agentMessage !== undefined) {
    response.agentMessage = input.agentMessage;
  }
  if (input.updated_input !== undefined) {
    response.updated_input = input.updated_input;
  }
  return response;
}

/**
 * Encode a verdict for Claude Code's PreToolUse response shape (measured
 * 2026-08-03 on claude 2.1.220): exit 0 + hookSpecificOutput.permissionDecision.
 */
export function encodeClaudePolicyResponse(input: {
  readonly permission: "allow" | "deny" | "ask";
  readonly agentMessage?: string;
  readonly updated_input?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const hookSpecificOutput: Record<string, unknown> = {
    hookEventName: "PreToolUse",
    permissionDecision: input.permission,
  };
  if (input.agentMessage !== undefined) {
    hookSpecificOutput.permissionDecisionReason = input.agentMessage;
  }
  if (input.updated_input !== undefined) {
    hookSpecificOutput.updatedInput = input.updated_input;
  }
  return { hookSpecificOutput };
}

export async function runPolicyEvalCli(
  argv: readonly string[],
): Promise<number> {
  const parsed = parsePolicyEvalArgv(argv);
  if (typeof parsed === "string") {
    console.error(parsed);
    return 1;
  }

  const encode =
    parsed.format === "claude"
      ? encodeClaudePolicyResponse
      : encodeCursorPolicyResponse;

  const policyId = parsed.policyId ?? Bun.env.AGENTS_POLICY_ID;
  if (policyId === undefined || policyId.length === 0) {
    console.log(JSON.stringify(encode({ permission: "deny" })));
    console.error(
      "policy-eval: policy identity env AGENTS_POLICY_ID is missing; the enforcement environment may have been stripped; failing closed",
    );
    return 0;
  }
  if (policyId === POLICY_NONE_TOKEN) {
    console.log(JSON.stringify(encode({ permission: "allow" })));
    return 0;
  }
  const agentsDir = parsed.agentsDir ?? Bun.env.AGENTS_AGENTS_DIR ?? ".agents";

  let policy: PolicySpec;
  try {
    policy = await loadPolicy(agentsDir, policyId);
  } catch (error) {
    // Fail closed: an unreadable policy denies the action.
    console.log(JSON.stringify(encode({ permission: "deny" })));
    console.error(
      `policy-eval: could not load policy "${policyId}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }

  let payload: unknown;
  try {
    const stdin = await Bun.stdin.text();
    payload = stdin.trim().length === 0 ? {} : JSON.parse(stdin);
  } catch {
    payload = undefined;
  }
  if (payload === undefined) {
    console.log(JSON.stringify(encode({ permission: "deny" })));
    console.error("policy-eval: stdin was not valid JSON; failing closed");
    return 0;
  }

  const handler = createPolicyEvalHandler(policy);
  const normalized = normalizeHookPayload(payload);
  const output = handler(
    parsed.workspace === undefined
      ? normalized
      : relativizeContainedPaths(normalized, parsed.workspace),
  );
  const permission = DECISION_TO_PERMISSION[output.verdict];
  const agentMessage =
    output.verdict === "deny" && output.reason !== undefined
      ? `Blocked by policy ${policy.id} (${output.reason})`
      : undefined;
  if (output.verdict === "warn") {
    console.error(`policy-eval: warning (${output.reason ?? "unspecified"})`);
  }
  console.log(
    JSON.stringify(
      encode({
        permission,
        ...(agentMessage === undefined ? {} : { agentMessage }),
        ...(output.updated_input === undefined
          ? {}
          : { updated_input: output.updated_input }),
      }),
    ),
  );
  return 0;
}

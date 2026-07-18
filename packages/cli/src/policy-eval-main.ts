import type { PolicySpec } from "@aguil/agents-harness-config";
import { loadPolicy } from "@aguil/agents-harness-config";
import type {
  PolicyHookInput,
  PolicyVerdictDecision,
} from "@aguil/agents-policy";
import { createPolicyEvalHandler } from "@aguil/agents-policy";

interface PolicyEvalArgs {
  readonly policyId: string;
  readonly agentsDir: string;
}

function parsePolicyEvalArgv(argv: readonly string[]): PolicyEvalArgs | string {
  let policyId: string | undefined;
  let agentsDir = ".agents";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--policy") {
      policyId = argv[index + 1];
      index += 1;
    } else if (arg === "--agents-dir") {
      agentsDir = argv[index + 1] ?? agentsDir;
      index += 1;
    } else {
      return `policy-eval: unknown argument "${arg}"`;
    }
  }
  if (policyId === undefined || policyId.length === 0) {
    return "policy-eval: --policy <id> is required";
  }
  return { policyId, agentsDir };
}

/** Cursor-or-canonical hook payload → canonical PolicyHookInput. */
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
    eventRaw === "beforeShellExecution" || eventRaw === "beforeMCPExecution"
      ? "pre_tool_call"
      : eventRaw === "afterFileEdit"
        ? "post_tool_call"
        : eventRaw === "stop"
          ? "role_stop"
          : eventRaw;

  const toolInputRaw =
    typeof record.tool_input === "object" && record.tool_input !== null
      ? (record.tool_input as Record<string, unknown>)
      : {};
  // Cursor's beforeShellExecution puts `command` at top level; afterFileEdit
  // puts `file_path` at top level. Merge them into the canonical tool_input.
  const toolInput: Record<string, unknown> = { ...toolInputRaw };
  for (const key of ["command", "file_path", "path", "url"]) {
    if (toolInput[key] === undefined && typeof record[key] === "string") {
      toolInput[key] = record[key];
    }
  }

  return {
    hook_event: event,
    ...(typeof record.tool_name === "string"
      ? { tool_name: record.tool_name }
      : eventRaw === "beforeShellExecution"
        ? { tool_name: "Execute" }
        : {}),
    tool_input: toolInput,
    ...(typeof record.state === "object" && record.state !== null
      ? { state: record.state as PolicyHookInput["state"] }
      : {}),
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

export async function runPolicyEvalCli(
  argv: readonly string[],
): Promise<number> {
  const parsed = parsePolicyEvalArgv(argv);
  if (typeof parsed === "string") {
    console.error(parsed);
    return 1;
  }

  let policy: PolicySpec;
  try {
    policy = await loadPolicy(parsed.agentsDir, parsed.policyId);
  } catch (error) {
    // Fail closed: an unreadable policy denies the action.
    console.log(JSON.stringify({ permission: "deny" }));
    console.error(
      `policy-eval: could not load policy "${parsed.policyId}": ${error instanceof Error ? error.message : String(error)}`,
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
    console.log(JSON.stringify({ permission: "deny" }));
    console.error("policy-eval: stdin was not valid JSON; failing closed");
    return 0;
  }

  const handler = createPolicyEvalHandler(policy);
  const output = handler(normalizeHookPayload(payload));
  const permission = DECISION_TO_PERMISSION[output.verdict];
  const response: Record<string, unknown> = { permission };
  if (output.verdict === "deny" && output.reason !== undefined) {
    response.agentMessage = `Blocked by policy ${policy.id} (${output.reason})`;
  }
  if (output.updated_input !== undefined) {
    response.updated_input = output.updated_input;
  }
  if (output.verdict === "warn") {
    console.error(`policy-eval: warning (${output.reason ?? "unspecified"})`);
  }
  console.log(JSON.stringify(response));
  return 0;
}

import type { PolicySpec } from "@aguil/agents-harness-config";
import { loadPolicy } from "@aguil/agents-harness-config";
import type {
  PolicyHookOutput,
  PolicyInterventionPoint,
  PolicyVerdict,
} from "@aguil/agents-policy";
import {
  createPolicyEvalHandler,
  evaluatePolicy,
  POLICY_NONE_TOKEN,
} from "@aguil/agents-policy";
import { normalizeHookPayload } from "./policy-eval-main";

const USAGE =
  "Usage: agents hooks test --policy <id> --agents-dir <dir> --event <name> [--tool <name>] [--input <json>] [--file <path>] [--format text|json]";

const SUPPORTED_EVENTS = new Set([
  "beforeShellExecution",
  "beforeMCPExecution",
  "afterFileEdit",
  "pre_tool_call",
  "post_tool_call",
]);

interface HooksTestArgs {
  readonly policyId: string;
  readonly agentsDir: string;
  readonly event: string;
  readonly tool?: string;
  readonly input?: string;
  readonly file?: string;
  readonly format: "text" | "json";
}

function usageError(message: string): number {
  console.error(`hooks test: ${message}`);
  console.error(USAGE);
  return 1;
}

function parseHooksTestArgv(
  argv: readonly string[],
): HooksTestArgs | { readonly error: string } {
  const values: Record<string, string | undefined> = {};
  const supported = new Set([
    "--policy",
    "--agents-dir",
    "--event",
    "--tool",
    "--input",
    "--file",
    "--format",
  ]);

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag === undefined || !supported.has(flag)) {
      return { error: `unknown argument "${flag ?? ""}"` };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    values[flag] = value;
  }

  const policyId = values["--policy"];
  const agentsDir = values["--agents-dir"];
  const event = values["--event"];
  if (
    policyId === undefined ||
    agentsDir === undefined ||
    event === undefined
  ) {
    return { error: "--policy, --agents-dir, and --event are required" };
  }
  if (!SUPPORTED_EVENTS.has(event)) {
    return { error: `unsupported event "${event}"` };
  }
  if (values["--input"] !== undefined && values["--file"] !== undefined) {
    return { error: "--input and --file are mutually exclusive" };
  }
  const format = values["--format"] ?? "text";
  if (format !== "text" && format !== "json") {
    return { error: '--format must be "text" or "json"' };
  }

  return {
    policyId,
    agentsDir,
    event,
    ...(values["--tool"] === undefined ? {} : { tool: values["--tool"] }),
    ...(values["--input"] === undefined ? {} : { input: values["--input"] }),
    ...(values["--file"] === undefined ? {} : { file: values["--file"] }),
    format,
  };
}

function asPayloadRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

async function readJsonPayload(
  args: HooksTestArgs,
): Promise<Readonly<Record<string, unknown>>> {
  if (args.input !== undefined) {
    const input = asPayloadRecord(JSON.parse(args.input));
    if (input === undefined) {
      throw new Error("--input must be a JSON object");
    }
    return { tool_input: input };
  }

  let source: string | undefined;
  if (args.file !== undefined) {
    source = await Bun.file(args.file).text();
  } else if (!process.stdin.isTTY) {
    source = await Bun.stdin.text();
  }
  if (source === undefined || source.trim().length === 0) {
    return {};
  }
  const payload = asPayloadRecord(JSON.parse(source));
  if (payload === undefined) {
    throw new Error("payload must be a JSON object");
  }
  return payload;
}

function interventionPointFor(
  hookEvent: string,
): PolicyInterventionPoint | undefined {
  if (hookEvent === "pre_tool_call" || hookEvent === "post_tool_call") {
    return hookEvent;
  }
  return undefined;
}

function printResult(
  output: PolicyHookOutput,
  format: "text" | "json",
  detail?: PolicyVerdict,
): void {
  if (format === "json") {
    console.log(JSON.stringify(output));
    return;
  }
  const reason = output.reason === undefined ? "" : ` (${output.reason})`;
  const message = detail?.message === undefined ? "" : ` — ${detail.message}`;
  console.log(`verdict: ${output.verdict}${reason}${message}`);
}

function exitCodeFor(verdict: PolicyHookOutput["verdict"]): number {
  if (verdict === "deny") {
    return 2;
  }
  if (verdict === "escalate") {
    return 3;
  }
  return 0;
}

export async function runHooksTestCli(
  argv: readonly string[],
): Promise<number> {
  const parsed = parseHooksTestArgv(argv);
  if ("error" in parsed) {
    return usageError(parsed.error);
  }

  let payload: Readonly<Record<string, unknown>>;
  try {
    payload = await readJsonPayload(parsed);
  } catch (error) {
    return usageError(
      `could not read payload: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const hookPayload = {
    hook_event_name: parsed.event,
    ...payload,
    ...(parsed.tool === undefined ? {} : { tool_name: parsed.tool }),
  };
  const normalized = normalizeHookPayload(hookPayload);

  if (parsed.policyId === POLICY_NONE_TOKEN) {
    const output: PolicyHookOutput = { verdict: "allow" };
    printResult(output, parsed.format);
    return 0;
  }

  let policy: PolicySpec;
  try {
    policy = await loadPolicy(parsed.agentsDir, parsed.policyId);
  } catch (error) {
    console.error(
      `hooks test: could not load policy "${parsed.policyId}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const output = createPolicyEvalHandler(policy)(normalized);
  const interventionPoint = interventionPointFor(normalized.hook_event);
  const detail =
    interventionPoint === undefined
      ? undefined
      : evaluatePolicy(policy, {
          interventionPoint,
          toolName: normalized.tool_name,
          toolInput: normalized.tool_input,
        });
  printResult(output, parsed.format, detail);
  return exitCodeFor(output.verdict);
}

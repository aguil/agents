import type {
  PolicyCapabilityRules,
  PolicySpec,
} from "@aguil/agents-harness-config";

export type PolicyVerdictDecision =
  | "allow"
  | "warn"
  | "deny"
  | "escalate"
  | "transform";

export interface PolicyVerdict {
  readonly decision: PolicyVerdictDecision;
  /** Low-cardinality code (e.g. "exec-denied"). */
  readonly reason?: string;
  /** Human/agent-facing explanation. */
  readonly message?: string;
  /** Replacement tool input; only meaningful for "transform". */
  readonly transform?: Readonly<Record<string, unknown>>;
}

/**
 * Reserved reason for evaluator failures (fail-closed). Policy rules must
 * never emit this reason themselves.
 */
export const POLICY_RUNTIME_ERROR_REASON = "policy-runtime-error";

export type PolicyInterventionPoint =
  | "pre_tool_call"
  | "post_tool_call"
  | "role_start"
  | "role_stop"
  | "run_start"
  | "run_end";

export interface PolicyEvalInput {
  readonly interventionPoint: PolicyInterventionPoint;
  readonly toolName?: string;
  readonly toolInput?: Readonly<Record<string, unknown>>;
  readonly state?: {
    readonly elapsedMs?: number;
    readonly cumulativeCostUsd?: number;
  };
}

const VERDICT_SEVERITY: Readonly<Record<PolicyVerdictDecision, number>> = {
  deny: 4,
  escalate: 3,
  transform: 2,
  warn: 1,
  allow: 0,
};

export const ALLOW_VERDICT: PolicyVerdict = { decision: "allow" };

/**
 * Compose verdicts from the policy evaluator and any user hooks:
 * deny > escalate > transform > warn > allow. A deny anywhere wins — user
 * hooks can tighten but never override a policy deny.
 */
export function composeVerdicts(
  verdicts: readonly PolicyVerdict[],
): PolicyVerdict {
  let composed = ALLOW_VERDICT;
  for (const verdict of verdicts) {
    if (
      VERDICT_SEVERITY[verdict.decision] > VERDICT_SEVERITY[composed.decision]
    ) {
      composed = verdict;
    }
  }
  return composed;
}

/**
 * A command matches a rule when it equals the rule or starts with the rule
 * followed by a space (word boundary): deny "rm" blocks "rm -rf x" but not
 * "rmdir".
 */
function commandMatchesRule(command: string, rule: string): boolean {
  return command === rule || command.startsWith(`${rule} `);
}

function pathMatchesRule(relativePath: string, rule: string): boolean {
  if (rule === "*" || rule === "**") {
    return true;
  }
  return new Bun.Glob(rule).match(relativePath);
}

function hostMatchesRule(host: string, rule: string): boolean {
  if (rule === "*") {
    return true;
  }
  return host === rule || host.endsWith(`.${rule}`);
}

const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "Create",
  "MultiEdit",
  "NotebookEdit",
]);

function extractCommand(input: PolicyEvalInput): string | undefined {
  const command = input.toolInput?.command;
  return typeof command === "string" && command.trim().length > 0
    ? command.trim()
    : undefined;
}

function extractFilePath(input: PolicyEvalInput): string | undefined {
  const candidate = input.toolInput?.file_path ?? input.toolInput?.path;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function extractHost(input: PolicyEvalInput): string | undefined {
  const url = input.toolInput?.url;
  if (typeof url !== "string" || url.length === 0) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function evaluateRules(
  rules: PolicyCapabilityRules | undefined,
  candidate: string,
  matches: (candidate: string, rule: string) => boolean,
): "denied" | "allowed" | "unlisted" {
  if (rules === undefined) {
    return "allowed";
  }
  if (rules.deny?.some((rule) => matches(candidate, rule))) {
    return "denied";
  }
  if (rules.allow === undefined || rules.allow.length === 0) {
    return "allowed";
  }
  return rules.allow.some((rule) => matches(candidate, rule))
    ? "allowed"
    : "unlisted";
}

function evaluateExec(
  policy: PolicySpec,
  input: PolicyEvalInput,
): PolicyVerdict {
  const command = extractCommand(input);
  if (command === undefined) {
    return ALLOW_VERDICT;
  }
  const result = evaluateRules(
    policy.capabilities?.exec,
    command,
    commandMatchesRule,
  );
  if (result === "denied") {
    return {
      decision: "deny",
      reason: "exec-denied",
      message: `Command is denied by policy ${policy.id}: ${command}`,
    };
  }
  if (result === "unlisted") {
    if (policy.confirmations?.requiredFor.includes("exec.unknown")) {
      return {
        decision: "escalate",
        reason: "exec-unknown-confirmation",
        message: `Command is not on the allow list of policy ${policy.id} and requires approval: ${command}`,
      };
    }
    return {
      decision: "deny",
      reason: "exec-not-allowed",
      message: `Command is not on the allow list of policy ${policy.id}: ${command}`,
    };
  }
  return ALLOW_VERDICT;
}

function evaluateFilesystem(
  policy: PolicySpec,
  input: PolicyEvalInput,
): PolicyVerdict {
  const path = extractFilePath(input);
  if (path === undefined) {
    return ALLOW_VERDICT;
  }
  const result = evaluateRules(
    policy.capabilities?.filesystem,
    path,
    pathMatchesRule,
  );
  if (result === "denied") {
    return {
      decision: "deny",
      reason: "filesystem-denied",
      message: `Path is denied by policy ${policy.id}: ${path}`,
    };
  }
  if (result === "unlisted") {
    return {
      decision: "deny",
      reason: "filesystem-not-allowed",
      message: `Path is not on the allow list of policy ${policy.id}: ${path}`,
    };
  }
  if (
    input.toolName !== undefined &&
    WRITE_TOOL_NAMES.has(input.toolName) &&
    policy.confirmations?.requiredFor.includes("filesystem.write")
  ) {
    return {
      decision: "escalate",
      reason: "filesystem-write-confirmation",
      message: `Write to ${path} requires approval under policy ${policy.id}`,
    };
  }
  return ALLOW_VERDICT;
}

function evaluateNetwork(
  policy: PolicySpec,
  input: PolicyEvalInput,
): PolicyVerdict {
  const host = extractHost(input);
  if (host === undefined) {
    return ALLOW_VERDICT;
  }
  const result = evaluateRules(
    policy.capabilities?.network,
    host,
    hostMatchesRule,
  );
  if (result === "denied") {
    return {
      decision: "deny",
      reason: "network-denied",
      message: `Network access to ${host} is denied by policy ${policy.id}`,
    };
  }
  if (result === "unlisted") {
    return {
      decision: "deny",
      reason: "network-not-allowed",
      message: `Host is not on the allow list of policy ${policy.id}: ${host}`,
    };
  }
  return ALLOW_VERDICT;
}

const COST_WARN_FRACTION = 0.8;

function evaluateCost(
  policy: PolicySpec,
  input: PolicyEvalInput,
): PolicyVerdict {
  const limit = policy.limits?.costUsd;
  const spent = input.state?.cumulativeCostUsd;
  if (limit === undefined || spent === undefined) {
    return ALLOW_VERDICT;
  }
  if (spent >= limit) {
    return {
      decision: "deny",
      reason: "cost-budget-exceeded",
      message: `Cumulative cost $${spent.toFixed(2)} reached the $${limit.toFixed(2)} budget of policy ${policy.id}`,
    };
  }
  if (spent >= limit * COST_WARN_FRACTION) {
    return {
      decision: "warn",
      reason: "cost-budget-warning",
      message: `Cumulative cost $${spent.toFixed(2)} is above ${COST_WARN_FRACTION * 100}% of the $${limit.toFixed(2)} budget of policy ${policy.id}`,
    };
  }
  return ALLOW_VERDICT;
}

/**
 * Evaluate one intervention point against a resolved policy. Never throws:
 * evaluator errors return deny with the reserved runtime-error reason
 * (fail-closed, ACS semantics).
 */
export function evaluatePolicy(
  policy: PolicySpec,
  input: PolicyEvalInput,
): PolicyVerdict {
  try {
    if (
      input.interventionPoint !== "pre_tool_call" &&
      input.interventionPoint !== "post_tool_call"
    ) {
      // Lifecycle points currently carry no enforced constraints beyond
      // cost, which is checked everywhere.
      return evaluateCost(policy, input);
    }
    return composeVerdicts([
      evaluateExec(policy, input),
      evaluateFilesystem(policy, input),
      evaluateNetwork(policy, input),
      evaluateCost(policy, input),
    ]);
  } catch (error) {
    return {
      decision: "deny",
      reason: POLICY_RUNTIME_ERROR_REASON,
      message: `Policy evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Hook-shaped input (JSON stdin contract used by the hook pipeline). */
export interface PolicyHookInput {
  readonly hook_event: string;
  readonly tool_name?: string;
  readonly tool_input?: Readonly<Record<string, unknown>>;
  readonly state?: {
    readonly elapsed_ms?: number;
    readonly cumulative_cost_usd?: number;
  };
}

export interface PolicyHookOutput {
  readonly verdict: PolicyVerdictDecision;
  readonly reason?: string;
  readonly updated_input?: Readonly<Record<string, unknown>>;
}

const HOOK_EVENT_TO_INTERVENTION: Readonly<
  Record<string, PolicyInterventionPoint>
> = {
  pre_tool_call: "pre_tool_call",
  post_tool_call: "post_tool_call",
  role_start: "role_start",
  role_stop: "role_stop",
  run_start: "run_start",
  run_end: "run_end",
};

/**
 * Adapt the hook JSON contract to the evaluator. This is the builtin
 * handler the runtime registers first at each mapped intervention point;
 * user hooks run after and compose via composeVerdicts (deny wins).
 */
export function createPolicyEvalHandler(
  policy: PolicySpec,
): (input: PolicyHookInput) => PolicyHookOutput {
  return (input) => {
    const interventionPoint = HOOK_EVENT_TO_INTERVENTION[input.hook_event];
    if (interventionPoint === undefined) {
      return {
        verdict: "deny",
        reason: POLICY_RUNTIME_ERROR_REASON,
      };
    }
    const verdict = evaluatePolicy(policy, {
      interventionPoint,
      toolName: input.tool_name,
      toolInput: input.tool_input,
      state: {
        elapsedMs: input.state?.elapsed_ms,
        cumulativeCostUsd: input.state?.cumulative_cost_usd,
      },
    });
    return {
      verdict: verdict.decision,
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      ...(verdict.transform === undefined
        ? {}
        : { updated_input: verdict.transform }),
    };
  };
}
